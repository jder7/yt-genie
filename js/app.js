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
  let currentPlaylistEdit = null;
  let videos = []; // fetched from API
  let editedVideos = []; // working copy for review/edit
  let batchRunning = false;
  let dragSourceIndex = null;
  let dragAutoScrollRaf = null;
  let dragAutoScrollVelocity = 0;
  let authInitialized = false;
  let authClientId = null;
  let activeAccountId = 'anonymous';

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
    API.setQuotaCallback((used, limit) => {
      updateQuotaUI(used, limit);
      Persistence.writeQuotaUsed(activeAccountId, used);
    });

    restoreQuotaUsageForActiveAccount();

    // Attempt local session restore on page load (no popup auth flow)
    if (savedClientId) {
      try {
        showLoading('Restoring session…');
        await ensureAuthInitialized(savedClientId);
        const restored = await Auth.restoreSessionFromStorage();
        if (!restored) hideLoading();
      } catch (e) {
        hideLoading();
      }
    }
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
    $('#playlist-title-input').addEventListener('input', handlePlaylistFieldEdit);
    $('#playlist-desc-input').addEventListener('input', handlePlaylistFieldEdit);

    // Actions
    $('#btn-export').addEventListener('click', handleExport);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', handleImportFile);
    $('#btn-reset-all').addEventListener('click', handleResetAllChanges);
    $('#btn-batch-update').addEventListener('click', handleBatchUpdate);
    $('#btn-cancel-batch').addEventListener('click', cancelBatch);
    $('#btn-sort-title-asc').addEventListener('click', () => sortVideos('title', 'asc'));
    $('#btn-sort-title-desc').addEventListener('click', () => sortVideos('title', 'desc'));
    $('#btn-sort-date-asc').addEventListener('click', () => sortVideos('date', 'asc'));
    $('#btn-sort-date-desc').addEventListener('click', () => sortVideos('date', 'desc'));
    document.addEventListener('dragover', handleGlobalDragOver, { passive: true });
    window.addEventListener('beforeunload', persistCurrentPlaylistDraft);

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
      await ensureAuthInitialized(clientId);
      Auth.login();
    } catch (e) {
      hideLoading();
      toast('Failed to initialize auth: ' + e.message, 'error');
    }
  }

  async function ensureAuthInitialized(clientId) {
    if (authInitialized && authClientId === clientId) return;
    await Auth.init(clientId, onAuthChange);
    authInitialized = true;
    authClientId = clientId;
  }

  function handleLogout() {
    Auth.logout();
  }

  function onAuthChange(isLoggedIn, profile) {
    hideLoading();
    if (isLoggedIn) {
      activeAccountId = Persistence.resolveAccountId(profile);
      restoreQuotaUsageForActiveAccount();

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
      persistCurrentPlaylistDraft();
      activeAccountId = 'anonymous';
      restoreQuotaUsageForActiveAccount();

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
      currentPlaylistEdit = null;
      renderPlaylistEditor();
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
    const previousClientId = localStorage.getItem('yt_genie_client_id');
    const clientId = $('#config-client-id').value.trim();
    const quotaLimit = parseInt($('#config-quota-limit').value, 10);

    if (!clientId) {
      toast('Client ID is required.', 'error');
      return;
    }

    localStorage.setItem('yt_genie_client_id', clientId);
    if (previousClientId && previousClientId !== clientId) {
      Auth.clearSavedSession();
      authInitialized = false;
      authClientId = null;
    }
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

      const preselectId = resolveDraftPreselectPlaylistId();
      if (preselectId) {
        const select = $('#playlist-select');
        select.value = preselectId;
        select.dispatchEvent(new Event('change'));
      }
    } catch (e) {
      hideLoading();
      toast('Failed to load playlists: ' + e.message, 'error');
    }
  }

  function renderPlaylistSelector() {
    const draftPlaylistIds = Persistence.getDraftPlaylistIds(activeAccountId);
    const select = $('#playlist-select');
    select.innerHTML = '<option value="">— Select a playlist —</option>';
    for (const pl of playlists) {
      const opt = document.createElement('option');
      opt.value = pl.id;
      const draftMarker = draftPlaylistIds.has(pl.id) ? ' • Draft' : '';
      opt.textContent = `${pl.title} (${pl.videoCount} videos)${draftMarker}`;
      select.appendChild(opt);
    }
  }

  async function handlePlaylistChange(e) {
    const playlistId = e.target.value;
    const previousPlaylistId = currentPlaylistId;
    if (previousPlaylistId && previousPlaylistId !== playlistId) {
      persistCurrentPlaylistDraft();
    }

    if (!playlistId) {
      currentPlaylistId = null;
      currentPlaylistEdit = null;
      videos = [];
      editedVideos = [];
      renderVideoList();
      renderPlaylistEditor();
      updateStats();
      return;
    }

    currentPlaylistId = playlistId;
    Persistence.writeLastWorkingPlaylist(activeAccountId, playlistId);
    showLoading('Loading videos…');
    try {
      videos = await API.getPlaylistVideos(playlistId);
      editedVideos = videos.map((v) => ({
        ...v,
        originalOrder: 0,
        orderModified: false,
        newTitle: v.title,
        newDescription: v.description,
        status: 'unchanged', // unchanged | modified | synced | error
      }));
      editedVideos.forEach((v, index) => {
        v.originalOrder = typeof v.position === 'number' ? v.position : index;
        v.position = typeof v.position === 'number' ? v.position : index;
      });
      const selectedPlaylist = playlists.find((p) => p.id === playlistId);
      currentPlaylistEdit = selectedPlaylist ? {
        playlistId: selectedPlaylist.id,
        title: selectedPlaylist.title || '',
        description: selectedPlaylist.description || '',
        thumbnail: selectedPlaylist.thumbnail || '',
        newTitle: selectedPlaylist.title || '',
        newDescription: selectedPlaylist.description || '',
        status: 'unchanged',
      } : null;
      const hasDraft = applyStoredDraftForCurrentPlaylist();
      renderVideoList();
      renderPlaylistEditor();
      updateStats();
      hideLoading();
      if (hasDraft) {
        toast(`Loaded ${videos.length} video(s). Restored local draft.`, 'info');
      } else {
        toast(`Loaded ${videos.length} video(s).`, 'info');
      }
    } catch (e) {
      hideLoading();
      toast('Failed to load videos: ' + e.message, 'error');
    }
  }

  function handlePlaylistFieldEdit(e) {
    if (!currentPlaylistEdit) return;
    if (e.target.id === 'playlist-title-input') {
      currentPlaylistEdit.newTitle = e.target.value;
    } else if (e.target.id === 'playlist-desc-input') {
      currentPlaylistEdit.newDescription = e.target.value;
    }

    const titleChanged = currentPlaylistEdit.newTitle !== currentPlaylistEdit.title;
    const descChanged = currentPlaylistEdit.newDescription !== currentPlaylistEdit.description;
    currentPlaylistEdit.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';
    updatePlaylistStatusBadge();
    updateStats();
    persistCurrentPlaylistDraft();
  }

  function renderPlaylistEditor() {
    const editor = $('#playlist-editor');
    const titleInput = $('#playlist-title-input');
    const descInput = $('#playlist-desc-input');
    const thumbnailEl = $('#playlist-thumb');
    if (!editor || !titleInput || !descInput || !thumbnailEl) return;

    if (!currentPlaylistEdit) {
      editor.classList.add('hidden');
      titleInput.value = '';
      descInput.value = '';
      thumbnailEl.src = '';
      thumbnailEl.classList.add('hidden');
      return;
    }

    editor.classList.remove('hidden');
    titleInput.value = currentPlaylistEdit.newTitle || '';
    descInput.value = currentPlaylistEdit.newDescription || '';
    titleInput.classList.toggle('modified', currentPlaylistEdit.newTitle !== currentPlaylistEdit.title);
    descInput.classList.toggle('modified', currentPlaylistEdit.newDescription !== currentPlaylistEdit.description);
    titleInput.title = currentPlaylistEdit.newTitle !== currentPlaylistEdit.title
      ? getModifiedTooltip(currentPlaylistEdit.title)
      : '';
    descInput.title = currentPlaylistEdit.newDescription !== currentPlaylistEdit.description
      ? getModifiedTooltip(currentPlaylistEdit.description)
      : '';
    if (currentPlaylistEdit.thumbnail) {
      thumbnailEl.src = currentPlaylistEdit.thumbnail;
      thumbnailEl.alt = currentPlaylistEdit.newTitle
        ? `Thumbnail for playlist ${currentPlaylistEdit.newTitle}`
        : 'Playlist thumbnail';
      thumbnailEl.classList.remove('hidden');
    } else {
      thumbnailEl.src = '';
      thumbnailEl.classList.add('hidden');
    }
    updatePlaylistStatusBadge();
  }

  function updatePlaylistStatusBadge() {
    const status = $('#playlist-edit-status');
    if (!status) return;
    if (currentPlaylistEdit?.status === 'modified') {
      status.className = 'video-item__status video-item__status--pending';
      status.textContent = 'Modified';
      status.classList.remove('hidden');
    } else if (currentPlaylistEdit?.status === 'synced') {
      status.className = 'video-item__status video-item__status--synced';
      status.textContent = 'Synced ✓';
      status.classList.remove('hidden');
    } else {
      status.className = 'video-item__status hidden';
      status.textContent = '';
    }
  }

  // --- Sorting / Reordering ---
  function isPersistableVideo(video) {
    return !!(video.playlistItemId && video.playlistId && video.videoId);
  }

  function hasSnippetChanges(video) {
    return video.newTitle !== video.title || video.newDescription !== video.description;
  }

  function hasPendingChanges(video) {
    return hasSnippetChanges(video) || !!video.orderModified;
  }

  function syncOrderFlags() {
    const desiredPersistable = editedVideos.filter(isPersistableVideo);
    const desiredIndexById = new Map(desiredPersistable.map((video, index) => [video.playlistItemId, index]));

    editedVideos.forEach((video, index) => {
      // Keep current list position in sync for UI/export.
      video.position = index;
      if (isPersistableVideo(video)) {
        const desiredIndex = desiredIndexById.get(video.playlistItemId);
        const original = typeof video.originalOrder === 'number' ? video.originalOrder : desiredIndex;
        video.originalOrder = original;
        video.orderModified = desiredIndex !== original;
      } else {
        const original = typeof video.originalOrder === 'number' ? video.originalOrder : index;
        video.originalOrder = original;
        video.orderModified = index !== original;
      }

      if (hasPendingChanges(video)) {
        video.status = 'modified';
      } else if (video.status !== 'synced') {
        video.status = 'unchanged';
      }
    });
  }

  function buildReorderPlan() {
    const reorderTargets = editedVideos.filter((video) => video.orderModified);
    const skipped = reorderTargets.filter((video) => !isPersistableVideo(video)).length;
    const persistableVideos = editedVideos.filter(isPersistableVideo);
    const changedPersistable = reorderTargets.filter(isPersistableVideo).length;

    if (persistableVideos.length === 0) {
      return {
        operations: [],
        initialOrderIds: [],
        skipped,
        changedPersistable,
      };
    }

    const desiredOrderIds = persistableVideos.map((video) => video.playlistItemId);
    const currentOrderIds = [...persistableVideos]
      .sort((a, b) => {
        const aOrder = typeof a.originalOrder === 'number' ? a.originalOrder : Number.MAX_SAFE_INTEGER;
        const bOrder = typeof b.originalOrder === 'number' ? b.originalOrder : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      })
      .map((video) => video.playlistItemId);

    const videoByPlaylistItemId = new Map(persistableVideos.map((video) => [video.playlistItemId, video]));
    const workingOrder = [...currentOrderIds];
    const operations = [];

    for (let targetIndex = 0; targetIndex < desiredOrderIds.length; targetIndex++) {
      const desiredId = desiredOrderIds[targetIndex];
      if (workingOrder[targetIndex] === desiredId) continue;

      const fromIndex = workingOrder.indexOf(desiredId);
      if (fromIndex === -1) continue;

      const video = videoByPlaylistItemId.get(desiredId);
      if (!video) continue;

      operations.push({ video, targetIndex });
      workingOrder.splice(fromIndex, 1);
      workingOrder.splice(targetIndex, 0, desiredId);
    }

    return {
      operations,
      initialOrderIds: currentOrderIds,
      skipped,
      changedPersistable,
    };
  }

  function computeSyncPlan() {
    const videosToUpdate = editedVideos.filter((v) => hasSnippetChanges(v));
    const reorderPlan = buildReorderPlan();
    const reorderOperations = reorderPlan.operations;
    const reorderSkipped = reorderPlan.skipped;
    const reorderedChangedCount = reorderPlan.changedPersistable;
    const reorderedOnlyCount = editedVideos.filter((video) => video.orderModified && !hasSnippetChanges(video)).length;
    const playlistNeedsUpdate = !!(currentPlaylistEdit && currentPlaylistEdit.status === 'modified' && currentPlaylistEdit.playlistId);
    const videoQuota = videosToUpdate.length * 51; // fetch + update
    const playlistQuota = playlistNeedsUpdate ? 51 : 0; // fetch + update
    const reorderQuota = reorderOperations.length * 50; // playlistItems.update only
    const costEstimate = videoQuota + playlistQuota + reorderQuota;
    const opCount = videosToUpdate.length + (playlistNeedsUpdate ? 1 : 0) + reorderOperations.length;
    const videoApiCalls = videosToUpdate.length * 2; // videos.list + videos.update
    const playlistApiCalls = playlistNeedsUpdate ? 2 : 0; // playlists.list + playlists.update
    const reorderApiCalls = reorderOperations.length; // playlistItems.update
    const apiCallCount = videoApiCalls + playlistApiCalls + reorderApiCalls;

    return {
      videosToUpdate,
      reorderPlan,
      reorderOperations,
      reorderSkipped,
      reorderedChangedCount,
      reorderedOnlyCount,
      playlistNeedsUpdate,
      videoQuota,
      playlistQuota,
      reorderQuota,
      costEstimate,
      opCount,
      videoApiCalls,
      playlistApiCalls,
      reorderApiCalls,
      apiCallCount,
    };
  }

  function applyPersistedOrderState(persistedOrderIds) {
    const persistedIndexById = new Map(persistedOrderIds.map((id, index) => [id, index]));
    const desiredPersistable = editedVideos.filter(isPersistableVideo);
    const desiredIndexById = new Map(desiredPersistable.map((video, index) => [video.playlistItemId, index]));

    editedVideos.forEach((video) => {
      if (!isPersistableVideo(video)) return;
      const persistedIndex = persistedIndexById.get(video.playlistItemId);
      const desiredIndex = desiredIndexById.get(video.playlistItemId);
      if (persistedIndex == null || desiredIndex == null) return;

      video.originalOrder = persistedIndex;
      video.position = persistedIndex;
      video.orderModified = desiredIndex !== persistedIndex;

      if (video.status !== 'error') {
        video.status = hasPendingChanges(video) ? 'modified' : 'synced';
      }
    });
  }

  function sortVideos(field, direction) {
    if (editedVideos.length === 0) return;

    const order = direction === 'asc' ? 1 : -1;
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

    editedVideos.sort((a, b) => {
      if (field === 'title') {
        return collator.compare(a.newTitle || '', b.newTitle || '') * order;
      }

      const dateA = Date.parse(a.publishedAt || '');
      const dateB = Date.parse(b.publishedAt || '');
      const hasDateA = !Number.isNaN(dateA);
      const hasDateB = !Number.isNaN(dateB);

      if (!hasDateA && !hasDateB) return 0;
      if (!hasDateA) return 1;
      if (!hasDateB) return -1;
      return (dateA - dateB) * order;
    });

    syncOrderFlags();
    renderVideoList();
    updateStats();
    persistCurrentPlaylistDraft();
  }

  // --- Video List Rendering ---
  function renderVideoList(options = {}) {
    const skipEntryAnimation = !!options.skipEntryAnimation;
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
      const titleChanged = video.newTitle !== video.title;
      const descChanged = video.newDescription !== video.description;
      const titleTooltip = titleChanged ? ` title="${escapeAttr(getModifiedTooltip(video.title))}"` : '';
      const descTooltip = descChanged ? ` title="${escapeAttr(getModifiedTooltip(video.description))}"` : '';
      const orderOnlyChanged = video.orderModified && !hasSnippetChanges(video);
      const modifiedLabel = orderOnlyChanged ? 'Reordered' : 'Modified';
      const resetDisabled = hasPendingChanges(video) ? '' : 'disabled';
      const thumbnail = video.thumbnail
        ? `<img class="video-item__thumb" src="${escapeAttr(video.thumbnail)}" alt="${escapeAttr(`Thumbnail for ${video.newTitle || video.title || 'video'}`)}" loading="lazy" />`
        : '<div class="video-item__thumb video-item__thumb--placeholder">No thumbnail</div>';

      const item = document.createElement('div');
      item.className = `video-item ${video.status !== 'unchanged' ? 'video-item--' + video.status : ''} video-item--draggable`;
      if (skipEntryAnimation) {
        item.style.animation = 'none';
        item.style.animationDelay = '0s';
      } else {
        item.style.animationDelay = `${index * 0.04}s`;
      }
      item.dataset.index = index;
      item.dataset.videoKey = getVideoStableKey(video, index);
      item.draggable = true;

      const statusLabels = {
        unchanged: '',
        modified: `<span class="video-item__status video-item__status--pending">${modifiedLabel}</span>`,
        synced: '<span class="video-item__status video-item__status--synced">Synced ✓</span>',
        error: '<span class="video-item__status video-item__status--error">Error</span>',
      };
      const rightHandle = '<div class="video-item__drag video-item__drag--right" title="Drag and drop to reorder">☰</div>';
      const leftHandle = '<div class="video-item__drag video-item__drag--left" title="Drag and drop to reorder">☰</div>';

      item.innerHTML = `
        <div class="video-item__header">
          <div class="video-item__header-left">
            ${leftHandle}
            <div class="video-item__order">
              <span class="video-item__order-label">#</span>
              <input
                id="order-${index}"
                class="video-item__order-input"
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                value="${index + 1}"
                data-index="${index}"
                title="Edit order number and press Enter"
              />
            </div>
            <div class="video-item__meta">
              <div class="video-item__upload-date">${escapeHtml(formatUploadDate(video.publishedAt))}</div>
            </div>
          </div>
          <div class="video-item__header-right">
            ${statusLabels[video.status] || ''}
            <button class="video-item__reset-chip" data-index="${index}" ${resetDisabled} title="Reset this video changes">Reset Video</button>
            ${rightHandle}
          </div>
        </div>
        <div class="video-item__content">
          <div class="video-item__fields">
            <div class="video-item__field">
              <label for="title-${index}">Title</label>
              <input type="text" id="title-${index}" value="${escapeAttr(video.newTitle)}"
                data-index="${index}" data-field="newTitle"
                class="${titleChanged ? 'modified' : ''}"${titleTooltip} />
            </div>
            <div class="video-item__field">
              <label for="desc-${index}">Description</label>
              <textarea id="desc-${index}" rows="3"
                data-index="${index}" data-field="newDescription"
                class="${descChanged ? 'modified' : ''}"${descTooltip}>${escapeHtml(video.newDescription)}</textarea>
            </div>
          </div>
          <div class="video-item__media">
            ${thumbnail}
          </div>
        </div>
      `;

      // Bind input events
      const titleInput = item.querySelector(`#title-${index}`);
      const descInput = item.querySelector(`#desc-${index}`);
      const orderInput = item.querySelector(`#order-${index}`);
      const resetVideoButton = item.querySelector('.video-item__reset-chip');

      titleInput.addEventListener('input', handleFieldEdit);
      descInput.addEventListener('input', handleFieldEdit);
      orderInput.addEventListener('change', handleOrderInputChange);
      orderInput.addEventListener('keydown', handleOrderInputKeyDown);
      resetVideoButton.addEventListener('click', handleResetVideo);
      item.addEventListener('dragstart', (e) => handleDragStart(e, index));
      item.addEventListener('dragover', (e) => handleDragOver(e, index));
      item.addEventListener('dragleave', handleDragLeave);
      item.addEventListener('drop', (e) => handleDrop(e, index));
      item.addEventListener('dragend', handleDragEnd);

      container.appendChild(item);
    });
  }

  function handleOrderInputKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  function handleOrderInputChange(e) {
    const fromIndex = parseInt(e.currentTarget.dataset.index, 10);
    const requested = parseInt(e.currentTarget.value, 10);
    if (Number.isNaN(fromIndex) || Number.isNaN(requested) || editedVideos.length === 0) {
      renderVideoList();
      return;
    }

    const targetIndex = Math.min(Math.max(requested, 1), editedVideos.length) - 1;
    if (targetIndex === fromIndex) {
      e.currentTarget.value = String(fromIndex + 1);
      return;
    }

    moveVideoInList(fromIndex, targetIndex, { focusMovedOrderInput: true });
  }

  function moveVideoInList(fromIndex, targetIndex, options = {}) {
    if (fromIndex < 0 || targetIndex < 0 || fromIndex >= editedVideos.length || targetIndex >= editedVideos.length) return;
    const viewportAnchor = captureViewportAnchor();
    const previousPositions = captureVideoItemPositions();
    const movedKey = getVideoStableKey(editedVideos[fromIndex], fromIndex);
    const [moved] = editedVideos.splice(fromIndex, 1);
    editedVideos.splice(targetIndex, 0, moved);
    syncOrderFlags();
    renderVideoList({ skipEntryAnimation: true });
    restoreViewportAnchor(viewportAnchor);
    animateVideoItemReorder(previousPositions);
    if (options.focusMovedOrderInput) {
      window.requestAnimationFrame(() => focusOrderInputByVideoKey(movedKey));
    }
    updateStats();
    persistCurrentPlaylistDraft();
  }

  function handleResetVideo(e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    if (Number.isNaN(index) || index < 0 || index >= editedVideos.length) return;

    const video = editedVideos[index];
    video.newTitle = video.title;
    video.newDescription = video.description;
    delete video.errorMessage;

    const targetIndex = Math.max(0, Math.min(editedVideos.length - 1, video.originalOrder ?? index));
    if (targetIndex !== index) {
      moveVideoInList(index, targetIndex, { focusMovedOrderInput: false });
      return;
    }

    syncOrderFlags();
    renderVideoList({ skipEntryAnimation: true });
    updateStats();
    persistCurrentPlaylistDraft();
  }

  function handleFieldEdit(e) {
    const index = parseInt(e.target.dataset.index, 10);
    const field = e.target.dataset.field;
    editedVideos[index][field] = e.target.value;

    // Update status
    const v = editedVideos[index];
    const titleChanged = v.newTitle !== v.title;
    const descChanged = v.newDescription !== v.description;
    v.status = (titleChanged || descChanged || v.orderModified) ? 'modified' : (v.status === 'synced' ? 'synced' : 'unchanged');

    // Update CSS classes
    const changed = field === 'newTitle' ? titleChanged : descChanged;
    e.target.classList.toggle('modified', changed);
    if (changed) {
      const originalValue = field === 'newTitle' ? v.title : v.description;
      e.target.title = getModifiedTooltip(originalValue);
    } else {
      e.target.removeAttribute('title');
    }

    // Update the item's border
    const item = e.target.closest('.video-item');
    item.className = `video-item ${v.status !== 'unchanged' ? 'video-item--' + v.status : ''} video-item--draggable`;
    item.draggable = true;

    // Update status badge
    const header = item.querySelector('.video-item__header');
    const existingBadge = header.querySelector('.video-item__status');
    if (existingBadge) existingBadge.remove();
    if (v.status === 'modified') {
      const label = (v.orderModified && !hasSnippetChanges(v)) ? 'Reordered' : 'Modified';
      const rightContainer = header.querySelector('.video-item__header-right');
      rightContainer.insertAdjacentHTML('afterbegin', `<span class="video-item__status video-item__status--pending">${label}</span>`);
    }
    const resetButton = item.querySelector('.video-item__reset-chip');
    if (resetButton) {
      resetButton.disabled = !hasPendingChanges(v);
    }

    updateStats();
    persistCurrentPlaylistDraft();
  }

  function handleDragStart(e, index) {
    dragSourceIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    e.currentTarget.classList.add('video-item--dragging');
    document.body.classList.add('dragging-reorder');
  }

  function handleDragOver(e, index) {
    if (dragSourceIndex === null || dragSourceIndex === index) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('video-item--drop-target');
  }

  function handleDragLeave(e) {
    e.currentTarget.classList.remove('video-item--drop-target');
  }

  function handleDrop(e, targetIndex) {
    e.preventDefault();
    e.currentTarget.classList.remove('video-item--drop-target');

    if (dragSourceIndex === null || dragSourceIndex === targetIndex) return;
    const insertionIndex = dragSourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    moveVideoInList(dragSourceIndex, insertionIndex, { focusMovedOrderInput: false });
    dragSourceIndex = null;
  }

  function handleDragEnd() {
    $$('.video-item--dragging').forEach((el) => el.classList.remove('video-item--dragging'));
    $$('.video-item--drop-target').forEach((el) => el.classList.remove('video-item--drop-target'));
    dragSourceIndex = null;
    stopDragAutoScroll();
    document.body.classList.remove('dragging-reorder');
  }

  function handleGlobalDragOver(e) {
    if (dragSourceIndex === null) return;
    const viewportMargin = 96;
    const maxStep = 24;
    let dy = 0;

    if (e.clientY < viewportMargin) {
      dy = -Math.ceil(((viewportMargin - e.clientY) / viewportMargin) * maxStep);
    } else if (e.clientY > window.innerHeight - viewportMargin) {
      dy = Math.ceil(((e.clientY - (window.innerHeight - viewportMargin)) / viewportMargin) * maxStep);
    }

    dragAutoScrollVelocity = dy;
    if (dragAutoScrollRaf != null) return;
    const tick = () => {
      if (dragSourceIndex === null || dragAutoScrollVelocity === 0) {
        dragAutoScrollRaf = null;
        return;
      }
      window.scrollBy(0, dragAutoScrollVelocity);
      dragAutoScrollRaf = window.requestAnimationFrame(tick);
    };
    dragAutoScrollRaf = window.requestAnimationFrame(tick);
  }

  function stopDragAutoScroll() {
    dragAutoScrollVelocity = 0;
    if (dragAutoScrollRaf != null) {
      window.cancelAnimationFrame(dragAutoScrollRaf);
      dragAutoScrollRaf = null;
    }
  }

  // --- Export ---
  function handleExport() {
    if (editedVideos.length === 0) {
      toast('No videos to export.', 'error');
      return;
    }

    const exportData = buildCurrentPlaylistDocument();
    const playlistName = exportData.playlistTitle || 'playlist';

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
      dragSourceIndex = null;
      if (editedVideos.length > 0 && data.playlistId === currentPlaylistId) {
        // Match by playlistItemId/videoId and apply changes
        let matchCount = 0;
        const sourceVideos = Array.isArray(data.videos) ? data.videos : [];

        for (const imported of data.videos) {
          const key = getImportMatchKey(imported);
          const existing = key
            ? editedVideos.find((v) => getImportMatchKey(v) === key)
            : editedVideos.find((v) => v.videoId === imported.videoId);
          if (existing) {
            existing.newTitle = imported.title;
            existing.newDescription = imported.description;
            const titleChanged = existing.newTitle !== existing.title;
            const descChanged = existing.newDescription !== existing.description;
            existing.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';
            matchCount++;
          }
        }
        applyImportedOrder(sourceVideos);
        if (currentPlaylistEdit) {
          if (typeof data.playlistTitle === 'string') currentPlaylistEdit.newTitle = data.playlistTitle;
          if (typeof data.playlistDescription === 'string') currentPlaylistEdit.newDescription = data.playlistDescription;
          if (typeof data.playlistThumbnail === 'string') currentPlaylistEdit.thumbnail = data.playlistThumbnail;
          const titleChanged = currentPlaylistEdit.newTitle !== currentPlaylistEdit.title;
          const descChanged = currentPlaylistEdit.newDescription !== currentPlaylistEdit.description;
          currentPlaylistEdit.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';
        }
        syncOrderFlags();
        renderPlaylistEditor();
        toast(`Imported changes for ${matchCount} video(s).`, 'success');
      } else {
        // Load as standalone review data
        editedVideos = data.videos.map((v) => ({
          playlistItemId: v.playlistItemId || '',
          playlistId: v.playlistId || data.playlistId || '',
          position: typeof v.position === 'number' ? v.position : null,
          videoId: v.videoId,
          title: v.originalTitle || v.title,
          description: v.originalDescription || v.description,
          newTitle: v.title,
          newDescription: v.description,
          publishedAt: v.publishedAt || '',
          categoryId: v.categoryId || '',
          tags: v.tags || [],
          defaultLanguage: v.defaultLanguage || '',
          thumbnail: v.thumbnail || '',
          privacyStatus: '',
          _originalSnippet: null,
          status: (v.title !== (v.originalTitle || v.title) || v.description !== (v.originalDescription || v.description))
            ? 'modified' : 'unchanged',
        }));
        const importedByKey = new Map();
        for (const imported of data.videos) {
          const key = getImportMatchKey(imported);
          if (!key) continue;
          importedByKey.set(key, imported);
        }
        const { oneBasedPositions } = applyImportedOrder(data.videos);
        editedVideos.forEach((video, idx) => {
          const source = importedByKey.get(getImportMatchKey(video));
          let originalOrder = null;
          if (typeof source?.originalOrder === 'number') {
            originalOrder = source.originalOrder;
          } else if (typeof source?.position === 'number') {
            const normalized = oneBasedPositions ? source.position - 1 : source.position;
            originalOrder = normalized;
          }
          if (!Number.isFinite(originalOrder)) {
            originalOrder = idx;
          }
          originalOrder = Math.max(0, Math.min(editedVideos.length - 1, Math.trunc(originalOrder)));
          video.originalOrder = originalOrder;
          video.orderModified = idx !== originalOrder;
        });
        currentPlaylistId = data.playlistId || null;
        currentPlaylistEdit = {
          playlistId: data.playlistId || null,
          title: data.originalPlaylistTitle || data.playlistTitle || '',
          description: data.originalPlaylistDescription || data.playlistDescription || '',
          thumbnail: data.playlistThumbnail || '',
          newTitle: data.playlistTitle || '',
          newDescription: data.playlistDescription || '',
          status: 'unchanged',
        };
        currentPlaylistEdit.status =
          (currentPlaylistEdit.newTitle !== currentPlaylistEdit.title || currentPlaylistEdit.newDescription !== currentPlaylistEdit.description)
            ? 'modified'
            : 'unchanged';
        syncOrderFlags();
        renderPlaylistEditor();
        toast(`Imported ${editedVideos.length} video(s) from file.`, 'success');
      }

      renderVideoList();
      updateStats();
      persistCurrentPlaylistDraft();
    } catch (e) {
      toast('Failed to parse file: ' + e.message, 'error');
    }
  }

  function hasVideoChanges() {
    return editedVideos.some((video) => hasSnippetChanges(video) || video.orderModified);
  }

  function hasAnyCurrentChanges() {
    const playlistChanged = !!(currentPlaylistEdit && currentPlaylistEdit.status === 'modified' && currentPlaylistEdit.playlistId);
    return hasVideoChanges() || playlistChanged;
  }

  function resetVideoStateToOriginal() {
    if (editedVideos.length === 0) return;

    editedVideos.forEach((video) => {
      video.newTitle = video.title;
      video.newDescription = video.description;
      delete video.errorMessage;
    });

    editedVideos.sort((a, b) => {
      const aOrder = typeof a.originalOrder === 'number' ? a.originalOrder : Number.MAX_SAFE_INTEGER;
      const bOrder = typeof b.originalOrder === 'number' ? b.originalOrder : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });

    syncOrderFlags();
    editedVideos.forEach((video) => {
      if (!hasPendingChanges(video)) {
        video.status = 'unchanged';
      }
    });
  }

  function handleResetAllChanges() {
    if (!hasAnyCurrentChanges()) {
      toast('No changes to reset.', 'info');
      return;
    }
    if (!confirm('Reset all unsynced changes for this playlist (playlist details + videos)?')) {
      return;
    }

    resetVideoStateToOriginal();
    if (currentPlaylistEdit) {
      currentPlaylistEdit.newTitle = currentPlaylistEdit.title;
      currentPlaylistEdit.newDescription = currentPlaylistEdit.description;
      currentPlaylistEdit.status = 'unchanged';
    }

    renderVideoList({ skipEntryAnimation: true });
    renderPlaylistEditor();
    updateStats();
    persistCurrentPlaylistDraft();
    toast('All unsynced changes reset.', 'success');
  }

  // --- Batch Update ---
  async function handleBatchUpdate() {
    const plan = computeSyncPlan();
    const {
      videosToUpdate,
      reorderPlan,
      reorderOperations,
      reorderSkipped,
      reorderedChangedCount,
      reorderedOnlyCount,
      playlistNeedsUpdate,
      videoQuota,
      playlistQuota,
      reorderQuota,
      costEstimate,
      opCount,
    } = plan;

    if (videosToUpdate.length === 0 && !playlistNeedsUpdate && reorderOperations.length === 0) {
      if (reorderedOnlyCount > 0 || reorderSkipped > 0) {
        toast('No persistable reorder changes found for YouTube sync.', 'info');
      } else {
        toast('No modified fields to update.', 'info');
      }
      return;
    }

    const quota = API.getQuota();
    if (quota.used + costEstimate > quota.limit) {
      toast(`Estimated cost (${costEstimate} units) would exceed quota limit. Only ${quota.limit - quota.used} units remaining.`, 'error');
      return;
    }

    const summaryParts = [];
    if (videosToUpdate.length > 0) summaryParts.push(`${videosToUpdate.length} video metadata`);
    if (playlistNeedsUpdate) summaryParts.push('1 playlist metadata');
    if (reorderedChangedCount > 0) {
      summaryParts.push(`${reorderedChangedCount} reordered videos -> ${reorderOperations.length} reorder ops`);
    }
    if (reorderSkipped > 0) summaryParts.push(`${reorderSkipped} reorder ops (skipped: missing playlist item IDs)`);
    const quotaParts = [];
    if (videoQuota > 0) quotaParts.push(`videos ${videoQuota}`);
    if (playlistQuota > 0) quotaParts.push(`playlist ${playlistQuota}`);
    if (reorderQuota > 0) quotaParts.push(`reorder ${reorderQuota}`);
    const quotaBreakdown = quotaParts.length > 0 ? ` [${quotaParts.join(', ')}]` : '';
    if (!confirm(`Run ${opCount} operation(s): ${summaryParts.join(', ')}? Estimated quota cost: ${costEstimate} units${quotaBreakdown}.`)) {
      return;
    }

    batchRunning = true;
    showBatchProgress(0, opCount);
    $('#btn-batch-update').disabled = true;
    $('#btn-cancel-batch').classList.remove('hidden');

    let completed = 0;
    let errors = 0;

    if (playlistNeedsUpdate) {
      try {
        await API.updatePlaylistSnippet(
          currentPlaylistEdit.playlistId,
          currentPlaylistEdit.newTitle,
          currentPlaylistEdit.newDescription
        );
        currentPlaylistEdit.title = currentPlaylistEdit.newTitle;
        currentPlaylistEdit.description = currentPlaylistEdit.newDescription;
        currentPlaylistEdit.status = 'synced';
        const existing = playlists.find((p) => p.id === currentPlaylistEdit.playlistId);
        if (existing) {
          existing.title = currentPlaylistEdit.newTitle;
          existing.description = currentPlaylistEdit.newDescription;
          renderPlaylistSelector();
          $('#playlist-select').value = currentPlaylistEdit.playlistId;
        }
        completed++;
      } catch (e) {
        currentPlaylistEdit.status = 'error';
        errors++;
        console.error(`Failed to update playlist ${currentPlaylistEdit.playlistId}:`, e);
      }
      renderPlaylistEditor();
      showBatchProgress(completed + errors, opCount);
      if (batchRunning) await API.delay(500);
    }

    for (const video of videosToUpdate) {
      if (!batchRunning) {
        toast('Batch update cancelled.', 'info');
        break;
      }

      try {
        await API.updateVideoSnippet(video, video.newTitle, video.newDescription);
        // Update original data to reflect the sync
        video.title = video.newTitle;
        video.description = video.newDescription;
        video.status = video.orderModified ? 'modified' : 'synced';
        completed++;
      } catch (e) {
        video.status = 'error';
        video.errorMessage = e.message;
        errors++;
        console.error(`Failed to update ${video.videoId}:`, e);
      }

      showBatchProgress(completed + errors, opCount);
      renderVideoList();

      // 500ms delay between requests to avoid rate limiting
      if (batchRunning) await API.delay(500);
    }

    const persistedOrderIds = [...reorderPlan.initialOrderIds];
    for (const { video, targetIndex } of reorderOperations) {
      if (!batchRunning) {
        toast('Batch update cancelled.', 'info');
        break;
      }

      try {
        await API.updatePlaylistItemPosition(
          video.playlistItemId,
          video.playlistId,
          video.videoId,
          targetIndex
        );

        const currentIndex = persistedOrderIds.indexOf(video.playlistItemId);
        if (currentIndex !== -1) {
          persistedOrderIds.splice(currentIndex, 1);
          persistedOrderIds.splice(targetIndex, 0, video.playlistItemId);
          applyPersistedOrderState(persistedOrderIds);
        }

        completed++;
      } catch (e) {
        video.status = 'error';
        video.errorMessage = e.message;
        errors++;
        console.error(`Failed to reorder playlistItem ${video.playlistItemId}:`, e);
      }

      showBatchProgress(completed + errors, opCount);
      renderVideoList();

      // 500ms delay between requests to avoid rate limiting
      if (batchRunning) await API.delay(500);
    }

    batchRunning = false;
    hideBatchProgress();
    $('#btn-batch-update').disabled = false;
    $('#btn-cancel-batch').classList.add('hidden');
    updateStats();
    persistCurrentPlaylistDraft();

    if (errors > 0 || reorderSkipped > 0) {
      const skippedMsg = reorderSkipped > 0 ? `, ${reorderSkipped} reorder skipped` : '';
      toast(`Batch complete: ${completed} updated, ${errors} failed${skippedMsg}.`, 'error');
    } else {
      toast(`All ${completed} item(s) updated successfully!`, 'success');
    }
  }

  function cancelBatch() {
    batchRunning = false;
  }

  // --- UI Updates ---
  function updateStats() {
    const total = editedVideos.length;
    const hasAnyChanges = hasAnyCurrentChanges();
    const modifiedVideos = editedVideos.filter((v) => v.status === 'modified').length;
    const playlistModified = (currentPlaylistEdit?.status === 'modified' && currentPlaylistEdit?.playlistId) ? 1 : 0;
    const modified = modifiedVideos + playlistModified;
    const synced = editedVideos.filter((v) => v.status === 'synced').length;
    const syncPlan = computeSyncPlan();

    $('#stat-playlists').textContent = playlists.length;
    $('#stat-videos').textContent = total;
    $('#stat-modified').textContent = modified;
    $('#stat-synced').textContent = synced;

    // Toggle action buttons
    const hasVideos = total > 0;
    $('#btn-batch-update').disabled = syncPlan.opCount === 0;
    $('#btn-export').disabled = !hasVideos;
    $('#btn-reset-all').disabled = !hasAnyChanges;
    $('#btn-sort-title-asc').disabled = !hasVideos;
    $('#btn-sort-title-desc').disabled = !hasVideos;
    $('#btn-sort-date-asc').disabled = !hasVideos;
    $('#btn-sort-date-desc').disabled = !hasVideos;

    if (!hasVideos) {
      dragSourceIndex = null;
    }

    // Toggle drop zone vs video list
    const dropZone = $('#drop-zone');
    if (hasVideos) {
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
    updateBatchEstimateChip(computeSyncPlan());
  }

  function updateBatchEstimateChip(syncPlan) {
    const chip = $('#batch-estimate-chip');
    if (!chip) return;
    const quota = API.getQuota();

    if (syncPlan.opCount === 0) {
      chip.textContent = 'Next sync: 0 units';
      chip.title = 'No pending changes to sync.';
      chip.classList.remove('quota-chip--warn');
      return;
    }

    chip.textContent = `Next sync: ${syncPlan.costEstimate} units (${syncPlan.opCount} ops)`;
    const tooltipLines = [
      `Operations: ${syncPlan.opCount}`,
      `API calls: ${syncPlan.apiCallCount}`,
      `- Video metadata: ${syncPlan.videosToUpdate.length} ops, ${syncPlan.videoApiCalls} calls, ${syncPlan.videoQuota} units`,
      `- Playlist metadata: ${syncPlan.playlistNeedsUpdate ? 1 : 0} ops, ${syncPlan.playlistApiCalls} calls, ${syncPlan.playlistQuota} units`,
      `- Reorder: ${syncPlan.reorderOperations.length} ops, ${syncPlan.reorderApiCalls} calls, ${syncPlan.reorderQuota} units`,
    ];
    if (syncPlan.reorderSkipped > 0) {
      tooltipLines.push(`- Reorder skipped: ${syncPlan.reorderSkipped} (missing playlist item IDs)`);
    }
    tooltipLines.push(`Total estimated cost: ${syncPlan.costEstimate} units`);
    chip.title = tooltipLines.join('\n');
    const exceeds = quota.used + syncPlan.costEstimate > quota.limit;
    chip.classList.toggle('quota-chip--warn', exceeds);
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
  function restoreQuotaUsageForActiveAccount() {
    const persisted = Persistence.readQuotaUsed(activeAccountId);
    if (persisted == null) {
      API.setQuotaUsed(0);
      return;
    }
    API.setQuotaUsed(persisted);
  }

  function resolveDraftPreselectPlaylistId() {
    const draftIds = Persistence.getDraftPlaylistIds(activeAccountId);
    if (draftIds.size === 0) return '';

    const availableIds = new Set(playlists.map((playlist) => playlist.id));
    const lastWorking = Persistence.readLastWorkingPlaylist(activeAccountId);
    if (lastWorking && draftIds.has(lastWorking) && availableIds.has(lastWorking)) {
      return lastWorking;
    }

    for (const playlist of playlists) {
      if (draftIds.has(playlist.id)) return playlist.id;
    }
    return '';
  }

  function buildCurrentPlaylistDocument() {
    const playlistName = currentPlaylistEdit?.newTitle
      || playlists.find((p) => p.id === currentPlaylistId)?.title
      || 'playlist';

    return {
      playlistId: currentPlaylistId,
      playlistTitle: playlistName,
      playlistDescription: currentPlaylistEdit?.newDescription || '',
      playlistThumbnail: currentPlaylistEdit?.thumbnail || '',
      originalPlaylistTitle: currentPlaylistEdit?.title || '',
      originalPlaylistDescription: currentPlaylistEdit?.description || '',
      exportedAt: new Date().toISOString(),
      videos: editedVideos.map((video, index) => ({
        playlistItemId: video.playlistItemId || '',
        playlistId: video.playlistId || currentPlaylistId || '',
        position: index,
        originalOrder: typeof video.originalOrder === 'number' ? video.originalOrder : null,
        videoId: video.videoId,
        title: video.newTitle,
        description: video.newDescription,
        publishedAt: video.publishedAt || '',
        originalTitle: video.title,
        originalDescription: video.description,
      })),
    };
  }

  function loadPlaylistDraft(playlistId) {
    return Persistence.readPlaylistDraft(activeAccountId, playlistId);
  }

  function applyStoredDraftForCurrentPlaylist() {
    if (!currentPlaylistId || editedVideos.length === 0) return false;
    const draft = loadPlaylistDraft(currentPlaylistId);
    if (!draft) return false;

    const draftByKey = new Map();
    for (const entry of draft.videos) {
      const key = getImportMatchKey(entry);
      if (!key) continue;
      draftByKey.set(key, entry);
    }

    let updatedCount = 0;
    for (const video of editedVideos) {
      const source = draftByKey.get(getImportMatchKey(video));
      if (!source) continue;

      if (typeof source.title === 'string') {
        video.newTitle = source.title;
      }
      if (typeof source.description === 'string') {
        video.newDescription = source.description;
      }
      updatedCount++;
    }

    if (currentPlaylistEdit) {
      if (typeof draft.playlistTitle === 'string') {
        currentPlaylistEdit.newTitle = draft.playlistTitle;
      }
      if (typeof draft.playlistDescription === 'string') {
        currentPlaylistEdit.newDescription = draft.playlistDescription;
      }
      if (typeof draft.playlistThumbnail === 'string') {
        currentPlaylistEdit.thumbnail = draft.playlistThumbnail;
      }
      const titleChanged = currentPlaylistEdit.newTitle !== currentPlaylistEdit.title;
      const descChanged = currentPlaylistEdit.newDescription !== currentPlaylistEdit.description;
      currentPlaylistEdit.status = (titleChanged || descChanged) ? 'modified' : 'unchanged';
    }

    applyImportedOrder(draft.videos);
    syncOrderFlags();
    return updatedCount > 0 || (currentPlaylistEdit?.status === 'modified');
  }

  function persistCurrentPlaylistDraft() {
    if (!currentPlaylistId) return;

    if (!hasAnyCurrentChanges()) {
      Persistence.removePlaylistDraft(activeAccountId, currentPlaylistId);
      refreshPlaylistSelectorDraftMarkers();
      return;
    }

    const payload = buildCurrentPlaylistDocument();
    Persistence.writePlaylistDraft(activeAccountId, currentPlaylistId, payload);
    Persistence.writeLastWorkingPlaylist(activeAccountId, currentPlaylistId);
    refreshPlaylistSelectorDraftMarkers();
  }

  function refreshPlaylistSelectorDraftMarkers() {
    const select = $('#playlist-select');
    if (!select || playlists.length === 0) return;
    const selected = select.value || currentPlaylistId || '';
    renderPlaylistSelector();
    if (selected) {
      select.value = selected;
    }
  }

  function getVideoStableKey(video, index) {
    if (!video) return `idx:${index}`;
    if (video._stableKey) return video._stableKey;

    const videoId = String(video.videoId || '').trim();
    const playlistItemId = String(video.playlistItemId || '').trim();
    const originalOrder = typeof video.originalOrder === 'number' ? video.originalOrder : index;

    if (videoId && playlistItemId) {
      video._stableKey = `vid:${videoId}|pli:${playlistItemId}`;
      return video._stableKey;
    }
    if (videoId) {
      // Include original order so duplicate video IDs still produce stable distinct keys.
      video._stableKey = `vid:${videoId}|o:${originalOrder}`;
      return video._stableKey;
    }
    if (playlistItemId) {
      video._stableKey = `pli:${playlistItemId}`;
      return video._stableKey;
    }

    video._stableKey = `idx:${index}|o:${originalOrder}`;
    return video._stableKey;
  }

  function getImportMatchKey(video) {
    if (!video) return '';
    const playlistItemId = String(video.playlistItemId || '').trim();
    if (playlistItemId) return `pli:${playlistItemId}`;
    const videoId = String(video.videoId || '').trim();
    if (videoId) return `vid:${videoId}`;
    return '';
  }

  function buildImportedOrderPlan(importedVideos, totalCount) {
    const rawSteps = [];
    for (const imported of importedVideos || []) {
      const key = getImportMatchKey(imported);
      if (!key) continue;
      const rawPosition = Number(imported.position);
      if (!Number.isFinite(rawPosition)) continue;
      rawSteps.push({
        key,
        position: Math.trunc(rawPosition),
      });
    }

    if (rawSteps.length === 0 || totalCount <= 0) {
      return { steps: [], oneBasedPositions: false };
    }

    const hasZero = rawSteps.some((step) => step.position === 0);
    const oneBasedPositions = !hasZero && rawSteps.every((step) => step.position >= 1 && step.position <= totalCount);
    const steps = rawSteps.map((step) => {
      const normalized = oneBasedPositions ? step.position - 1 : step.position;
      return {
        key: step.key,
        targetIndex: Math.max(0, Math.min(totalCount - 1, normalized)),
      };
    });

    return { steps, oneBasedPositions };
  }

  function applyImportedOrder(importedVideos) {
    const { steps, oneBasedPositions } = buildImportedOrderPlan(importedVideos, editedVideos.length);
    if (steps.length === 0) {
      return { movedCount: 0, oneBasedPositions };
    }

    let movedCount = 0;
    for (const step of steps) {
      const currentIndex = editedVideos.findIndex((video) => getImportMatchKey(video) === step.key);
      if (currentIndex === -1 || currentIndex === step.targetIndex) continue;

      const [moved] = editedVideos.splice(currentIndex, 1);
      editedVideos.splice(step.targetIndex, 0, moved);
      movedCount++;
    }

    return { movedCount, oneBasedPositions };
  }

  function captureViewportAnchor() {
    const items = Array.from($$('#video-list .video-item'));
    if (items.length === 0) return null;

    const anchorItem = items.find((item) => item.getBoundingClientRect().bottom > 0) || items[0];
    return {
      key: anchorItem.dataset.videoKey,
      top: anchorItem.getBoundingClientRect().top,
    };
  }

  function restoreViewportAnchor(anchor) {
    if (!anchor?.key) return;

    const anchorItem = Array.from($$('#video-list .video-item'))
      .find((item) => item.dataset.videoKey === anchor.key);
    if (!anchorItem) return;

    const delta = anchorItem.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) {
      window.scrollBy(0, delta);
    }
  }

  function captureVideoItemPositions() {
    const positions = new Map();
    $$('#video-list .video-item').forEach((item) => {
      const key = item.dataset.videoKey;
      if (!key) return;
      positions.set(key, item.getBoundingClientRect().top);
    });
    return positions;
  }

  function animateVideoItemReorder(previousPositions) {
    if (!previousPositions || previousPositions.size === 0) return;

    $$('#video-list .video-item').forEach((item) => {
      const key = item.dataset.videoKey;
      if (!key) return;
      const previousTop = previousPositions.get(key);
      if (previousTop == null) return;

      const currentTop = item.getBoundingClientRect().top;
      const deltaY = previousTop - currentTop;
      if (Math.abs(deltaY) < 1) return;

      item.style.transition = 'none';
      item.style.transform = `translateY(${deltaY}px)`;
      item.style.willChange = 'transform';

      window.requestAnimationFrame(() => {
        item.style.transition = 'transform 1200ms var(--ease-out)';
        item.style.transform = 'translateY(0)';
        const clear = () => {
          item.style.transition = '';
          item.style.transform = '';
          item.style.willChange = '';
          item.removeEventListener('transitionend', clear);
        };
        item.addEventListener('transitionend', clear);
      });
    });
  }

  function focusOrderInputByVideoKey(videoKey) {
    if (!videoKey) return;

    for (const item of $$('#video-list .video-item')) {
      if (item.dataset.videoKey !== videoKey) continue;
      const input = item.querySelector('.video-item__order-input');
      if (!input) return;
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(0, input.value.length);
      } catch {
        input.select();
      }
      return;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function formatUploadDate(publishedAt) {
    const dt = new Date(publishedAt || '');
    if (Number.isNaN(dt.getTime())) return 'Upload date unavailable';
    return `Uploaded ${dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
  }

  function getModifiedTooltip(originalValue) {
    const normalized = String(originalValue == null ? '' : originalValue).replace(/\s+/g, ' ').trim();
    const preview = normalized.length > 220 ? normalized.slice(0, 220) + '…' : normalized;
    return `Original: ${preview || '(empty)'}`;
  }

  function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  return { init };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
