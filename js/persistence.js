/**
 * persistence.js — Account-scoped storage helpers
 *
 * Keeps quota usage and playlist drafts scoped by authenticated account.
 */

const Persistence = (() => {
  const LEGACY_QUOTA_USED_STORAGE_KEY = 'yt_genie_quota_used';
  const QUOTA_USED_STORAGE_PREFIX = 'yt_genie_quota_used_';
  const PLAYLIST_DRAFT_STORAGE_PREFIX = 'yt_genie_playlist_draft_';
  const LAST_WORKING_PLAYLIST_PREFIX = 'yt_genie_last_working_playlist_';

  function normalizeAccountId(accountId) {
    const normalized = String(accountId || '').trim();
    return normalized || 'anonymous';
  }

  function getScope(accountId) {
    return encodeURIComponent(normalizeAccountId(accountId));
  }

  function getQuotaUsedStorageKey(accountId) {
    return `${QUOTA_USED_STORAGE_PREFIX}${getScope(accountId)}`;
  }

  function getLastWorkingPlaylistStorageKey(accountId) {
    return `${LAST_WORKING_PLAYLIST_PREFIX}${getScope(accountId)}`;
  }

  function getPlaylistDraftStorageKey(accountId, playlistId) {
    return `${PLAYLIST_DRAFT_STORAGE_PREFIX}${getScope(accountId)}_${playlistId}`;
  }

  function getCurrentQuotaDay() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalizeQuotaUsed(used) {
    const parsed = Number(used);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  }

  function parseQuotaRecord(raw) {
    if (raw == null) return null;

    const legacy = parseInt(raw, 10);
    if (String(legacy) === String(raw).trim() && Number.isFinite(legacy) && legacy >= 0) {
      return 0;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.date !== getCurrentQuotaDay()) return 0;
      return normalizeQuotaUsed(parsed.used);
    } catch {
      return 0;
    }
  }

  function resolveAccountId(profile) {
    return normalizeAccountId(profile?.id || profile?.email || profile?.name || 'anonymous');
  }

  function readQuotaUsed(accountId) {
    const normalized = normalizeAccountId(accountId);
    const scoped = localStorage.getItem(getQuotaUsedStorageKey(normalized));
    let raw = scoped;
    if (raw == null && normalized === 'anonymous') {
      raw = localStorage.getItem(LEGACY_QUOTA_USED_STORAGE_KEY);
    }
    return parseQuotaRecord(raw);
  }

  function writeQuotaUsed(accountId, used) {
    localStorage.setItem(getQuotaUsedStorageKey(accountId), JSON.stringify({
      date: getCurrentQuotaDay(),
      used: normalizeQuotaUsed(used),
    }));
  }

  function getDraftPlaylistIds(accountId) {
    const scopedPrefix = `${PLAYLIST_DRAFT_STORAGE_PREFIX}${getScope(accountId)}_`;
    const ids = new Set();
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(scopedPrefix)) continue;
      ids.add(key.slice(scopedPrefix.length));
    }
    return ids;
  }

  function readLastWorkingPlaylist(accountId) {
    return sessionStorage.getItem(getLastWorkingPlaylistStorageKey(accountId));
  }

  function writeLastWorkingPlaylist(accountId, playlistId) {
    sessionStorage.setItem(getLastWorkingPlaylistStorageKey(accountId), playlistId);
  }

  function readPlaylistDraft(accountId, playlistId) {
    if (!playlistId) return null;
    const raw = sessionStorage.getItem(getPlaylistDraftStorageKey(accountId, playlistId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.playlistId !== playlistId || !Array.isArray(parsed.videos)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writePlaylistDraft(accountId, playlistId, payload) {
    if (!playlistId) return;
    sessionStorage.setItem(getPlaylistDraftStorageKey(accountId, playlistId), JSON.stringify(payload));
  }

  function removePlaylistDraft(accountId, playlistId) {
    if (!playlistId) return;
    sessionStorage.removeItem(getPlaylistDraftStorageKey(accountId, playlistId));
  }

  return {
    resolveAccountId,
    readQuotaUsed,
    writeQuotaUsed,
    getDraftPlaylistIds,
    readLastWorkingPlaylist,
    writeLastWorkingPlaylist,
    readPlaylistDraft,
    writePlaylistDraft,
    removePlaylistDraft,
  };
})();
