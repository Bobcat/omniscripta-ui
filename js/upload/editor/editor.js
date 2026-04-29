import { loadSettings as apiLoadSettings, saveSettings as apiSaveSettings, fetchJobStatus as apiFetchJobStatus, fetchSrt as apiFetchSrt, getApiUrl } from "../../api.js";
import { safePreview, normSpeaker, secondsToTimecodeWhole, hashString, _parseSrt, extractMetadata } from "../../utils.js";
import { TextView } from "./ui/TextView.js";
import { TopicsView } from "./ui/TopicsView.js";
import { AudioPlayer } from "./ui/AudioPlayer.js";
import {
  secondsToSrtTimecode,
  suggestSrtName as _suggestSrtName,
  saveSrtLocally as _saveSrtLocally
} from "./export/editorSave.js";
import {
  findNext as _findNext,
  replaceCurrent as _replaceCurrent, openReplaceAllConfirm as _openReplaceAllConfirm,
  closeReplaceAllConfirm as _closeReplaceAllConfirm, doReplaceAllConfirmed as _doReplaceAllConfirmed,
  openFindModal as _openFindModal, closeFindModal as _closeFindModal,
  getTranscriptSelectionText as _getTranscriptSelectionText,
} from "./editorFind.js";
import {
  getRowBySegId as _getRowBySegId, reindexAllRows as _reindexAllRows,
  insertRowAtIndex as _insertRowAtIndex, removeRowBySegId as _removeRowBySegId,
  moveRowBySegIdToIndex as _moveRowBySegIdToIndex, applySegStartNoHistory as _applySegStartNoHistory,
  canJoinAtIndex as _canJoinAtIndex, joinWithPrevious as _joinWithPrevious,
  splitSegment as _splitSegment
} from "./editorSegments.js";
import { actionToDebugJson, timecodeToSeconds, nowHHMMSS } from "./editorHelpers.js";
import { getEditorBootDom } from "./ui/editorDom.js";
import { setupHistoryModal, setupHelpModal, setupSettingsModal } from "./ui/editorModals.js";
import { ModalController, createDialogDragController } from "@spa-foundation/core";
import { createSpeakerDropdownController } from "./ui/editorSpeakerDropdown.js";
import {
  wireEditorHotkeys as shortcutsWireEditorHotkeys,
} from "./editorShortcuts.js";
import {
  seekRelative as playbackSeekRelative,
  findSegmentIndexAtTime as playbackFindSegmentIndexAtTime,
  snapToVisibleIfNeeded as playbackSnapToVisibleIfNeeded,
  enforceFilteredPlayback as playbackEnforceFilteredPlayback,
  wirePlaybackLoopEvents as playbackWirePlaybackLoopEvents,
} from "./editorPlayback.js";
import {
  isFilterActive as filtersIsFilterActive,
  matchesFilter as filtersMatchesFilter,
  isVisibleNow as filtersIsVisibleNow,
  clearFilterState as filtersClearFilterState,
  showFilterNotice as filtersShowFilterNotice,
  hideFilterNotice as filtersHideFilterNotice,
  pruneForcedVisibleIds as filtersPruneForcedVisibleIds,
  forceVisibleIfFilteredOut as filtersForceVisibleIfFilteredOut,
  updateFilterBarUI as filtersUpdateFilterBarUI,
  rebuildFilterSpeakerOptions as filtersRebuildFilterSpeakerOptions,
  syncFilterUIFromState as filtersSyncFilterUIFromState,
  openFilterModal as filtersOpenFilterModal,
  closeFilterModal as filtersCloseFilterModal,
  applyFilterFromModalControls as filtersApplyFilterFromModalControls,
  wireFilterControlEvents as filtersWireFilterControlEvents,
  createFilterApplyScheduler as filtersCreateFilterApplyScheduler,
} from "./editorFilters.js";
import { setupExportModal } from "./export/editorExportModal.js";
// ... imports ...
export function mountEditor(options = {}) {
  // Capture options if needed
  const { jobId, audioUrl, srtUrlPreview, startTime, srtContent, canUseFileSystem, app } = options;
  const queryEditorMode = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const mode = String(params.get("mode") || params.get("viewMode") || "").trim();
      return (mode === "text" || mode === "segments") ? mode : null;
    } catch {
      return null;
    }
  })();

  const {
    transcriptInput,
    audioInput,
    transcriptBtnLabelEl,
    audioBtnLabelEl,
    segmentsDiv,
    player,
    customPlayerContainer,
    textViewDiv,
    modeSegmentsBtn,
    modeTextBtn,
    saveBtn,
    saveAsBtn,
    historyBtn,
    historyModal,
    closeHistoryBtn,
    undoListEl,
    redoListEl,
    undoCountEl,
    redoCountEl,
    detailsEl,
  } = getEditorBootDom();

  // Mobile Detection moved to App.js
  // We rely on document.body.classList having 'mobile' or 'desktop' set by App.detectDeviceType()
  function setChosenFileLabel(labelEl, name, chooseText, kind) {
    if (!labelEl) return;
    const txt = chooseText || '';
    // Keep button labels stable (always "Choose …"); the current file name only appears in the tooltip.
    labelEl.textContent = txt;
    const k = kind ? String(kind) : 'file';
    if (name) {
      labelEl.title = `Click to change ${k}: ${name}`;
      labelEl.classList.remove('muted');
      labelEl.dataset.chosen = "1";
    } else {
      labelEl.title = txt;
      labelEl.classList.add('muted');
      labelEl.dataset.chosen = "0";
    }
  }


  let editorMode = queryEditorMode
    ? queryEditorMode
    : (options.lastViewMode === 'text' || options.lastViewMode === 'segments')
      ? options.lastViewMode
      : (document.body.classList.contains('mobile') ? 'text' : 'segments');

  // Component Instances
  const textView = new TextView({
    containerId: 'textView',
    onSeek: (time, segId) => {
      // When clicking text view, jump player and activate segment
      if (segId) {
        // Mobile UX: Close sidebar if open when clicking a segment
        if (app && typeof app.isMobile === 'function' && app.isMobile()) {
          if (typeof app.toggleSidebar === 'function') app.toggleSidebar(false);
        }

        const idx = findIndexById(segId);
        if (idx >= 0) {
          // preserveScroll=false (default?) or true? We want to jump segments view too?
          // Actually old logic was: player.currentTime = seg.start; setActiveSegment...
          setActiveSegment(idx, 'auto', 'center', true); // Instant jump on click
          player.currentTime = segments[idx].start;
        }
      }
    },
    getSegments: () => getTextViewSegmentsInOrder() // Uses the existing helper
  });

  const topicsView = new TopicsView({
    containerId: 'topicsView',
    onSeek: (time) => {
      if (Number.isFinite(time)) {
        player.currentTime = time;
        // Also sync textView position immediately (even if paused)
        // Find segment containing time, OR the first segment starting after time
        let seg = segments.find(s => s.start <= time && s.end > time);

        if (!seg) {
          // Fallback: find closest next segment (for gaps)
          seg = segments.find(s => s.start > time);
        }

        if (seg) {
          const idx = segments.indexOf(seg);
          if (idx >= 0) {
            setActiveSegment(idx, 'smooth', 'center', true);
          }
        }
      }
    }
  }); // TopicsView needs to be loaded later

  const customPlayer = new AudioPlayer({
    audioElement: player,
    container: customPlayerContainer
  });

  if (startTime && typeof startTime === 'number') {
    player.currentTime = startTime;
  }

  // Sync Topics View on timeupdate
  player.addEventListener('timeupdate', () => {
    if (topicsView && topicsView.container && !topicsView.container.classList.contains('hidden')) {
      topicsView.setActiveTime(player.currentTime);
    }
  });

  function syncTopicsFromSrtText(srtText) {
    const meta = extractMetadata(String(srtText || ''));
    const topics = (meta && Array.isArray(meta.topics) && meta.topics.length > 0) ? meta.topics : [];
    const splitter = document.getElementById('docViewSplitter');
    const docContainer = document.getElementById('docViewContainer');

    topicsView.topics = topics;
    topicsView.render();

    if (topicsView.container) topicsView.container.classList.toggle('hidden', topics.length === 0);
    if (splitter) splitter.classList.toggle('hidden', topics.length === 0);
    if (docContainer) docContainer.classList.toggle('no-topics', topics.length === 0);
  }

  let historySelected = null; // {stack:'undo'|'redo', hid:number}
  let historyNextId = 1;


  function renderHistory() {
    if (!historyModal || historyModal.classList.contains('hidden')) return;

    const buildList = (el, stack, items) => {
      el.innerHTML = '';
      // show newest first
      const arr = items.slice().reverse();
      for (const a of arr) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-item';
        btn.dataset.stack = stack;
        btn.dataset.hid = String(a.hid);

        const left = document.createElement('div');
        left.className = 'left';
        const label = a.label || '(actie)';
        const summary = a.summary ? ` — ${a.summary}` : '';
        left.textContent = `${label}${summary}`;

        const right = document.createElement('div');
        right.className = 'right';
        right.textContent = `#${a.hid}`;

        btn.appendChild(left);
        btn.appendChild(right);

        btn.addEventListener('click', () => {
          historySelected = { stack, hid: a.hid };
          // highlight
          document.querySelectorAll('.history-item.active').forEach(x => x.classList.remove('active'));
          btn.classList.add('active');
          detailsEl.textContent = actionToDebugJson(a);
        });

        el.appendChild(btn);
      }
    };

    if (undoCountEl) undoCountEl.textContent = `(${undoStack.length})`;
    if (redoCountEl) redoCountEl.textContent = `(${redoStack.length})`;

    buildList(undoListEl, 'undo', undoStack);
    buildList(redoListEl, 'redo', redoStack);

    if (detailsEl && (!historySelected)) detailsEl.textContent = '(click an item)';
  }

  const { openHistoryModal, closeHistoryModal } = setupHistoryModal({
    historyBtn,
    closeHistoryBtn,
    historyModal,
    player,
    clearSelection: () => { historySelected = null; },
    detailsEl,
    renderHistory,
  });


  // -------------------------
  // Find / Replace
  // -------------------------
  const findBtn = document.getElementById('findBtn');
  const findModal = document.getElementById('findModal');
  const closeFindBtn = document.getElementById('closeFindBtn');
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  const optRegex = document.getElementById('optRegex');
  const optCase = document.getElementById('optCase');
  const optWords = document.getElementById('optWords');
  const optWrap = document.getElementById('optWrap');
  const findNextBtn = document.getElementById('findNextBtn');
  const replaceBtn = document.getElementById('replaceBtn');
  const replaceAllBtn = document.getElementById('replaceAllBtn');
  const findStatus = document.getElementById('findStatus');

  const findCard = findModal ? findModal.querySelector('.find-card') : null;
  const findDragHandle = document.getElementById('findDragHandle');

  const findDrag = createDialogDragController((x, y) => {
    if (findCard) {
      findCard.style.setProperty('--drag-x', `${x}px`);
      findCard.style.setProperty('--drag-y', `${y}px`);
    }
  });
  function resetFindDrag() { findDrag.reset(); }
  function onFindDragUp() { findDrag.onUp(); }

  if (findDragHandle) {
    findDragHandle.addEventListener('mousedown', findDrag.onMouseDown);
  }



  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');
  const closeHelpBtn = document.getElementById('closeHelpBtn');
  const helpCard = helpModal ? helpModal.querySelector('.help-card') : null;
  const helpDragHandle = document.getElementById('helpDragHandle');

  const helpDrag = createDialogDragController((x, y) => {
    if (helpCard) {
      helpCard.style.setProperty('--drag-x', `${x}px`);
      helpCard.style.setProperty('--drag-y', `${y}px`);
    }
  });

  if (helpDragHandle) {
    helpDragHandle.addEventListener('mousedown', helpDrag.onMouseDown);
  }

  const { openHelpModal, closeHelpModal } = setupHelpModal({
    helpBtn,
    closeHelpBtn,
    helpModal,
    player,
  });


  // -------------------------
  // Filter (speaker / changed) + playback skipping
  // -------------------------
  const filterBtn = document.getElementById('filterBtn');
  const filterModal = document.getElementById('filterModal');
  const closeFilterBtn = document.getElementById('closeFilterBtn');
  const filterCard = filterModal ? filterModal.querySelector('.filter-card') : null;
  const filterDragHandle = document.getElementById('filterDragHandle');

  const filterDrag = createDialogDragController((x, y) => {
    if (filterCard) {
      filterCard.style.setProperty('--drag-x', `${x}px`);
      filterCard.style.setProperty('--drag-y', `${y}px`);
    }
  });

  if (filterDragHandle) {
    filterDragHandle.addEventListener('mousedown', filterDrag.onMouseDown);
  }

  const filterClearBtn3 = document.getElementById('filterClearBtn3');
  const filterSpeakersList = document.getElementById('filterSpeakersList');

  const filterBar = document.getElementById('filterBar');
  const filterChipsEl = document.getElementById('filterChips');
  const filterCountEl = document.getElementById('filterCount');
  const filterClearBtn = document.getElementById('filterClearBtn');

  const filterNotice = document.getElementById('filterNotice');
  const filterNoticeText = document.getElementById('filterNoticeText');
  const filterStrictBtn = document.getElementById('filterStrictBtn');

  const playFilteredToggle = document.getElementById('playFilteredToggle');

  const filterState = {
    speakers: new Set(),      // empty = all
    changedMode: 'all',       // 'all' | 'changed' | 'unchanged'
    doneMode: 'all',          // 'all' | 'done' | 'undone'
    playbackFiltered: true,   // skip hidden while playing
  };

  const forcedVisibleIds = new Set(); // segments that stay visible even if filtered out

  // ---- Done workflow (meta, not part of transcript) ----
  function doneKeyForSeg(seg) {
    if (!seg) return '';
    const sec = Math.round(seg.start || 0);
    const sp = normSpeaker(seg.speaker);
    const tx = String(seg.text || '').trim();
    return `${sec}|${sp}|${tx}`;
  }

  function transcriptSignatureForDone() {
    // Signature independent of blocks: stable across "reblocked" transcripts.
    const parts = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) parts[i] = doneKeyForSeg(segments[i]);
    return String(hashString(parts.join('\n')) >>> 0);
  }

  let _doneStorageKey = null;

  function loadDoneFromStorage() {
    doneSegIds = new Set();
    try {
      _doneStorageKey = 'te_done_v1:' + transcriptSignatureForDone();
      const raw = localStorage.getItem(_doneStorageKey);
      if (!raw) return;
      const keys = JSON.parse(raw);
      const keySet = new Set(Array.isArray(keys) ? keys : []);
      for (const seg of segments) {
        if (keySet.has(doneKeyForSeg(seg))) doneSegIds.add(seg.id);
      }
    } catch { }
  }

  function saveDoneToStorage() {
    try {
      if (!_doneStorageKey) _doneStorageKey = 'te_done_v1:' + transcriptSignatureForDone();
      const keys = [];
      for (const seg of segments) {
        if (doneSegIds.has(seg.id)) keys.push(doneKeyForSeg(seg));
      }
      localStorage.setItem(_doneStorageKey, JSON.stringify(keys));
    } catch { }
  }

  function updateDonePill() {
    const pill = document.getElementById('donePill');
    if (!pill) return;
    let done = 0;
    for (const seg of segments) { if (doneSegIds.has(seg.id)) done++; }
    pill.textContent = `Done: ${done}/${segments.length}`;
  }

  // ---- Repeat loop (segment-to-segment) ----
  const loopPill = document.getElementById('loopPill');

  const loopState = {
    mode: 'off',      // 'off' | 'armed' | 'active'
    startId: null,
    endId: null
  };

  // Repeat a single segment (nested loop over the current A→B loop, if any)
  const repeatSegState = {
    active: false,
    segId: null
  };

  function getRepeatSegBounds() {
    if (!repeatSegState.active) return null;
    const idx = findIndexById(repeatSegState.segId);
    if (idx === -1) return null;
    const start = segments[idx].start;
    const end = computeLoopEndTime(idx);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 1e-4) return null;
    return { start, end, segId: repeatSegState.segId };
  }

  function getEffectiveLoopBounds() {
    const r = getRepeatSegBounds();
    if (r) return { start: r.start, end: r.end, mode: 'repeat', segId: r.segId };
    const b = getLoopBounds();
    if (b) return { start: b.start, end: b.end, mode: 'range', startId: b.startId, endId: b.endId };
    return null;
  }

  function updateRepeatBadges() {
    try {
      const old = segmentsDiv.querySelectorAll('.done-btn[data-repeatmark]');
      old.forEach(b => b.removeAttribute('data-repeatmark'));
    } catch { }

    // Delegate to TextView
    try {
      const sid = (repeatSegState && repeatSegState.active) ? repeatSegState.segId : null;
      textView.updateRepeatBadge(sid);
    } catch (e) { console.warn(e); }

    if (!repeatSegState || !repeatSegState.active) return;

    try {
      const row = getRowBySegId(repeatSegState.segId);
      const btn = row ? row.querySelector('.done-btn') : null;
      if (btn) btn.setAttribute('data-repeatmark', 'R');
    } catch { }
  }

  function clearRepeatSeg(opts = {}) {
    repeatSegState.active = false;
    repeatSegState.segId = null;
    updateLoopUI();
    if (!opts.silent) {
      try { clampToLoopStartIfNeeded(); } catch { }
    }
  }

  function toggleRepeatSeg(idx) {
    if (idx < 0 || idx >= segments.length) return;
    const segId = segments[idx].id;
    if (!segId) return;

    // Toggle off if same segment
    if (repeatSegState.active && repeatSegState.segId === segId) {
      clearRepeatSeg();
      return;
    }

    // Activate (nested over any existing A→B loop)
    repeatSegState.active = true;
    repeatSegState.segId = segId;
    updateLoopUI();

    const b = getRepeatSegBounds();
    if (b) {
      try { player.currentTime = b.start; } catch { }
      try {
        if (player.paused) player.play();
      } catch { }
    }
  }

  function loopLabelForBounds(b) {
    return `Loop: ${secondsToTimecodeWhole(b.start)} — ${secondsToTimecodeWhole(b.end)}`;
  }

  function computeLoopEndTime(idx) {
    if (idx < 0 || idx >= segments.length) return null;
    const s = segments[idx];
    let end = s.end;
    if (!Number.isFinite(end) || end <= s.start + 1e-4) {
      if (idx + 1 < segments.length) end = segments[idx + 1].start;
      else if (Number.isFinite(player.duration) && player.duration > 0) end = player.duration;
    }
    if (!Number.isFinite(end) || end <= s.start + 1e-4) end = s.start + 0.25;
    return end;
  }

  function getLoopBounds() {
    if (loopState.mode !== 'active') return null;
    const aIdx = findIndexById(loopState.startId);
    const bIdx = findIndexById(loopState.endId);
    if (aIdx === -1 || bIdx === -1) return null;
    const start = segments[aIdx].start;
    const end = computeLoopEndTime(bIdx);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 1e-4) return null;
    return { start, end, startId: loopState.startId, endId: loopState.endId };
  }

  function clearLoop(opts = {}) {
    loopState.mode = 'off';
    loopState.startId = null;
    loopState.endId = null;
    if (!opts.silent) updateLoopUI();
  }

  function updateLoopBadges() {
    try {
      const old = segmentsDiv.querySelectorAll('.done-btn[data-loopmark]');
      old.forEach(b => b.removeAttribute('data-loopmark'));
    } catch { }

    // Delegate to TextView
    try {
      const mode = (loopState && loopState.mode) ? loopState.mode : 'off';
      textView.updateLoopBadges(loopState.startId, loopState.endId, mode);
    } catch (e) { console.warn(e); }

    if (!loopState || loopState.mode === 'off') return;

    const mark = (segId, markChar) => {
      if (!segId) return;

      // Segments view badge (on Done button)
      try {
        const row = getRowBySegId(segId);
        const btn = row ? row.querySelector('.done-btn') : null;
        if (btn) {
          const ex = btn.getAttribute('data-loopmark');
          if (ex && ex !== markChar) btn.setAttribute('data-loopmark', ex + markChar); // e.g. "AB"
          else btn.setAttribute('data-loopmark', markChar);
        }
      } catch { }
    };

    mark(loopState.startId, 'A');
    if (loopState.mode === 'active' && loopState.endId) {
      mark(loopState.endId, 'B');
    }
  }

  function updateLoopUI() {
    // Validate repeat segment loop
    if (repeatSegState.active) {
      const rb = getRepeatSegBounds();
      if (!rb) { clearRepeatSeg({ silent: true }); }
    }

    // Validate A→B loop
    if (loopState.mode === 'active') {
      const b = getLoopBounds();
      if (!b) { clearLoop({ silent: true }); }
    } else if (loopState.mode === 'armed') {
      const aIdx = findIndexById(loopState.startId);
      if (aIdx === -1) { clearLoop({ silent: true }); }
    }

    updateLoopBadges();
    updateRepeatBadges();

    if (!loopPill) return;

    // If repeating a single segment, show that as the active loop (nested over A→B loop)
    if (repeatSegState.active) {
      const rb = getRepeatSegBounds();
      if (!rb) {
        loopPill.classList.add('hidden');
        loopPill.textContent = 'Loop: —';
        loopPill.title = 'Repeat loop (F6). Repeat segment (F2).';
        return;
      }
      loopPill.classList.remove('hidden');
      loopPill.textContent = `Repeat: ${secondsToTimecodeWhole(rb.start)} — ${secondsToTimecodeWhole(rb.end)}`;
      let base = 'off';
      if (loopState.mode === 'armed') base = 'armed';
      else if (loopState.mode === 'active') base = 'active';
      loopPill.title = `Repeat segment active (F2 to clear). Base loop: ${base}. Click to clear repeat.`;
      return;
    }

    // Otherwise show the A→B loop state
    if (loopState.mode === 'off') {
      loopPill.classList.add('hidden');
      loopPill.textContent = 'Loop: —';
      loopPill.title = 'Repeat loop (F6). Click to clear.';
      return;
    }

    loopPill.classList.remove('hidden');

    if (loopState.mode === 'armed') {
      const aIdx = findIndexById(loopState.startId);
      const aStart = (aIdx !== -1) ? segments[aIdx].start : 0;
      loopPill.textContent = `Loop: start @ ${secondsToTimecodeWhole(aStart)}`;
      loopPill.title = 'Loop start set. Select the end segment and press F6 again. Click to clear.';
      return;
    }

    const b = getLoopBounds();
    if (!b) {
      loopPill.textContent = 'Loop: —';
      loopPill.title = 'Repeat loop (F6). Click to clear.';
      loopPill.classList.add('hidden');
      return;
    }

    loopPill.textContent = loopLabelForBounds(b);
    loopPill.title = 'Repeat loop active (F6 to clear). Click to clear.';
  }

  function clampToLoopStartIfNeeded() {
    const b = getEffectiveLoopBounds();
    if (!b) return;
    const t = player.currentTime;
    if (!(t >= b.start && t < b.end)) {
      player.currentTime = b.start;
    }
  }

  function handleLoopHotkey(idx) {
    if (idx < 0 || idx >= segments.length) return;
    const segId = segments[idx].id;
    if (!segId) return;

    if (loopState.mode === 'off') {
      loopState.mode = 'armed';
      loopState.startId = segId;
      loopState.endId = null;
      updateLoopUI();
      return;
    }

    if (loopState.mode === 'armed') {
      loopState.endId = segId;

      // Ensure ordering by transcript order (swap if needed)
      const aIdx = findIndexById(loopState.startId);
      const bIdx = findIndexById(loopState.endId);
      if (aIdx === -1 || bIdx === -1) {
        clearLoop();
        return;
      }
      if (bIdx < aIdx) {
        const tmp = loopState.startId;
        loopState.startId = loopState.endId;
        loopState.endId = tmp;
      }

      loopState.mode = 'active';
      updateLoopUI();

      // Clamp immediately if currently playing/seeking outside
      try { clampToLoopStartIfNeeded(); } catch { }
      return;
    }

    // active -> clear
    clearLoop();
  }

  if (loopPill) {
    loopPill.addEventListener('click', () => {
      if (repeatSegState.active) { clearRepeatSeg(); return; }
      if (loopState.mode !== 'off') clearLoop();
    });
  }
  let segmentStarts = []; // sorted by segment order
  let visibleStarts = []; // starts of segments currently visible (incl. forced-visible)
  let visibleSegIds = [];

  function rebuildSegmentStarts() {
    segmentStarts = segments.map(s => s.start);
  }

  // --- Tiny toast ---
  let __toastTimer = null;
  function showToast(message) {
    try {
      let el = document.getElementById('toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
      }
      el.textContent = String(message || '');
      el.classList.add('show');
      clearTimeout(__toastTimer);
      __toastTimer = setTimeout(() => { el.classList.remove('show'); }, 1500);
    } catch (_) { }
  }

  function _hasAudioLoaded() {
    try {
      const src = (typeof player !== 'undefined' && player) ? (player.currentSrc || player.src || '') : '';
      return !!src;
    } catch (_) { return false; }
  }

  function ensureAudioLoadedForPlay() {
    if (_hasAudioLoaded()) return true;
    try { showToast("No audio file loaded (press: Choose audio)"); } catch { }
    return false;
  }


  const showFilterNotice = (message) => filtersShowFilterNotice({
    filterNotice,
    filterNoticeText,
    message,
  });
  const hideFilterNotice = () => filtersHideFilterNotice({
    filterNotice,
    filterNoticeText,
  });

  const isFilterActiveNow = () => filtersIsFilterActive(filterState);
  const matchesFilterNow = (segment) => filtersMatchesFilter({ segment, filterState, changedSegIds, doneSegIds });
  const isVisibleNow = (segment) => filtersIsVisibleNow({
    segment,
    filterState,
    changedSegIds,
    doneSegIds,
    forcedVisibleIds,
  });
  const pruneForcedVisibleNow = () => filtersPruneForcedVisibleIds({
    forcedVisibleIds,
    hideFilterNotice,
    segments,
    matchesFilter: matchesFilterNow,
    findIndexById,
  });
  const forceVisibleIfFilteredOut = (ids, reason, opts) => filtersForceVisibleIfFilteredOut({
    ids,
    reason,
    options: opts,
    filterIsActive: isFilterActiveNow,
    forcedVisibleIds,
    segments,
    matchesFilter: matchesFilterNow,
    findIndexById,
    showFilterNotice,
  });

  function updateFilterBarUI(visibleCount, total) {
    return filtersUpdateFilterBarUI({
      filterBar,
      filterBtn,
      filterChipsEl,
      filterCountEl,
      filterState,
      visibleCount,
      total,
      openFilterModal,
      syncFilterUIFromState,
      scheduleApplyFilters,
    });
  }

  function rebuildFilterSpeakerOptions() {
    return filtersRebuildFilterSpeakerOptions({
      filterSpeakersList,
      segments,
      filterState,
      scheduleApplyFilters,
    });
  }

  function syncFilterUIFromState() {
    return filtersSyncFilterUIFromState({
      rebuildFilterSpeakerOptions,
      filterState,
      playFilteredToggle,
    });
  }

  function openFilterModal() {
    return filtersOpenFilterModal({
      filterModal,
      player,
      syncFilterUIFromState,
      closeFilterBtn,
    });
  }

  function closeFilterModal() {
    return filtersCloseFilterModal({ filterModal });
  }

  const scheduleApplyFilters = filtersCreateFilterApplyScheduler({
    segmentsDiv,
    getSegments: () => segments,
    setVisibleResults: (starts, ids) => {
      visibleStarts = starts;
      visibleSegIds = ids;
    },
    filterBar,
    filterBtn,
    hideFilterNotice,
    rebuildSegmentStarts,
    isFilterActive: () => filtersIsFilterActive(filterState),
    getFilterState: () => filterState,
    getForcedVisibleIds: () => forcedVisibleIds,
    recomputeChangedSegIds,
    pruneForcedVisibleNow,
    getRowBySegId,
    getEditingTextSegId: () => editingTextSegId,
    matchesFilterNow,
    canJoinAtIndex,
    updateFilterBarUI,
    getEditorMode: () => editorMode,
    renderTextView,
  });

  function applyFilterFromModalControls() {
    return filtersApplyFilterFromModalControls({
      filterState,
      playFilteredToggle,
      scheduleApplyFilters,
    });
  }
  filtersWireFilterControlEvents({
    filterBtn,
    openFilterModal,
    closeFilterBtn,
    closeFilterModal,
    filterModal,
    applyFilterFromModalControls,
    filterClearBtn3,
    filterClearBtn,
    clearFilterState: () => filtersClearFilterState({
      filterState,
      forcedVisibleIds,
      hideFilterNotice,
      syncFilterUIFromState,
      syncModeButtons,
      scheduleApplyFilters,
    }),
    filterStrictBtn,
    forcedVisibleIds,
    hideFilterNotice,
    scheduleApplyFilters,
  });

  function findSegmentIndexAtTime(t) {
    return playbackFindSegmentIndexAtTime({
      time: t,
      segments,
      segmentStarts,
      rebuildSegmentStarts,
    });
  }

  function snapToVisibleIfNeeded() {
    const result = playbackSnapToVisibleIfNeeded({
      filterActive: filtersIsFilterActive(filterState),
      playbackFiltered: filterState.playbackFiltered,
      visibleStarts,
      visibleSegIds,
      segments,
      isVisibleNow,
      player,
      findSegmentIndexAtTime,
    });
    visibleStarts = result.visibleStarts;
    visibleSegIds = result.visibleSegIds;
  }

  function enforceFilteredPlayback() {
    return playbackEnforceFilteredPlayback({
      filterActive: filtersIsFilterActive(filterState),
      playbackFiltered: filterState.playbackFiltered,
      visibleStarts,
      segments,
      isVisibleNow,
      player,
      findSegmentIndexAtTime,
    });
  }

  playbackWirePlaybackLoopEvents({
    player,
    clampToLoopStartIfNeeded,
    snapToVisibleIfNeeded,
    getEffectiveLoopBounds,
    getSuppressTimeSyncUntil: () => suppressTimeSyncUntil,
    enforceFilteredPlayback,
    findSegmentIndexAtTime,
    getCurrentSegmentIndex: () => currentSegmentIndex,
    getKeepCenteredDuringPlayback: () => keepCenteredDuringPlayback,
    setActiveSegment,
  });

  const replaceAllModal = document.getElementById('replaceAllModal');
  const raSummary = document.getElementById('raSummary');
  const raCancelBtn = document.getElementById('raCancelBtn');
  const raConfirmBtn = document.getElementById('raConfirmBtn');

  let currentFind = null; // {sig, segId, field, start, end, match, segIndex}
  let lastFindQuery = null;
  let lastFindIndex = -1;

  /* Find/Replace — delegated to editorFind.js */
  function findNext(fromReplace) { return _findNext(ctx, fromReplace); }
  function replaceCurrent() { return _replaceCurrent(ctx); }
  function getTranscriptSelectionText() { return _getTranscriptSelectionText(ctx); }
  function openFindModal() { return _openFindModal(ctx); }
  function closeFindModal() { return _closeFindModal(ctx); }

  let pendingReplaceAll = null;
  function openReplaceAllConfirm() { return _openReplaceAllConfirm(ctx); }
  function closeReplaceAllConfirm() { return _closeReplaceAllConfirm(ctx); }
  function doReplaceAllConfirmed() { return _doReplaceAllConfirmed(ctx); }

  if (findBtn) findBtn.addEventListener('click', openFindModal);
  if (closeFindBtn) closeFindBtn.addEventListener('click', closeFindModal);

  if (findModal) {
    new ModalController(findModal, {
      backdropEvent: 'mousedown',
      onBackdrop: () => closeFindModal()
    });
  }
  if (replaceAllModal) {
    new ModalController(replaceAllModal, {
      backdropEvent: 'mousedown',
      onBackdrop: () => closeReplaceAllConfirm()
    });
  }

  if (findNextBtn) findNextBtn.addEventListener('click', () => findNext(false));
  if (replaceBtn) replaceBtn.addEventListener('click', replaceCurrent);
  if (replaceAllBtn) replaceAllBtn.addEventListener('click', openReplaceAllConfirm);

  if (raCancelBtn) raCancelBtn.addEventListener('click', closeReplaceAllConfirm);
  if (raConfirmBtn) raConfirmBtn.addEventListener('click', doReplaceAllConfirmed);

  if (findInput) findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(false); }
  });
  if (replaceInput) replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
  });

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const optKeepCentered = document.getElementById('optKeepCentered');
  const optAutoSplitTs = document.getElementById('optAutoSplitTs');
  const settingsCard = settingsModal ? settingsModal.querySelector('.settings-card') : null;
  const settingsDragHandle = document.getElementById('settingsDragHandle');

  const settingsDrag = createDialogDragController((x, y) => {
    if (settingsCard) {
      settingsCard.style.setProperty('--drag-x', `${x}px`);
      settingsCard.style.setProperty('--drag-y', `${y}px`);
    }
  });
  function resetSettingsDrag() { settingsDrag.reset(); }
  function onSettingsDragUp() { settingsDrag.onUp(); }

  if (settingsDragHandle) {
    settingsDragHandle.addEventListener('mousedown', settingsDrag.onMouseDown);
  }

  const { syncSettingsUI, closeSettingsModal } = setupSettingsModal({
    settingsBtn,
    closeSettingsBtn,
    settingsModal,
    optKeepCentered,
    optAutoSplitTs,
    flushPendingText,
    player,
    resetSettingsDrag,
    onSettingsDragUp,
    loadSettings,
    saveSettings,
    getKeepCenteredDuringPlayback: () => keepCenteredDuringPlayback,
    setKeepCenteredDuringPlayback: (value) => { keepCenteredDuringPlayback = value; },
    getAutoAssignSplitTs: () => autoAssignSplitTs,
    setAutoAssignSplitTs: (value) => { autoAssignSplitTs = value; },
  });

  const { exportModal, closeExportModal } = setupExportModal({
    flushPendingText,
    player,
    getExportContext: () => ctx,
    showToast,
  });


  let segments = [];
  let currentSegmentIndex = -1;
  let globalSeq = 0;
  let rowById = new Map();

  // Transcript textarea sizing state (prevents long main-thread stalls)
  let _taSizeQueue = [];
  let _taSizeSet = new Set();
  let _taSizeRaf = 0;


  // --- App-level Undo/Redo (start with Split) ---
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 100;

  const pendingTextEdits = new Map(); // segId -> {from, to, timer}

  let editingTextSegId = null; // seg.id currently being edited in a textarea
  function isEditingText() { return !!editingTextSegId; }

  function flushPendingText(segId = null, opts = {}) {
    const commitOne = (id, p) => {
      beginHistoryMutation();
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      pendingTextEdits.delete(id);
      if (p.from !== p.to) {
        const from = p.from;
        const to = p.to;
        const activeId = getActiveSegId();
        pushHistory({
          label: 'Edit text',
          summary: `seg=${id} len ${from.length}→${to.length}`,
          meta: { segId: id, fromPreview: safePreview(from), toPreview: safePreview(to), fromLen: from.length, toLen: to.length },
          do: () => {
            const seg = segments.find(s => s.id === id);
            if (!seg) return;
            seg.text = to;
            updateRowBySegId(id);
            if (activeId) setActiveSegment(findIndexById(activeId), null);
            scheduleDirtyCheck();
            forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.');
            scheduleApplyFilters();
          },
          undo: () => {
            const seg = segments.find(s => s.id === id);
            if (!seg) return;
            seg.text = from;
            updateRowBySegId(id);
            if (activeId) setActiveSegment(findIndexById(activeId), null);
            scheduleDirtyCheck();
            forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.');
            scheduleApplyFilters();
          }
        });
        const showNotice = (opts && opts.showFilterNotice !== false);
        forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.', { silent: !showNotice });
        if (showNotice && !isEditingText()) {
          scheduleApplyFilters();
        }
      }
    };

    if (segId) {
      commitOne(segId, pendingTextEdits.get(segId));
      return;
    }
    // flush all
    for (const [id, p] of Array.from(pendingTextEdits.entries())) {
      commitOne(id, p);
    }
  }


  function getActiveSegId() {
    if (currentSegmentIndex < 0 || currentSegmentIndex >= segments.length) return null;
    return segments[currentSegmentIndex]?.id ?? null;
  }

  function findIndexById(id) {
    if (!id) return -1;
    return segments.findIndex(s => s.id === id);
  }

  function updateRowBySegId(segId) {
    const row = rowById.get(segId) || segmentsDiv.querySelector(`.segment[data-id="${segId}"]`);
    if (!row) return;
    if (!rowById.has(segId)) rowById.set(segId, row);

    const seg = segments.find(s => s.id === segId);
    if (!seg) return;

    const safeSetValue = (el, value) => {
      if (!el) return;
      const val = value ?? '';
      if (el.value === val) return;

      const isActive = (document.activeElement === el);
      let selStart = null, selEnd = null;
      if (isActive && typeof el.selectionStart === 'number') {
        selStart = el.selectionStart;
        selEnd = el.selectionEnd;
      }
      const prevScrollTop = (el.tagName === 'TEXTAREA') ? el.scrollTop : null;

      el.value = val;

      if (isActive && selStart !== null) {
        const len = el.value.length;
        const a = Math.min(selStart, len);
        const b = Math.min(selEnd, len);
        try { el.setSelectionRange(a, b); } catch { }
      }
      if (prevScrollTop !== null) el.scrollTop = prevScrollTop;
    };

    const t = row.querySelector('.time-input');
    safeSetValue(t, secondsToTimecodeWhole(seg.start));

    const sp = row.querySelector('.speaker-input');
    safeSetValue(sp, seg.speaker || '');
    if (sp) sp.dataset.before = sp.value;

    const ta = row.querySelector('.text-input');
    safeSetValue(ta, seg.text || '');
    if (ta) {
      // size is expensive across many rows; for single-row updates it's fine,
      // but we still run it through the chunked scheduler.
      try { queueTextareaSizing(ta); } catch { try { autosizeTextarea(ta); } catch { } }
    }

    const jb = row.querySelector('.icon-btn.join');
    if (jb) {
      const i = parseInt(row.dataset.index, 10);
      const idx = Number.isFinite(i) ? i : findIndexById(segId);
      jb.disabled = !canJoinAtIndex(idx);
    }
  }

  function pushHistory(action) {
    if (!action) return;
    action.hid = action.hid ?? (historyNextId++);
    action.ts = action.ts ?? Date.now();
    undoStack.push(action);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    renderHistory();
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  function focusAfterHistoryAction(a) {
    if (!a) return;
    // Prefer explicit segId; for bulk actions use firstSegId.
    let targetId = (a.meta && (a.meta.segId || a.meta.firstSegId)) ? (a.meta.segId || a.meta.firstSegId) : null;

    // Special case: Split -> always focus the originally split segment
    if (a.label === 'Split' && a.meta && a.meta.segId) targetId = a.meta.segId;

    if (!targetId) return;
    const idx = findIndexById(targetId);
    if (idx >= 0) {
      setActiveSegment(idx, 'auto', 'center');
      // Re-apply on next tick to avoid late events overriding the highlight (e.g. seek/timeupdate)
      setTimeout(() => {
        const idx2 = findIndexById(targetId);
        if (idx2 >= 0) setActiveSegment(idx2, 'auto', 'center');
        const seg = segments[idx2];
        if (seg && topicsView && typeof topicsView.setActiveTime === 'function') {
          topicsView.setActiveTime(seg.start, true, 'auto');
        }
      }, 0);
    }
  }



  function affectedIdsFromHistoryAction(a) {
    const out = [];
    const m = a && a.meta ? a.meta : null;
    if (!m) return out;
    const add = (v) => { if (!v) return; if (!out.includes(v)) out.push(v); };
    add(m.segId);
    add(m.newSegId);
    add(m.firstSegId);
    if (Array.isArray(m.segIds)) for (const id of m.segIds) add(id);
    if (Array.isArray(m.ids)) for (const id of m.ids) add(id);
    return out;
  }

  function doUndo() {
    if (!canUndo()) return;
    beginHistoryMutation();
    const a = undoStack.pop();
    a.undo();
    redoStack.push(a);
    const ids = affectedIdsFromHistoryAction(a);
    if (ids && ids.length) {
      forceVisibleIfFilteredOut(ids, 'Change moved segments outside the current filter.');
      scheduleApplyFilters();
    }
    scheduleDirtyCheck();
    focusAfterHistoryAction(a);
    renderHistory();
  }

  function doRedo() {
    if (!canRedo()) return;
    beginHistoryMutation();
    const a = redoStack.pop();
    a.do();
    undoStack.push(a);
    const ids = affectedIdsFromHistoryAction(a);
    if (ids && ids.length) {
      forceVisibleIfFilteredOut(ids, 'Change moved segments outside the current filter.');
      scheduleApplyFilters();
    }
    scheduleDirtyCheck();
    focusAfterHistoryAction(a);
    renderHistory();
  }


  // Suppress highlight-following from timeupdate for a brief period (used for undo/redo focus)
  let suppressTimeSyncUntil = 0;
  function suppressTimeSync(ms = 350) { suppressTimeSyncUntil = Date.now() + ms; }
  let keepCenteredDuringPlayback = true;
  let autoAssignSplitTs = false;

  function loadSettings() {
    const s = apiLoadSettings();
    keepCenteredDuringPlayback = s.keepCenteredDuringPlayback;
    autoAssignSplitTs = s.autoAssignSplitTs;
  }

  function saveSettings() {
    apiSaveSettings({ keepCenteredDuringPlayback, autoAssignSplitTs });
  }

  // Load settings immediately so they affect behavior even before opening Settings.
  try {
    loadSettings();
  } catch (error) {
    console.error('Failed to load editor settings', error);
  }
  try {
    syncSettingsUI();
  } catch (error) {
    console.error('Failed to sync editor settings UI', error);
  }


  function beginHistoryMutation() {
    // Any user-initiated, undoable mutation should pause playback first to avoid racey UI updates
    try { player.pause(); } catch { }
    suppressTimeSync(450);
  }



  let loadedJsonFileName = null;
  let exportFileName = null;
  let lastSavedAt = null;
  let srtSaveHandle = null; // FileSystemFileHandle when available (enables true Save without re-prompt)

  // dirty tracking via hash comparison (undo -> clean again)
  let cleanHash = null;
  let dirtyDebounce = null;

  // === Shared context for extracted modules ===
  // Getter/setter proxies keep ctx in sync with closure variables.
  // Functions (hoisted declarations) are assigned directly.
  const ctx = {};
  Object.defineProperties(ctx, {
    // Mutable state (let variables — need getter/setter to stay in sync)
    segments: { get() { return segments; }, set(v) { segments = v; } },
    currentSegmentIndex: { get() { return currentSegmentIndex; }, set(v) { currentSegmentIndex = v; } },
    exportFileName: { get() { return exportFileName; }, set(v) { exportFileName = v; } },
    loadedJsonFileName: { get() { return loadedJsonFileName; }, set(v) { loadedJsonFileName = v; } },
    lastSavedAt: { get() { return lastSavedAt; }, set(v) { lastSavedAt = v; } },
    srtSaveHandle: { get() { return srtSaveHandle; }, set(v) { srtSaveHandle = v; } },
    canUseFileSystem: { get() { return (typeof canUseFileSystem !== 'undefined') ? canUseFileSystem : false; } },
    // Find/replace mutable state
    currentFind: { get() { return currentFind; }, set(v) { currentFind = v; } },
    lastFindQuery: { get() { return lastFindQuery; }, set(v) { lastFindQuery = v; } },
    lastFindIndex: { get() { return lastFindIndex; }, set(v) { lastFindIndex = v; } },
    pendingReplaceAll: { get() { return pendingReplaceAll; }, set(v) { pendingReplaceAll = v; } },
  });
  // Const refs (DOM elements, component instances)
  ctx.topicsView = topicsView;
  ctx.player = player;
  ctx.segmentsDiv = segmentsDiv;
  ctx.findModal = findModal;
  ctx.findInput = findInput;
  ctx.replaceInput = replaceInput;
  ctx.findStatus = findStatus;
  ctx.optRegex = optRegex;
  ctx.optCase = optCase;
  ctx.optWords = optWords;
  ctx.optWrap = optWrap;
  ctx.replaceAllModal = replaceAllModal;
  ctx.raSummary = raSummary;
  ctx.filterState = filterState;
  ctx.forcedVisibleIds = forcedVisibleIds;
  ctx.pendingTextEdits = pendingTextEdits;
  // Hoisted function refs (wrapped to capture closure at call time)
  ctx.showToast = showToast;
  ctx.setCleanNow = function () { return setCleanNow(); };
  ctx.nowHHMMSS = function () { return nowHHMMSS(); };
  ctx.setActiveSegment = function (i, sb, bl, fs) { return setActiveSegment(i, sb, bl, fs); };
  ctx.pushHistory = function (a) { return pushHistory(a); };
  ctx.beginHistoryMutation = function () { return beginHistoryMutation(); };
  ctx.flushPendingText = function (sid, opts) { return flushPendingText(sid, opts); };
  ctx.updateRowBySegId = function (id) { return updateRowBySegId(id); };
  ctx.scheduleDirtyCheck = function (opts) { return scheduleDirtyCheck(opts); };
  ctx.forceVisibleIfFilteredOut = function (ids, reason, opts) {
    return forceVisibleIfFilteredOut(ids, reason, opts);
  };
  ctx.scheduleApplyFilters = function () { return scheduleApplyFilters(); };
  ctx.filterIsActive = function () { return filtersIsFilterActive(filterState); };
  ctx.matchesFilter = function (seg) {
    return matchesFilterNow(seg);
  };
  ctx.recomputeChangedSegIds = function () { return recomputeChangedSegIds(); };
  ctx.pruneForcedVisibleIds = function () {
    return pruneForcedVisibleNow();
  };
  ctx.resetFindDrag = function () { return resetFindDrag(); };
  ctx.onFindDragUp = function () { return onFindDragUp(); };
  // Phase 3: Segment operations dependencies
  Object.defineProperties(ctx, {
    globalSeq: { get() { return globalSeq; }, set(v) { globalSeq = v; } },
    editingTextSegId: { get() { return editingTextSegId; }, set(v) { editingTextSegId = v; } },
    autoAssignSplitTs: { get() { return autoAssignSplitTs; }, set(v) { autoAssignSplitTs = v; } },
  });
  ctx.rowById = rowById;
  ctx.undoStack = undoStack;
  ctx.redoStack = redoStack;
  ctx.createSegmentRow = function (seg, idx) { return createSegmentRow(seg, idx); };
  ctx.enforceTiming = function (opts) { return enforceTiming(opts); };
  ctx.findIndexById = function (id) { return findIndexById(id); };
  ctx.getActiveSegId = function () { return getActiveSegId(); };
  ctx.allocUniqueStartWithinSecond = function (b, ig, p) { return allocUniqueStartWithinSecond(b, ig, p); };
  ctx.timecodeToSeconds = function (tc) { return timecodeToSeconds(tc); };
  ctx.queueTextareaSizing = function (el) { return queueTextareaSizing(el); };

  function allocUniqueStartWithinSecond(baseSec, ignoreSegId = null, preferAfterMs = 0) {
    // Allocate a start time within +/- 499ms around baseSec, so Math.round(start) == baseSec.
    const used = new Set();
    for (const s of segments) {
      if (ignoreSegId && s.id === ignoreSegId) continue;
      if (Math.round(s.start) !== baseSec) continue;
      const ms = Math.round((s.start - baseSec) * 1000);
      if (ms >= -499 && ms <= 499) used.add(ms);
    }

    const pref = Math.max(-499, Math.min(499, Math.round(preferAfterMs)));
    if (!used.has(pref)) return baseSec + (pref / 1000);

    for (let ms = pref + 1; ms <= 499; ms++) {
      if (!used.has(ms)) return baseSec + (ms / 1000);
    }
    for (let ms = pref - 1; ms >= -499; ms--) {
      if (!used.has(ms)) return baseSec + (ms / 1000);
    }
    return baseSec;
  }


  function enforceTiming(opts = {}) {
    const doSort = (opts.sort !== false);
    const fallbackDur = (typeof opts.fallbackDur === 'number' && Number.isFinite(opts.fallbackDur) && opts.fallbackDur > 0)
      ? opts.fallbackDur
      : 5;
    const invalidMinDur = (typeof opts.invalidMinDur === 'number' && Number.isFinite(opts.invalidMinDur) && opts.invalidMinDur > 0)
      ? opts.invalidMinDur
      : 0.5;
    const eps = (typeof opts.eps === 'number' && Number.isFinite(opts.eps) && opts.eps > 0)
      ? opts.eps
      : 0.001;

    if (doSort) {
      segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    }

    // Normalize numbers + ensure end > start (for invalid/missing ends only)
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const st = (typeof s.start === 'number' && Number.isFinite(s.start)) ? s.start : 0;
      s.start = Math.max(0, st);

      let en = (typeof s.end === 'number' && Number.isFinite(s.end)) ? s.end : (s.start + fallbackDur);
      if (en <= s.start) en = s.start + invalidMinDur;
      s.end = en;
    }

    // Enforce non-overlap (preserve end-times unless they collide with the next start)
    for (let i = 0; i < segments.length - 1; i++) {
      const s = segments[i];
      const n = segments[i + 1];

      // If starts collide (should be rare), nudge the later start forward slightly.
      if (n.start <= s.start) n.start = s.start + eps;

      if (s.end > n.start) {
        // Prefer preserving n.start; clamp s.end to exactly n.start.
        s.end = n.start;

        // If that would invert the segment, keep a tiny duration and nudge n.start.
        if (s.end <= s.start) {
          s.end = s.start + eps;
          if (n.start <= s.end) n.start = s.end + eps;
        }
      }
    }

    // Last segment: keep a sane end if it became invalid.
    if (segments.length) {
      const last = segments[segments.length - 1];
      if (!(typeof last.end === 'number' && Number.isFinite(last.end)) || last.end <= last.start) {
        last.end = last.start + fallbackDur;
      }
    }

    if (typeof rebuildSegmentStarts === 'function') rebuildSegmentStarts();
  }

  // --- Dirty tracking via hash ---
  function stateString() {
    const parts = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      parts[i] = s.blockId + "|" + s.start + "|" + (s.speaker || "") + "|" + (s.text || "");
    }
    return parts.join("\n");
  }


  function computeHash() { return hashString(stateString()); }


  // Per-segment baseline & change tracking (since last load/save)
  let baselineById = new Map();      // segId -> fingerprint string
  let changedSegIds = new Set();
  let doneSegIds = new Set(); // workflow: segments marked Done (not part of transcript)     // segIds currently different from baseline

  function segFingerprint(seg) {
    return `${seg.start}|${seg.speaker || ''}|${seg.text || ''}`;
  }

  function setBaselineNow() {
    baselineById = new Map();
    for (const seg of segments) baselineById.set(seg.id, segFingerprint(seg));
    changedSegIds = new Set();
    updateSegmentsChangedPill();
  }

  function recomputeChangedSegIds() {
    const s = new Set();
    for (const seg of segments) {
      const base = baselineById.get(seg.id);
      if (base === undefined) { s.add(seg.id); continue; } // new segment since baseline (e.g. split)
      if (base !== segFingerprint(seg)) s.add(seg.id);
    }
    changedSegIds = s;
    return s;
  }

  function updateSegmentsChangedPill() {
    const pill = document.getElementById('segmentsChangedPill');
    if (!pill) return;
    if (!segments.length) { pill.textContent = 'Segments changed: 0'; updateDonePill(); return; }
    const count = changedSegIds.size;
    pill.textContent = `Segments changed: ${count}`;
    updateDonePill();
  }

  function setCleanNow() { cleanHash = computeHash(); setBaselineNow(); updateHeaderUI(false); }

  function isDirtyNow() {
    if (!segments.length) return false;
    if (cleanHash === null) return true;
    return computeHash() !== cleanHash;
  }

  function scheduleDirtyCheck(opts = {}) {
    if (dirtyDebounce) clearTimeout(dirtyDebounce);
    const skipFilterApply = !!(opts && opts.skipFilterApply);
    dirtyDebounce = setTimeout(() => {
      updateHeaderUI();

      // Important: don't change filtered visibility while the user is actively typing in a textarea.
      if (!skipFilterApply && !isEditingText()) {
        scheduleApplyFilters();
      }
    }, 120);
  }

  // --- Speaker dropdown (editable combobox) ---
  const speakerDropdown = createSpeakerDropdownController({
    segmentsDiv,
    player,
    getSegments: () => segments,
    beginHistoryMutation,
    scheduleDirtyCheck,
    forceVisibleIfFilteredOut,
    scheduleApplyFilters,
    updateRowBySegId,
    pushHistory,
    safePreview,
  });
  const setSpeakerDropdownIndex = (newIdx) => speakerDropdown.setSpeakerDropdownIndex(newIdx);
  const applySpeakerSelected = () => speakerDropdown.applySpeakerSelected();
  const closeSpeakerDropdown = () => speakerDropdown.closeSpeakerDropdown();
  const openSpeakerDropdown = (ev, inputEl, seg) => speakerDropdown.openSpeakerDropdown(ev, inputEl, seg);


  // --- UI ---
  function updateHeaderUI(forceDirty = null) {
    const hasData = segments.length > 0;
    const nameForTitle = (exportFileName || _suggestSrtName(ctx));

    if (!hasData) {
      saveBtn.disabled = true;
      saveBtn.classList.remove('primary');
      saveBtn.textContent = "Save";
      saveBtn.title = "Ctrl+S";
      document.title = "Transcript editor";
      const pill = document.getElementById('segmentsChangedPill');
      if (pill) pill.textContent = 'Segments changed: 0';
      return;
    }

    const dirty = (forceDirty === null) ? isDirtyNow() : !!forceDirty;

    recomputeChangedSegIds();
    updateSegmentsChangedPill();

    saveBtn.disabled = false;
    saveBtn.classList.toggle('primary', dirty);

    const canPicker = ctx.canUseFileSystem;
    if (canPicker) {
      saveBtn.textContent = dirty ? "Save*" : "Save";
      saveBtn.title = dirty
        ? "Ctrl+S — Unsaved changes"
        : (lastSavedAt ? ("Ctrl+S — Saved " + lastSavedAt) : "Ctrl+S — Saved");
    } else {
      saveBtn.textContent = dirty ? "Download*" : "Download";
      saveBtn.title = "Download .srt (Browser mode)";
    }

    document.title = (dirty ? "* " : "") + nameForTitle + " — Transcript editor";
  }

  function setActiveSegment(index, scrollBehavior = 'smooth', block = 'center', forceScroll = false) {
    const rows = segmentsDiv.querySelectorAll('.segment');
    if (!rows.length || index < 0 || index >= rows.length) return;

    // Smart Scroll: Force 'auto' (instant) if jumping > 2 minutes (120s)
    let behavior = scrollBehavior;
    if (index >= 0 && segments[index]) {
      const targetTime = segments[index].start;
      let currentTime = 0;
      // Use currentSegmentIndex to find previous time
      if (currentSegmentIndex >= 0 && segments[currentSegmentIndex]) {
        currentTime = segments[currentSegmentIndex].start;
      }
      // If starting from scratch (-1) assume 0.
      // This handles the "Resume Project" case (jumping from 0 to 15:00)

      if (Math.abs(targetTime - currentTime) > 120) {
        behavior = 'auto';
      }
    }

    rows.forEach((el, idx) => el.classList.toggle('active', idx === index));
    currentSegmentIndex = index;


    // Mirror active highlight into Text View (if rendered)
    textView.setActive(segments[index].id, behavior, forceScroll);

    // Mirror to Topics View as well (so it jumps if we jump)
    if (segments[index]) {
      topicsView.setActiveTime(segments[index].start, true, behavior);
    }

    // Only scroll if the active row is outside the visible area
    if (behavior !== null) {
      const row = rows[index];
      const c = segmentsDiv.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const pad = 8;
      const inView = (r.top >= c.top + pad) && (r.bottom <= c.bottom - pad);
      if (forceScroll || !inView) {
        row.scrollIntoView({ block, behavior: behavior || 'auto' });
      }
    }
  }


  // Auto-size textareas (expand the active or focused one to fit content)
  const TEXTAREA_BASE_HEIGHT = 30;      // px (matches CSS height)
  const TEXTAREA_MAX_HEIGHT = 220;     // px (prevents giant blocks)

  function autosizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    const needed = Math.max(TEXTAREA_BASE_HEIGHT, el.scrollHeight);
    const h = Math.min(needed, TEXTAREA_MAX_HEIGHT);
    el.style.height = h + 'px';
    el.style.overflowY = (needed > TEXTAREA_MAX_HEIGHT) ? 'auto' : 'hidden';
  }

  // Transcript textarea sizing (avoids long stalls after split/undo/resize)
  function queueTextareaSizing(el) {
    if (!el) return;
    if (_taSizeSet.has(el)) return;
    _taSizeSet.add(el);
    _taSizeQueue.push(el);
    if (!_taSizeRaf) _taSizeRaf = requestAnimationFrame(processTextareaSizingQueue);
  }

  function processTextareaSizingQueue() {
    _taSizeRaf = 0;
    const MAX_PER_FRAME = 60;
    const BUDGET_MS = 10;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    let n = 0;
    while (_taSizeQueue.length && n < MAX_PER_FRAME) {
      const el = _taSizeQueue.shift();
      _taSizeSet.delete(el);
      if (el && el.isConnected) {
        try { autosizeTextarea(el); } catch { }
      }
      n++;

      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if ((t1 - t0) > BUDGET_MS) break;
    }

    if (_taSizeQueue.length) _taSizeRaf = requestAnimationFrame(processTextareaSizingQueue);
  }

  function cancelTextareaSizingQueue() {
    _taSizeQueue.length = 0;
    _taSizeSet.clear();
    if (_taSizeRaf) {
      try { cancelAnimationFrame(_taSizeRaf); } catch { }
      _taSizeRaf = 0;
    }
  }

  function updateTextareaSizing() {
    // Schedule sizing for all textareas (chunked).
    // Safe to call often (e.g. after resize), it won't block the UI.
    const list = segmentsDiv.querySelectorAll('.text-input');
    for (const el of list) queueTextareaSizing(el);
  }

  /* Segment row management — delegated to editorSegments.js */
  function getRowBySegId(segId) { return _getRowBySegId(ctx, segId); }
  function reindexAllRows() { return _reindexAllRows(ctx); }
  function insertRowAtIndex(row, index) { return _insertRowAtIndex(ctx, row, index); }
  function removeRowBySegId(segId) { return _removeRowBySegId(ctx, segId); }
  function moveRowBySegIdToIndex(segId, index) { return _moveRowBySegIdToIndex(ctx, segId, index); }
  function applySegStartNoHistory(segId, newStart, opts) { return _applySegStartNoHistory(ctx, segId, newStart, opts); }
  function canJoinAtIndex(idx) { return _canJoinAtIndex(ctx, idx); }


  function createSegmentRow(seg, idx) {
    const row = document.createElement('div');
    row.className = 'segment';
    row.dataset.index = String(idx);
    row.dataset.id = seg.id;
    rowById.set(seg.id, row);

    const getIdx = () => {
      const n = parseInt(row.dataset.index, 10);
      return Number.isFinite(n) ? n : 0;
    };

    // --- done toggle ---
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'done-btn';
    doneBtn.title = 'Done (F9)';

    const applyDoneUI = () => {
      const isDone = doneSegIds.has(seg.id);
      row.classList.toggle('done', isDone);
      doneBtn.textContent = isDone ? '☑' : '☐';
      doneBtn.setAttribute('aria-pressed', isDone ? 'true' : 'false');
    };
    applyDoneUI();

    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (doneSegIds.has(seg.id)) doneSegIds.delete(seg.id);
      else doneSegIds.add(seg.id);

      // Soft filter behavior (consistent with other filters)
      forceVisibleIfFilteredOut([seg.id], 'Updated done status moved segment outside the current filter.');
      if (matchesFilterNow(seg)) forcedVisibleIds.delete(seg.id);
      pruneForcedVisibleNow();

      applyDoneUI();
      updateDonePill();
      saveDoneToStorage();
      scheduleApplyFilters();
    });

    // --- time input ---
    const timeInput = document.createElement('input');
    timeInput.type = 'text';
    timeInput.className = 'time-input time';
    timeInput.value = secondsToTimecodeWhole(seg.start);
    timeInput.title = secondsToSrtTimecode(seg.start);

    timeInput.addEventListener('focus', () => {
      player.pause();
      player.currentTime = seg.start;
      setActiveSegment(getIdx(), 'smooth');
      setTimeout(() => { try { timeInput.select(); } catch { } }, 0);
    });

    function commitTimeEdit() {
      beginHistoryMutation();

      const raw = String(timeInput.value || '').trim();
      if (!raw) { timeInput.value = secondsToTimecodeWhole(seg.start); return; }

      let sec;
      try { sec = raw.includes(':') ? timecodeToSeconds(raw) : parseFloat(raw); }
      catch { sec = NaN; }

      if (!Number.isFinite(sec)) {
        timeInput.value = secondsToTimecodeWhole(seg.start);
        return;
      }

      const baseSec = Math.max(0, Math.round(sec));
      const curBase = Math.round(seg.start);

      if (baseSec === curBase) {
        timeInput.value = secondsToTimecodeWhole(seg.start);
        return;
      }

      const segId = seg.id;
      const beforeStart = seg.start;
      const afterStart = allocUniqueStartWithinSecond(baseSec, segId, 0);

      pushHistory({
        label: 'Set time',
        summary: `${secondsToTimecodeWhole(beforeStart)}→${secondsToTimecodeWhole(afterStart)} (seg=${segId})`,
        meta: { segId: segId, from: secondsToTimecodeWhole(beforeStart), to: secondsToTimecodeWhole(afterStart), fromSec: Math.round(beforeStart), toSec: Math.round(afterStart) },
        do: () => {
          const s = segments.find(x => x.id === segId);
          if (!s) return;
          applySegStartNoHistory(segId, afterStart, { preserveScroll: true, focus: false, scrollBehavior: 'auto', block: 'nearest' });
          player.currentTime = s.start;
        },
        undo: () => {
          const s = segments.find(x => x.id === segId);
          if (!s) return;
          applySegStartNoHistory(segId, beforeStart, { preserveScroll: true, focus: false, scrollBehavior: 'auto', block: 'nearest' });
          player.currentTime = s.start;
        }
      });

      applySegStartNoHistory(segId, afterStart, { preserveScroll: true, focus: false, scrollBehavior: 'auto', block: 'nearest' });
      player.currentTime = afterStart;
    }

    timeInput.addEventListener('blur', () => { commitTimeEdit(); });

    timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        timeInput.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        timeInput.value = secondsToTimecodeWhole(seg.start);
        timeInput.blur();
      }
    });

    // --- speaker input + dropdown ---
    const speakerWrap = document.createElement('div');
    speakerWrap.className = 'speaker-wrap';

    const speakerInput = document.createElement('input');
    speakerInput.className = 'speaker-input';
    speakerInput.value = seg.speaker || '';
    speakerInput.placeholder = 'SPEAKER_x / naam';

    speakerInput.addEventListener('input', () => {
      seg.speaker = speakerInput.value;
      scheduleDirtyCheck();
    });

    const speakerBtn = document.createElement('button');
    speakerBtn.className = 'speaker-dd-btn';
    speakerBtn.type = 'button';
    speakerBtn.textContent = '▾';
    speakerBtn.title = 'Choose speaker (dropdown)';
    speakerBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSpeakerDropdown(e, speakerInput, seg);
    });

    speakerWrap.appendChild(speakerInput);
    speakerWrap.appendChild(speakerBtn);

    speakerInput.addEventListener('focus', () => {
      speakerInput.dataset.before = (seg.speaker || '');
      player.pause();
      player.currentTime = seg.start;
      setActiveSegment(getIdx(), 'smooth');
    });

    speakerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        speakerInput.value = speakerInput.dataset.before ?? (seg.speaker || '');
        speakerInput.blur();
      }
    });

    speakerInput.addEventListener('blur', () => {
      const before = speakerInput.dataset.before ?? (seg.speaker || '');
      const after = (speakerInput.value || '');

      // Ensure model is in sync with input
      seg.speaker = after;
      speakerInput.dataset.before = after;

      if (before !== after) {
        const segId = seg.id;

        const apply = (val) => {
          const s = segments.find(x => x.id === segId);
          if (!s) return;
          s.speaker = val;
          updateRowBySegId(segId);
          scheduleDirtyCheck();
          forceVisibleIfFilteredOut([segId], 'Edited speaker moved segment outside the current filter.');
          scheduleApplyFilters();
        };

        // Apply immediately (already reflected in the input, but this normalizes + triggers filter/dirty UI)
        apply(after);

        pushHistory({
          label: 'Set speaker',
          summary: `${safePreview(before, 20)}→${safePreview(after, 20)} (seg=${segId})`,
          meta: { segId: segId, from: before, to: after },
          do: () => apply(after),
          undo: () => apply(before)
        });
      }
    });

    // Klik (mousedown) in speaker-veld => dropdown openen (en play/scroll stoppen)
    speakerInput.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      openSpeakerDropdown(e, speakerInput, seg);
    });

    // --- text ---
    const textArea = document.createElement('textarea');
    textArea.className = 'text-input';
    textArea.rows = 1;
    textArea.value = seg.text || '';
    try { queueTextareaSizing(textArea); } catch { }

    textArea.addEventListener('input', () => {
      const newVal = textArea.value;
      const segId = seg.id;
      const existing = pendingTextEdits.get(segId);

      if (!existing) {
        pendingTextEdits.set(segId, { from: (seg.text || ''), to: newVal, timer: null });
      } else {
        existing.to = newVal;
      }

      seg.text = newVal;

      const p = pendingTextEdits.get(segId);
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        flushPendingText(segId, { showFilterNotice: false });
      }, 700);

      // While typing under an 'Unchanged' filter, keep this segment visible to prevent focus loss.
      if (filtersIsFilterActive(filterState) && filterState.changedMode === 'unchanged') {
        forcedVisibleIds.add(segId);
      }
      scheduleDirtyCheck({ skipFilterApply: true });
      autosizeTextarea(textArea);
    });

    textArea.addEventListener('blur', () => {
      // User-initiated commit point for filter evaluation.
      const id = seg.id;
      editingTextSegId = null;

      // Commit any pending grouped edit (may have been flushed silently by the debounce).
      flushPendingText(id, { showFilterNotice: true });

      // Ensure "outside filter" is evaluated on *your* blur, even if we already flushed history silently.
      recomputeChangedSegIds();
      updateSegmentsChangedPill();
      forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.');
      scheduleApplyFilters();
    });

    textArea.addEventListener('focus', () => {
      editingTextSegId = seg.id;
      player.pause();
      player.currentTime = seg.start;
      setActiveSegment(getIdx(), 'smooth');
    });

    textArea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        textArea.blur();
      }
    });

    // --- buttons ---
    const btnWrap = document.createElement('div');
    btnWrap.className = 'col-buttons';

    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'icon-btn play';
    jumpBtn.textContent = '▶';
    jumpBtn.title = 'Jump to this segment and play';
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ensureAudioLoadedForPlay()) return;
      player.currentTime = seg.start;
      player.play();
      setActiveSegment(getIdx(), 'smooth');
    });

    const splitBtn = document.createElement('button');
    splitBtn.className = 'icon-btn split';
    splitBtn.textContent = '✂';
    splitBtn.title = 'Split segment (at cursor location while editing) (F4)';
    // If you press the split button while the text area is focused, treat it like a cursor-split.
    // (Click normally steals focus from the textarea before the click event, so we capture on pointerdown.)
    splitBtn.addEventListener('pointerdown', (e) => {
      if (document.activeElement === textArea) {
        e.preventDefault();
        e.stopPropagation();
        splitBtn.dataset.skipClick = '1';
        const i = getIdx();
        setActiveSegment(i, 'auto', 'center');
        splitSegment(i, textArea);
      }
    });

    splitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (splitBtn.dataset.skipClick === '1') {
        splitBtn.dataset.skipClick = '';
        return;
      }
      const i = getIdx();
      setActiveSegment(i, 'auto', 'center');
      // No textarea focus: use the timestamp prompt/auto-assign logic.
      splitSegment(i, null);
    });

    const joinBtn = document.createElement('button');
    joinBtn.className = 'icon-btn join';
    joinBtn.textContent = '🔗';
    joinBtn.title = 'Append segment to previous segment (F3)';
    joinBtn.disabled = !canJoinAtIndex(idx);
    joinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = getIdx();
      setActiveSegment(i, 'auto', 'center');
      joinWithPrevious(i);
    });

    btnWrap.appendChild(jumpBtn);
    btnWrap.appendChild(splitBtn);
    btnWrap.appendChild(joinBtn);

    row.addEventListener('click', (e) => {
      if (e.target === doneBtn || e.target === jumpBtn || e.target === splitBtn || e.target === joinBtn) return;
      player.pause();
      player.currentTime = seg.start;
      setActiveSegment(getIdx(), 'smooth');
    });

    row.appendChild(doneBtn);
    row.appendChild(timeInput);
    row.appendChild(speakerWrap);
    row.appendChild(textArea);
    row.appendChild(btnWrap);

    return row;
  }

  function renderSegments() {
    cancelTextareaSizingQueue();
    rowById.clear();

    segmentsDiv.innerHTML = '';
    for (let i = 0; i < segments.length; i++) {
      segmentsDiv.appendChild(createSegmentRow(segments[i], i));
    }

    updateTextareaSizing();
    updateHeaderUI();
    updateDonePill();
    updateLoopUI();
    scheduleApplyFilters();
  }


  // -----------------------------
  // Text View (read-only document view)
  // -----------------------------
  function syncModeButtons() {
    if (!modeSegmentsBtn || !modeTextBtn) return;
    modeSegmentsBtn.classList.toggle('active', editorMode === 'segments');
    modeTextBtn.classList.toggle('active', editorMode === 'text');
  }

  function setEditorMode(mode) {
    editorMode = (mode === 'text') ? 'text' : 'segments';
    if (segmentsDiv) segmentsDiv.classList.toggle('hidden', editorMode === 'text');
    const docContainer = document.getElementById('docViewContainer');
    if (docContainer) docContainer.classList.toggle('hidden', editorMode !== 'text');
    syncModeButtons();

    // Save mode to project data if active
    if (options.jobId && typeof options.updateProject === 'function') {
      options.updateProject(options.jobId, { lastViewMode: editorMode });
    }

    const cur = segments[currentSegmentIndex] || null;

    if (editorMode === 'text') {
      renderTextView();
      if (cur) {
        // Ensure active segment is scrolled into view (instant/auto to avoid slow scroll on switch/load)
        requestAnimationFrame(() => setTextViewActive(cur.id, 'auto', true));
      }
      // Also sync topics view
      if (topicsView && typeof topicsView.setActiveTime === 'function') {
        topicsView.setActiveTime(player.currentTime, true, 'auto');
      }
    } else {
      if (cur) {
        // Ensure active segment row is scrolled into view (instant/auto)
        requestAnimationFrame(() => setActiveSegment(currentSegmentIndex, 'auto', 'center', true));
      }
      // Recalculate heights (in case they were rendered while hidden)
      requestAnimationFrame(() => updateTextareaSizing());
    }
  }

  function getTextViewSegmentsInOrder() {
    // Prefer the already computed visible segment ids (includes forced-visible + soft filter)
    if (Array.isArray(visibleSegIds) && visibleSegIds.length) {
      const set = new Set(visibleSegIds);
      return segments.filter(s => set.has(s.id));
    }
    return segments.slice();
  }

  function renderTextView() {
    if (editorMode === 'text') {
      textView.render(getTextViewSegmentsInOrder(), doneSegIds);
      // Sync active state
      if (segments[currentSegmentIndex]) {
        textView.setActive(segments[currentSegmentIndex].id, null, false);
      }
      // Sync loops
      updateLoopBadges();
    }
  }



  function setTextViewActive(segId, scrollBehavior, forceScroll) {
    textView.setActive(segId, scrollBehavior, forceScroll);
  }


  if (modeSegmentsBtn) modeSegmentsBtn.addEventListener('click', () => setEditorMode('segments'));
  if (modeTextBtn) modeTextBtn.addEventListener('click', () => setEditorMode('text'));


  // === Mobile Doc-View Splitter (textView / topicsView) ===
  const SPLIT_STORAGE_KEY = 'omniscripta_tv_split_ratio';
  const SPLIT_MIN = 0.15;  // minimum 15% for either panel
  const SPLIT_MAX = 0.85;

  function initDocViewSplitter() {
    const splitter = document.getElementById('docViewSplitter');
    const docContainer = document.getElementById('docViewContainer');
    const textViewEl = document.getElementById('textView');
    const topicsEl = document.getElementById('topicsView');
    if (!splitter || !docContainer) return;

    // Restore saved ratio
    try {
      const saved = localStorage.getItem(SPLIT_STORAGE_KEY);
      if (saved) {
        const r = parseFloat(saved);
        if (Number.isFinite(r) && r >= SPLIT_MIN && r <= SPLIT_MAX) {
          docContainer.style.setProperty('--tv-split-ratio', r);
        }
      }
    } catch { }

    let dragging = false;
    let startY = 0;
    let startRatio = 0;

    splitter.addEventListener('pointerdown', (e) => {
      // Only primary pointer (finger / left mouse button)
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      dragging = true;
      startY = e.clientY;
      // Read current ratio
      const cur = getComputedStyle(docContainer).getPropertyValue('--tv-split-ratio');
      startRatio = parseFloat(cur) || 0.6;

      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');

      // Prevent child panels from capturing scroll events during drag
      if (textViewEl) textViewEl.style.pointerEvents = 'none';
      if (topicsEl) topicsEl.style.pointerEvents = 'none';
    });

    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();

      const rect = docContainer.getBoundingClientRect();
      const usableHeight = rect.height - (splitter.offsetHeight || 12);
      if (usableHeight < 1) return;

      // Delta pixels from where we started → convert to ratio change
      const deltaY = e.clientY - startY;
      let ratio = startRatio + (deltaY / usableHeight);

      // Clamp
      ratio = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, ratio));

      docContainer.style.setProperty('--tv-split-ratio', ratio);
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dragging');

      // Re-enable child panel interactions
      if (textViewEl) textViewEl.style.pointerEvents = '';
      if (topicsEl) topicsEl.style.pointerEvents = '';

      // Persist ratio
      try {
        const current = getComputedStyle(docContainer).getPropertyValue('--tv-split-ratio');
        const val = parseFloat(current);
        if (Number.isFinite(val)) {
          localStorage.setItem(SPLIT_STORAGE_KEY, val.toFixed(3));
        }
      } catch { }
    };

    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    splitter.addEventListener('lostpointercapture', endDrag);
  }

  // Initialize if we're on mobile
  if (document.body.classList.contains('mobile')) {
    initDocViewSplitter();
  }

  /* Split/Join operations — delegated to editorSegments.js */
  function joinWithPrevious(idx) { return _joinWithPrevious(ctx, idx); }
  function splitSegment(idx, textAreaEl) { return _splitSegment(ctx, idx, textAreaEl); }

  // Active highlight while playing

  // Recompute textarea heights on resize (debounced)
  let _resizeT = null;
  window.addEventListener('resize', () => {
    if (_resizeT) clearTimeout(_resizeT);
    _resizeT = setTimeout(() => {
      updateTextareaSizing();
    }, 120);
  });

  // timeupdate highlight is handled by playbackLoop() (rAF)

  // Load transcript (SRT)
  async function _loadTranscriptSrtText(srtText, displayName, { handle = null } = {}) {
    setChosenFileLabel(transcriptBtnLabelEl, displayName, 'Choose transcript', 'transcript');

    loadedJsonFileName = displayName || null;
    exportFileName = displayName || null;
    lastSavedAt = null;

    srtSaveHandle = handle || null; // if present, enables true Save without prompting
    buildSegmentsFromSrtText(String(srtText || ''));
    loadDoneFromStorage();
    renderSegments();
    syncTopicsFromSrtText(srtText);

    // After loading a transcript from disk/network, default the active highlight to the first segment
    if (segments && segments.length) {
      currentSegmentIndex = 0;
      setActiveSegment(0, 'auto', 'start', true);
    } else {
      currentSegmentIndex = -1;
    }

    updateDonePill();

    setCleanNow();
  }

  // Prefer File System Access API for disk loads so "Save" can overwrite without a chooser.
  if (transcriptBtnLabelEl) {
    transcriptBtnLabelEl.addEventListener('click', async (e) => {
      const canOpen = ctx.canUseFileSystem;
      if (!canOpen) { try { transcriptInput && transcriptInput.click(); } catch { } return; }
      e.preventDefault();
      e.stopPropagation();
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: "SubRip (.srt)", accept: { "text/plain": [".srt"] } }]
        });
        if (!handle) return;

        const file = await handle.getFile();
        const srtText = await file.text();
        try { transcriptInput.value = ""; } catch { }
        await _loadTranscriptSrtText(srtText, handle.name || file.name || "transcript.srt", { handle });
      } catch (err) {
        if (err && (err.name === "AbortError" || err.code === 20)) return;
        console.error(err);
      }
    }, true);
  }

  // Fallback disk load via <input type=file> (no write-back handle available)
  transcriptInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const srtText = String(reader.result || '');
      _loadTranscriptSrtText(srtText, file.name || "transcript.srt", { handle: null });
    };
    reader.readAsText(file, 'utf-8');
  });


  // Load audio
  audioInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setChosenFileLabel(audioBtnLabelEl, file.name, 'Choose audio', 'audio');
    const url = URL.createObjectURL(file);
    player.src = url;
  });

  /* SAVE_AS_SRT_V1 — delegated to editorSave.js */
  // secondsToSrtTimecode is imported directly from editorSave.js

  async function saveSrtLocally(forceSaveAs = false) { return _saveSrtLocally(forceSaveAs, ctx); }


  saveBtn.addEventListener('click', () => saveSrtLocally(false));
  if (saveAsBtn) saveAsBtn.addEventListener('click', () => saveSrtLocally(true));

  shortcutsWireEditorHotkeys({
    flushPendingText,
    doRedo,
    doUndo,
    saveSrtLocally,
    openFindModal,
    historyModal,
    closeHistoryModal,
    findModal,
    closeFindModal,
    replaceAllModal,
    closeReplaceAllConfirm,
    helpModal,
    closeHelpModal,
    settingsModal,
    closeSettingsModal,
    filterModal,
    closeFilterModal,
    exportModal,
    closeExportModal,
    getSpeakerDropdownEl: () => speakerDropdown.getSpeakerDropdownEl(),
    closeSpeakerDropdown,
    getSpeakerDropdownIndex: () => speakerDropdown.getSpeakerDropdownIndex(),
    setSpeakerDropdownIndex,
    applySpeakerSelected,
    player,
    ensureAudioLoadedForPlay,
    segmentsDiv,
    getSegments: () => segments,
    getCurrentSegmentIndex: () => currentSegmentIndex,
    findIndexById,
    setActiveSegment,
    snapToVisibleIfNeeded,
    getDoneSegIds: () => doneSegIds,
    forceVisibleIfFilteredOut,
    matchesFilterNow,
    forcedVisibleIds,
    pruneForcedVisibleNow,
    getRowById: () => rowById,
    updateDonePill,
    saveDoneToStorage,
    scheduleApplyFilters,
    getEditorMode: () => editorMode,
    toggleRepeatSeg,
    repeatSegState,
    joinWithPrevious,
    splitSegment,
    handleLoopHotkey,
    findSegmentIndexAtTime,
    seekRelative: (delta) => playbackSeekRelative(player, delta),
  });

  // Warn on close if dirty
  window.addEventListener('beforeunload', (e) => {
    if (!segments.length) return;
    if (!isDirtyNow()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateHeaderUI(false);

  /* AUTOLOAD_FROM_QUERY_V1 */

  function buildSegmentsFromSrtText(srtText) {
    const items = _parseSrt(srtText);
    segments = [];
    globalSeq = 0;

    for (const it of items) {
      const start = (typeof it.start === "number" && isFinite(it.start)) ? it.start : 0;
      let end = (typeof it.end === "number" && isFinite(it.end)) ? it.end : start + 5;
      if (end <= start) end = start + 0.5;

      segments.push({
        id: `seg_${globalSeq++}`,
        seq: globalSeq,
        blockId: "srt",
        speaker: it.speaker || "",
        text: it.text || "",
        start,
        end,
      });
    }

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));

    // Preserve end-times from SRT; only clamp overlaps / invalid times.
    enforceTiming({ sort: false });
  }

  async function autoloadFromQueryParams(startTime = null) {
    try {
      const params = new URLSearchParams(window.location.search);

      let audioUrl = options.audioUrl || params.get("audioUrl");
      let srtUrl = options.srtUrlPreview || params.get("srtUrl");
      const jobId = options.jobId || params.get("jobId");

      // Resolve "real" filenames for UI (snippet_filename / srt_filename) when jobId is present.
      let audioName = null;
      let transcriptName = null;
      let origFilename = null;
      if (jobId) {
        try {
          const j = await apiFetchJobStatus(jobId);
          audioName = j.snippet_filename || null;
          transcriptName = j.srt_filename || null;
          origFilename = j.orig_filename || null;

          // If not explicitly provided in params, construct audioUrl from jobId
          if (!audioUrl && audioName) {
            audioUrl = getApiUrl(`/api/demo/jobs/${encodeURIComponent(jobId)}/snippet`);
          }

          if (!srtUrl && transcriptName) {
            srtUrl = getApiUrl(`/api/demo/jobs/${encodeURIComponent(jobId)}/transcript.srt`);
          }
        } catch { }
      }

      // Audio autoload
      if (audioUrl) {
        player.src = audioUrl;

        const tail = (() => {
          try { return decodeURIComponent(audioUrl.split("/").pop() || "audio"); }
          catch { return (audioUrl.split("/").pop() || "audio"); }
        })();

        const aName = audioName || tail;
        setChosenFileLabel(audioBtnLabelEl, aName, "Choose audio", "audio");
      }

      if (srtContent) {
        // Local file content provided directly
        const tName = options.transcriptName || 'Local Project';
        setChosenFileLabel(transcriptBtnLabelEl, tName, "Choose transcript", "transcript");
        loadedJsonFileName = tName;
        srtSaveHandle = null;
        exportFileName = null;

        buildSegmentsFromSrtText(srtContent);
        loadDoneFromStorage(); // Works if based on content hash
        renderSegments();
        updateDonePill();
        setCleanNow();
      }
      // Transcript autoload (.srt) from URL
      else if (srtUrl) {
        const srtText = await apiFetchSrt(srtUrl);

        const tail = (() => {
          try { return decodeURIComponent(srtUrl.split("/").pop() || "transcript.srt"); }
          catch { return (srtUrl.split("/").pop() || "transcript.srt"); }
        })();

        const tName = transcriptName || tail;

        setChosenFileLabel(transcriptBtnLabelEl, tName, "Choose transcript", "transcript");
        loadedJsonFileName = tName; // used for default Save-As name
        // Server-loaded transcript: no write-back handle yet (design later)
        srtSaveHandle = null;
        exportFileName = null;

        buildSegmentsFromSrtText(srtText);
        loadDoneFromStorage();
        renderSegments();
        // Initial sync to saved startTime (if provided)
        if (typeof startTime === 'number' && Number.isFinite(startTime)) {
          setTimeout(() => {
            const idx = findSegmentIndexAtTime(startTime);
            if (idx >= 0) setActiveSegment(idx, 'auto', 'center', true); // Use 'auto' for instant jump on load
            if (topicsView && typeof topicsView.setActiveTime === 'function') {
              topicsView.setActiveTime(startTime, true, 'auto');
            }
          }, 100);
        }
        updateDonePill();
        setCleanNow();

        // Process embedded topics (now injected by server)
        syncTopicsFromSrtText(srtText);
      }
    } catch (e) {
      console.error(e);
      // Silent fail is ok; editor remains usable with manual choices
    }
  }

  // Set up UI state based on security context
  setTimeout(() => {
    const canPicker = ctx.canUseFileSystem;
    if (!canPicker) {
      if (document.getElementById('saveAsBtn')) {
        document.getElementById('saveAsBtn').style.display = ctx.canUseFileSystem ? '' : 'none';
      }
      const sb = document.getElementById('saveBtn');
      if (sb) {
        sb.textContent = "Download";
        sb.title = "Download .srt (Browser mode)";
      }
    }
    autoloadFromQueryParams(startTime);
    // Ensure correct initial view (e.g. text mode for mobile)
    setEditorMode(editorMode);

  }, 0);


  const moreMenuBtn = document.getElementById('moreMenuBtn');
  const headerMoreMenu = document.getElementById('headerMoreMenu');
  const moreMenus = [
    (moreMenuBtn && headerMoreMenu) ? { trigger: moreMenuBtn, menu: headerMoreMenu } : null,
  ].filter(Boolean);

  if (moreMenus.length > 0) {
    const setMenuOpen = (entry, open) => {
      const isOpen = !!open;
      entry.menu.classList.toggle('show-menu', isOpen);
      entry.trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    const closeAllMoreMenus = () => {
      for (const entry of moreMenus) setMenuOpen(entry, false);
    };

    for (const entry of moreMenus) {
      entry.trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !entry.menu.classList.contains('show-menu');
        closeAllMoreMenus();
        setMenuOpen(entry, willOpen);
      });

      entry.menu.addEventListener('click', (e) => {
        const item = e.target instanceof Element ? e.target.closest('.more-menu-item') : null;
        if (item) closeAllMoreMenus();
      }, true);
    }

    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const inside = moreMenus.some(({ trigger, menu }) => trigger.contains(target) || menu.contains(target));
      if (!inside) closeAllMoreMenus();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllMoreMenus();
    });
  }
}

export function unmountEditor() {
  const player = document.getElementById('player');
  let currentTime = 0;
  if (player) {
    currentTime = player.currentTime; // Capture FIRST
    player.pause();
    player.removeAttribute('src'); // Stop buffering/playback
    player.load(); // Force reset
  }
  return { currentTime };
}
