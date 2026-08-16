import { Bot } from 'grammy';
import {
	recordFeedFetchFailure,
	getFeedConsecutiveFailures,
	disableFeedAfterFailures,
	getFeedAlertContext,
} from '../db/d1';
import type { FeedAlertContext } from '../db/d1';
import { escapeHtml } from '../utils/text';

/**
 * Consecutive-failure counts that produce a degraded-feed alert. Deliberately a
 * fixed list, not a modulo: a permanently dead feed must not alert forever.
 */
const DEGRADED_ALERT_AT = [5, 20, 100];

/** Consecutive failures after which a feed is auto-disabled and alerting stops. */
const DEGRADED_DISABLE_AT = 200;

/**
 * Quiet period between degraded alerts for the same feed. The threshold list
 * alone does not bound alert volume: a flapping mirror recovers, which resets
 * consecutive_failures, so the feed crosses 5 again and again. Auto-disable
 * alerts are exempt — those fire once per feed.
 */
const ALERT_COOLDOWN_SECONDS = 12 * 60 * 60;

const alertCooldownKey = (feedId: string) => `feed:alert:${feedId}`;

/**
 * True when this feed already alerted inside the cooldown window. Claims the
 * window as a side effect, so callers must only ask when about to alert.
 * Storage errors never suppress — a missed alert is worse than a duplicate.
 */
async function isAlertOnCooldown(env: Env, feedId: string): Promise<boolean> {
	try {
		const key = alertCooldownKey(feedId);
		if (await env.CACHE.get(key)) return true;
		await env.CACHE.put(key, String(Math.floor(Date.now() / 1000)), { expirationTtl: ALERT_COOLDOWN_SECONDS });
		return false;
	} catch (err) {
		console.error('[FeedHealth] Cooldown check failed:', err);
		return false;
	}
}

/**
 * Send an admin Telegram DM. Alerting must never fail a fetch, so errors are
 * logged and swallowed.
 */
async function sendAdminAlert(env: Env, html: string): Promise<void> {
	try {
		const adminId = parseInt(env.ADMIN_TELEGRAM_ID, 10);
		if (isNaN(adminId)) return;
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
		await bot.api.sendMessage(adminId, html, { parse_mode: 'HTML' });
	} catch (err) {
		console.error('[FeedHealth] Failed to send admin alert:', err);
	}
}

/** Human-readable age of a unix timestamp, e.g. "3h ago". */
function formatAge(ts: number | null | undefined): string {
	if (!ts) return 'never';
	const secs = Math.floor(Date.now() / 1000) - ts;
	if (secs < 60) return 'just now';
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
	return `${Math.floor(secs / 86400)}d ago`;
}

/** Max subscribing channels listed before the rest are summarised as a count. */
const MAX_LISTED_SUBSCRIBERS = 8;

/**
 * Render the "what broke and who is affected" block shared by both alerts:
 * feed name/id, source type + fetch target, categories, every subscribing
 * Telegram channel, MCP subscription, and how stale the feed now is. Without
 * this the admin only gets an opaque id and has to go dig in the dashboard.
 */
function formatFeedDetails(ctx: FeedAlertContext, feedId: string, fallbackName: string, via?: string): string {
	const { feed, subscribers, mcp, categories } = ctx;
	const name = feed?.title || fallbackName || feedId;

	const lines = [
		`<b>${escapeHtml(name)}</b>`,
		`Feed ID: <code>${feedId}</code>`,
	];

	if (feed) {
		// source_value is a URL for rss_url/rsshub_url but a bare username for
		// instagram_*/tiktok_* — label it generically so neither case reads wrong.
		lines.push(`Source: <code>${escapeHtml(feed.source_type)}</code> → <code>${escapeHtml(feed.source_value)}</code>`);
		lines.push(`Last OK: ${formatAge(feed.last_success_at)} · every ${feed.check_interval_minutes}m${feed.enabled ? '' : ' · <b>disabled</b>'}`);
	}

	if (categories.length > 0) {
		lines.push(`Categories: ${categories.map(c => escapeHtml(c)).join(', ')}`);
	}

	if (subscribers.length > 0) {
		const shown = subscribers.slice(0, MAX_LISTED_SUBSCRIBERS).map(s => {
			const label = s.channel_name ? escapeHtml(s.channel_name) : '(unknown channel)';
			const flags: string[] = [];
			if (s.media_filter && s.media_filter !== 'all') flags.push(s.media_filter);
			if (!s.sub_enabled) flags.push('sub paused');
			if (s.channel_enabled === 0) flags.push('channel off');
			return `  • ${label} (<code>${s.channel_id}</code>)${flags.length ? ` — ${flags.join(', ')}` : ''}`;
		});
		const rest = subscribers.length - shown.length;
		lines.push(`Telegram (${subscribers.length}):\n${shown.join('\n')}${rest > 0 ? `\n  …and ${rest} more` : ''}`);
	} else {
		lines.push('Telegram: none');
	}

	lines.push(mcp ? `MCP: subscribed${mcp.label ? ` as ${escapeHtml(mcp.label)}` : ''}${mcp.enabled ? '' : ' (disabled)'}` : 'MCP: no');

	if (subscribers.length === 0 && !mcp) {
		lines.push('⚠️ No subscribers — consider removing this feed.');
	}

	if (via) lines.push(`Detected by: ${via}`);

	return lines.join('\n');
}

