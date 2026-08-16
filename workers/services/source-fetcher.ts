import type { FeedItem, FetchResult } from '../types/feed';
import type { ChannelSource } from '../types/telegram';
import { fetchFeed } from './feed-fetcher';
import { getConfig } from '../db/d1';
import { RSS_ITEMS_LIMIT, FEED_CACHE_TTL } from '../constants';

// --- RSS-Bridge Public Instances (failover list) ---
export const RSS_BRIDGE_INSTANCES = [
	'https://rssbridge.prenghy.org',
	'https://rss-bridge.sans-nuage.fr',
	'https://rss.bloat.cat',
];

// RSS-Bridge instances known to have TikTokBridge enabled
export const RSS_BRIDGE_TIKTOK_INSTANCES = [
	'https://rss-bridge.org/bridge01',
	...RSS_BRIDGE_INSTANCES
];

// RSSHub public instances for Instagram Stories fallback
export const RSSHUB_INSTANCES = [
	'https://rsshub.rssforever.com',
	'https://hub.slarker.me',
	'https://rsshub.pseudoyu.com',
	'https://rsshub.ktachibana.party',
	'https://rss.owo.nz',
	'https://rsshub.umzzz.com',
	'https://rsshub.isrss.com',
	'https://rsshub-balancer.virworks.moe',
	'https://rss.spriple.org',
	'https://rsshub.cups.moe',
	'https://rss.4040940.xyz'
];

/**
 * Load instance list from D1 config (keys: instances_rssbridge / instances_tiktok / instances_rsshub).
 * Falls back to the hardcoded constants so the InstancesTab changes are actually honoured by the fetcher.
 */
async function getConfiguredInstances(env: Env | undefined, type: 'rssbridge' | 'tiktok' | 'rsshub' | 'instagram'): Promise<string[]> {
	const defaults =
		type === 'rsshub' ? RSSHUB_INSTANCES :
		type === 'tiktok' ? RSS_BRIDGE_TIKTOK_INSTANCES :
		type === 'instagram' ? [...RSS_BRIDGE_INSTANCES, ...RSSHUB_INSTANCES] :
		RSS_BRIDGE_INSTANCES;
	if (!env?.DB) return defaults;
	try {
		const saved = await getConfig(env.DB, `instances_${type}`);
		if (saved) return JSON.parse(saved) as string[];
	} catch { /* non-fatal — fall through to defaults */ }
	return defaults;
}

/**
 * Source types whose items arrive by push (webhook) instead of polling. They have
 * no fetchable URL, so every poll path must skip them — otherwise the health
 * tracker reads the empty result as a failure and marks the feed degraded.
 */
const PUSH_SOURCE_TYPES: readonly string[] = ['folo_push'];

export function isPushSource(sourceType: string): boolean {
	return PUSH_SOURCE_TYPES.includes(sourceType);
}

/**
 * Route to correct fetcher based on source type.
 */
export async function fetchForSource(source: ChannelSource, env?: Env): Promise<FetchResult> {
	const type = source.type as string;

	if (isPushSource(type)) {
		// Nothing to poll — empty, but deliberately with no errors so a caller that
		// reaches here anyway does not record a failure.
		return { items: [], feedTitle: '', feedLink: '', errors: [] };
	}

	switch (type) {
		case 'instagram_user':
		case 'username': // legacy
			return await fetchInstagramUser(source.value, env);
		case 'instagram_tag':
		case 'hashtag': // legacy
			return await fetchInstagramTag(source.value, env);
		case 'instagram_story':
			return await fetchInstagramStory(source.value, env);
		case 'rss_url':
			return await fetchRssUrl(source.value, env);
		case 'rsshub_url':
			return await fetchRSSHubUrl(source.value, env);
		case 'tiktok_user':
			return await fetchTikTokUser(source.value, env);
		default:
			return {
				items: [],
				feedTitle: '',
				feedLink: '',
				errors: [{ tier: 'config', message: `Unknown source type: ${source.type}` }],
			};
	}
}

/**
 * Instance families a stored full URL can be failed over across. Feeds saved as
 * 'rss_url' usually have one public mirror's origin baked into source_value; a
 * 502 from that single mirror does not mean the feed is broken, so try its
 * siblings before reporting a failure to the health tracker.
 */
