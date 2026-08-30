import type { Context } from 'hono';
import { Bot } from 'grammy';
import { fetchFeed } from '../services/feed-fetcher';
import { fetchForSource } from '../services/source-fetcher';
import { formatFeedItem, resolveFormatSettings } from '../utils/telegram-format';
import { enrichFeedItems } from '../utils/media-enrichment';
import { summarizeItem } from '../services/ai-summarizer';
import {
	getFeeds, getFeedById, getFeedByUrl, insertFeed, removeFeed, setFeedEnabled,
	updateLastFetched, upsertItems, listNewItems, searchItems, getItemById,
	markItemsRead, getConfig, setConfig, dbItemToFeedItem,
	getChats, getChatByName, upsertChat, removeChat, setDefaultChat,
	insertNote, listNotes, searchNotes, deleteNote,
	listPostLog, recall, updateItemSummary,
	upsertFeedBySource, upsertChannel, addTelegramSubscription, removeTelegramSubscription, addMcpSubscription, removeMcpSubscription,
	getChannels, getTelegramSubscriptions, getTelegramSubscriptionsByFeed, getMcpSubscriptions, getFoloFeeds,
	listCategories, getFeedsInCategory, createCategory, deleteCategory, addFeedToCategory, removeFeedFromCategory,
	createWorkflow, updateWorkflow, listWorkflows, getWorkflow, deleteWorkflow, setWorkflowFeeds,
	setRunStatus, listRuns, getRun, getRunEvents,
	getFoloChannelIds, addFoloChannel, removeFoloChannel,
	listFoloWebhooks, getFoloWebhook, createFoloWebhook, deleteFoloWebhook,
	getFoloWebhookChannels, addFoloWebhookChannel, removeFoloWebhookChannel,
	listRssBundles, getRssBundleBySlug, getRssBundleFeedIds, createRssBundle,
	updateRssBundle, deleteRssBundle, addFeedToBundle, removeFeedFromBundle,
} from '../db/d1';
import { launchWorkflowRun } from '../workflows/trigger';
import { resolveTarget, logAndSend } from '../services/post-service';
import { requireApiAuth } from '../utils/auth';
import { getChannelsList, getChannelConfig, getFailedPosts, clearFailedPosts } from '../services/telegram-bot/storage/kv-operations';
import { cleanupOldData } from '../cron/cleanup';
import { semanticSearchItems, semanticSearchNotes, embedNote } from '../services/embed';
import { buildSendTask } from '../types/queue';
import type { TelegramMediaMessage, SourceType } from '../types/telegram';
import type { DbNote } from '../db/d1';

type HonoEnv = { Bindings: Env };

/** Curated free-text model suggestions for the workflow editor datalist (non-restrictive). */
const MODEL_SUGGESTIONS = [
	'google/gemini-2.0-flash',
	'google/gemini-2.5-flash',
	'openai/gpt-4o-mini',
	'anthropic/claude-3-5-sonnet',
	'groq/llama-3.3-70b-versatile',
	'nvidia/llama-3.1-nemotron-70b-instruct',
	'deepseek/deepseek-chat',
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];

/** Map a Cloudflare Workflows instance status to our workflow_runs status vocabulary. */
function mapWorkflowStatus(status?: string): string | null {
	switch (status) {
		case 'queued': return 'queued';
		case 'running':
		case 'paused':
		case 'waiting':
		case 'waitingForPause': return 'running';
		case 'complete': return 'complete';
		case 'errored':
		case 'unknown': return 'errored';
		case 'terminated': return 'terminated';
		default: return null;
	}
}

