-- Folo delivers entries by webhook push. Those feeds were previously stored as
-- 'rss_url' with the site homepage as source_value, so the cron poller kept
-- fetching them, got zero items every time, and raised "feed degraded" alerts.
--
-- Retag them as 'folo_push' (the poll paths skip that type) and clear the failure
-- state they accumulated. Folo feeds are identified by their webhook-created
-- category: 'Folo' (legacy webhook) or 'Folo: <name>' (named webhooks).
UPDATE feeds
SET source_type          = 'folo_push',
    -- Re-enable only rows that look auto-disabled by the health tracker
    -- (disabled + a recorded fetch error); leaves manually paused feeds paused.
    enabled              = CASE WHEN enabled = 0 AND last_error IS NOT NULL THEN 1 ELSE enabled END,
    consecutive_failures = 0,
    last_error           = NULL
WHERE source_type = 'rss_url'
  -- Guard: a feed that ever polled successfully is a real RSS feed that merely got
  -- filed under a Folo category — leave it pollable.
  AND last_success_at IS NULL
  AND id IN (
    SELECT m.feed_id
    FROM feed_category_members m
    JOIN feed_categories c ON c.id = m.category_id
    WHERE c.name = 'Folo' OR c.name LIKE 'Folo: %'
  );