const FAILOVER_FAMILIES = ['rssbridge', 'rsshub'] as const;

/**
 * Sibling instances tried after the stored one fails. Capped so a family-wide
 * outage cannot spend the whole cron budget walking a dead mirror list.
 */
const MAX_FAILOVER_ATTEMPTS = 5;

/**
 * Fetch an RSS URL, with instance failover for known RSS-Bridge / RSSHub mirrors.
 * If the URL points at a mirror in either list and fails, retry the same path on
 * the other mirrors in that list.
 */
async function fetchRssUrl(url: string, env?: Env): Promise<FetchResult> {
	// Try the original URL first
	const result = await fetchFeed(url, undefined, env?.CACHE, FEED_CACHE_TTL);
	if (result.items.length > 0) return result;

	// Check whether this URL belongs to a mirror family that can failover
	try {
		const origin = new URL(url).origin;

		for (const family of FAILOVER_FAMILIES) {
			const instances = await getConfiguredInstances(env, family);
			// Instances are usually bare origins, but some carry a path prefix
			// (e.g. rss-bridge.org/bridge01) — startsWith covers both.
			const matchedInstance = instances.find((inst) => origin === inst || url.startsWith(inst));
			if (!matchedInstance) continue;

			const path = url.substring(matchedInstance.length); // "/anthropic/news" or "/?action=display&bridge=..."
			const siblings = instances.filter((inst) => inst !== matchedInstance);
			const tried = siblings.slice(0, MAX_FAILOVER_ATTEMPTS);
			console.log(`[${family}] ${matchedInstance} failed, trying ${tried.length} of ${siblings.length} sibling instances...`);

			for (const instance of tried) {
				const altResult = await fetchFeed(instance + path, undefined, env?.CACHE, FEED_CACHE_TTL);
				if (altResult.items.length > 0) {
					console.log(`[${family}] Failover success with ${instance}`);
					return altResult;
				}
			}

			if (siblings.length > tried.length) {
				console.warn(`[${family}] Gave up after ${tried.length} siblings; ${siblings.length - tried.length} not tried`);
			}
			// The origin belongs to this family — no point testing the other one.
			break;
		}
	} catch {
		// URL parsing failed, just return original result
	}

	return result;
}

/**
 * Fetch a RSSHub path via all known RSSHub instances, with failover.
 * The value stored is the path+query (e.g. "/anthropic/news"), not a full URL.
 */
async function fetchRSSHubUrl(path: string, env?: Env): Promise<FetchResult> {
	const instances = await getConfiguredInstances(env, 'rsshub');
	return fetchFromRSSBridgeInstances(
		(instance) => `${instance}${path}`,
		`rsshub:${path}`,
		instances,
		env
	);
}

/**
 * Build the RSS-Bridge URL for a TikTok username.
 */
function buildTikTokUserUrl(instance: string, username: string): string {
	return `${instance}/?action=display&bridge=TikTokBridge&context=By+user&username=${encodeURIComponent(username)}&format=Atom`;
}

/**
 * Fetch TikTok user feed via RSS-Bridge instances, with failover.
 */
export async function fetchTikTokUser(username: string, env?: Env): Promise<FetchResult> {
	const instances = await getConfiguredInstances(env, 'tiktok');
	return fetchFromRSSBridgeInstances(
		(instance) => buildTikTokUserUrl(instance, username),
		`tiktok @${username}`,
		instances,
		env
	);
}

/**
 * Build the RSSHub URL for an Instagram Story feed.
 */
export function buildRSSHubStoryUrl(instance: string, username: string): string {
	return `${instance}/picnob.info/user/${encodeURIComponent(username)}/stories?limit=10`;
}

/**
 * Build the RSSHub URL for an Instagram Post feed.
 */
export function buildRSSHubPostUrl(instance: string, username: string): string {
	return `${instance}/picnob.info/user/${encodeURIComponent(username)}/posts?limit=10`;
}

/**
 * Fetch Instagram Story feed via RSSHub instances, with failover.
 */
export async function fetchInstagramStory(username: string, env?: Env): Promise<FetchResult> {
	const instances = await getConfiguredInstances(env, 'rsshub');
	return fetchFromRSSBridgeInstances(
		(instance) => buildRSSHubStoryUrl(instance, username),
		`${username} (Stories)`,
		instances,
		env
	);
}

