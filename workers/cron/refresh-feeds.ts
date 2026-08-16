import { getFeeds, upsertItems, recordFeedFetchSuccess } from '../db/d1';
import { fetchForSource, isPushSource } from '../services/source-fetcher';
import { recordFailureAndAlert } from '../services/feed-health';
import type { ChannelSource } from '../types/telegram';

/**
 * Cron handler: refresh all enabled saved feeds and upsert new items into D1.
 * Called from the scheduled() handler alongside checkAllFeeds().
 *
 * Health is recorded here as well as on the queue path — feeds with no Telegram
 * subscription are never queue-fetched, so this is their only health signal.
 */
export async function refreshSavedFeeds(env: Env): Promise<void> {
	const db = env.DB;
	const feeds = await getFeeds(db);
	// Push feeds (Folo webhook) have no pollable URL — polling them would produce
	// an endless empty result and a bogus "feed degraded" alert.
	const enabled = feeds.filter(f => f.enabled === 1 && !isPushSource(f.source_type));

	await Promise.allSettled(
		enabled.map(async (feed) => {
			const name = feed.title || feed.source_value;
			// Route by source_type: source_value is a bare username for
			// instagram_*/tiktok_* feeds, which is not a fetchable URL.
			const source: ChannelSource = {
				id: feed.id,
				type: feed.source_type as ChannelSource['type'],
				value: feed.source_value,
				mediaFilter: 'all',
				enabled: true,
			};
			try {
				const result = await fetchForSource(source, env);
				if (result.items.length === 0) {
					const errMsg = result.errors.map(e => e.message).join('; ') || 'All instances returned empty results';
					await recordFailureAndAlert(env, feed.id, name, errMsg, 'cron refresh');
					return;
				}
				const inserted = await upsertItems(db, feed.id, result.items);
				await recordFeedFetchSuccess(db, feed.id);
				console.log(`[RefreshFeeds] ${name}: ${inserted} new items`);
			} catch (err) {
				console.error(`[RefreshFeeds] Error refreshing ${name}:`, err);
				await recordFailureAndAlert(env, feed.id, name, err instanceof Error ? err.message : String(err), 'cron refresh');
			}
		})
	);
}
