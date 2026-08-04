import type { FeedMediaFilter, FeedItem } from '../types/feed';
import type { ChannelSource, SourceType, FormatSettings, ChannelConfig } from '../types/telegram';
import { genId, parseJsonSafe } from './base';
import type { DbFeed, DbFeedWithCounts } from './base';

// ── Types for Channels/Subscriptions ──────────────────────────────────────────

export interface DbChannel {
	id: string;                      // numeric Telegram chat id, as text
	name: string;
	enabled: number;
	check_interval_minutes: number;
	default_format: string | null;  // JSON Partial<FormatSettings>
	last_check_timestamp: number;
	created_at: number;
}

export interface DbTelegramSubscription {
	id: string;
	feed_id: string;
	channel_id: string;
	media_filter: string;
	format: string | null;          // JSON Partial<FormatSettings>
	enabled: number;
	created_at: number;
}

export interface DbMcpSubscription {
	id: string;
	feed_id: string;
	label: string | null;
	enabled: number;
	created_at: number;
}

// ── Categories Types ──────────────────────────────────────────────────────────

export interface DbCategory {
	id: string;
	name: string;
	created_at: number;
	feed_count?: number;
}

// ── Feed CRUD ─────────────────────────────────────────────────────────────────

export async function getFeeds(db: D1Database): Promise<DbFeedWithCounts[]> {
	const result = await db.prepare(`
		SELECT f.*, f.source_value AS url,
			COUNT(i.id) as total_count,
			SUM(CASE WHEN i.read = 0 THEN 1 ELSE 0 END) as unread_count,
			(SELECT GROUP_CONCAT(ts.channel_id) FROM telegram_subscriptions ts WHERE ts.feed_id = f.id) as telegram_channel_ids
		FROM feeds f
		LEFT JOIN items i ON i.feed_id = f.id
		GROUP BY f.id
		ORDER BY f.created_at ASC
	`).all<DbFeedWithCounts>();
	return result.results;
}

export async function getFeedById(db: D1Database, feedId: string): Promise<DbFeed | null> {
	return db.prepare('SELECT *, source_value AS url FROM feeds WHERE id = ?').bind(feedId).first<DbFeed>();
}

export async function getFeedBySource(
	db: D1Database,
	sourceType: SourceType,
	sourceValue: string,
): Promise<DbFeed | null> {
	return db.prepare('SELECT *, source_value AS url FROM feeds WHERE source_type = ? AND source_value = ?')
		.bind(sourceType, sourceValue).first<DbFeed>();
}

export async function getFeedByUrl(db: D1Database, url: string): Promise<DbFeed | null> {
	return getFeedBySource(db, 'rss_url', url);
}

export async function upsertFeedBySource(
	db: D1Database,
	opts: { sourceType: SourceType; sourceValue: string; title?: string; checkIntervalMinutes?: number },
): Promise<DbFeed> {
	const existing = await getFeedBySource(db, opts.sourceType, opts.sourceValue);
	if (existing) return existing;
	const id = genId();
	const now = Math.floor(Date.now() / 1000);
	const interval = opts.checkIntervalMinutes ?? 60;
	await db.prepare(
		`INSERT OR IGNORE INTO feeds (id, source_type, source_value, title, enabled, check_interval_minutes, created_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`
	).bind(id, opts.sourceType, opts.sourceValue, opts.title ?? '', interval, now).run();
	const row = await getFeedBySource(db, opts.sourceType, opts.sourceValue);
	return row ?? {
		id, source_type: opts.sourceType, source_value: opts.sourceValue, title: opts.title ?? '',
		enabled: 1, check_interval_minutes: interval, last_fetched_at: null, created_at: now,
		ai_summary: 'inherit', url: opts.sourceValue,
		last_error: null, last_success_at: null, consecutive_failures: 0,
	};
}

export async function insertFeed(db: D1Database, url: string, title: string): Promise<DbFeed> {
	return upsertFeedBySource(db, { sourceType: 'rss_url', sourceValue: url, title });
}

