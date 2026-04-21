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
    // Step 1: Get all video IDs from the playlist
    const videoIds = [];
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
        const vid = item.snippet.resourceId?.videoId;
        if (vid) videoIds.push(vid);
      }
      pageToken = response.result.nextPageToken || '';
    } while (pageToken);

    // Step 2: Batch fetch video details in chunks of 50
    const videos = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const response = await gapi.client.youtube.videos.list({
        part: 'snippet,status',
        id: chunk.join(','),
      });
      addQuota(1);

      const items = response.result.items || [];
      for (const item of items) {
        videos.push({
          videoId: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          categoryId: item.snippet.categoryId,
          tags: item.snippet.tags || [],
          defaultLanguage: item.snippet.defaultLanguage || '',
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
          privacyStatus: item.status?.privacyStatus || 'unknown',
          // Store full snippet to avoid data loss on update
          _originalSnippet: { ...item.snippet },
        });
      }
    }

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
   * Helper to sleep between batch operations.
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    getPlaylists,
    getPlaylistVideos,
    updateVideoSnippet,
    delay,
    getQuota,
    resetQuota,
    setQuotaLimit,
    setQuotaCallback,
  };
})();
