/**
 * app.js — Core controller
 *
 * Ties together Auth, API, and the UI. Handles export/import,
 * batch updates, and the review/edit workflow.
 */

const App = (() => {
  // --- State ---
  let playlists = [];
  let currentPlaylistId = null;
  let videos = []; // fetched from API
  let editedVideos = []; // working copy for review/edit
  let batchRunning = false;

  // --- DOM refs (cached on init) ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Init ---
  async function init() {
    // Check for saved client ID
    const savedClientId = localStorage.getItem('yt_genie_client_id');
    if (savedClientId) {
      $('#config-client-id').value = savedClientId;
    }

    // Restore saved quota limit
    const savedQuota = localStorage.getItem('yt_genie_quota_limit');
    if (savedQuota) {
      API.setQuotaLimit(parseInt(savedQuota, 10));
      $('#config-quota-limit').value = savedQuota;
    }

    // Wire up UI events
    bindEvents();

    // Quota callback
    API.setQuotaCallback(updateQuotaUI);
  }

  function bindEvents() {
    // Config modal
    $('#btn-config').addEventListener('click', openConfigModal);
    $('#btn-config-save').addEventListener('click', saveConfig);
    $('#btn-config-cancel').addEventListener('click', closeConfigModal);

    // Auth
    $('#btn-login').addEventListener('click', handleLogin);
    $('#btn-logout').addEventListener('click', handleLogout);
    $('#btn-hero-login').addEventListener('click', handleLogin);

    // Playlists
    $('#playlist-select').addEventListener('change', handlePlaylistChange);

    // Actions
    $('#btn-export').addEventListener('click', handleExport);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', handleImportFile);
    $('#btn-batch-update').addEventListener('click', handleBatchUpdate);
    $('#btn-cancel-batch').addEventListener('click', cancelBatch);

    // Drop zone
    const dropZone = $('#drop-zone');
    if (dropZone) {
      dropZone.addEventListener('click', () => $('#import-file').click());
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
      });
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) processImportFile(file);
      });
    }
  }

  // --- Auth Handlers ---
  async function handleLogin() {
    const clientId = localStorage.getItem('yt_genie_client_id');
    if (!clientId) {
      toast('Please configure your Google Client ID first.', 'error');
      openConfigModal();
      return;
    }

    showLoading('Connecting to YouTube…');
    try {
      await Auth.init(clientId, onAuthChange);
      Auth.login();
    } catch (e) {
      hideLoading();
      toast('Failed to initialize auth: ' + e.message, 'error');
    }
  }

  function handleLogout() {
    Auth.logout();
  }

  function onAuthChange(isLoggedIn, profile) {
    hideLoading();
    if (isLoggedIn) {
      // Show dashboard, hide hero
      $('#hero-section').classList.add('hidden');
      $('#dashboard').classList.add('active');

      // Update user info
      if (profile) {
        $('#user-name').textContent = profile.name || 'YouTube User';
        if (profile.picture) {
          $('#user-avatar').src = profile.picture;
          $('#user-avatar').classList.remove('hidden');
        }
      }
      $('#btn-login').classList.add('hidden');
      $('#btn-logout').classList.remove('hidden');

      toast('Connected to YouTube!', 'success');
      loadPlaylists();
    } else {
      // Show hero, hide dashboard
      $('#hero-section').classList.remove('hidden');
      $('#dashboard').classList.remove('active');
      $('#btn-login').classList.remove('hidden');
      $('#btn-logout').classList.add('hidden');
      $('#user-avatar').classList.add('hidden');
      $('#user-name').textContent = '';

      playlists = [];
      videos = [];
      editedVideos = [];
    }
  }

  // --- Config Modal ---
  function openConfigModal() {
    $('#config-modal').classList.add('active');
  }

  function closeConfigModal() {
    $('#config-modal').classList.remove('active');
  }

  function saveConfig() {
    const clientId = $('#config-client-id').value.trim();
    const quotaLimit = parseInt($('#config-quota-limit').value, 10);

    if (!clientId) {
      toast('Client ID is required.', 'error');
      return;
    }

    localStorage.setItem('yt_genie_client_id', clientId);
    if (quotaLimit > 0) {
      API.setQuotaLimit(quotaLimit);
      localStorage.setItem('yt_genie_quota_limit', quotaLimit);
    }

    closeConfigModal();
    toast('Configuration saved!', 'success');
  }

  // --- Playlists ---
  async function loadPlaylists() {
    showLoading('Fetching playlists…');
    try {
      playlists = await API.getPlaylists();
      renderPlaylistSelector();
      updateStats();
      hideLoading();
      toast(`Found ${playlists.length} playlist(s).`, 'info');
    } catch (e) {
      hideLoading();
      toast('Failed to load playlists: ' + e.message, 'error');
    }
  }

  function renderPlaylistSelector() {
    const select = $('#playlist-select');
    select.innerHTML = '<option value="">— Select a playlist —</option>';
    for (const pl of playlists) {
      const opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = `${pl.title} (${pl.videoCount} videos)`;
      select.appendChild(opt);
    }
  }

  async function handlePlaylistChange(e) {
    const playlistId = e.target.value;
    if (!playlistId) {
      currentPlaylistId = null;
      videos = [];
      editedVideos = [];
      renderVideoList();
      updateStats();
      return;
    }

    currentPlaylistId = playlistId;
    showLoading('Loading videos…');
    try {
      videos = await API.getPlaylistVideos(playlistId);
      editedVideos = videos.map((v) => ({
        ...v,
        newTitle: v.title,
        newDescription: v.description,
        status: 'unchanged', // unchanged | modified | synced | error
      }));
      renderVideoList();
      updateStats();
      hideLoading();
      toast(`Loaded ${videos.length} video(s).`, 'info');
    } catch (e) {
      hideLoading();
      toast('Failed to load videos: ' + e.message, 'error');
    }
  }

  // --- Video List Rendering ---
  function renderVideoList() {
    const container = $('#video-list');
    const emptyState = $('#empty-state');

    if (editedVideos.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    container.innerHTML = '';

    editedVideos.forEach((video, index) => {
      const item = document.createElement('div');
      item.className = `video-item ${video.status !== 'unchanged' ? 'video-item--' + video.status : ''}`;
      item.style.animationDelay = `${index * 0.04}s`;
      item.dataset.index = index;

      const statusLabels = {
        unchanged: '',
        modified: '<span class="video-item__status video-item__status--pending">Modified</span>',
        synced: '<span class="video-item__status video-item__status--synced">Synced ✓</span>',
        error: '<span class="video-item__status video-item__status--error">Error</span>',
      };

      item.innerHTML = `
        <div class="video-item__header">
          <div class="video-item__index">${index + 1}</div>
          ${statusLabels[video.status] || ''}
        </div>
        <div class="video-item__fields">
          <div class="video-item__field">
            <label for="title-${index}">Title</label>
            <input type="text" id="title-${index}" value="${escapeHtml(video.newTitle)}"
              data-index="${index}" data-field="newTitle"
              class="${video.newTitle !== video.title ? 'modified' : ''}" />
          </div>
          <div class="video-item__field">
            <label for="desc-${index}">Description</label>
            <textarea id="desc-${index}" rows="3"
              data-index="${index}" data-field="newDescription"
              class="${video.newDescription !== video.description ? 'modified' : ''}">${escapeHtml(video.newDescription)}</textarea>
          </div>
        </div>
      `;

      // Bind input events
      const titleInput = item.querySelector(`#title-${index}`);
      const descInput = item.querySelector(`#desc-${index}`);

      titleInput.addEventListener('input', handleFieldEdit);
      descInput.addEventListener('input', handleFieldEdit);

      container.appendChild(item);
    });
  }

  function handleFieldEdit(e) {
    const index = parseInt(e.target.dataset.index, 10);
    const field = e.target.dataset.field;
    editedVideos[index][field] = e.target.value;

    // Update status
    const v = editedVideos[index];
    const titleChanged = v.newTitle !== v.title;
    const descChanged = v.newDescription !== v.description;
    v.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';

    // Update CSS classes
    e.target.classList.toggle('modified', (field === 'newTitle' ? titleChanged : descChanged));

    // Update the item's border
    const item = e.target.closest('.video-item');
    item.className = `video-item ${v.status !== 'unchanged' ? 'video-item--' + v.status : ''}`;

    // Update status badge
    const header = item.querySelector('.video-item__header');
    const existingBadge = header.querySelector('.video-item__status');
    if (existingBadge) existingBadge.remove();
    if (v.status === 'modified') {
      header.insertAdjacentHTML('beforeend', '<span class="video-item__status video-item__status--pending">Modified</span>');
    }

    updateStats();
  }

  // --- Export ---
  function handleExport() {
    if (editedVideos.length === 0) {
      toast('No videos to export.', 'error');
      return;
    }

    const playlistName = playlists.find((p) => p.id === currentPlaylistId)?.title || 'playlist';
    const exportData = {
      playlistId: currentPlaylistId,
      playlistTitle: playlistName,
      exportedAt: new Date().toISOString(),
      videos: editedVideos.map((v) => ({
        videoId: v.videoId,
        title: v.newTitle,
        description: v.newDescription,
        originalTitle: v.title,
        originalDescription: v.description,
      })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(playlistName)}-export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast('Playlist exported!', 'success');
  }

  // --- Import ---
  function handleImportFile(e) {
    const file = e.target.files[0];
    if (file) processImportFile(file);
    e.target.value = ''; // reset so same file can be re-imported
  }

  async function processImportFile(file) {
    if (!file.name.endsWith('.json')) {
      toast('Please select a .json file.', 'error');
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.videos || !Array.isArray(data.videos)) {
        toast('Invalid format: missing "videos" array.', 'error');
        return;
      }

      // Map imported data onto current editedVideos, or create new set
      if (editedVideos.length > 0 && data.playlistId === currentPlaylistId) {
        // Match by videoId and apply changes
        let matchCount = 0;
        for (const imported of data.videos) {
          const existing = editedVideos.find((v) => v.videoId === imported.videoId);
          if (existing) {
            existing.newTitle = imported.title;
            existing.newDescription = imported.description;
            const titleChanged = existing.newTitle !== existing.title;
            const descChanged = existing.newDescription !== existing.description;
            existing.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';
            matchCount++;
          }
        }
        toast(`Imported changes for ${matchCount} video(s).`, 'success');
      } else {
        // Load as standalone review data
        editedVideos = data.videos.map((v) => ({
          videoId: v.videoId,
          title: v.originalTitle || v.title,
          description: v.originalDescription || v.description,
          newTitle: v.title,
          newDescription: v.description,
          categoryId: v.categoryId || '',
          tags: v.tags || [],
          defaultLanguage: v.defaultLanguage || '',
          thumbnail: '',
          privacyStatus: '',
          _originalSnippet: null,
          status: (v.title !== (v.originalTitle || v.title) || v.description !== (v.originalDescription || v.description))
            ? 'modified' : 'unchanged',
        }));
        currentPlaylistId = data.playlistId || null;
        toast(`Imported ${editedVideos.length} video(s) from file.`, 'success');
      }

      renderVideoList();
      updateStats();
    } catch (e) {
      toast('Failed to parse file: ' + e.message, 'error');
    }
  }

  // --- Batch Update ---
  async function handleBatchUpdate() {
    const toUpdate = editedVideos.filter((v) => v.status === 'modified');
    if (toUpdate.length === 0) {
      toast('No modified videos to update.', 'info');
      return;
    }

    const quota = API.getQuota();
    const costEstimate = toUpdate.length * 51; // 50 for update + 1 for fetch
    if (quota.used + costEstimate > quota.limit) {
      toast(`Estimated cost (${costEstimate} units) would exceed quota limit. Only ${quota.limit - quota.used} units remaining.`, 'error');
      return;
    }

    if (!confirm(`Update ${toUpdate.length} video(s)? Estimated quota cost: ${costEstimate} units.`)) {
      return;
    }

    batchRunning = true;
    showBatchProgress(0, toUpdate.length);
    $('#btn-batch-update').disabled = true;
    $('#btn-cancel-batch').classList.remove('hidden');

    let completed = 0;
    let errors = 0;

    for (const video of toUpdate) {
      if (!batchRunning) {
        toast('Batch update cancelled.', 'info');
        break;
      }

      try {
        await API.updateVideoSnippet(video, video.newTitle, video.newDescription);
        // Update original data to reflect the sync
        video.title = video.newTitle;
        video.description = video.newDescription;
        video.status = 'synced';
        completed++;
      } catch (e) {
        video.status = 'error';
        video.errorMessage = e.message;
        errors++;
        console.error(`Failed to update ${video.videoId}:`, e);
      }

      showBatchProgress(completed + errors, toUpdate.length);
      renderVideoList();

      // 500ms delay between requests to avoid rate limiting
      if (batchRunning) await API.delay(500);
    }

    batchRunning = false;
    hideBatchProgress();
    $('#btn-batch-update').disabled = false;
    $('#btn-cancel-batch').classList.add('hidden');
    updateStats();

    if (errors > 0) {
      toast(`Batch complete: ${completed} updated, ${errors} failed.`, 'error');
    } else {
      toast(`All ${completed} video(s) updated successfully!`, 'success');
    }
  }

  function cancelBatch() {
    batchRunning = false;
  }

  // --- UI Updates ---
  function updateStats() {
    const total = editedVideos.length;
    const modified = editedVideos.filter((v) => v.status === 'modified').length;
    const synced = editedVideos.filter((v) => v.status === 'synced').length;

    $('#stat-playlists').textContent = playlists.length;
    $('#stat-videos').textContent = total;
    $('#stat-modified').textContent = modified;
    $('#stat-synced').textContent = synced;

    // Toggle action buttons
    $('#btn-batch-update').disabled = modified === 0;
    $('#btn-export').disabled = total === 0;

    // Toggle drop zone vs video list
    const dropZone = $('#drop-zone');
    if (total > 0) {
      dropZone.classList.add('hidden');
    } else {
      dropZone.classList.remove('hidden');
    }

    updateQuotaUI(API.getQuota().used, API.getQuota().limit);
  }

  function updateQuotaUI(used, limit) {
    const pct = Math.min((used / limit) * 100, 100);
    $('#quota-fill').style.width = pct + '%';
    $('#quota-value').textContent = `${used} / ${limit} units`;
  }

  function showBatchProgress(current, total) {
    const el = $('#batch-progress');
    el.classList.add('active');
    const pct = total > 0 ? (current / total) * 100 : 0;
    $('#batch-fill').style.width = pct + '%';
    $('#batch-count').textContent = `${current} / ${total}`;
  }

  function hideBatchProgress() {
    $('#batch-progress').classList.remove('active');
  }

  function showLoading(text) {
    $('#loading-text').textContent = text || 'Loading…';
    $('#loading-overlay').classList.add('active');
  }

  function hideLoading() {
    $('#loading-overlay').classList.remove('active');
  }

  // --- Toast Notifications ---
  function toast(message, type = 'info') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('toast--exit');
      el.addEventListener('animationend', () => el.remove());
    }, 4000);
  }

  // --- Utilities ---
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  return { init };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