export async function removeFeed(db: D1Database, feedId: string): Promise<void> {
	await db.prepare('DELETE FROM feeds WHERE id = ?').bind(feedId).run();
}

export async function setFeedEnabled(db: D1Database, feedId: string, enabled: boolean): Promise<void> {
	await db.prepare('UPDATE feeds SET enabled = ? WHERE id = ?')
		.bind(enabled ? 1 : 0, feedId).run();
}

export async function updateLastFetched(db: D1Database, feedId: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.prepare('UPDATE feeds SET last_fetched_at = ? WHERE id = ?').bind(now, feedId).run();
}

export async function recordFeedFetchSuccess(db: D1Database, feedId: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.prepare(
		'UPDATE feeds SET last_fetched_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?',
	).bind(now, now, feedId).run();
}

export async function recordFeedFetchFailure(db: D1Database, feedId: string, error: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.prepare(
		'UPDATE feeds SET last_fetched_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?',
	).bind(now, error.slice(0, 500), feedId).run();
}

/**
 * Auto-disable a feed that has failed past the alerting ceiling. The failure
 * counter is reset so a manual re-enable gets a fresh budget instead of tripping
 * the ceiling again on its first failure; last_error is kept for diagnosis.
 */
export async function disableFeedAfterFailures(db: D1Database, feedId: string): Promise<void> {
	await db.prepare('UPDATE feeds SET enabled = 0, consecutive_failures = 0 WHERE id = ?')
		.bind(feedId).run();
}

export async function getFeedConsecutiveFailures(db: D1Database, feedId: string): Promise<number> {
	const row = await db.prepare('SELECT consecutive_failures FROM feeds WHERE id = ?')
		.bind(feedId).first<{ consecutive_failures: number }>();
	return row?.consecutive_failures ?? 0;
}

// ── Channels CRUD ─────────────────────────────────────────────────────────────

export async function getChannels(db: D1Database): Promise<DbChannel[]> {
	const result = await db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all<DbChannel>();
	return result.results;
}

export async function getChannelById(db: D1Database, id: string): Promise<DbChannel | null> {
	return db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<DbChannel>();
}

export async function upsertChannel(
	db: D1Database,
	opts: {
		id: string;
		name?: string;
		enabled?: boolean;
		checkIntervalMinutes?: number;
		defaultFormat?: Partial<FormatSettings> | null;
		lastCheckTimestamp?: number;
	},
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const format = opts.defaultFormat === undefined || opts.defaultFormat === null
		? null
		: JSON.stringify(opts.defaultFormat);
	await db.prepare(
		`INSERT INTO channels (id, name, enabled, check_interval_minutes, default_format, last_check_timestamp, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			enabled = excluded.enabled,
			check_interval_minutes = excluded.check_interval_minutes,
			default_format = excluded.default_format,
			last_check_timestamp = excluded.last_check_timestamp`,
	).bind(
		opts.id,
		opts.name ?? '',
		opts.enabled === false ? 0 : 1,
		opts.checkIntervalMinutes ?? 60,
		format,
		opts.lastCheckTimestamp ?? 0,
		now,
	).run();
}

export async function removeChannel(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
}

