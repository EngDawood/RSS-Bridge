import type { Context } from 'hono';
import { Bot } from 'grammy';
import type { FeedItem, FeedItemMedia, FeedItemMediaType } from '../types/feed';
import type { FormatSettings } from '../types/telegram';
import { formatFeedItem, resolveFormatSettings } from '../utils/telegram-format';
import { sendMediaToChannel } from '../services/telegram-bot/handlers/send-media';
import { getAdminConfig } from '../services/telegram-bot/storage/kv-operations';
import { enrichFeedItems } from '../utils/media-enrichment';
import {
	getFoloChannelIds, getChannelConfigFromD1, upsertFeedBySource, upsertItems,
	addMcpSubscription, listCategories, createCategory, addFeedToCategory,
	getFoloWebhook, getFoloWebhookChannels, getTelegramSubscriptionsByFeed,
} from '../db/d1';

type HonoEnv = { Bindings: Env };

interface FoloMedia {
	url: string;
	type: 'photo' | 'video';
	preview_image_url?: string;
	width?: number;
	height?: number;
	blurhash?: string;
}

interface FoloWebhookPayload {
	entry: {
		id: string;
		guid: string;
		feedId: string;
		title: string | null;
		description: string | null;
		content: string | null;
		author: string | null;
		url: string | null;
		publishedAt: string;
		insertedAt: string;
		media: FoloMedia[] | null;
	};
	feed: {
		url: string;
		siteUrl: string;
		title: string | null;
		description: string | null;
		image: string | null;
		id?: string;
		language?: string | null;
	};
	view: number;
}

function deriveMediaType(media: FoloMedia[] | null): FeedItemMediaType {
	if (!media || media.length === 0) return 'none';
	if (media.length > 1) return 'album';
	return media[0].type === 'video' ? 'video' : 'photo';
}

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.trim();
}

function payloadToFeedItem(payload: FoloWebhookPayload): FeedItem {
	const { entry, feed } = payload;
	const mediaItems: FeedItemMedia[] = (entry.media || []).map((m) => ({
		type: m.type,
		url: m.url,
		thumbnailUrl: m.preview_image_url,
	}));

	const rawText = entry.content || entry.description || '';
	const text = rawText.includes('<') ? stripHtml(rawText) : rawText;

	return {
		id: entry.guid || entry.id,
		link: entry.url || '',
		title: entry.title || '',
		text,
		contentHtml: entry.content || undefined,
		author: entry.author || '',
		feedTitle: feed.title || '',
		feedLink: feed.siteUrl || feed.url,
		timestamp: new Date(entry.publishedAt).getTime() / 1000,
		mediaType: deriveMediaType(entry.media),
		media: mediaItems,
	};
}

