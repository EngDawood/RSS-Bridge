import React, { useState } from 'react';
import { ArrowsClockwise, Plus, Eye, Trash, X, Pause, Play } from '@phosphor-icons/react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';

const HUES = ['#B85A3A', '#6E8B6A', '#5F7E92', '#A77B3E', '#8A5A7A', '#8a7d68'];
const hueFor = (s: string) => HUES[[...(s || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

const prettyType = (t: string): string =>
  (({
    rss_url: 'RSS', rss: 'RSS', rsshub_url: 'RSSHub', rsshub: 'RSSHub',
    'rss-bridge': 'RSS-Bridge', instagram_user: 'Instagram', instagram: 'Instagram',
    instagram_tag: 'Hashtag', instagram_story: 'Story', tiktok_user: 'TikTok', tiktok: 'TikTok',
    folo_push: 'Folo',
  } as Record<string, string>)[t]) || (t || 'feed').split('_')[0].toUpperCase();

export const FeedsTab: React.FC = () => {
  const {
    feeds,
    channels,
    categories,
    feedViewFilter,
    setFeedViewFilterState,
    selectedChannelId,
    selectedFeedCategoryId,
    categoryFeedIds,
    setFeedViewFilter,
    setSelectedFeedCategoryId,
    setSelectedChannelId,
    loadFeeds,
    callApi,
    showToast,
    setReaderFeedFilter,
    setActiveTab,
  } = useApp();

  const [feedsSortOrder, setFeedsSortOrder] = useState<string>(() => localStorage.getItem('rss_feeds_sort_order') || 'unread_desc');

  const handleSortChange = (order: string) => {
    setFeedsSortOrder(order);
    localStorage.setItem('rss_feeds_sort_order', order);
  };

  const [isAddFeedOpen, setIsAddFeedOpen] = useState(false);
  const [addFeedType, setAddFeedType] = useState<'rss' | 'rsshub' | 'rss-bridge' | 'instagram' | 'tiktok'>('rss');
  const [addFeedUrl, setAddFeedUrl] = useState('');
  const [addFeedTitle, setAddFeedTitle] = useState('');
  const [addFeedDestination, setAddFeedDestination] = useState<'mcp' | 'telegram' | 'both'>('mcp');
  const [addFeedCategoryId, setAddFeedCategoryId] = useState('');
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'success'));
  };

  const handleCreateCategoryInline = async () => {
    if (!newCategoryName.trim()) return;
    const res = await callApi('create_category', { name: newCategoryName.trim() });
    if (res.error) {
      showToast(res.error, 'error');
    } else {
      showToast(`Category "${newCategoryName.trim()}" created.`, 'success');
      await loadFeeds(true);
      setAddFeedCategoryId(res.data.id);
      setIsCreatingCategory(false);
      setNewCategoryName('');
    }
  };

  const resetAddFeedModal = () => {
    setAddFeedUrl('');
    setAddFeedTitle('');
    setAddFeedType('rss');
    setAddFeedDestination('mcp');
    setAddFeedCategoryId('');
    setIsCreatingCategory(false);
    setNewCategoryName('');
  };

  const handleAddFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAddFeedOpen(false);
    showToast('Registering feed and importing articles...', 'info');
    const subscribeToMcp = addFeedDestination === 'mcp' || addFeedDestination === 'both';
    const res = await callApi('add_feed', {
      url: addFeedUrl,
      sourceType: addFeedType,
      title: addFeedTitle,
      subscribeToMcp,
      categoryId: addFeedCategoryId || undefined,
    });
    if (res.error) showToast(res.error, 'error');
    else {
      showToast(`Feed successfully added! Imported ${res.data.itemsInserted || 0} items.`, 'success');
      loadFeeds();
    }
    resetAddFeedModal();
  };

  const handleToggleFeed = async (feedId: string, currentStatus: number) => {
    const res = await callApi('set_feed_enabled', { feedId, enabled: currentStatus !== 1 });
    if (res.error) showToast(res.error, 'error');
    else { showToast('Feed status updated.', 'success'); loadFeeds(); }
  };

  const handleRefreshFeed = async (feedId: string) => {
    showToast('Refreshing feed items...', 'info');
    const res = await callApi('refresh_feed', { feedId });
    if (res.error) showToast(res.error, 'error');
    else { showToast(`Refreshed! Found ${res.data.itemsFetched || 0} items (${res.data.itemsInserted || 0} new).`, 'success'); loadFeeds(); }
  };

  const handleRefreshAllFeeds = async () => {
    showToast('Syncing all enabled feeds in the background...', 'info');
    const res = await callApi('refresh_all');
    if (res.error) showToast(res.error, 'error');
    else { showToast(`Successfully synced ${res.data.refreshed || 0} feeds.`, 'success'); loadFeeds(); }
  };

  const handleRemoveFeed = async (feedId: string) => {
    if (!confirm('Are you sure you want to delete this feed and purge all stored unread items?')) return;
    const res = await callApi('remove_feed', { feedId });
    if (res.error) showToast(res.error, 'error');
    else { showToast('Feed deleted successfully.', 'success'); loadFeeds(); }
  };

  const filteredFeeds = feeds.filter(feed => {
    const channelIds: string[] = feed.telegram_channel_ids || [];
    if (feedViewFilter === 'mcp' || feedViewFilter === 'category') {
      if (channelIds.length !== 0) return false;
      if (selectedFeedCategoryId) {
        const ids = categoryFeedIds[selectedFeedCategoryId];
        return ids ? ids.includes(feed.id) : true;
      }
      return true;
    }
    if (feedViewFilter === 'folo') {
      const foloCategories = categories.filter((c: any) => c.name === 'Folo' || c.name.startsWith('Folo:'));
      if (selectedFeedCategoryId) {
        const ids = categoryFeedIds[selectedFeedCategoryId];
        return ids ? ids.includes(feed.id) : false;
      }
      return foloCategories.some(cat => {
        const ids = categoryFeedIds[cat.id];
        return ids ? ids.includes(feed.id) : false;
      });
    }
    if (feedViewFilter === 'telegram') {
      if (channelIds.length === 0) return false;
      if (selectedChannelId) return channelIds.includes(selectedChannelId);
      return true;
    }
    return true;
  });

  const sortedFeeds = [...filteredFeeds].sort((a, b) => {
    switch (feedsSortOrder) {
      case 'name_asc': return a.title.localeCompare(b.title);
      case 'name_desc': return b.title.localeCompare(a.title);
      case 'synced_desc': return (b.last_fetched_at || 0) - (a.last_fetched_at || 0);
      case 'synced_asc': return (a.last_fetched_at || 9999999999) - (b.last_fetched_at || 9999999999);
      case 'unread_desc': return (b.unread_count || 0) - (a.unread_count || 0);
      case 'created_desc': return (b.created_at || 0) - (a.created_at || 0);
      default: return 0;
    }
  });

  const totalUnread = feeds.reduce((n, f) => n + (Number(f.unread_count) || 0), 0);

  const formatDate = (unixSecs: number | null | undefined) => {
    if (!unixSecs) return 'never';
    const date = new Date(unixSecs * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const sourceTabs = [
    { id: 'all', label: 'All sources' },
    { id: 'mcp', label: 'MCP agent' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'folo', label: 'Folo' },
  ] as const;

  const isSourceActive = (id: string) =>
    feedViewFilter === id || (id === 'mcp' && feedViewFilter === 'category');

  const selectClass =
    'bg-bg-base border border-line rounded-full px-3.5 py-1.5 text-xs text-ink focus:outline-none focus:border-accent cursor-pointer font-semibold';

  return (
    <div className="h-full rr-scroll px-6 md:px-10 py-8">
      {/* Heading */}
      <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
        <div>
          <h2 className="font-display font-semibold text-[34px] tracking-tight text-ink leading-none mb-1.5">Your Feeds</h2>
          <p className="font-display italic text-[15px] text-muted m-0">
            {feeds.length} {feeds.length === 1 ? 'source' : 'sources'} · {totalUnread} unread {totalUnread === 1 ? 'piece' : 'pieces'} waiting
          </p>
        </div>
        <div className="flex gap-2.5">
          <button
            onClick={handleRefreshAllFeeds}
            className="btn-press flex items-center gap-2 px-4 py-2.5 rounded-full bg-transparent border-[1.5px] border-ink text-ink text-[13px] font-semibold cursor-pointer"
          >
            <ArrowsClockwise size={14} weight="bold" /> Sync all
          </button>
          <button
            onClick={() => setIsAddFeedOpen(true)}
            className="btn-press flex items-center gap-2 px-[18px] py-2.5 rounded-full bg-accent border-[1.5px] border-accent text-onaccent text-[13px] font-semibold cursor-pointer"
          >
            <Plus size={14} weight="bold" /> Add a feed
          </button>
        </div>
      </div>

      {/* Source filter strip */}
      <div className="flex items-center gap-6 border-b border-line mb-[18px] flex-wrap">
        {sourceTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setFeedViewFilter(t.id)}
            className={`text-[13px] pb-3 cursor-pointer transition ${
              isSourceActive(t.id)
                ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--rr-accent)]'
                : 'font-medium text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 pb-2.5 flex-wrap">
          {feedViewFilter === 'telegram' && channels.length > 0 && (
            <select value={selectedChannelId || ''} onChange={e => setSelectedChannelId(e.target.value || null)} className={selectClass}>
              <option value="">All channels</option>
              {channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name || ch.id}</option>)}
            </select>
          )}
          {(feedViewFilter === 'mcp' || feedViewFilter === 'category' || feedViewFilter === 'folo') && categories.length > 0 && (
            <select
              value={selectedFeedCategoryId || ''}
              onChange={e => {
                const id = e.target.value || null;
                if (feedViewFilter !== 'folo') {
                  setFeedViewFilterState(id ? 'category' : 'mcp');
                  localStorage.setItem('rss_feed_filter', id ? 'category' : 'mcp');
                }
                setSelectedFeedCategoryId(id);
              }}
              className={selectClass}
            >
              <option value="">All categories</option>
              {(feedViewFilter === 'folo'
                ? categories.filter(c => c.name === 'Folo' || c.name.startsWith('Folo:'))
                : categories
              ).map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name} ({cat.feed_count})</option>
              ))}
            </select>
          )}
          <select value={feedsSortOrder} onChange={e => handleSortChange(e.target.value)} className={selectClass}>
            <option value="unread_desc">Sorted by most unread</option>
            <option value="name_asc">Title (A–Z)</option>
            <option value="name_desc">Title (Z–A)</option>
            <option value="synced_desc">Last synced (newest)</option>
            <option value="synced_asc">Last synced (oldest)</option>
            <option value="created_desc">Date created</option>
          </select>
          <span className="font-mono text-[11px] text-muted">{sortedFeeds.length}/{feeds.length}</span>
        </div>
      </div>

      {/* Feed rows */}
      <div className="flex flex-col gap-3 pb-4">
        {sortedFeeds.length === 0 ? (
          <div className="p-12 text-center border border-dashed border-line rounded-2xl bg-surface/40 text-sm text-muted">
            {feeds.length === 0
              ? 'No feeds registered. Click "Add a feed" to start importing content.'
              : `No ${feedViewFilter === 'mcp' ? 'MCP-only' : feedViewFilter === 'telegram' ? 'Telegram' : ''} feeds found.`}
          </div>
        ) : (
          sortedFeeds.map(feed => {
            const active = feed.enabled === 1;
            const unread = Number(feed.unread_count) || 0;
            return (
              <div
                key={feed.id}
                className="rr-row flex items-center gap-5 px-[22px] py-5 rounded-[14px] bg-surface border border-line"
              >
                {/* Monogram */}
                <div
                  className="w-[50px] h-[50px] flex-none rounded-[13px] text-white flex items-center justify-center font-display font-semibold text-[23px]"
                  style={{ background: hueFor(feed.id || feed.title) }}
                >
                  {(feed.title || '?').trim().charAt(0).toUpperCase()}
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-display font-semibold text-[20px] text-ink truncate max-w-full">{feed.title}</span>
                    <span className="text-[10px] font-semibold tracking-[0.05em] uppercase text-accent bg-accent-soft px-2.5 py-0.5 rounded-full">
                      {prettyType(feed.source_type)}
                    </span>
                    <span className={`text-[9px] font-semibold tracking-[0.05em] uppercase ${active ? 'text-ok' : 'text-muted'}`}>
                      ● {active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div
                    className="font-mono text-[11px] text-muted mt-1.5 truncate cursor-pointer hover:text-ink"
                    onClick={() => handleCopyText(feed.url)}
                    title={feed.url}
                  >
                    {feed.url} · synced {formatDate(feed.last_fetched_at)}
                  </div>
                </div>

                {/* Unread number */}
                <div className="text-right flex-none">
                  <div className="font-display font-semibold text-[30px] text-accent leading-none">{unread}</div>
                  <div className="text-[11px] text-muted">new to read</div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-none">
                  <button
                    onClick={() => { setReaderFeedFilter([feed.id]); setActiveTab('reader'); }}
                    className="btn-press px-[18px] py-2.5 rounded-full bg-ink text-bg-base text-xs font-semibold cursor-pointer flex items-center gap-1.5"
                  >
                    <Eye size={13} /> Read →
                  </button>
                  <button onClick={() => handleRefreshFeed(feed.id)} title="Sync feed" className="btn-press w-9 h-9 rounded-full border border-line-strong bg-bg-base text-ink-soft hover:text-accent flex items-center justify-center cursor-pointer">
                    <ArrowsClockwise size={14} />
                  </button>
                  <button onClick={() => handleToggleFeed(feed.id, feed.enabled)} title={active ? 'Pause' : 'Activate'} className="btn-press w-9 h-9 rounded-full border border-line-strong bg-bg-base text-ink-soft hover:text-accent flex items-center justify-center cursor-pointer">
                    {active ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button onClick={() => handleRemoveFeed(feed.id)} title="Remove" className="btn-press w-9 h-9 rounded-full border border-line-strong bg-bg-base text-muted hover:text-danger hover:border-danger flex items-center justify-center cursor-pointer">
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* MODAL: Add Feed */}
      <Modal
        isOpen={isAddFeedOpen}
        onClose={() => { setIsAddFeedOpen(false); resetAddFeedModal(); }}
        title="Register Feed"
        footer={
          <>
            <button
              type="button"
              onClick={() => { setIsAddFeedOpen(false); resetAddFeedModal(); }}
              className="btn-press px-4 py-2 rounded-full text-xs font-semibold bg-bg-input border border-border-base text-text-muted hover:text-text-base cursor-pointer transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              onClick={handleAddFeed}
              className="btn-press px-4 py-2 rounded-full text-xs font-semibold bg-accent text-onaccent hover:bg-accent-primary-hover cursor-pointer transition"
            >
              Register
            </button>
          </>
        }
      >
        {/* Source Type */}
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] font-mono">Source Type</label>
          <div className="flex bg-bg-input border border-border-base rounded-xl p-1 gap-0.5 flex-wrap">
            {([
              { id: 'rss', label: 'RSS' },
              { id: 'rsshub', label: 'RSSHub' },
              { id: 'rss-bridge', label: 'RSS-Bridge' },
              { id: 'instagram', label: 'Instagram' },
              { id: 'tiktok', label: 'TikTok' },
            ] as const).map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => { setAddFeedType(opt.id); setAddFeedUrl(''); }}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer min-w-[60px] ${
                  addFeedType === opt.id ? 'bg-accent text-onaccent' : 'text-text-muted hover:text-text-base'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* URL or Username */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] font-mono">
            {addFeedType === 'instagram' || addFeedType === 'tiktok' ? 'Username' : 'Feed Source URL'}
          </label>
          <input
            type={addFeedType === 'instagram' || addFeedType === 'tiktok' ? 'text' : 'url'}
            value={addFeedUrl}
            onChange={e => setAddFeedUrl(e.target.value)}
            placeholder={
              addFeedType === 'rsshub' ? 'https://rsshub.app/twitter/user/username' :
              addFeedType === 'rss-bridge' ? 'https://rss-bridge.instance.com/?action=display&bridge=...' :
              addFeedType === 'instagram' ? 'username (without @)' :
              addFeedType === 'tiktok' ? 'username (without @)' :
              'https://example.com/feed.xml'
            }
            className="bg-bg-input border border-border-base rounded-xl px-4 py-3.5 text-sm text-text-base focus:outline-none focus:border-accent-primary font-mono mt-1"
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] font-mono">Friendly Title (Optional)</label>
          <input
            type="text"
            value={addFeedTitle}
            onChange={e => setAddFeedTitle(e.target.value)}
            placeholder="e.g. Technology News"
            className="bg-bg-input border border-border-base rounded-xl px-4 py-3.5 text-sm text-text-base focus:outline-none focus:border-accent-primary font-semibold mt-1"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] font-mono">Destination</label>
          <div className="flex bg-bg-input border border-border-base rounded-xl p-1 gap-0.5">
            {([
              { id: 'mcp', label: 'MCP Agent' },
              { id: 'telegram', label: 'Telegram' },
              { id: 'both', label: 'Both' },
            ] as const).map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAddFeedDestination(opt.id)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  addFeedDestination === opt.id ? 'bg-accent text-onaccent' : 'text-text-muted hover:text-text-base'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-text-muted leading-relaxed">
            {addFeedDestination === 'mcp' && 'Feed will be added to the MCP workspace for agent browsing.'}
            {addFeedDestination === 'telegram' && 'Feed will be registered for Telegram auto-posting (configure channel subscriptions in Telegram tab).'}
            {addFeedDestination === 'both' && 'Feed will be available for both MCP agent browsing and Telegram posting.'}
          </p>
        </div>

        {/* Category */}
        {(addFeedDestination === 'mcp' || addFeedDestination === 'both') && (
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] font-mono">Category (Optional)</label>
            {!isCreatingCategory ? (
              <div className="flex items-center gap-2 mt-1">
                {categories.length > 0 ? (
                  <select
                    value={addFeedCategoryId}
                    onChange={e => setAddFeedCategoryId(e.target.value)}
                    className="flex-1 bg-bg-input border border-border-base rounded-xl px-4 py-3 text-sm text-text-base focus:outline-none focus:border-accent-primary"
                  >
                    <option value="">No category</option>
                    {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                  </select>
                ) : (
                  <span className="flex-1 text-xs text-text-muted italic py-3">No categories yet</span>
                )}
                <button
                  type="button"
                  onClick={() => setIsCreatingCategory(true)}
                  className="btn-press flex items-center gap-1 px-3 py-2.5 text-xs font-semibold rounded-xl bg-bg-input border border-border-base text-text-muted hover:text-text-base transition cursor-pointer flex-shrink-0"
                  title="Create new category"
                >
                  <Plus size={12} /> New
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={e => setNewCategoryName(e.target.value)}
                  placeholder="Category name..."
                  className="flex-1 bg-bg-input border border-border-base rounded-xl px-4 py-3 text-sm text-text-base focus:outline-none focus:border-accent-primary"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleCreateCategoryInline()}
                />
                <button
                  type="button"
                  onClick={handleCreateCategoryInline}
                  className="btn-press px-3 py-2.5 text-xs font-semibold rounded-xl bg-accent text-onaccent hover:bg-accent-primary-hover transition cursor-pointer flex-shrink-0"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => { setIsCreatingCategory(false); setNewCategoryName(''); }}
                  className="btn-press p-2.5 rounded-xl bg-bg-input border border-border-base text-text-muted hover:text-text-base transition cursor-pointer flex-shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};
export default FeedsTab;