export async function setChannelEnabled(db: D1Database, id: string, enabled: boolean): Promise<void> {
	await db.prepare('UPDATE channels SET enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id).run();
}

export async function updateChannelLastCheck(db: D1Database, id: string, timestamp: number): Promise<void> {
	await db.prepare('UPDATE channels SET last_check_timestamp = ? WHERE id = ?').bind(timestamp, id).run();
}

// ── Telegram subscriptions ────────────────────────────────────────────────────

export async function getTelegramSubscriptions(db: D1Database, channelId?: string): Promise<DbTelegramSubscription[]> {
	if (channelId) {
		const result = await db.prepare('SELECT * FROM telegram_subscriptions WHERE channel_id = ? ORDER BY created_at ASC')
			.bind(channelId).all<DbTelegramSubscription>();
		return result.results;
	}
	const result = await db.prepare('SELECT * FROM telegram_subscriptions ORDER BY created_at ASC')
		.all<DbTelegramSubscription>();
	return result.results;
}

export async function getTelegramSubscriptionsByFeed(db: D1Database, feedId: string): Promise<DbTelegramSubscription[]> {
	const result = await db.prepare('SELECT * FROM telegram_subscriptions WHERE feed_id = ? AND enabled = 1')
		.bind(feedId).all<DbTelegramSubscription>();
	return result.results;
}

export async function addTelegramSubscription(
	db: D1Database,
	opts: { channelId: string; feedId: string; mediaFilter?: FeedMediaFilter; format?: Partial<FormatSettings> | null },
): Promise<void> {
	const id = genId();
	const now = Math.floor(Date.now() / 1000);
	const format = opts.format === undefined || opts.format === null ? null : JSON.stringify(opts.format);
	await db.prepare(
		`INSERT INTO telegram_subscriptions (id, feed_id, channel_id, media_filter, format, enabled, created_at)
		 VALUES (?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(channel_id, feed_id) DO UPDATE SET
			media_filter = excluded.media_filter,
			format = excluded.format`,
	).bind(id, opts.feedId, opts.channelId, opts.mediaFilter ?? 'all', format, now).run();
}

export async function removeTelegramSubscription(db: D1Database, channelId: string, feedId: string): Promise<void> {
	await db.prepare('DELETE FROM telegram_subscriptions WHERE channel_id = ? AND feed_id = ?')
		.bind(channelId, feedId).run();
}

export async function setTelegramSubscriptionEnabled(
	db: D1Database,
	channelId: string,
	feedId: string,
	enabled: boolean,
): Promise<void> {
	await db.prepare('UPDATE telegram_subscriptions SET enabled = ? WHERE channel_id = ? AND feed_id = ?')
		.bind(enabled ? 1 : 0, channelId, feedId).run();
}

// ── MCP subscriptions ─────────────────────────────────────────────────────────

export async function getMcpSubscriptions(db: D1Database): Promise<DbMcpSubscription[]> {
	const result = await db.prepare('SELECT * FROM mcp_subscriptions WHERE enabled = 1 ORDER BY created_at ASC')
		.all<DbMcpSubscription>();
	return result.results;
}

export async function getMcpSubscribedFeedIds(db: D1Database): Promise<string[]> {
	const result = await db.prepare('SELECT feed_id FROM mcp_subscriptions WHERE enabled = 1')
		.all<{ feed_id: string }>();
	return result.results.map(r => r.feed_id);
}

export async function addMcpSubscription(db: D1Database, feedId: string, label?: string): Promise<void> {
	const id = genId();
	const now = Math.floor(Date.now() / 1000);
	await db.prepare(
		`INSERT INTO mcp_subscriptions (id, feed_id, label, enabled, created_at)
		 VALUES (?, ?, ?, 1, ?)
		 ON CONFLICT(feed_id) DO UPDATE SET label = excluded.label, enabled = 1`,
	).bind(id, feedId, label ?? null, now).run();
}

export async function removeMcpSubscription(db: D1Database, feedId: string): Promise<void> {
	await db.prepare('DELETE FROM mcp_subscriptions WHERE feed_id = ?').bind(feedId).run();
}

// ── D1 ChannelConfig facade ───────────────────────────────────────────────────

export async function getChannelConfigFromD1(db: D1Database, channelId: string): Promise<ChannelConfig | null> {
	const channel = await getChannelById(db, channelId);
	if (!channel) return null;

	const subs = await getTelegramSubscriptions(db, channelId);
	const sources: ChannelSource[] = [];
	for (const sub of subs) {
		const feed = await getFeedById(db, sub.feed_id);
		if (feed) sources.push(dbTelegramSubToChannelSource(sub, feed));
	}

	return {
		channelTitle: channel.name,
		enabled: channel.enabled === 1,
		checkIntervalMinutes: channel.check_interval_minutes,
		lastCheckTimestamp: channel.last_check_timestamp,
		sources,
		defaultFormat: channel.default_format
			? parseJsonSafe<Partial<FormatSettings>>(channel.default_format, {})
			: undefined,
	};
}

export async function saveChannelConfigToD1(
	db: D1Database,
	channelId: string,
	config: ChannelConfig,
): Promise<void> {
	await upsertChannel(db, {
		id: channelId,
		name: config.channelTitle,
		enabled: config.enabled,
		checkIntervalMinutes: config.checkIntervalMinutes,
		defaultFormat: config.defaultFormat ?? null,
		lastCheckTimestamp: config.lastCheckTimestamp,
	});

	const existingSubs = await getTelegramSubscriptions(db, channelId);
	const newFeedIds = new Set<string>();

	for (const source of config.sources) {
		const feed = await upsertFeedBySource(db, {
			sourceType: source.type as SourceType,
			sourceValue: source.value,
		});
		newFeedIds.add(feed.id);
		await addTelegramSubscription(db, {
			channelId,
			feedId: feed.id,
			mediaFilter: source.mediaFilter,
			format: source.format ?? null,
		});
		if (!source.enabled) {
			await setTelegramSubscriptionEnabled(db, channelId, feed.id, false);
		} else {
			await setTelegramSubscriptionEnabled(db, channelId, feed.id, true);
		}
	}

	for (const sub of existingSubs) {
		if (!newFeedIds.has(sub.feed_id)) {
			await removeTelegramSubscription(db, channelId, sub.feed_id);
		}
	}
}

export async function getChannelsListD1(db: D1Database): Promise<string[]> {
	const channels = await getChannels(db);
	return channels.map(c => c.id);
}

export async function findChannelByNameD1(db: D1Database, name: string): Promise<string | null> {
	const clean = name.replace(/^@/, '').toLowerCase();
	const channels = await getChannels(db);
	const found = channels.find(
		c => c.name.toLowerCase() === clean || c.name.toLowerCase() === `@${clean}`,
	);
	return found?.id ?? null;
}

export function dbTelegramSubToChannelSource(
	sub: DbTelegramSubscription,
	feed: Pick<DbFeed, 'source_type' | 'source_value'>,
): ChannelSource {
	return {
		id: sub.feed_id,
		type: feed.source_type as SourceType,
		value: feed.source_value,
		mediaFilter: sub.media_filter as FeedMediaFilter,
		enabled: sub.enabled === 1,
		format: sub.format ? parseJsonSafe<Partial<FormatSettings>>(sub.format, {}) : undefined,
	};
}

// ── Categories CRUD ───────────────────────────────────────────────────────────

export async function listCategories(db: D1Database): Promise<DbCategory[]> {
	const result = await db.prepare(`
		SELECT c.*, COUNT(fcm.feed_id) as feed_count
		FROM feed_categories c
		LEFT JOIN feed_category_members fcm ON fcm.category_id = c.id
		GROUP BY c.id
		ORDER BY c.name ASC
	`).all<DbCategory>();
	return result.results;
}

export async function getFeedsInCategory(db: D1Database, categoryId: string): Promise<DbFeedWithCounts[]> {
	const result = await db.prepare(`
		SELECT f.*, f.source_value AS url,
			COUNT(i.id) as total_count,
			SUM(CASE WHEN i.read = 0 THEN 1 ELSE 0 END) as unread_count,
			(SELECT GROUP_CONCAT(ts.channel_id) FROM telegram_subscriptions ts WHERE ts.feed_id = f.id) as telegram_channel_ids
		FROM feeds f
		JOIN feed_category_members fcm ON fcm.feed_id = f.id
		LEFT JOIN items i ON i.feed_id = f.id
		WHERE fcm.category_id = ?
		GROUP BY f.id
		ORDER BY f.created_at ASC
	`).bind(categoryId).all<DbFeedWithCounts>();
	return result.results;
}

export async function addFeedToCategory(db: D1Database, categoryId: string, feedId: string): Promise<void> {
	await db.prepare('INSERT OR IGNORE INTO feed_category_members (category_id, feed_id) VALUES (?, ?)')
		.bind(categoryId, feedId).run();
}

export async function removeFeedFromCategory(db: D1Database, categoryId: string, feedId: string): Promise<void> {
	await db.prepare('DELETE FROM feed_category_members WHERE category_id = ? AND feed_id = ?')
		.bind(categoryId, feedId).run();
}

export async function createCategory(db: D1Database, name: string): Promise<DbCategory> {
	const id = genId();
	const now = Math.floor(Date.now() / 1000);
	await db.prepare('INSERT INTO feed_categories (id, name, created_at) VALUES (?, ?, ?)')
		.bind(id, name, now).run();
	return { id, name, created_at: now };
}

export async function deleteCategory(db: D1Database, categoryId: string): Promise<void> {
	await db.prepare('DELETE FROM feed_categories WHERE id = ?').bind(categoryId).run();
}

// ── RSS Bundles ───────────────────────────────────────────────────────────────

export interface DbRssBundle {
	id: string;
	slug: string;
	title: string;
	description: string;
	enabled: number;
	created_at: number;
}

export async function listRssBundles(db: D1Database): Promise<DbRssBundle[]> {
	const result = await db.prepare('SELECT * FROM rss_bundles ORDER BY created_at ASC').all<DbRssBundle>();
	return result.results;
}

export async function getRssBundleBySlug(db: D1Database, slug: string): Promise<DbRssBundle | null> {
	return db.prepare('SELECT * FROM rss_bundles WHERE slug = ? AND enabled = 1').bind(slug).first<DbRssBundle>();
}

export async function getRssBundleFeedIds(db: D1Database, bundleId: string): Promise<string[]> {
	const result = await db.prepare('SELECT feed_id FROM rss_bundle_feeds WHERE bundle_id = ?')
		.bind(bundleId).all<{ feed_id: string }>();
	return result.results.map(r => r.feed_id);
}

export async function createRssBundle(
	db: D1Database,
	opts: { slug: string; title: string; description?: string },
): Promise<DbRssBundle> {
	const id = genId();
	const now = Math.floor(Date.now() / 1000);
	await db.prepare(
		'INSERT INTO rss_bundles (id, slug, title, description, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
	).bind(id, opts.slug, opts.title, opts.description ?? '', now).run();
	return { id, slug: opts.slug, title: opts.title, description: opts.description ?? '', enabled: 1, created_at: now };
}

export async function updateRssBundle(
	db: D1Database,
	id: string,
	opts: { title?: string; description?: string; enabled?: boolean },
): Promise<void> {
	const updates: string[] = [];
	const params: unknown[] = [];
	if (opts.title !== undefined) { updates.push('title = ?'); params.push(opts.title); }
	if (opts.description !== undefined) { updates.push('description = ?'); params.push(opts.description); }
	if (opts.enabled !== undefined) { updates.push('enabled = ?'); params.push(opts.enabled ? 1 : 0); }
	if (updates.length === 0) return;
	params.push(id);
	await db.prepare(`UPDATE rss_bundles SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
}

export async function deleteRssBundle(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM rss_bundles WHERE id = ?').bind(id).run();
}

export async function addFeedToBundle(db: D1Database, bundleId: string, feedId: string): Promise<void> {
	await db.prepare('INSERT OR IGNORE INTO rss_bundle_feeds (bundle_id, feed_id) VALUES (?, ?)')
		.bind(bundleId, feedId).run();
}

export async function removeFeedFromBundle(db: D1Database, bundleId: string, feedId: string): Promise<void> {
	await db.prepare('DELETE FROM rss_bundle_feeds WHERE bundle_id = ? AND feed_id = ?')
		.bind(bundleId, feedId).run();
}

export async function getFoloFeeds(db: D1Database): Promise<DbFeed[]> {
	const result = await db.prepare(`
		SELECT f.*, f.source_value AS url
		FROM feeds f
		JOIN feed_category_members fcm ON f.id = fcm.feed_id
		JOIN feed_categories c ON fcm.category_id = c.id
		WHERE c.name = 'Folo' OR c.name LIKE 'Folo:%'
		GROUP BY f.id
		ORDER BY f.title ASC
	`).all<DbFeed>();
	return result.results;
}
