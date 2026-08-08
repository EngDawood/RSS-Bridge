import type { FeedMediaFilter } from './feed';

// Format settings for controlling Telegram message appearance
export interface FormatSettings {
	notification: 'normal' | 'muted';
	media: 'enable' | 'disable' | 'only_media';
	author: 'enable' | 'disable';
	sourceFormat: 'title_link' | 'link_only' | 'bare_url' | 'disable';
	linkPreview: 'enable' | 'disable';
	lengthLimit: number; // 0 = unlimited, or 256/512/1024
	fallbackMode: 'thumbnail_link' | 'thumbnail' | 'skip';
	hashtags: 'enable' | 'disable';
	customHeader?: string;
	customFooter?: string;
	customHashtags?: string;
	cleanupText?: string;
	removeTikTokViews: 'enable' | 'disable';
}

// Global admin configuration stored in KV
export interface AdminConfig {
	telegraph: {
		enabled: boolean;
		threshold: number; // min chars to trigger Telegraph page creation
		token?: string;    // overrides TELEGRAPH_ACCESS_TOKEN env var when set
	};
}

// 'folo_push' is push-only: items arrive via the Folo webhook, never by polling.
export type SourceType = 'instagram_user' | 'instagram_tag' | 'instagram_story' | 'rss_url' | 'rsshub_url' | 'tiktok_user' | 'folo_push';

// Channel source configuration
export interface ChannelSource {
	id: string;
	type: SourceType;
	value: string;
	mediaFilter: FeedMediaFilter;
	enabled: boolean;
	format?: Partial<FormatSettings>;
}

// Channel configuration stored in KV
export interface ChannelConfig {
	channelTitle: string;
	enabled: boolean;
	checkIntervalMinutes: number;
	lastCheckTimestamp: number;
	sources: ChannelSource[];
	defaultFormat?: Partial<FormatSettings>;
}

// Admin conversation state for multi-step flows
export interface AdminState {
	action: 'adding_channel' | 'adding_source' | 'removing_channel' | 'downloading_media' | 'setting_format_custom' | 'setting_telegraph_token' | 'setting_ai_model' | 'setting_ai_prompt' | 'testing_ai_summary' | 'testing_source';
	context?: {
		channelId?: string;
		sourceId?: string;
		settingKey?: keyof FormatSettings;
		sourceType?: SourceType;
		downloadUrl?: string;
		downloadPlatform?: string;
		/** Available video qualities for YouTube picker */
		qualities?: Array<{ quality: string; url: string; size?: string }>;
		/** Cached caption from quality fetch */
		downloadCaption?: string;
		/** Direct CDN media URL that Telegram rejected (for dl:confirm fallback) */
		directMediaUrl?: string;
		/** Message ID of the in-progress status message (e.g. "Fetching..."), for /cancel cleanup */
		statusMessageId?: number;
	};
}

// Formatted Telegram media message
export interface TelegramMediaMessage {
	type: 'photo' | 'video' | 'audio' | 'mediagroup' | 'text';
	url?: string;
	thumbnailUrl?: string;
	caption: string;
	media?: Array<{
		type: 'photo' | 'video';
		media: string;
		caption?: string;
		parse_mode?: string;
	}>;
}