/**
 * Build the RSS-Bridge URL for an Instagram username.
 */
function buildRSSBridgeUserUrl(instance: string, username: string): string {
	return `${instance}/?action=display&bridge=InstagramBridge&format=Atom&direct_links=on&context=Username&u=${encodeURIComponent(username)}&media_type=all`;
}

/**
 * Build the RSS-Bridge URL for an Instagram username via ImgsedBridge.
 */
function buildImgsedUserUrl(instance: string, username: string): string {
	return `${instance}/?action=display&bridge=ImgsedBridge&context=Username&u=${encodeURIComponent(username)}&post=on&format=Atom`;
}

/**
 * Build the RSS-Bridge URL for an Instagram hashtag.
 */
function buildRSSBridgeTagUrl(instance: string, hashtag: string): string {
	return `${instance}/?action=display&bridge=InstagramBridge&format=Atom&direct_links=on&context=Hashtag&h=${encodeURIComponent(hashtag)}&media_type=all`;
}

/**
 * Fetch Instagram user feed via the dedicated instagram instance list (RSS-Bridge + RSSHub combined).
 * Per-instance URL format is chosen based on whether the instance is a known RSSHub host.
 */
export async function fetchInstagramUser(username: string, env?: Env): Promise<FetchResult> {
	const instances = await getConfiguredInstances(env, 'instagram');
	const result = await fetchFromRSSBridgeInstances(
		(instance) => RSSHUB_INSTANCES.includes(instance)
			? buildRSSHubPostUrl(instance, username)
			: buildRSSBridgeUserUrl(instance, username),
		username,
		instances,
		env
	);

	if (result.items.length > 0) {
		return result;
	}

	// Fallback: Try RSS-Bridge instances using ImgsedBridge
	console.log(`[Instagram] Primary methods failed for ${username}, trying ImgsedBridge fallback...`);
	const rssBridgeOnlyInstances = instances.filter(i => !RSSHUB_INSTANCES.includes(i));
	
	const fallbackResult = await fetchFromRSSBridgeInstances(
		(instance) => buildImgsedUserUrl(instance, username),
		`${username} (ImgsedBridge)`,
		rssBridgeOnlyInstances,
		env
	);

	if (fallbackResult.items.length > 0) {
		return fallbackResult;
	}

	// If fallback also fails, return combined errors
	return {
		...fallbackResult,
		errors: [...result.errors, ...fallbackResult.errors]
	};
}

/**
 * Fetch Instagram hashtag feed via the dedicated instagram instance list (RSS-Bridge only —
 * RSSHub picnob.info does not expose a hashtag route).
 */
export async function fetchInstagramTag(hashtag: string, env?: Env): Promise<FetchResult> {
	const instances = (await getConfiguredInstances(env, 'instagram'))
		.filter(i => !RSSHUB_INSTANCES.includes(i));
	return fetchFromRSSBridgeInstances(
		(instance) => buildRSSBridgeTagUrl(instance, hashtag),
		`#${hashtag}`,
		instances,
		env
	);
}

/**
 * Try each RSS-Bridge instance in order, return first successful result.
 */
async function fetchFromRSSBridgeInstances(
	buildUrl: (instance: string) => string,
	label: string,
	instances: string[] = RSS_BRIDGE_INSTANCES,
	env?: Env
): Promise<FetchResult> {
	const allErrors: FetchResult['errors'] = [];

	for (const instance of instances) {
		const url = buildUrl(instance);
		console.log(`[RSSBridge] Trying ${instance} for ${label}...`);

		const result = await fetchFeed(url, undefined, env?.CACHE, FEED_CACHE_TTL);

		if (result.items.length > 0) {
			console.log(`[RSSBridge] Success with ${instance}`);
			return {
				...result,
				items: result.items.slice(0, RSS_ITEMS_LIMIT),
			};
		}

		allErrors.push(
			...result.errors.map((e) => ({ ...e, tier: `rss-bridge:${instance}` })),
		);
	}

	console.warn(`[RSSBridge] All instances failed for ${label}`);
	return {
		items: [],
		feedTitle: '',
		feedLink: '',
		errors: allErrors.length > 0
			? allErrors
			: [{ tier: 'rss-bridge', message: 'All instances returned empty results' }],
	};
}
