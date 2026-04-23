/**
 * api.js — YouTube Data API v3 wrapper
 *
 * Provides methods for fetching playlists, videos, and updating
 * video snippets. Uses gapi.client (loaded by auth.js).
 */

const API = (() => {
  // Track estimated quota usage per session
  let quotaUsed = 0;
  let quotaLimit = 10000;
  let onQuotaChange = null;

  function setQuotaLimit(limit) {
    quotaLimit = limit;
  }

  function setQuotaCallback(cb) {
    onQuotaChange = cb;
  }

  function addQuota(units) {
    quotaUsed += units;
    onQuotaChange?.(quotaUsed, quotaLimit);
  }

  function getQuota() {
    return { used: quotaUsed, limit: quotaLimit };
  }

  function resetQuota() {
    quotaUsed = 0;
    onQuotaChange?.(quotaUsed, quotaLimit);
  }

  function setQuotaUsed(used) {
    const parsed = Number(used);
    quotaUsed = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    onQuotaChange?.(quotaUsed, quotaLimit);
  }

  /**
   * Fetch all playlists for the authenticated user.
   * Cost: ~1 unit per request.
   */
  async function getPlaylists() {
    const playlists = [];
    let pageToken = '';

    do {
      const response = await gapi.client.youtube.playlists.list({
        part: 'snippet,contentDetails',
        mine: true,
        maxResults: 50,
        pageToken: pageToken,
      });
      addQuota(1);

      const items = response.result.items || [];
      for (const item of items) {
        playlists.push({
          id: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
          videoCount: item.contentDetails.itemCount,
        });
      }
      pageToken = response.result.nextPageToken || '';
    } while (pageToken);

    return playlists;
  }

  /**
   * Fetch all video IDs for a playlist, then fetch full video snippets.
   * Cost: ~1 unit per playlistItems page, ~1 unit per videos page.
   */
  async function getPlaylistVideos(playlistId) {
    // Step 1: Collect playlist item rows (stable order + playlistItem metadata)
    const playlistRows = [];
    let pageToken = '';

    do {
      const response = await gapi.client.youtube.playlistItems.list({
        part: 'snippet',
        playlistId: playlistId,
        maxResults: 50,
        pageToken: pageToken,
      });
      addQuota(1);

      const items = response.result.items || [];
      for (const item of items) {
        const videoId = item.snippet.resourceId?.videoId;
        if (!videoId) continue;
        playlistRows.push({
          playlistItemId: item.id,
          playlistId: item.snippet.playlistId || playlistId,
          position: typeof item.snippet.position === 'number' ? item.snippet.position : playlistRows.length,
          videoId,
          fallbackTitle: item.snippet.title || '',
          fallbackDescription: item.snippet.description || '',
          fallbackThumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
          fallbackPublishedAt: item.snippet.publishedAt || '',
        });
      }
      pageToken = response.result.nextPageToken || '';
    } while (pageToken);

    // Step 2: Batch fetch unique video details, then project back in playlist order
    const uniqueVideoIds = [...new Set(playlistRows.map((row) => row.videoId))];
    const detailsByVideoId = new Map();
    for (let i = 0; i < uniqueVideoIds.length; i += 50) {
      const chunk = uniqueVideoIds.slice(i, i + 50);
      const detailsResponse = await gapi.client.youtube.videos.list({
        part: 'snippet,status',
        id: chunk.join(','),
      });
      addQuota(1);

      const items = detailsResponse.result.items || [];
      for (const item of items) {
        detailsByVideoId.set(item.id, {
          title: item.snippet.title,
          description: item.snippet.description,
          publishedAt: item.snippet.publishedAt || '',
          scheduledPublishAt: item.status?.publishAt || '',
          categoryId: item.snippet.categoryId,
          tags: item.snippet.tags || [],
          defaultLanguage: item.snippet.defaultLanguage || '',
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
          privacyStatus: item.status?.privacyStatus || 'unknown',
          _originalSnippet: { ...item.snippet },
        });
      }
    }

    const videos = playlistRows.map((row) => {
      const details = detailsByVideoId.get(row.videoId);
      if (!details) {
        return {
          playlistItemId: row.playlistItemId,
          playlistId: row.playlistId,
          position: row.position,
          videoId: row.videoId,
          title: row.fallbackTitle,
          description: row.fallbackDescription,
          publishedAt: row.fallbackPublishedAt,
          scheduledPublishAt: '',
          categoryId: '',
          tags: [],
          defaultLanguage: '',
          thumbnail: row.fallbackThumbnail,
          privacyStatus: 'unknown',
          _originalSnippet: null,
        };
      }

      return {
        playlistItemId: row.playlistItemId,
        playlistId: row.playlistId,
        position: row.position,
        videoId: row.videoId,
        ...details,
      };
    });

    return videos;
  }

  /**
   * Update a video's title and description.
   * IMPORTANT: We must send the full snippet to avoid data loss.
   * Cost: 50 units per update.
   */
  async function updateVideoSnippet(video, newTitle, newDescription) {
    // First fetch fresh snippet to avoid overwriting concurrent changes
    const freshResponse = await gapi.client.youtube.videos.list({
      part: 'snippet',
      id: video.videoId,
    });
    addQuota(1);

    const freshItem = freshResponse.result.items?.[0];
    if (!freshItem) {
      throw new Error(`Video ${video.videoId} not found`);
    }

    // Build the full snippet (preserve all existing fields)
    const snippet = { ...freshItem.snippet };
    snippet.title = newTitle;
    snippet.description = newDescription;

    const response = await gapi.client.youtube.videos.update({
      part: 'snippet',
      resource: {
        id: video.videoId,
        snippet: snippet,
      },
    });
    addQuota(50);

    return response.result;
  }

  /**
   * Update a playlist's title and description.
   * Fetches a fresh snippet first to preserve existing fields.
   * Cost: 50 units per update.
   */
  async function updatePlaylistSnippet(playlistId, newTitle, newDescription) {
    const freshResponse = await gapi.client.youtube.playlists.list({
      part: 'snippet',
      id: playlistId,
      maxResults: 1,
    });
    addQuota(1);

    const freshItem = freshResponse.result.items?.[0];
    if (!freshItem) {
      throw new Error(`Playlist ${playlistId} not found`);
    }

    const snippet = { ...freshItem.snippet };
    snippet.title = newTitle;
    snippet.description = newDescription;

    const response = await gapi.client.youtube.playlists.update({
      part: 'snippet',
      resource: {
        id: playlistId,
        snippet,
      },
    });
    addQuota(50);

    return response.result;
  }

  /**
   * Persist playlist order by updating a playlist item's position.
   * Cost: 50 units per update.
   */
  async function updatePlaylistItemPosition(playlistItemId, playlistId, videoId, position) {
    const response = await gapi.client.youtube.playlistItems.update({
      part: 'snippet',
      resource: {
        id: playlistItemId,
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId,
          },
          position,
        },
      },
    });
    addQuota(50);
    return response.result;
  }

  /**
   * Helper to sleep between batch operations.
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    getPlaylists,
    getPlaylistVideos,
    updateVideoSnippet,
    updatePlaylistSnippet,
    updatePlaylistItemPosition,
    delay,
    getQuota,
    resetQuota,
    setQuotaUsed,
    setQuotaLimit,
    setQuotaCallback,
  };
})();
