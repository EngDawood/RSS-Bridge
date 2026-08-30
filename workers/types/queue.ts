import type { FeedItem } from './feed';
import type { FormatSettings } from './telegram';

/**
 * Task for fetching a core feed by its D1 feed id.
 * One task is emitted per due feed (deduped across all subscribing channels).
 */
export interface FetchTask {
	type: 'fetch';
	feedId: string;
}

/**
 * Task for sending a single feed item to a channel.
 */
export interface SendTask {
	type: 'send';
	channelId: string;
	item: FeedItem;
	settings: FormatSettings;
}

/**
 * Combined type for all queue tasks.
 */
export type QueueTask = FetchTask | SendTask;

/** Cloudflare Queues reject any message over 128 KB. Leave headroom for JSON escaping. */
const MAX_SEND_TASK_BYTES = 96 * 1024;
/** Telegram captions cap at 4096 chars — the queue never needs a full article body. */
const MAX_TEXT_CHARS = 8000;

/**
 * Build a SendTask small enough for the queue.
 *
 * Full-text feeds (e.g. RSSHub blog bridges) carry article bodies well past the
 * 128 KB message limit, which made `.send()` throw "Payload Too Large" and fail
 * the whole fetch task. `contentHtml` is only needed for Telegraph enrichment —
 * which already ran by this point — and the full body is persisted in D1, so the
 * Telegram send path never reads it.
 */
export function buildSendTask(
	channelId: string,
	item: FeedItem,
	settings: FormatSettings,
): SendTask {
	const { contentHtml: _contentHtml, ...rest } = item;

	let trimmed: FeedItem = rest.text.length > MAX_TEXT_CHARS
		? { ...rest, text: rest.text.slice(0, MAX_TEXT_CHARS) }
		: rest;

	// Last resort for pathological items (huge summary or media list): trim to the
	// most the formatter could ever render rather than letting the send throw.
	if (byteLength(trimmed) > MAX_SEND_TASK_BYTES) {
		trimmed = {
			...trimmed,
			text: trimmed.text.slice(0, 4096),
			summary: trimmed.summary?.slice(0, 2048),
		};
	}

	return { type: 'send', channelId, item: trimmed, settings };
}

function byteLength(item: FeedItem): number {
	return new TextEncoder().encode(JSON.stringify(item)).length;
}
