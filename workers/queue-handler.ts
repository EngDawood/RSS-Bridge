import type { QueueTask, FetchTask, SendTask } from './types/queue';
import { Bot, GrammyError } from 'grammy';
import { sendMediaToChannel, addFailedPost } from './services/telegram-bot';
import { getAdminConfig } from './services/telegram-bot/storage/kv-operations';
import { fetchForSource, isPushSource } from './services/source-fetcher';
import { enrichFeedItems } from './utils/media-enrichment';
import { formatFeedItem, resolveFormatSettings } from './utils/telegram-format';
import {
	getFeedById,
	getChannelById,
	getTelegramSubscriptionsByFeed,
	upsertItems,
	wasPostedToChannel,
	insertPostLog,
	resolveAiSummaryEnabled,
	getWorkflowsForFeed,
	listNewItems,
	recordFeedFetchSuccess,
} from './db/d1';
import { recordFailureAndAlert } from './services/feed-health';
import { embedItems } from './services/embed';
import { launchWorkflowRun } from './workflows/trigger';
import { maybeEnrichSummary } from './services/ai-summarizer';
import { sendFallbackMessage } from './services/telegram-bot/helpers/fallback-sender';
import { FileTooLargeError } from './services/telegram-bot/handlers/send-media';
import { filterItems } from './cron/check-feeds';
import type { ChannelSource } from './types/telegram';
import type { FormatSettings } from './types/telegram';

/**
 * Main entry point for Cloudflare Queue events.
 * Collects task-level failures and sends one batched admin DM at the end instead of
 * a separate message per error (avoids notification spam on transient outages).
 */
export async function handleQueue(batch: MessageBatch<QueueTask>, env: Env): Promise<void> {
	const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
	const batchErrors: string[] = [];

	for (const message of batch.messages) {
		const task = message.body;
		try {
			if (task.type === 'fetch') {
				await processFetchTask(task, env);
			} else if (task.type === 'send') {
				await processSendTask(task, bot, env);
			}
			message.ack();
		} catch (err) {
			const label = task.type === 'send' ? `send→${task.channelId}` : `fetch:${task.feedId}`;
			batchErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
			console.error(`[Queue] Failed to process ${task.type} task:`, err);
			// Do NOT ack — Cloudflare retries un-acked messages.
		}
	}

	// Send one batched DM for all un-acked failures instead of per-message spam.
	if (batchErrors.length > 0) {
		try {
			const adminId = parseInt(env.ADMIN_TELEGRAM_ID, 10);
			if (!isNaN(adminId)) {
				const preview = batchErrors.slice(0, 5).map(e => e.slice(0, 120)).join('\n');
				const tail = batchErrors.length > 5 ? `\n…and ${batchErrors.length - 5} more` : '';
				await bot.api.sendMessage(
					adminId,
					`⚠️ <b>Queue errors (${batchErrors.length})</b>\n<pre>${preview}${tail}</pre>`,
					{ parse_mode: 'HTML' },
				);
			}
		} catch { /* non-fatal */ }
	}
}

/**
 * Tier 1: Fetch a core feed, store items to D1, then queue SendTasks for each
 * subscribing Telegram channel that hasn't received the item yet (post_log dedup).
 * One FetchTask per feed — dedup happens in the cron, not here.
 */
async function processFetchTask(task: FetchTask, env: Env): Promise<void> {
	const { feedId } = task;

	const feed = await getFeedById(env.DB, feedId);
	if (!feed || !feed.enabled) return;

	// Push feeds (Folo webhook) deliver their own items; polling them would only
	// ever return empty and trip the degraded-feed alert.
	if (isPushSource(feed.source_type)) return;

	// Build a minimal ChannelSource so fetchForSource can route by source_type.
	const source: ChannelSource = {
		id: feed.id,
		type: feed.source_type as ChannelSource['type'],
		value: feed.source_value,
		mediaFilter: 'all',
		enabled: true,
	};

	const result = await fetchForSource(source, env);

	if (result.items.length === 0) {
		const errMsg = result.errors.map(e => e.message).join('; ') || 'All instances returned empty results';
		await recordFailureAndAlert(env, feedId, feed.title || feed.source_value, errMsg);
		return;
	}

	// Persist ALL fetched items to D1 (INSERT OR IGNORE — cheap, idempotent).
	const insertedCount = await upsertItems(env.DB, feedId, result.items);
	await recordFeedFetchSuccess(env.DB, feedId);

	// Embed newly fetched items to Vectorize (non-fatal — skipped if binding absent).
	if (insertedCount > 0) {
		await embedItems(env, feedId, result.items);
	}

	// Fire any rss_batch agent workflows watching this feed (independent of Telegram subs).
	if (insertedCount > 0) {
		await triggerRssBatchWorkflows(env, feedId, insertedCount);
	}

	// Find all enabled Telegram subscriptions for this feed.
	const subs = await getTelegramSubscriptionsByFeed(env.DB, feedId);
	if (subs.length === 0) return;

	// Enrich ONCE — Telegraph / TikTok enrichment is feed-level, not per-channel.
	const recentItems = result.items.slice(0, 20);
	const adminConfig = await getAdminConfig(env.CACHE);
	await enrichFeedItems(recentItems, {
		token: adminConfig.telegraph.token || env.TELEGRAPH_ACCESS_TOKEN,
		enabled: adminConfig.telegraph.enabled,
		threshold: adminConfig.telegraph.threshold,
	});

	// For each subscribing channel, filter + dedup + queue.
	for (const sub of subs) {
		const channel = await getChannelById(env.DB, sub.channel_id);
		if (!channel || !channel.enabled) continue;

		// Filter by this subscription's media type.
		const filtered = filterItems(recentItems, sub.media_filter as ChannelSource['mediaFilter']);

		// Dedup: skip items already successfully posted to this channel.
		const newItems = [];
		for (const item of filtered) {
			if (!(await wasPostedToChannel(env.DB, sub.channel_id, item.id))) {
				newItems.push(item);
			}
		}
		if (newItems.length === 0) continue;

		// Oldest first, cap at 5 per cycle.
		newItems.reverse();
		const toPost = newItems.slice(0, 5);

		// Resolve format for this subscription.
		const channelDefaultFormat = channel.default_format
			? (JSON.parse(channel.default_format) as Partial<FormatSettings>)
			: undefined;
		const subFormat = sub.format
			? (JSON.parse(sub.format) as Partial<FormatSettings>)
			: undefined;
		const settings = resolveFormatSettings(channelDefaultFormat, subFormat);

		// AI summarization is per-subscription (channels may have different settings).
		const aiEnabled = await resolveAiSummaryEnabled(env.DB, sub.channel_id, sub.feed_id);
		if (aiEnabled) {
			await Promise.all(
				toPost.map(item =>
					maybeEnrichSummary(item, sub.feed_id, env.DB, env, sub.channel_id, sub.feed_id),
				),
			);
		}

		for (const item of toPost) {
			await env.TELEGRAM_SEND_QUEUE.send({
				type: 'send',
				channelId: sub.channel_id,
				item,
				settings,
			});
		}
	}
}