/**
 * Warn the admin that a feed is failing. Fires only at DEGRADED_ALERT_AT counts.
 */
async function sendDegradedFeedAlert(
	env: Env,
	ctx: FeedAlertContext,
	feedName: string,
	feedId: string,
	failures: number,
	lastError: string,
	via?: string,
): Promise<void> {
	await sendAdminAlert(
		env,
		`⚠️ <b>Feed degraded</b>\n\n` +
		`${formatFeedDetails(ctx, feedId, feedName, via)}\n\n` +
		`Failed <b>${failures}×</b> in a row.\n\n` +
		`Last error:\n<code>${escapeHtml(lastError.slice(0, 300))}</code>\n\n` +
		`<i>Muted for ${ALERT_COOLDOWN_SECONDS / 3600}h.</i>`,
	);
}

/**
 * Final notice for a feed that crossed DEGRADED_DISABLE_AT and has been disabled.
 * Nothing further is sent for this feed until it is re-enabled.
 */
async function sendFeedDisabledAlert(
	env: Env,
	ctx: FeedAlertContext,
	feedName: string,
	feedId: string,
	failures: number,
	lastError: string,
	via?: string,
): Promise<void> {
	await sendAdminAlert(
		env,
		`🛑 <b>Feed auto-disabled</b>\n\n` +
		`${formatFeedDetails(ctx, feedId, feedName, via)}\n\n` +
		`Failed <b>${failures}×</b> in a row — no further alerts for this feed.\n\n` +
		`Last error:\n<code>${escapeHtml(lastError.slice(0, 300))}</code>\n\n` +
		`Re-enable it once the source works again.`,
	);
}

/**
 * Record a failed fetch, then alert or auto-disable according to the thresholds.
 * Shared by the queue path (Telegram-subscribed feeds) and the cron refresh path
 * so both agree on when a feed counts as dead.
 */
export async function recordFailureAndAlert(
	env: Env,
	feedId: string,
	feedName: string,
	errMsg: string,
	via?: string,
): Promise<void> {
	await recordFeedFetchFailure(env.DB, feedId, errMsg);
	const failures = await getFeedConsecutiveFailures(env.DB, feedId);

	const disabling = failures >= DEGRADED_DISABLE_AT;
	if (!disabling && !DEGRADED_ALERT_AT.includes(failures)) return;

	if (!disabling && await isAlertOnCooldown(env, feedId)) {
		console.log(`[FeedHealth] ${feedName}: ${failures} failures, alert suppressed (cooldown)`);
		return;
	}

	// Only alerts pay for the context queries. Read before disableFeedAfterFailures
	// so the alert reports the feed as it was when it failed.
	let ctx: FeedAlertContext;
	try {
		ctx = await getFeedAlertContext(env.DB, feedId);
	} catch (err) {
		console.error('[FeedHealth] Failed to load alert context:', err);
		ctx = { feed: null, subscribers: [], mcp: null, categories: [] };
	}

	if (disabling) {
		// Feed is dead, not flaky. Disable it and say so once — then stay quiet.
		await disableFeedAfterFailures(env.DB, feedId);
		await sendFeedDisabledAlert(env, ctx, feedName, feedId, failures, errMsg, via);
	} else {
		await sendDegradedFeedAlert(env, ctx, feedName, feedId, failures, errMsg, via);
	}
}