export async function handleActionApi(c: Context<HonoEnv>): Promise<Response> {
	// 1. Authenticate (fail-closed: requires MCP_AUTH_TOKEN to be configured)
	const authFail = requireApiAuth(c);
	if (authFail) return authFail;

	// 2. Parse request
	let body: { action: string; params?: any };
	try {
		body = await c.req.json();
	} catch (e) {
		return c.json({ error: 'Invalid JSON request body' }, 400);
	}

	const { action, params = {} } = body;
	const db = c.env.DB;

	try {
		switch (action) {
			// ── Feed management ──────────────────────────────────────────────────────
			case 'list_feeds': {
				const feeds = await getFeeds(db);
				const normalized = feeds.map(f => ({
					...f,
					telegram_channel_ids: f.telegram_channel_ids
						? f.telegram_channel_ids.split(',').filter(Boolean)
						: [],
				}));
				return c.json({ data: normalized });
			}
			case 'list_channels': {
				const channels = await getChannels(db);
				return c.json({ data: channels });
			}
			case 'list_categories': {
				const categories = await listCategories(db);
				return c.json({ data: categories });
			}
			case 'get_category_feeds': {
				const { categoryId } = params;
				if (!categoryId) return c.json({ error: 'categoryId is required' }, 400);
				const categoryFeeds = await getFeedsInCategory(db, categoryId);
				const normalized = categoryFeeds.map(f => ({
					...f,
					telegram_channel_ids: f.telegram_channel_ids
						? f.telegram_channel_ids.split(',').filter(Boolean)
						: [],
				}));
				return c.json({ data: normalized });
			}
			case 'add_feed': {
				const { url, title, categoryId, subscribeToMcp = false, sourceType: rawType = 'rss' } = params;
				if (!url) return c.json({ error: 'url parameter is required' }, 400);

				const typeMap: Record<string, SourceType> = {
					'rss': 'rss_url', 'rss-bridge': 'rss_url',
					'rsshub': 'rsshub_url',
					'instagram': 'instagram_user',
					'tiktok': 'tiktok_user',
				};
				const internalType: SourceType = typeMap[rawType] ?? 'rss_url';
				const isUrlType = internalType === 'rss_url' || internalType === 'rsshub_url';
				const sourceValue = isUrlType ? url.trim() : url.replace(/^@/, '').trim();

				if (isUrlType) {
					const existing = await getFeedByUrl(db, sourceValue);
					if (existing) return c.json({ data: { message: 'Feed already exists', feed: existing } });
				}

				const result = await fetchForSource({ type: internalType, value: sourceValue } as any, c.env);
				const feedTitle = title || result.feedTitle || sourceValue;
				const feed = await upsertFeedBySource(db, { sourceType: internalType, sourceValue, title: feedTitle });
				const inserted = await upsertItems(db, feed.id, result.items);
				await updateLastFetched(db, feed.id);

				if (subscribeToMcp) await addMcpSubscription(db, feed.id, feedTitle);
				if (categoryId) await addFeedToCategory(db, categoryId, feed.id);

				return c.json({ data: { feed, itemsInserted: inserted, errors: result.errors } });
			}
			case 'remove_feed': {
				const { feedId } = params;
				if (!feedId) return c.json({ error: 'feedId is required' }, 400);
				const feed = await getFeedById(db, feedId);
				if (!feed) return c.json({ error: `Feed ${feedId} not found` }, 404);
				await removeFeed(db, feedId);
				return c.json({ data: { removed: feedId, title: feed.title } });
			}
			case 'set_feed_enabled': {
				const { feedId, enabled } = params;
				if (!feedId || enabled === undefined) return c.json({ error: 'feedId and enabled are required' }, 400);
				await setFeedEnabled(db, feedId, !!enabled);
				return c.json({ data: { feedId, enabled } });
			}

			// ── Fetch / refresh ───────────────────────────────────────────────────────
			case 'refresh_feed': {
				const { feedId } = params;
				if (!feedId) return c.json({ error: 'feedId is required' }, 400);
				const feed = await getFeedById(db, feedId);
				if (!feed) return c.json({ error: `Feed ${feedId} not found` }, 404);
				const result = await fetchFeed(feed.url, feed.title || undefined);
				const inserted = await upsertItems(db, feedId, result.items);
				await updateLastFetched(db, feedId);
				return c.json({ data: { feedId, itemsFetched: result.items.length, itemsInserted: inserted, errors: result.errors } });
			}
			case 'refresh_all': {
				const feeds = await getFeeds(db);
				const enabled = feeds.filter(f => f.enabled === 1);
				const settled = await Promise.allSettled(
					enabled.map(async (feed) => {
						const result = await fetchFeed(feed.url, feed.title || undefined);
						const inserted = await upsertItems(db, feed.id, result.items);
						await updateLastFetched(db, feed.id);
						return { feedId: feed.id, title: feed.title, inserted, errors: result.errors.length };
					})
				);
				const results = settled.map((r, i) =>
					r.status === 'fulfilled'
						? r.value
						: { feedId: enabled[i].id, title: enabled[i].title, inserted: 0, errors: 1 }
				);
				return c.json({ data: { refreshed: results.length, results } });
			}
			case 'fetch_rss_feed': {
				const { url, count = 10 } = params;
				if (!url) return c.json({ error: 'url is required' }, 400);
				const result = await fetchFeed(url);
				const items = result.items.slice(0, count).map(item => ({
					id: item.id,
					title: item.title,
					link: item.link,
					author: item.author,
					topics: item.topics ?? [],
					timestamp: item.timestamp,
					mediaType: item.mediaType,
					text: item.text.slice(0, 500),
				}));
				return c.json({ data: { feedTitle: result.feedTitle, feedLink: result.feedLink, items, errors: result.errors } });
			}

			// ── Browse / read tracking ─────────────────────────────────────────────────
			case 'list_new_items': {
				const { feedId, query, since, limit = 50, unreadOnly, readOnly, orderBy } = params;
				const items = await listNewItems(db, { feedId, query, since, limit, unreadOnly, readOnly, orderBy });
				return c.json({ data: items });
			}
			case 'search_items': {
				const { query, feedId, since, unreadOnly = false, readOnly = false, limit = 50, orderBy } = params;
				if (!query) return c.json({ error: 'query is required' }, 400);
				const items = await searchItems(db, { query, feedId, since, unreadOnly, readOnly, limit, orderBy });
				return c.json({ data: items });
			}
			case 'get_item': {
				const { id, markRead = false } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				const row = await getItemById(db, id);
				if (!row) return c.json({ error: `Item ${id} not found` }, 404);
				if (markRead) await markItemsRead(db, [id], true);
				return c.json({
					data: {
						...row,
						topics: JSON.parse(row.topics || '[]'),
						media: JSON.parse(row.media || '[]'),
					}
				});
			}
			case 'mark_read': {
				const { ids } = params;
				if (!ids || !Array.isArray(ids)) return c.json({ error: 'ids array is required' }, 400);
				await markItemsRead(db, ids, true);
				return c.json({ data: { marked: ids.length } });
			}
			case 'mark_unread': {
				const { ids } = params;
				if (!ids || !Array.isArray(ids)) return c.json({ error: 'ids array is required' }, 400);
				await markItemsRead(db, ids, false);
				return c.json({ data: { marked: ids.length } });
			}

			// ── Chat management ───────────────────────────────────────────────────────
			case 'list_chats': {
				const chats = await getChats(db);
				return c.json({ data: chats });
			}
			case 'add_chat': {
				const { name, chatId, type = 'channel', makeDefault = false } = params;
				if (!name || !chatId) return c.json({ error: 'name and chatId are required' }, 400);
				let resolvedId = String(chatId).trim();
				// Extract username from t.me URLs (https://t.me/x or t.me/x)
				const tmeMatch = resolvedId.match(/(?:https?:\/\/)?t\.me\/([^/?#\s]+)/i);
				if (tmeMatch) resolvedId = tmeMatch[1];
				// Strip leading @
				if (resolvedId.startsWith('@')) resolvedId = resolvedId.slice(1);
				// Resolve non-numeric values via Telegram API
				if (!/^-?\d+$/.test(resolvedId)) {
					try {
						const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);
						const resolved = await bot.api.getChat(`@${resolvedId}`);
						resolvedId = String(resolved.id);
					} catch (e) {
						return c.json({ error: `Could not resolve "@${resolvedId}": ${e instanceof Error ? e.message : String(e)}` }, 400);
					}
				}
				const chat = await upsertChat(db, name, resolvedId, type, makeDefault);
				return c.json({ data: chat });
			}
			case 'remove_chat': {
				const { name } = params;
				if (!name) return c.json({ error: 'name is required' }, 400);
				const chat = await getChatByName(db, name);
				if (!chat) return c.json({ error: `Chat "${name}" not found` }, 404);
				await removeChat(db, name);
				return c.json({ data: { removed: name } });
			}
			case 'set_default_chat': {
				const { name } = params;
				if (!name) return c.json({ error: 'name is required' }, 400);
				const chat = await getChatByName(db, name);
				if (!chat) return c.json({ error: `Chat "${name}" not found` }, 404);
				await setDefaultChat(db, name);
				return c.json({ data: { default: name } });
			}

			// ── Post ──────────────────────────────────────────────────────────────────
			case 'post_to_telegram': {
				const { id, target } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				const row = await getItemById(db, id);
				if (!row) return c.json({ error: `Item ${id} not found` }, 404);

				const feed = await getFeedById(db, row.feed_id);
				const feedTitle = feed?.title ?? '';
				const feedLink = feed?.url ?? '';

				const { chatId, chatName } = await resolveTarget(db, target);

				const item = dbItemToFeedItem(row, feedTitle, feedLink);
				await enrichFeedItems([item], { token: c.env.TELEGRAPH_ACCESS_TOKEN });

				const settings = resolveFormatSettings();
				const message = formatFeedItem(item, settings);

				const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);
				await logAndSend(db, bot, chatId, chatName, message, id);

				return c.json({ data: { ok: true, chatId, chatName, itemId: id } });
			}
			case 'post_message': {
				const { target, type, caption, mediaUrl, media, itemId } = params;
				const { chatId, chatName } = await resolveTarget(db, target);
				const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);
				let message: TelegramMediaMessage;

				if (itemId) {
					const row = await getItemById(db, itemId);
					if (!row) return c.json({ error: `Item ${itemId} not found` }, 404);
					const feed = await getFeedById(db, row.feed_id);
					const item = dbItemToFeedItem(row, feed?.title ?? '', feed?.url ?? '');
					await enrichFeedItems([item], { token: c.env.TELEGRAPH_ACCESS_TOKEN });
					message = formatFeedItem(item, resolveFormatSettings());
					if (caption) message = { ...message, caption };
				} else {
					const msgType = type ?? 'text';
					const cap = caption ?? '';
					if (msgType === 'text') {
						message = { type: 'text', caption: cap };
					} else if (msgType === 'album') {
						const items = media ?? [];
						if (items.length === 0) return c.json({ error: 'album type requires at least one item in media[]' }, 400);
						message = {
							type: 'mediagroup',
							caption: cap,
							media: items.map((m: any, i: number) => ({
								type: m.type,
								media: m.url,
								...(i === 0 ? { caption: cap, parse_mode: 'HTML' } : {}),
							})),
						};
					} else {
						if (!mediaUrl) return c.json({ error: `type "${msgType}" requires mediaUrl` }, 400);
						message = { type: msgType as 'photo' | 'video' | 'audio', url: mediaUrl, caption: cap };
					}
				}

				await logAndSend(db, bot, chatId, chatName, message, itemId);
				return c.json({ data: { ok: true, chatId, chatName, type: message.type } });
			}

			// ── Notes ─────────────────────────────────────────────────────────────────
			case 'save_note': {
				const { content, tags, refItemId, refChat } = params;
				if (!content) return c.json({ error: 'content is required' }, 400);
				const note = await insertNote(db, { content, tags, refItemId, refChat });
				// Embed the note for semantic search (non-fatal if Vectorize not configured).
				await embedNote(c.env, note.id, content);
				return c.json({ data: { ...note, tags: JSON.parse(note.tags) } });
			}
			case 'list_notes': {
				const { limit = 50, tag } = params;
				const notes = await listNotes(db, limit, tag);
				return c.json({ data: notes.map(n => ({ ...n, tags: JSON.parse(n.tags) })) });
			}
			case 'search_notes': {
				const { query, limit = 50 } = params;
				if (!query) return c.json({ error: 'query is required' }, 400);
				const notes = await searchNotes(db, query, limit);
				return c.json({ data: notes.map(n => ({ ...n, tags: JSON.parse(n.tags) })) });
			}
			case 'delete_note': {
				const { id } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				await deleteNote(db, id);
				return c.json({ data: { deleted: id } });
			}

			// ── Memory recall ─────────────────────────────────────────────────────────
			case 'recall': {
				const { limit = 50, since } = params;
				const entries = await recall(db, limit, since);
				return c.json({ data: entries });
			}
			case 'list_post_log': {
				const { limit = 50, itemId, chatId } = params;
				const logs = await listPostLog(db, limit, { itemId, chatId });
				return c.json({ data: logs });
			}

			// ── Config ────────────────────────────────────────────────────────────────
			case 'get_config': {
				const telegramChatId = await getConfig(db, 'telegram_chat_id');
				const aiSummaryEnabled = await getConfig(db, 'ai_summary_enabled');
				const aiModel = await getConfig(db, 'ai_model');
				const aiPrompt = await getConfig(db, 'ai_prompt');
				return c.json({ data: { telegramChatId, aiSummaryEnabled, aiModel, aiPrompt } });
			}
			case 'set_config': {
				const { key, value } = params;
				if (!key || value === undefined) return c.json({ error: 'key and value are required' }, 400);
				await setConfig(db, key, value);
				return c.json({ data: { [key]: value } });
			}
			case 'get_folo_config': {
				const secret = c.env.FOLO_WEBHOOK_SECRET;
				const tokenPart = secret ? `?token=${encodeURIComponent(secret)}` : '';
				const legacyUrl = `${c.env.WORKER_URL}/folo${tokenPart}`;
				const legacyChannels = await getFoloChannelIds(db);
				const rawWebhooks = await listFoloWebhooks(db);
				const webhooks = await Promise.all(rawWebhooks.map(async (wh) => {
					const t = wh.token ? `&token=${encodeURIComponent(wh.token)}` : '';
					return {
						id: wh.id,
						name: wh.name,
						webhookUrl: `${c.env.WORKER_URL}/folo?id=${encodeURIComponent(wh.id)}${t}`,
						channels: await getFoloWebhookChannels(db, wh.id),
					};
				}));
				return c.json({
					data: {
						legacy: { webhookUrl: legacyUrl, channels: legacyChannels, hasSecret: !!secret },
						webhooks,
					}
				});
			}
			case 'add_folo_channel': {
				const { channelId, webhookId } = params;
				if (!channelId) return c.json({ error: 'channelId is required' }, 400);
				if (webhookId) {
					await addFoloWebhookChannel(db, channelId, webhookId);
					return c.json({ data: { channels: await getFoloWebhookChannels(db, webhookId) } });
				}
				await addFoloChannel(db, channelId);
				return c.json({ data: { channels: await getFoloChannelIds(db) } });
			}
			case 'remove_folo_channel': {
				const { channelId, webhookId } = params;
				if (!channelId) return c.json({ error: 'channelId is required' }, 400);
				if (webhookId) {
					await removeFoloWebhookChannel(db, channelId, webhookId);
					return c.json({ data: { channels: await getFoloWebhookChannels(db, webhookId) } });
				}
				await removeFoloChannel(db, channelId);
				return c.json({ data: { channels: await getFoloChannelIds(db) } });
			}
			case 'get_folo_feeds': {
				const foloFeeds = await getFoloFeeds(db);
				const normalized = await Promise.all(foloFeeds.map(async (f) => {
					const subs = await getTelegramSubscriptionsByFeed(db, f.id);
					return {
						...f,
						telegram_channel_ids: subs.map(s => s.channel_id),
					};
				}));
				return c.json({ data: normalized });
			}
			case 'add_telegram_subscription': {
				const { channelId, feedId, mediaFilter = 'all' } = params;
				if (!channelId || !feedId) return c.json({ error: 'channelId and feedId are required' }, 400);
				await addTelegramSubscription(db, { channelId, feedId, mediaFilter });
				return c.json({ data: { success: true } });
			}
			case 'remove_telegram_subscription': {
				const { channelId, feedId } = params;
				if (!channelId || !feedId) return c.json({ error: 'channelId and feedId are required' }, 400);
				await removeTelegramSubscription(db, channelId, feedId);
				return c.json({ data: { success: true } });
			}
			case 'create_folo_webhook': {
				const { id, name, token } = params;
				if (!id || !name) return c.json({ error: 'id and name are required' }, 400);
				if (await getFoloWebhook(db, id)) return c.json({ error: `Webhook '${id}' already exists` }, 409);
				const finalToken = token || crypto.randomUUID().replace(/-/g, '');
				await createFoloWebhook(db, id, name, finalToken);
				const t = `&token=${encodeURIComponent(finalToken)}`;
				return c.json({
					data: {
						id, name, token: finalToken,
						webhookUrl: `${c.env.WORKER_URL}/folo?id=${encodeURIComponent(id)}${t}`,
					}
				});
			}
			case 'delete_folo_webhook': {
				const { id } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				await deleteFoloWebhook(db, id);
				return c.json({ data: { ok: true } });
			}
			case 'list_folo_webhooks': {
				const rawWebhooks = await listFoloWebhooks(db);
				const webhooks = await Promise.all(rawWebhooks.map(async (wh) => {
					const t = wh.token ? `&token=${encodeURIComponent(wh.token)}` : '';
					return {
						id: wh.id,
						name: wh.name,
						webhookUrl: `${c.env.WORKER_URL}/folo?id=${encodeURIComponent(wh.id)}${t}`,
						channels: await getFoloWebhookChannels(db, wh.id),
					};
				}));
				return c.json({ data: webhooks });
			}

			// ── Category management ───────────────────────────────────────────────────
			case 'create_category': {
				const { name } = params;
				if (!name) return c.json({ error: 'name is required' }, 400);
				const category = await createCategory(db, name);
				return c.json({ data: category });
			}
			case 'delete_category': {
				const { categoryId } = params;
				if (!categoryId) return c.json({ error: 'categoryId is required' }, 400);
				await deleteCategory(db, categoryId);
				return c.json({ data: { deleted: categoryId } });
			}
			case 'add_feed_to_category': {
				const { categoryId, feedId } = params;
				if (!categoryId || !feedId) return c.json({ error: 'categoryId and feedId are required' }, 400);
				await addFeedToCategory(db, categoryId, feedId);
				return c.json({ data: { ok: true } });
			}
			case 'remove_feed_from_category': {
				const { categoryId, feedId } = params;
				if (!categoryId || !feedId) return c.json({ error: 'categoryId and feedId are required' }, 400);
				await removeFeedFromCategory(db, categoryId, feedId);
				return c.json({ data: { ok: true } });
			}

			// ── MCP subscription management ───────────────────────────────────────────
			case 'list_mcp_subscriptions': {
				const subs = await getMcpSubscriptions(db);
				return c.json({ data: subs });
			}
			case 'add_mcp_subscription': {
				const { feedId } = params;
				if (!feedId) return c.json({ error: 'feedId is required' }, 400);
				const feed = await getFeedById(db, feedId);
				if (!feed) return c.json({ error: `Feed ${feedId} not found` }, 404);
				await addMcpSubscription(db, feedId, feed.title ?? undefined);
				return c.json({ data: { ok: true, feedId } });
			}
			case 'remove_mcp_subscription': {
				const { feedId } = params;
				if (!feedId) return c.json({ error: 'feedId is required' }, 400);
				await removeMcpSubscription(db, feedId);
				return c.json({ data: { ok: true, feedId } });
			}

			// ── AI On-Demand Summary (Added for Dashboard UI) ────────────────────────
			case 'summarize_item': {
				const { itemId } = params;
				if (!itemId) return c.json({ error: 'itemId is required' }, 400);
				const row = await getItemById(db, itemId);
				if (!row) return c.json({ error: `Item ${itemId} not found` }, 404);
				const feed = await getFeedById(db, row.feed_id);
				const item = dbItemToFeedItem(row, feed?.title ?? '', feed?.url ?? '');

				const globalModel = await getConfig(db, 'ai_model') || undefined;
				const globalPrompt = await getConfig(db, 'ai_prompt') || undefined;

				const summary = await summarizeItem(item, c.env, globalModel, globalPrompt, row.feed_id);
				if (summary) {
					await updateItemSummary(db, row.feed_id, row.id, summary);
					return c.json({ data: { summary } });
				}
				return c.json({ error: 'AI summarization failed. Check that your AI_GATEWAY_TOKEN secret is configured and you have active internet connection.' }, 500);
			}

			case 'get_instances': {
				const [rb, tiktok, rsshub, instagram] = await Promise.all([
					getConfig(db, 'instances_rssbridge'),
					getConfig(db, 'instances_tiktok'),
					getConfig(db, 'instances_rsshub'),
					getConfig(db, 'instances_instagram'),
				]);
				const { FULL_RSS_BRIDGE_INSTANCES, RSS_BRIDGE_TIKTOK_INSTANCES, RSSHUB_INSTANCES } = await import('./test-bridges');
				return c.json({ data: {
					rssbridge: rb ? JSON.parse(rb) : FULL_RSS_BRIDGE_INSTANCES,
					tiktok: tiktok ? JSON.parse(tiktok) : RSS_BRIDGE_TIKTOK_INSTANCES,
					rsshub: rsshub ? JSON.parse(rsshub) : RSSHUB_INSTANCES,
					instagram: instagram ? JSON.parse(instagram) : [...FULL_RSS_BRIDGE_INSTANCES, ...RSSHUB_INSTANCES],
				}});
			}

			case 'set_instances': {
				const { type, instances: list } = params;
				if (!type || !Array.isArray(list)) return c.json({ error: 'type and instances[] are required' }, 400);
				if (!['rssbridge', 'tiktok', 'rsshub', 'instagram'].includes(type)) return c.json({ error: 'type must be rssbridge | tiktok | rsshub | instagram' }, 400);
				await setConfig(db, `instances_${type}`, JSON.stringify(list));
				return c.json({ data: { saved: list.length } });
			}

			case 'run_benchmark': {
				const { type } = params;
				if (!type || !['rssbridge', 'tiktok', 'rsshub', 'instagram'].includes(type)) return c.json({ error: 'type must be rssbridge | tiktok | rsshub | instagram' }, 400);
				const { runBridgeBenchmark, FULL_RSS_BRIDGE_INSTANCES, RSS_BRIDGE_TIKTOK_INSTANCES, RSSHUB_INSTANCES } = await import('./test-bridges');
				const savedRaw = await getConfig(db, `instances_${type}`);
				const instanceList: string[] = savedRaw ? JSON.parse(savedRaw) :
					type === 'rsshub' ? RSSHUB_INSTANCES :
					type === 'tiktok' ? RSS_BRIDGE_TIKTOK_INSTANCES :
					type === 'instagram' ? [...FULL_RSS_BRIDGE_INSTANCES, ...RSSHUB_INSTANCES] :
					FULL_RSS_BRIDGE_INSTANCES;
				const platform = type === 'tiktok' ? 'tiktok' : 'instagram';
				const { results } = await runBridgeBenchmark(c.env, {
					username: 'claudeai',
					platform,
					instancesType: type === 'rsshub' ? 'rsshub' : type === 'instagram' ? 'all' : 'rssbridge',
					useCache: false,
					overrideInstances: instanceList,
				});
				// Re-rank: Success first, then Empty, then all errors; ties broken by items desc then speed asc
				const statusRank = (s: string) => s === 'Success' ? 0 : s === 'Empty' ? 1 : 2;
				results.sort((a, b) => {
					const ra = statusRank(a.status), rb = statusRank(b.status);
					if (ra !== rb) return ra - rb;
					if (b.items !== a.items) return b.items - a.items;
					return a.durationMs - b.durationMs;
				});
				const ranked = results.map(r => r.instance);
				await setConfig(db, `instances_${type}`, JSON.stringify(ranked));
				return c.json({ data: { ranked } });
			}

			case 'test_instance': {
				const { url, type } = params;
				if (!url) return c.json({ error: 'url is required' }, 400);
				const start = Date.now();
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 15000);
					const res = await fetch(url, {
						signal: controller.signal,
						headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)', Accept: 'application/rss+xml, application/atom+xml, */*' },
					});
					clearTimeout(timeout);
					const durationMs = Date.now() - start;
					if (!res.ok) return c.json({ data: { success: false, itemCount: 0, durationMs, url } });
					const text = await res.text();
					const isAtom = text.includes('<entry>');
					const itemCount = (text.match(isAtom ? /<entry>/g : /<item>/g) || []).length;
					return c.json({ data: { success: true, itemCount, durationMs, url } });
				} catch (e: any) {
					return c.json({ data: { success: false, itemCount: 0, durationMs: Date.now() - start, url } });
				}
			}

			case 'test_bridges': {
				const { username, platform, instancesType, useCache, customRoute } = params;
				const isCustom = platform === 'custom_rsshub' || platform === 'custom_rssbridge';
				if (!isCustom && !username) return c.json({ error: 'Username or URL is required' }, 400);
				if (isCustom && !customRoute) return c.json({ error: 'customRoute is required for custom platform modes' }, 400);

				const { runBridgeBenchmark, FULL_RSS_BRIDGE_INSTANCES, RSS_BRIDGE_TIKTOK_INSTANCES, RSSHUB_INSTANCES } = await import('./test-bridges');

				// Load saved instances from D1 (fall back to hardcoded defaults)
				const [savedRb, savedTiktok, savedRsshub] = await Promise.all([
					getConfig(db, 'instances_rssbridge'),
					getConfig(db, 'instances_tiktok'),
					getConfig(db, 'instances_rsshub'),
				]);
				const rssbridgeInstances: string[] = savedRb ? JSON.parse(savedRb) : FULL_RSS_BRIDGE_INSTANCES;
				const tiktokInstances: string[] = savedTiktok ? JSON.parse(savedTiktok) : RSS_BRIDGE_TIKTOK_INSTANCES;
				const rsshubInstances: string[] = savedRsshub ? JSON.parse(savedRsshub) : RSSHUB_INSTANCES;

				let overrideInstances: string[] | undefined;
				if (platform === 'custom_rsshub') {
					overrideInstances = rsshubInstances;
				} else if (platform === 'custom_rssbridge') {
					overrideInstances = rssbridgeInstances;
				} else if (instancesType === 'rsshub') {
					overrideInstances = rsshubInstances;
				} else if (instancesType === 'rssbridge') {
					overrideInstances = platform === 'tiktok' ? tiktokInstances : rssbridgeInstances;
				} else {
					overrideInstances = [...(platform === 'tiktok' ? tiktokInstances : rssbridgeInstances), ...rsshubInstances];
				}

				const result = await runBridgeBenchmark(c.env, {
					username: username || '',
					platform: platform || 'instagram',
					instancesType: instancesType || 'all',
					useCache: !!useCache,
					customRoute,
					overrideInstances,
				});
				return c.json({ data: result });
			}

			// ── Agent workflows ────────────────────────────────
			case 'list_agent_workflows': {
				const workflows = await listWorkflows(db);
				const normalized = workflows.map(w => ({
					...w,
					enabled_tools: JSON.parse(w.enabled_tools || '[]'),
				}));
				return c.json({ data: normalized });
			}
			case 'create_agent_workflow': {
				const {
					name, aiModel, systemPrompt, temperature, maxTurns, enabledTools = [],
					triggerType = 'manual', batchSize, targetChatId, targetChatName, feedIds = [], enabled,
				} = params;
				if (!name || !aiModel || !systemPrompt) {
					return c.json({ error: 'name, aiModel, and systemPrompt are required' }, 400);
				}
				const wf = await createWorkflow(db, {
					name, aiModel, systemPrompt, temperature, maxTurns,
					enabledTools, triggerType, batchSize, targetChatId, targetChatName, enabled,
				});
				await setWorkflowFeeds(db, wf.id, feedIds);
				return c.json({ data: { ...wf, feed_ids: feedIds } });
			}
			case 'update_agent_workflow': {
				const {
					id, name, aiModel, systemPrompt, temperature, maxTurns, enabledTools = [],
					triggerType = 'manual', batchSize, targetChatId, targetChatName, feedIds = [], enabled,
				} = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				if (!name || !aiModel || !systemPrompt) {
					return c.json({ error: 'name, aiModel, and systemPrompt are required' }, 400);
				}
				await updateWorkflow(db, id, {
					name, aiModel, systemPrompt, temperature, maxTurns,
					enabledTools, triggerType, batchSize, targetChatId, targetChatName, enabled,
				});
				await setWorkflowFeeds(db, id, feedIds);
				return c.json({ data: { id, feed_ids: feedIds } });
			}
			case 'delete_agent_workflow': {
				const { id } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				await deleteWorkflow(db, id);
				return c.json({ data: { deleted: id } });
			}
			case 'trigger_agent_workflow': {
				const { id } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				const wf = await getWorkflow(db, id);
				if (!wf) return c.json({ error: `Workflow ${id} not found` }, 404);
				const items = wf.feed_ids.length
					? await listNewItems(db, { feedId: wf.feed_ids, limit: wf.batch_size || 5, unreadOnly: false })
					: [];
				const runId = await launchWorkflowRun(c.env, wf, items, 'manual');
				return c.json({ data: { runId, itemsCount: items.length } });
			}
			case 'list_workflow_runs': {
				const { workflowId } = params;
				if (!workflowId) return c.json({ error: 'workflowId is required' }, 400);
				const runs = await listRuns(db, workflowId);
				// Reconcile live state from the Workflows binding for non-terminal runs.
				for (const run of runs) {
					if (run.status === 'complete' || run.status === 'errored' || run.status === 'terminated') continue;
					try {
						const instance = await c.env.AGENT_WORKFLOW.get(run.id);
						const live = await instance.status();
						const mapped = mapWorkflowStatus((live as { status?: string }).status);
						if (mapped && mapped !== run.status) {
							await setRunStatus(db, run.id, mapped);
							run.status = mapped;
						}
					} catch { /* instance may be gone; keep stored status */ }
				}
				return c.json({ data: runs });
			}
			case 'get_workflow_run': {
				const { runId } = params;
				if (!runId) return c.json({ error: 'runId is required' }, 400);
				const run = await getRun(db, runId);
				if (!run) return c.json({ error: `Run ${runId} not found` }, 404);
				const events = await getRunEvents(db, runId);
				return c.json({
					data: {
						run,
						events: events.map(e => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })),
					},
				});
			}
			case 'list_models': {
				return c.json({ data: MODEL_SUGGESTIONS });
			}

			// ── Reliability: retry failed posts ────────────────────────────────────────
			case 'retry_failed_posts': {
				const { channelId } = params;
				if (!channelId) return c.json({ error: 'channelId is required' }, 400);
				const posts = await getFailedPosts(c.env.CACHE, channelId);
				if (posts.length === 0) return c.json({ data: { queued: 0, message: 'No failed posts' } });
				let queued = 0;
				for (const item of posts) {
					try {
						await c.env.TELEGRAM_SEND_QUEUE.send(
							buildSendTask(channelId, item, resolveFormatSettings()),
						);
						queued++;
					} catch (err) {
						console.error('[API] Failed to queue retry for item', item.id, err);
					}
				}
				await clearFailedPosts(c.env.CACHE, channelId);
				return c.json({ data: { queued } });
			}

			// ── Reliability: data-retention cleanup ────────────────────────────────────
			case 'cleanup_data': {
				const result = await cleanupOldData(c.env);
				return c.json({ data: result });
			}

			// ── Semantic search (Vectorize) ────────────────────────────────────────────
			case 'semantic_search_items': {
				const { query, feedId, limit = 20 } = params;
				if (!query) return c.json({ error: 'query is required' }, 400);
				const ids = await semanticSearchItems(c.env, query, { limit, feedId });
				if (ids.length > 0) {
					const items = await listNewItems(db, { feedId: ids, limit, unreadOnly: false });
					return c.json({ data: { items, source: 'vectorize' } });
				}
				// Vectorize not configured or no matches — fall back to LIKE search.
				const items = await searchItems(db, { query, feedId, limit });
				return c.json({ data: { items, source: 'keyword' } });
			}
			case 'semantic_search_notes': {
				const { query, limit = 20 } = params;
				if (!query) return c.json({ error: 'query is required' }, 400);
				const ids = await semanticSearchNotes(c.env, query, limit);
				if (ids.length > 0) {
					const rows = (await Promise.all(
						ids.map(id => db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<DbNote>()),
					)).filter(Boolean) as DbNote[];
					return c.json({ data: { notes: rows, source: 'vectorize' } });
				}
				// Fallback to keyword search.
				const notes = await searchNotes(db, query, limit);
				return c.json({ data: { notes, source: 'keyword' } });
			}

			// ── RSS Bundles ──────────────────────────────────────────────────────────
			case 'list_bundles': {
				const bundles = await listRssBundles(db);
				const withFeeds = await Promise.all(bundles.map(async b => ({
					...b,
					feed_ids: await getRssBundleFeedIds(db, b.id),
				})));
				return c.json({ data: withFeeds });
			}
			case 'create_bundle': {
				const { slug, title, description } = params;
				if (!slug || !title) return c.json({ error: 'slug and title are required' }, 400);
				const existing = await getRssBundleBySlug(db, slug);
				if (existing) return c.json({ error: `Bundle with slug "${slug}" already exists` }, 409);
				const bundle = await createRssBundle(db, { slug, title, description });
				return c.json({ data: bundle });
			}
			case 'update_bundle': {
				const { id, title, description, enabled } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				await updateRssBundle(db, id, { title, description, enabled });
				return c.json({ data: { ok: true } });
			}
			case 'delete_bundle': {
				const { id } = params;
				if (!id) return c.json({ error: 'id is required' }, 400);
				await deleteRssBundle(db, id);
				return c.json({ data: { ok: true } });
			}
			case 'get_bundle_feeds': {
				const { bundleId } = params;
				if (!bundleId) return c.json({ error: 'bundleId is required' }, 400);
				const feedIds = await getRssBundleFeedIds(db, bundleId);
				const feedRows = await Promise.all(feedIds.map(id => getFeedById(db, id)));
				return c.json({ data: feedRows.filter(Boolean) });
			}
			case 'add_feed_to_bundle': {
				const { bundleId, feedId } = params;
				if (!bundleId || !feedId) return c.json({ error: 'bundleId and feedId are required' }, 400);
				await addFeedToBundle(db, bundleId, feedId);
				return c.json({ data: { ok: true } });
			}
			case 'remove_feed_from_bundle': {
				const { bundleId, feedId } = params;
				if (!bundleId || !feedId) return c.json({ error: 'bundleId and feedId are required' }, 400);
				await removeFeedFromBundle(db, bundleId, feedId);
				return c.json({ data: { ok: true } });
			}

			default:
				return c.json({ error: `Unknown action: "${action}"` }, 400);
		}
	} catch (e: any) {
		console.error(`[API] Error executing action "${action}":`, e);
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
	}
}