/**
 * Launch every enabled rss_batch agent workflow watching this feed whose
 * batch_size threshold is met by the newly-inserted items. Items are gathered
 * from D1 (newest first, capped at batch_size) and passed to the workflow.
 */
async function triggerRssBatchWorkflows(env: Env, feedId: string, insertedCount: number): Promise<void> {
	let workflows;
	try {
		workflows = await getWorkflowsForFeed(env.DB, feedId);
	} catch (err) {
		console.error(`[Queue] Failed to load workflows for feed ${feedId}:`, err);
		return;
	}
	for (const wf of workflows) {
		const batchSize = wf.batch_size || 1;
		if (insertedCount < batchSize) continue;
		try {
			const items = await listNewItems(env.DB, { feedId, limit: batchSize, unreadOnly: false });
			await launchWorkflowRun(env, wf, items, 'rss_batch');
		} catch (err) {
			console.error(`[Queue] Failed to launch workflow ${wf.id} for feed ${feedId}:`, err);
		}
	}
}

/**
 * Tier 2: Format the post and send it to Telegram.
 */
async function processSendTask(task: SendTask, bot: Bot, env: Env): Promise<void> {
	const { channelId, item, settings } = task;
	const chatId = parseInt(channelId, 10);
	let messageType = 'text';
	let captionPreview = '';

	try {
		const message = formatFeedItem(item, settings);
		messageType = message.type;
		captionPreview = message.caption.slice(0, 200);

		await sendMediaToChannel(bot, chatId, message, settings);

		try {
			await insertPostLog(env.DB, {
				itemId: item.id,
				chatId: channelId,
				messageType,
				captionPreview,
				status: 'ok',
			});
		} catch (logErr) {
			console.error('[Queue Log] Failed to insert success log:', logErr);
		}
	} catch (err) {
		if (err instanceof GrammyError && err.error_code === 429) {
			console.error(`[Queue] Rate limited sending to ${channelId}. Rethrowing for retry.`);
			throw err;
		}

		console.error(`[Queue] Failed to send item ${item.id} to ${channelId}:`, err);

		if (settings.fallbackMode === 'skip') {
			await addFailedPost(env.CACHE, channelId, item);
			try {
				await insertPostLog(env.DB, {
					itemId: item.id,
					chatId: channelId,
					messageType,
					captionPreview: item.title.slice(0, 200),
					status: 'error',
					error: err instanceof Error ? err.message : String(err),
				});
			} catch (logErr) {
				console.error('[Queue Log] Failed to insert error log (skipped):', logErr);
			}
			return;
		}

		try {
			await sendFallbackMessage(bot, chatId, item, settings.fallbackMode as 'thumbnail_link' | 'thumbnail', err);
			try {
				await insertPostLog(env.DB, {
					itemId: item.id,
					chatId: channelId,
					messageType: 'photo',
					captionPreview: `[Fallback] ${item.title.slice(0, 180)}`,
					status: 'ok',
				});
			} catch (logErr) {
				console.error('[Queue Log] Failed to insert fallback success log:', logErr);
			}
		} catch (fallbackErr) {
			console.error(`[Queue] Fallback also failed for ${item.id}:`, fallbackErr);
			await addFailedPost(env.CACHE, channelId, item);

			if (fallbackErr instanceof GrammyError && fallbackErr.error_code === 429) {
				throw fallbackErr;
			}

			try {
				await insertPostLog(env.DB, {
					itemId: item.id,
					chatId: channelId,
					messageType,
					captionPreview,
					status: 'error',
					error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
				});
			} catch (logErr) {
				console.error('[Queue Log] Failed to insert permanent failure log:', logErr);
			}

			console.error(`[Queue] Permanent delivery failure for ${item.id} in channel ${channelId}`);
		}
	}
}
