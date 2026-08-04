import { Bot } from 'grammy';
import {
	recordFeedFetchFailure,
	getFeedConsecutiveFailures,
	disableFeedAfterFailures,
} from '../db/d1';

/**
 * Consecutive-failure counts that produce a degraded-feed alert. Deliberately a
 * fixed list, not a modulo: a permanently dead feed must not alert forever.
 */
const DEGRADED_ALERT_AT = [5, 20, 100];

/** Consecutive failures after which a feed is auto-disabled and alerting stops. */
const DEGRADED_DISABLE_AT = 200;

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

/**
 * Warn the admin that a feed is failing. Fires only at DEGRADED_ALERT_AT counts.
 */
async function sendDegradedFeedAlert(
	env: Env,
	feedName: string,
	feedId: string,
	failures: number,
	lastError: string,
): Promise<void> {
	await sendAdminAlert(
		env,
		`⚠️ <b>Feed degraded</b>\n\n` +
		`<b>${feedName}</b> (<code>${feedId}</code>)\n` +
		`Failed <b>${failures}×</b> in a row.\n\n` +
		`Last error:\n<code>${lastError.slice(0, 300)}</code>`,
	);
}

/**
 * Final notice for a feed that crossed DEGRADED_DISABLE_AT and has been disabled.
 * Nothing further is sent for this feed until it is re-enabled.
 */
async function sendFeedDisabledAlert(
	env: Env,
	feedName: string,
	feedId: string,
	failures: number,
	lastError: string,
): Promise<void> {
	await sendAdminAlert(
		env,
		`🛑 <b>Feed auto-disabled</b>\n\n` +
		`<b>${feedName}</b> (<code>${feedId}</code>)\n` +
		`Failed <b>${failures}×</b> in a row — no further alerts for this feed.\n\n` +
		`Last error:\n<code>${lastError.slice(0, 300)}</code>\n\n` +
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
): Promise<void> {
	await recordFeedFetchFailure(env.DB, feedId, errMsg);
	const failures = await getFeedConsecutiveFailures(env.DB, feedId);
	if (failures >= DEGRADED_DISABLE_AT) {
		// Feed is dead, not flaky. Disable it and say so once — then stay quiet.
		await disableFeedAfterFailures(env.DB, feedId);
		await sendFeedDisabledAlert(env, feedName, feedId, failures, errMsg);
	} else if (DEGRADED_ALERT_AT.includes(failures)) {
		await sendDegradedFeedAlert(env, feedName, feedId, failures, errMsg);
	}
}