// ── Channel backfill (Phase 2 — copy KV → D1 core feeds, run once) ────────────

/**
 * POST /api/migrate-channels
 *
 * One-shot admin-only endpoint. Reads every KV channel and its sources, writes:
 *   1. `channels` row (upsert by numeric id).
 *   2. For each source: `upsertFeedBySource` (INSERT OR IGNORE; existing feed
 *      from another channel or MCP is reused) + `addTelegramSubscription`.
 *   3. For every existing D1 `feeds` row (MCP-registered): `addMcpSubscription`
 *      (idempotent via ON CONFLICT DO NOTHING on feed_id).
 *
 * KV is left untouched — this is copy-on-write so the KV path stays intact as
 * a rollback path until Phase 3 cuts over.
 *
 * Response: { channelsMigrated, feedsCreated, subsCreated, mcpSubsMigrated }
 * Call it again safely — all writes are idempotent.
 */
export async function handleMigrateChannels(c: Context<HonoEnv>): Promise<Response> {
	const authFail = requireApiAuth(c);
	if (authFail) return authFail;

	const db = c.env.DB;
	const kv = c.env.CACHE;

	let channelsMigrated = 0;
	let feedsCreated = 0;
	let subsCreated = 0;
	const errors: string[] = [];

	// 1. Telegram channels from KV → channels + telegram_subscriptions
	const channelIds = await getChannelsList(kv);
	for (const channelId of channelIds) {
		try {
			const config = await getChannelConfig(kv, channelId);
			if (!config) continue;

			await upsertChannel(db, {
				id: channelId,
				name: config.channelTitle,
				enabled: config.enabled,
				checkIntervalMinutes: config.checkIntervalMinutes,
				defaultFormat: config.defaultFormat ?? null,
				lastCheckTimestamp: config.lastCheckTimestamp,
			});
			channelsMigrated++;

			for (const source of config.sources ?? []) {
				try {
					const feed = await upsertFeedBySource(db, {
						sourceType: source.type as SourceType,
						sourceValue: source.value,
						title: '',
						checkIntervalMinutes: config.checkIntervalMinutes,
					});
					// upsertFeedBySource does INSERT OR IGNORE — count new insertions
					if (!feed.last_fetched_at) feedsCreated++;

					await addTelegramSubscription(db, {
						channelId,
						feedId: feed.id,
						mediaFilter: source.mediaFilter,
						format: source.format ?? null,
					});
					subsCreated++;
				} catch (e) {
					errors.push(`channel ${channelId} source ${source.value}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		} catch (e) {
			errors.push(`channel ${channelId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 2. Existing D1 feeds (MCP-registered) → mcp_subscriptions
	let mcpSubsMigrated = 0;
	try {
		const feeds = await getFeeds(db);
		for (const feed of feeds) {
			try {
				await addMcpSubscription(db, feed.id, feed.title || undefined);
				mcpSubsMigrated++;
			} catch (e) {
				errors.push(`mcp feed ${feed.id}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	} catch (e) {
		errors.push(`reading feeds: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 3. Verification counts
	const [channels, tgSubs, mcpSubs] = await Promise.all([
		getChannels(db),
		getTelegramSubscriptions(db),
		getMcpSubscriptions(db),
	]);

	return c.json({
		data: {
			channelsMigrated,
			feedsCreated,
			subsCreated,
			mcpSubsMigrated,
			verification: {
				channelsInD1: channels.length,
				telegramSubsInD1: tgSubs.length,
				mcpSubsInD1: mcpSubs.length,
				kvChannelCount: channelIds.length,
			},
			errors: errors.length ? errors : undefined,
		},
	});
}

export async function handleChatApi(c: Context<HonoEnv>): Promise<Response> {
	const authFail = requireApiAuth(c);
	if (authFail) return authFail;

	let body: { messages: Array<{ role: 'user' | 'assistant'; content: string }> };
	try {
		body = await c.req.json();
	} catch (e) {
		return c.json({ error: 'Invalid JSON request body' }, 400);
	}

	const { messages = [] } = body;
	if (messages.length === 0) {
		return c.json({ error: 'messages array is required and cannot be empty' }, 400);
	}

	try {
		const { runChatAgent } = await import('../services/chat-agent');
		const result = await runChatAgent(messages, c.env);
		return c.json({ data: result });
	} catch (e: any) {
		console.error('[API] Error in chat agent:', e);
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
	}
}