export async function handleFoloWebhook(c: Context<HonoEnv>): Promise<Response> {
	const env = c.env;

	// Resolve webhook identity: named (?id=) takes priority, otherwise legacy (env secret)
	const webhookId = c.req.query('id') ?? null;
	let categoryName = 'Folo';
	let channelIds: string[];

	if (webhookId) {
		// Named webhook: look up in DB, validate its token
		const webhook = await getFoloWebhook(env.DB, webhookId);
		if (!webhook) {
			return c.json({ error: 'Webhook not found' }, 404);
		}
		if (webhook.token) {
			const token = c.req.query('token');
			if (token !== webhook.token) {
				return c.json({ error: 'Unauthorized' }, 401);
			}
		}
		categoryName = `Folo: ${webhook.name}`;
		channelIds = await getFoloWebhookChannels(env.DB, webhookId);
	} else {
		// Legacy: validate against FOLO_WEBHOOK_SECRET env var
		const secret = env.FOLO_WEBHOOK_SECRET;
		if (secret) {
			const token = c.req.query('token');
			if (token !== secret) {
				return c.json({ error: 'Unauthorized' }, 401);
			}
		}
		channelIds = await getFoloChannelIds(env.DB);
	}

	// Parse body
	let payload: FoloWebhookPayload;
	try {
		payload = await c.req.json<FoloWebhookPayload>();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!payload?.entry || !payload?.feed) {
		return c.json({ error: 'Invalid payload: missing entry or feed' }, 400);
	}

	// Dedup: scope key to webhookId to avoid cross-webhook suppression
	const dedupeKey = payload.entry.guid || payload.entry.id || `${payload.entry.feedId}:${payload.entry.publishedAt}`;
	const cacheKey = `folo:sent:${webhookId ?? 'legacy'}:${dedupeKey}`;
	try {
		const isSent = await env.CACHE.get(cacheKey);
		if (isSent) {
			console.log(`[folo] Duplicate payload for key: ${dedupeKey}. Skipping.`);
			return c.json({ ok: true, sent: 0, note: 'Duplicate payload skipped' });
		}
		await env.CACHE.put(cacheKey, '1', { expirationTtl: 86400 });
	} catch (err) {
		console.warn('[folo] KV dedup error:', err);
	}

	const feedItem = payloadToFeedItem(payload);

	let dbFeedId: string | null = null;
	// Persist feed + item to D1 under the appropriate category
	try {
		const feedSourceUrl = payload.feed.siteUrl || payload.feed.url;
		const feedTitle = payload.feed.title || feedSourceUrl;
		// 'folo_push', not 'rss_url': feedSourceUrl is usually a site homepage rather
		// than a feed document, and Folo already delivers these entries by webhook.
		// Tagging it as push keeps the cron poller — and its degraded-feed alerts —
		// away from a feed that can never be polled.
		const dbFeed = await upsertFeedBySource(env.DB, {
			sourceType: 'folo_push',
			sourceValue: feedSourceUrl,
			title: feedTitle,
		});
		dbFeedId = dbFeed.id;
		await upsertItems(env.DB, dbFeed.id, [feedItem]);
		await addMcpSubscription(env.DB, dbFeed.id, feedTitle);

		// Group under the resolved category ("Folo" or "Folo: <name>")
		const categories = await listCategories(env.DB);
		let category = categories.find(cat => cat.name === categoryName);
		if (!category) category = await createCategory(env.DB, categoryName);
		await addFeedToCategory(env.DB, category.id, dbFeed.id);
	} catch (err) {
		console.warn('[folo] Failed to persist item to D1:', err);
	}

	// Also get channels subscribed specifically to this feed
	if (dbFeedId) {
		try {
			const feedSubs = await getTelegramSubscriptionsByFeed(env.DB, dbFeedId);
			for (const sub of feedSubs) {
				if (sub.enabled && !channelIds.includes(sub.channel_id)) {
					channelIds.push(sub.channel_id);
				}
			}
		} catch (err) {
			console.warn('[folo] Failed to get feed-specific subscriptions:', err);
		}
	}

	if (channelIds.length === 0) {
		return c.json({ ok: true, sent: 0, note: 'No channels subscribed' });
	}

	// Enrich (Telegraph / media)
	try {
		const adminConfig = await getAdminConfig(env.CACHE);
		await enrichFeedItems([feedItem], {
			token: adminConfig.telegraph.token || env.TELEGRAPH_ACCESS_TOKEN,
			enabled: adminConfig.telegraph.enabled,
			threshold: adminConfig.telegraph.threshold,
		});
	} catch (err) {
		console.warn('[folo] Enrichment failed:', err);
	}

	const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
	let sent = 0;

	for (const channelId of channelIds) {
		try {
			let formatSettings: FormatSettings | undefined;
			const config = await getChannelConfigFromD1(env.DB, channelId);
			if (config) {
				formatSettings = resolveFormatSettings(config.defaultFormat);
			}
			const message = formatFeedItem(feedItem, formatSettings);
			await sendMediaToChannel(bot, parseInt(channelId, 10), message, formatSettings);
			sent++;
		} catch (err: any) {
			console.error(`[folo] Failed to send to channel ${channelId}:`, err.message);
		}
	}

	return c.json({ ok: true, sent, total: channelIds.length });
}
