import { loadSettings as apiLoadSettings, saveSettings as apiSaveSettings, fetchJobStatus as apiFetchJobStatus, fetchSrt as apiFetchSrt, getApiUrl } from "./api.js";
import { safePreview, normSpeaker, secondsToTimecodeWhole, hashString, _srtTcToSeconds, _parseSrt, extractMetadata, embedMetadata } from "./utils.js";
import { TextView } from "./components/TextView.js";
import { TopicsView } from "./components/TopicsView.js";
import { AudioPlayer } from "./components/AudioPlayer.js";
import {
  secondsToSrtTimecode, buildSrtFromSegments as _buildSrt,
  suggestSrtName as _suggestSrtName, sanitizeSrtFileName as _sanitizeSrtFileName,
  downloadTextBlob, downloadSrt as _downloadSrt, saveSrtLocally as _saveSrtLocally,
  doExport as _doExport
} from "./editorSave.js";
import {
  isFindOpen as _isFindOpen, findNext as _findNext,
  replaceCurrent as _replaceCurrent, openReplaceAllConfirm as _openReplaceAllConfirm,
  closeReplaceAllConfirm as _closeReplaceAllConfirm, doReplaceAllConfirmed as _doReplaceAllConfirmed,
  openFindModal as _openFindModal, closeFindModal as _closeFindModal,
  getTranscriptSelectionText as _getTranscriptSelectionText,
  escapeRegExp, getFieldValue, setFieldValue
} from "./editorFind.js";
import {
  joinTextsForJoin as _joinTextsForJoin,
  getRowBySegId as _getRowBySegId, reindexAllRows as _reindexAllRows,
  insertRowAtIndex as _insertRowAtIndex, removeRowBySegId as _removeRowBySegId,
  moveRowBySegIdToIndex as _moveRowBySegIdToIndex, applySegStartNoHistory as _applySegStartNoHistory,
  canJoinAtIndex as _canJoinAtIndex, applyJoinNoHistory as _applyJoinNoHistory,
  undoJoinNoHistory as _undoJoinNoHistory, joinWithPrevious as _joinWithPrevious,
  askForSplitTimeWhole as _askForSplitTimeWhole, applySplitNoHistory as _applySplitNoHistory,
  undoSplitNoHistory as _undoSplitNoHistory, splitSegment as _splitSegment
} from "./editorSegments.js";
// ... imports ...
export function mountEditor(options = {}) {
  // Capture options if needed
  const { jobId, audioUrl, srtUrlPreview, startTime, srtContent, canUseFileSystem, app } = options;

  const transcriptInput = document.getElementById('transcriptInput');

  const audioInput = document.getElementById('audioInput');
  const transcriptBtnLabelEl = document.getElementById('transcriptBtnLabel');
  const audioBtnLabelEl = document.getElementById('audioBtnLabel');

  const fileSummaryEl = document.getElementById('fileSummaryLabel');
  let chosenTranscriptName = null;
  let chosenAudioName = null;

  // Mobile Detection moved to App.js
  // We rely on document.body.classList having 'mobile' or 'desktop' set by App.detectDeviceType()

  function updateFileSummaryLabel() {
    if (!fileSummaryEl) return;
    let saved = null;
    try {
      // exportFileName is declared later in this script; guard with typeof to avoid TDZ issues.
      if (typeof exportFileName !== 'undefined' && exportFileName) saved = exportFileName;
    } catch { }
    const t = saved || chosenTranscriptName || 'No transcript selected';
    const a = chosenAudioName || 'No audio selected';
    const s = `${t} / ${a}`;
    fileSummaryEl.textContent = s;
    fileSummaryEl.title = s;
  }

  updateFileSummaryLabel();
  function setChosenFileLabel(labelEl, name, chooseText, kind) {
    if (!labelEl) return;
    const txt = chooseText || '';
    // Keep button labels stable (always "Choose …"); show filenames in the summary line instead.
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


  const segmentsDiv = document.getElementById('segments');
  const player = document.getElementById('player');


  const textViewDiv = document.getElementById('textView');
  const modeSegmentsBtn = document.getElementById('modeSegmentsBtn');
  const modeTextBtn = document.getElementById('modeTextBtn');

  let editorMode = (options.lastViewMode === 'text' || options.lastViewMode === 'segments')
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
    },
    getJobId: () => { /* Not strictly needed if we pass URL to load() */ }
  }); // TopicsView needs to be loaded later

  const customPlayer = new AudioPlayer({
    audioElement: player,
    container: document.getElementById('customPlayer')
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

  // Removed: let tvSpanById = new Map();
  // Removed: let tvActiveSegId = null;


  const saveBtn = document.getElementById('saveBtn');
  const saveAsBtn = document.getElementById('saveAsBtn');
  const exportDocBtn = document.getElementById('exportDocBtn');

  const saveModal = document.getElementById('saveModal');
  const saveNameIn = document.getElementById('saveName');
  const cancelSaveBtn = document.getElementById('cancelSaveBtn');
  const confirmSaveBtn = document.getElementById('confirmSaveBtn');

  const historyBtn = document.getElementById('historyBtn');
  const historyModal = document.getElementById('historyModal');
  const closeHistoryBtn = document.getElementById('closeHistoryBtn');
  const undoListEl = document.getElementById('undoList');
  const redoListEl = document.getElementById('redoList');
  const undoCountEl = document.getElementById('undoCount');
  const redoCountEl = document.getElementById('redoCount');
  const detailsEl = document.getElementById('historyDetails');

  let historySelected = null; // {stack:'undo'|'redo', hid:number}
  let historyNextId = 1;


  function actionToDebugJson(a) {
    const meta = a.meta || {};
    // avoid dumping big snapshots
    const out = {
      id: a.hid,
      label: a.label,
      meta,
    };
    return JSON.stringify(out, null, 2);
  }

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

  function openHistoryModal() {
    if (!historyModal) return;
    player.pause();
    historySelected = null;
    detailsEl.textContent = '(click an item)';
    historyModal.classList.remove('hidden');
    renderHistory();
  }

  function closeHistoryModal() {
    if (!historyModal) return;
    historyModal.classList.add('hidden');
  }


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

  let findDragX = 0;
  let findDragY = 0;
  let findDragging = false;
  let findDragStartX = 0;
  let findDragStartY = 0;
  let findDragOriginX = 0;
  let findDragOriginY = 0;

  function setFindDrag(x, y) {
    findDragX = x;
    findDragY = y;
    if (findCard) {
      findCard.style.setProperty('--drag-x', `${findDragX}px`);
      findCard.style.setProperty('--drag-y', `${findDragY}px`);
    }
  }

  function resetFindDrag() { setFindDrag(0, 0); }

  function onFindDragMove(e) {
    if (!findDragging) return;
    const dx = e.clientX - findDragStartX;
    const dy = e.clientY - findDragStartY;
    setFindDrag(findDragOriginX + dx, findDragOriginY + dy);
  }

  function onFindDragUp() {
    if (!findDragging) return;
    findDragging = false;
    document.removeEventListener('mousemove', onFindDragMove);
    document.removeEventListener('mouseup', onFindDragUp);
  }

  if (findDragHandle) {
    findDragHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // only drag if clicking the handle itself (not interacting with inputs)
      findDragging = true;
      findDragStartX = e.clientX;
      findDragStartY = e.clientY;
      findDragOriginX = findDragX;
      findDragOriginY = findDragY;
      document.addEventListener('mousemove', onFindDragMove);
      document.addEventListener('mouseup', onFindDragUp);
      e.preventDefault();
    });
  }



  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');
  const closeHelpBtn = document.getElementById('closeHelpBtn');
  const helpCard = helpModal ? helpModal.querySelector('.help-card') : null;
  const helpDragHandle = document.getElementById('helpDragHandle');

  let helpDragX = 0;
  let helpDragY = 0;
  let helpDragging = false;
  let helpDragStartX = 0;
  let helpDragStartY = 0;
  let helpDragOriginX = 0;
  let helpDragOriginY = 0;

  function setHelpDrag(x, y) {
    helpDragX = x;
    helpDragY = y;
    if (helpCard) {
      helpCard.style.setProperty('--drag-x', `${helpDragX}px`);
      helpCard.style.setProperty('--drag-y', `${helpDragY}px`);
    }
  }

  function onHelpDragMove(e) {
    if (!helpDragging) return;
    const dx = e.clientX - helpDragStartX;
    const dy = e.clientY - helpDragStartY;
    setHelpDrag(helpDragOriginX + dx, helpDragOriginY + dy);
  }

  function onHelpDragUp() {
    if (!helpDragging) return;
    helpDragging = false;
    document.removeEventListener('mousemove', onHelpDragMove);
    document.removeEventListener('mouseup', onHelpDragUp);
  }

  if (helpDragHandle) {
    helpDragHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      helpDragging = true;
      helpDragStartX = e.clientX;
      helpDragStartY = e.clientY;
      helpDragOriginX = helpDragX;
      helpDragOriginY = helpDragY;
      document.addEventListener('mousemove', onHelpDragMove);
      document.addEventListener('mouseup', onHelpDragUp);
      e.preventDefault();
    });
  }

  function isHelpOpen() { return helpModal && !helpModal.classList.contains('hidden'); }

  function openHelpModal() {
    if (!helpModal) return;
    player.pause();
    helpModal.classList.remove('hidden');
    setTimeout(() => { closeHelpBtn?.focus?.(); }, 0);
  }

  function closeHelpModal() {
    if (!helpModal) return;
    helpModal.classList.add('hidden');
  }

  if (helpBtn) helpBtn.addEventListener('click', openHelpModal);


  // -------------------------
  // Filter (speaker / changed) + playback skipping
  // -------------------------
  const filterBtn = document.getElementById('filterBtn');
  const filterModal = document.getElementById('filterModal');
  const closeFilterBtn = document.getElementById('closeFilterBtn');
  const filterCard = filterModal ? filterModal.querySelector('.filter-card') : null;
  const filterDragHandle = document.getElementById('filterDragHandle');

  let filterDragX = 0;
  let filterDragY = 0;
  let filterDragging = false;
  let filterDragStartX = 0;
  let filterDragStartY = 0;
  let filterDragOriginX = 0;
  let filterDragOriginY = 0;

  function setFilterDrag(x, y) {
    filterDragX = x;
    filterDragY = y;
    if (filterCard) {
      filterCard.style.setProperty('--drag-x', `${filterDragX}px`);
      filterCard.style.setProperty('--drag-y', `${filterDragY}px`);
    }
  }

  function onFilterDragMove(e) {
    if (!filterDragging) return;
    const dx = e.clientX - filterDragStartX;
    const dy = e.clientY - filterDragStartY;
    setFilterDrag(filterDragOriginX + dx, filterDragOriginY + dy);
  }

  function onFilterDragUp() {
    if (!filterDragging) return;
    filterDragging = false;
    document.removeEventListener('mousemove', onFilterDragMove);
    document.removeEventListener('mouseup', onFilterDragUp);
  }

  if (filterDragHandle) {
    filterDragHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      filterDragging = true;
      filterDragStartX = e.clientX;
      filterDragStartY = e.clientY;
      filterDragOriginX = filterDragX;
      filterDragOriginY = filterDragY;
      document.addEventListener('mousemove', onFilterDragMove);
      document.addEventListener('mouseup', onFilterDragUp);
      e.preventDefault();
    });
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
    try { segmentStarts = segments.map(s => s.start); } catch { segmentStarts = []; }
  }

  function filterIsActive() {
    return (filterState.speakers.size > 0) || (filterState.changedMode !== 'all') || (filterState.doneMode !== 'all');
  }


  function matchesFilter(seg) {
    if (!seg) return false;
    if (filterState.speakers.size) {
      const sp = normSpeaker(seg.speaker);
      if (!filterState.speakers.has(sp)) return false;
    }
    if (filterState.changedMode !== 'all') {
      const isChanged = changedSegIds.has(seg.id);
      if (filterState.changedMode === 'changed' && !isChanged) return false;
      if (filterState.changedMode === 'unchanged' && isChanged) return false;
    }
    if (filterState.doneMode !== 'all') {
      const isDone = doneSegIds.has(seg.id);
      if (filterState.doneMode === 'done' && !isDone) return false;
      if (filterState.doneMode === 'undone' && isDone) return false;
    }
    return true;
  }

  function isVisibleNow(seg) {
    if (!filterIsActive()) return true;
    return matchesFilter(seg) || forcedVisibleIds.has(seg.id);
  }

  function clearFilterState() {
    filterState.speakers.clear();
    filterState.changedMode = 'all';
    filterState.doneMode = 'all';
    // keep playbackFiltered preference
    forcedVisibleIds.clear();
    hideFilterNotice();
    syncFilterUIFromState();

    try { syncModeButtons(); } catch { }
    scheduleApplyFilters();
  }

  function setChangedMode(mode) {
    filterState.changedMode = (mode === 'changed' || mode === 'unchanged') ? mode : 'all';
  }

  function setDoneMode(mode) {
    filterState.doneMode = (mode === 'done' || mode === 'undone') ? mode : 'all';
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


  function showFilterNotice(msg) {
    if (!filterNotice || !filterNoticeText) return;
    filterNoticeText.textContent = msg || '';
    filterNotice.classList.remove('hidden');
  }

  function hideFilterNotice() {
    if (!filterNotice) return;
    filterNotice.classList.add('hidden');
    if (filterNoticeText) filterNoticeText.textContent = '';
  }

  function pruneForcedVisibleIds() {
    if (!forcedVisibleIds.size) { hideFilterNotice(); return; }

    // If many forced-visible ids exist, avoid O(n^2) (findIndexById is linear).
    if (forcedVisibleIds.size > 24) {
      const keep = new Set();
      for (const seg of segments) {
        if (!seg) continue;
        if (forcedVisibleIds.has(seg.id) && !matchesFilter(seg)) keep.add(seg.id);
      }
      forcedVisibleIds.clear();
      for (const id of keep) forcedVisibleIds.add(id);
    } else {
      for (const id of Array.from(forcedVisibleIds)) {
        const idx = findIndexById(id);
        if (idx === -1) { forcedVisibleIds.delete(id); continue; }
        const seg = segments[idx];
        if (matchesFilter(seg)) forcedVisibleIds.delete(id);
      }
    }

    if (!forcedVisibleIds.size) hideFilterNotice();
  }

  function forceVisibleIfFilteredOut(ids, reason, opts = {}) {
    if (!filterIsActive()) return;

    const silent = !!(opts && opts.silent);
    const arr = (ids || []).filter(Boolean);
    if (!arr.length) return;

    let added = false;
    let needsNotice = false;

    // If many ids, avoid O(n^2) lookups.
    if (arr.length > 24) {
      const wanted = new Set(arr);
      for (const seg of segments) {
        if (!seg) continue;
        if (!wanted.has(seg.id)) continue;
        if (!matchesFilter(seg)) {
          needsNotice = true;
          if (!forcedVisibleIds.has(seg.id)) {
            forcedVisibleIds.add(seg.id);
            added = true;
          }
        }
      }
    } else {
      for (const id of arr) {
        const idx = findIndexById(id);
        if (idx === -1) continue;
        const seg = segments[idx];
        if (!matchesFilter(seg)) {
          needsNotice = true;
          if (!forcedVisibleIds.has(id)) {
            forcedVisibleIds.add(id);
            added = true;
          }
        }
      }
    }

    // We intentionally show the notice on user-initiated actions (e.g. blur),
    // but stay silent during typing/debounced commits.
    if (needsNotice && !silent) {
      showFilterNotice(reason || 'Some changes are outside the current filter.');
    }
  }

  function makeChip(label, onClose) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';

    const t = document.createElement('span');
    t.textContent = label;

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove filter';
    x.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { onClose && onClose(); } catch { }
    });

    chip.appendChild(t);
    chip.appendChild(x);
    return chip;
  }

  function updateFilterBarUI(visibleCount, total) {
    if (!filterBar) return;
    const active = filterIsActive();
    filterBar.classList.toggle('hidden', !active);

    if (filterBtn) {
      filterBtn.textContent = active ? 'Filter*' : 'Filter';
    }

    if (filterChipsEl) {
      filterChipsEl.innerHTML = '';

      // Speakers
      const speakers = Array.from(filterState.speakers.values());
      const MAX = 4;
      for (let i = 0; i < Math.min(MAX, speakers.length); i++) {
        const sp = speakers[i];
        const lab = `Speaker: ${sp || '(empty)'}`;
        filterChipsEl.appendChild(makeChip(lab, () => {
          filterState.speakers.delete(sp);
          syncFilterUIFromState();
          scheduleApplyFilters();
        }));
      }
      if (speakers.length > MAX) {
        const extra = speakers.length - MAX;
        const chip = document.createElement('span');
        chip.className = 'filter-chip';
        chip.textContent = `+${extra} more`;
        chip.title = 'Open Filter to edit';
        chip.addEventListener('click', () => openFilterModal());
        filterChipsEl.appendChild(chip);
      }

      // Changed
      if (filterState.changedMode !== 'all') {
        const lab = (filterState.changedMode === 'changed') ? 'Changed only' : 'Unchanged only';
        filterChipsEl.appendChild(makeChip(lab, () => {
          setChangedMode('all');
          syncFilterUIFromState();
          scheduleApplyFilters();
        }));
      }
      // Done
      if (filterState.doneMode !== 'all') {
        const lab = (filterState.doneMode === 'done') ? 'Done only' : 'Undone only';
        filterChipsEl.appendChild(makeChip(lab, () => {
          setDoneMode('all');
          syncFilterUIFromState();
          scheduleApplyFilters();
        }));
      }

      // Play mode chip (only show when filter active)
      if (active) {
        const lab = filterState.playbackFiltered ? 'Play: visible only' : 'Play: all';
        const chip = document.createElement('span');
        chip.className = 'filter-chip';
        chip.textContent = lab;
        chip.title = 'Toggle in Filter…';
        chip.addEventListener('click', () => openFilterModal());
        filterChipsEl.appendChild(chip);
      }
    }

    if (filterCountEl) {
      if (!filterIsActive()) filterCountEl.textContent = '';
      else filterCountEl.textContent = `Showing ${visibleCount} / ${total}`;
    }
  }

  function rebuildFilterSpeakerOptions() {
    if (!filterSpeakersList) return;
    const counts = new Map();
    for (const s of segments) {
      const k = normSpeaker(s.speaker);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const keys = Array.from(counts.keys());
    keys.sort((a, b) => {
      // empty last
      if (!a && b) return 1;
      if (a && !b) return -1;
      return a.localeCompare(b);
    });

    filterSpeakersList.innerHTML = '';
    for (const k of keys) {
      const lab = document.createElement('label');
      lab.className = 'chk';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = k;
      cb.checked = filterState.speakers.has(k);

      cb.addEventListener('change', () => {
        if (cb.checked) filterState.speakers.add(k);
        else filterState.speakers.delete(k);
        scheduleApplyFilters();
      });

      const txt = document.createElement('span');
      const name = k || '(empty)';
      txt.textContent = `${name} (${counts.get(k) || 0})`;

      lab.appendChild(cb);
      lab.appendChild(txt);
      filterSpeakersList.appendChild(lab);
    }

    if (!keys.length) {
      const div = document.createElement('div');
      div.className = 'muted';
      div.textContent = '(no speakers found)';
      filterSpeakersList.appendChild(div);
    }
  }

  function syncFilterUIFromState() {
    // speakers list
    rebuildFilterSpeakerOptions();

    // changed radios
    try {
      const radios = document.querySelectorAll('input[name="changedMode"]');
      radios.forEach(r => r.checked = (r.value === filterState.changedMode));
    } catch { }

    // done radios
    try {
      const dRadios = document.querySelectorAll('input[name="doneMode"]');
      dRadios.forEach(r => r.checked = (r.value === filterState.doneMode));
    } catch { }

    // playback toggle
    if (playFilteredToggle) playFilteredToggle.checked = !!filterState.playbackFiltered;
  }

  function openFilterModal() {
    if (!filterModal) return;
    player.pause();
    syncFilterUIFromState();
    filterModal.classList.remove('hidden');
    setTimeout(() => { try { closeFilterBtn.focus(); } catch { } }, 0);
  }

  function closeFilterModal() {
    if (!filterModal) return;
    filterModal.classList.add('hidden');
  }

  if (filterBtn) filterBtn.addEventListener('click', openFilterModal);
  if (closeFilterBtn) closeFilterBtn.addEventListener('click', closeFilterModal);
  if (filterModal) filterModal.addEventListener('click', (e) => { if (e.target === filterModal) closeFilterModal(); });

  function applyFilterFromModalControls() {
    try {
      const r = document.querySelector('input[name="changedMode"]:checked');
      setChangedMode(r ? r.value : 'all');
    } catch { }
    try {
      const d = document.querySelector('input[name="doneMode"]:checked');
      setDoneMode(d ? d.value : 'all');
    } catch { }
    if (playFilteredToggle) filterState.playbackFiltered = !!playFilteredToggle.checked;
    scheduleApplyFilters();
  }

  if (filterModal) {
    filterModal.addEventListener('change', (e) => {
      // speaker checkboxes are already wired; just apply mode changes
      if (e.target && (e.target.name === 'changedMode' || e.target.name === 'doneMode' || e.target.id === 'playFilteredToggle')) {
        applyFilterFromModalControls();
      }
    });
  }

  if (filterClearBtn3) filterClearBtn3.addEventListener('click', () => { clearFilterState(); });
  if (filterClearBtn) filterClearBtn.addEventListener('click', () => { clearFilterState(); });

  if (filterStrictBtn) filterStrictBtn.addEventListener('click', () => {
    forcedVisibleIds.clear();
    hideFilterNotice();
    scheduleApplyFilters();
  });


  let _filterApplyRaf = 0;
  let _filterApplying = false;
  let _filterApplyPending = false;
  let _filterApplyToken = 0;

  function scheduleApplyFilters() {
    _filterApplyPending = true;
    if (_filterApplying) return;
    if (_filterApplyRaf) return;
    _filterApplyRaf = requestAnimationFrame(() => {
      _filterApplyRaf = 0;
      if (!_filterApplyPending) return;
      _filterApplyPending = false;
      applyFiltersToDOM();
    });
  }

  function applyFiltersToDOM() {
    if (!segmentsDiv) return;
    _filterApplying = true;
    const token = ++_filterApplyToken;
    if (!segments.length) {
      visibleStarts = [];
      visibleSegIds = [];
      if (filterBar) filterBar.classList.add('hidden');
      if (filterBtn) filterBtn.textContent = 'Filter';
      hideFilterNotice();
      _filterApplying = false;
      if (_filterApplyPending) scheduleApplyFilters();
      return;
    }

    // Keep starts array synced
    rebuildSegmentStarts();

    const active = filterIsActive();
    const usesChanged = (filterState.changedMode !== 'all') || forcedVisibleIds.size;
    if (usesChanged) {
      try { recomputeChangedSegIds(); } catch { }
    }

    pruneForcedVisibleIds();

    const total = segments.length;
    const newVisStarts = [];
    const newVisIds = [];
    let visibleCount = 0;

    // chunked apply to avoid stalls on big transcripts
    const BUDGET_MS = 10;
    const MAX_PER_FRAME = 1200;

    let i = 0;
    function step() {
      if (token !== _filterApplyToken) { _filterApplying = false; if (_filterApplyPending) scheduleApplyFilters(); return; }
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      let n = 0;

      while (i < total && n < MAX_PER_FRAME) {
        const seg = segments[i];
        const row = getRowBySegId(seg.id);
        const show = (!active) ? true : (matchesFilter(seg) || forcedVisibleIds.has(seg.id) || (editingTextSegId && seg.id === editingTextSegId));

        if (row) {
          row.classList.toggle('filtered-out', !show);
          const forced = active && forcedVisibleIds.has(seg.id) && !matchesFilter(seg);
          row.classList.toggle('forced-visible', !!forced);

          const jb = row.querySelector('.icon-btn.join');
          if (jb) jb.disabled = !canJoinAtIndex(i);
        }

        if (show) {
          newVisStarts.push(seg.start);
          newVisIds.push(seg.id);
          visibleCount++;
        }

        i++;
        n++;

        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if ((t1 - t0) > BUDGET_MS) break;
      }

      if (i < total) {
        requestAnimationFrame(step);
        return;
      }

      visibleStarts = newVisStarts;
      visibleSegIds = newVisIds;
      updateFilterBarUI(visibleCount, total);

      try { if (editorMode === 'text') renderTextView(); } catch { }
      _filterApplying = false;
      if (_filterApplyPending) scheduleApplyFilters();
    }

    step();
  }

  function upperBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function findSegmentIndexAtTime(t) {
    if (!segments.length) return -1;
    if (!segmentStarts.length || segmentStarts.length !== segments.length) rebuildSegmentStarts();

    const i = upperBound(segmentStarts, t) - 1;
    if (i < 0) return 0;
    if (i >= segments.length) return segments.length - 1;
    // if exactly at end of a segment, bump to next
    if (t >= segments[i].end && i + 1 < segments.length) return i + 1;
    return i;
  }

  function nextVisibleStartAfter(t) {
    if (!visibleStarts.length) return null;
    const idx = upperBound(visibleStarts, t);
    return (idx < visibleStarts.length) ? visibleStarts[idx] : null;
  }

  function snapToVisibleIfNeeded() {
    if (!filterIsActive() || !filterState.playbackFiltered) return;
    if (!visibleStarts.length) {
      // fallback compute (fast) if apply hasn't finished yet
      const arr = [];
      const ids = [];
      for (const seg of segments) {
        if (isVisibleNow(seg)) { arr.push(seg.start); ids.push(seg.id); }
      }
      visibleStarts = arr;
      visibleSegIds = ids;
    }
    if (!visibleStarts.length) return;

    const t = player.currentTime;
    const idx = findSegmentIndexAtTime(t);
    const seg = segments[idx];
    if (seg && isVisibleNow(seg)) return;

    const nxt = nextVisibleStartAfter(t - 0.001) ?? visibleStarts[0];
    if (nxt == null) return;
    player.currentTime = nxt;
  }

  function enforceFilteredPlayback() {
    if (!filterIsActive() || !filterState.playbackFiltered) return false;
    if (!visibleStarts.length) {
      // if nothing visible: pause
      player.pause();
      return true;
    }

    const t = player.currentTime;
    const idx = findSegmentIndexAtTime(t);
    const seg = segments[idx];
    if (seg && isVisibleNow(seg)) return false;

    const nxt = nextVisibleStartAfter(t - 0.001) ?? visibleStarts[0];
    if (nxt == null) {
      player.pause();
      return true;
    }
    if (Math.abs((player.currentTime || 0) - nxt) < 1e-4) {
      // avoid infinite loop
      player.pause();
      return true;
    }

    player.currentTime = nxt;
    return true;
  }

  // keep playback skipping and highlight in a rAF loop (smoother than timeupdate)
  let _playRaf = 0;
  function playbackLoop() {
    _playRaf = 0;
    if (player.paused) return;

    // Repeat loop (if active): jump back to loop start once we pass the end.
    try {
      const b = getEffectiveLoopBounds();
      if (b) {
        const t = player.currentTime;
        if (t >= b.end - 0.01 || t < b.start - 0.01) {
          player.currentTime = b.start;
        }
      }
    } catch { }

    if (Date.now() >= suppressTimeSyncUntil) {
      const jumped = enforceFilteredPlayback();
      if (!jumped) {
        const t = player.currentTime;
        const idx = findSegmentIndexAtTime(t);
        if (idx !== -1 && idx !== currentSegmentIndex) {
          if (keepCenteredDuringPlayback) setActiveSegment(idx, 'auto', 'center', true);
          else setActiveSegment(idx, 'smooth', 'nearest');
        }
      }
    }

    _playRaf = requestAnimationFrame(playbackLoop);
  }

  player.addEventListener('play', () => {
    try { clampToLoopStartIfNeeded(); } catch { }
    try { snapToVisibleIfNeeded(); } catch { }

    // Ensure active segment is in view (e.g. if user scrolled away)
    if (currentSegmentIndex >= 0) {
      // Use 'auto' to snap instantly if out of view, avoiding slow scrolls
      setActiveSegment(currentSegmentIndex, 'auto', 'center');
    }

    if (!_playRaf) _playRaf = requestAnimationFrame(playbackLoop);
  });
  player.addEventListener('pause', () => {
    if (_playRaf) { try { cancelAnimationFrame(_playRaf); } catch { } _playRaf = 0; }
  });
  player.addEventListener('seeked', () => {
    try { clampToLoopStartIfNeeded(); } catch { }
    try { snapToVisibleIfNeeded(); } catch { }
  });


  if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelpModal);
  if (helpModal) helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelpModal(); });

  // Floating Mobile Menu Button Logic
  const floatMenuBtn = document.getElementById('floatingMobileMenuBtn');
  if (floatMenuBtn) {
    floatMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle same menu as the header one
      const fileActions = document.getElementById('headerFileActions');
      if (fileActions) fileActions.classList.toggle('show');
    });
  }

  const replaceAllModal = document.getElementById('replaceAllModal');
  const raSummary = document.getElementById('raSummary');
  const raCancelBtn = document.getElementById('raCancelBtn');
  const raConfirmBtn = document.getElementById('raConfirmBtn');

  let currentFind = null; // {sig, segId, field, start, end, match, segIndex}
  let lastFindQuery = null;
  let lastFindIndex = -1;

  /* Find/Replace — delegated to editorFind.js */
  // escapeRegExp, getFieldValue, setFieldValue imported directly from editorFind.js

  function isFindOpen() { return _isFindOpen(ctx); }
  function setFindStatus(msg, isError) { /* delegated; used only within extracted module now */ }



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
    findModal.addEventListener('mousedown', (e) => { if (e.target === findModal) closeFindModal(); });
  }
  if (replaceAllModal) {
    replaceAllModal.addEventListener('mousedown', (e) => { if (e.target === replaceAllModal) closeReplaceAllConfirm(); });
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

  let settingsDragX = 0;
  let settingsDragY = 0;
  let settingsDragging = false;
  let settingsDragStartX = 0;
  let settingsDragStartY = 0;
  let settingsDragOriginX = 0;
  let settingsDragOriginY = 0;

  function setSettingsDrag(x, y) {
    settingsDragX = x;
    settingsDragY = y;
    if (settingsCard) {
      settingsCard.style.setProperty('--drag-x', `${settingsDragX}px`);
      settingsCard.style.setProperty('--drag-y', `${settingsDragY}px`);
    }
  }
  function resetSettingsDrag() { setSettingsDrag(0, 0); }

  function onSettingsDragMove(e) {
    if (!settingsDragging) return;
    const dx = e.clientX - settingsDragStartX;
    const dy = e.clientY - settingsDragStartY;
    setSettingsDrag(settingsDragOriginX + dx, settingsDragOriginY + dy);
  }
  function onSettingsDragUp() {
    if (!settingsDragging) return;
    settingsDragging = false;
    document.removeEventListener('mousemove', onSettingsDragMove);
    document.removeEventListener('mouseup', onSettingsDragUp);
  }

  if (settingsDragHandle) {
    settingsDragHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      settingsDragging = true;
      settingsDragStartX = e.clientX;
      settingsDragStartY = e.clientY;
      settingsDragOriginX = settingsDragX;
      settingsDragOriginY = settingsDragY;
      document.addEventListener('mousemove', onSettingsDragMove);
      document.addEventListener('mouseup', onSettingsDragUp);
      e.preventDefault();
    });
  }

  function syncSettingsUI() {
    if (optKeepCentered) optKeepCentered.checked = !!keepCenteredDuringPlayback;
    if (optAutoSplitTs) optAutoSplitTs.checked = !!autoAssignSplitTs;
  }

  function openSettingsModal() {
    flushPendingText();
    try { player.pause(); } catch { }
    resetSettingsDrag();
    try { loadSettings(); } catch { }
    syncSettingsUI();
    settingsModal.classList.remove('hidden');
  }
  function closeSettingsModal() {
    onSettingsDragUp();
    settingsModal.classList.add('hidden');
  }

  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);
  if (settingsModal) settingsModal.addEventListener('mousedown', (e) => { if (e.target === settingsModal) closeSettingsModal(); });

  if (optKeepCentered) {
    optKeepCentered.addEventListener('change', (e) => {
      keepCenteredDuringPlayback = !!e.target.checked;
      saveSettings();
    });
  }

  if (optAutoSplitTs) {
    optAutoSplitTs.addEventListener('change', (e) => {
      autoAssignSplitTs = !!e.target.checked;
      saveSettings();
    });
  }
  if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
  if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', closeHistoryModal);

  if (historyModal) {
    historyModal.addEventListener('mousedown', (e) => {
      if (e.target === historyModal) closeHistoryModal();
    });
  }


  let rawJson = {};
  let segments = [];
  let currentSegmentIndex = -1;
  let globalSeq = 0;
  let rowById = new Map();

  // Chunked textarea sizing state (prevents long main-thread stalls)
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
            try { scheduleDirtyCheck(); } catch { }
            try { forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.'); } catch { }
            try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
          },
          undo: () => {
            const seg = segments.find(s => s.id === id);
            if (!seg) return;
            seg.text = from;
            updateRowBySegId(id);
            if (activeId) setActiveSegment(findIndexById(activeId), null);
            try { scheduleDirtyCheck(); } catch { }
            try { forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.'); } catch { }
            try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
          }
        });
        const showNotice = (opts && opts.showFilterNotice !== false);
        try { forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.', { silent: !showNotice }); } catch { }
        if (showNotice && !isEditingText()) {
          try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
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


  function cloneSegmentsState(segs) {
    return segs.map(s => ({
      id: s.id, seq: s.seq, blockId: s.blockId,
      speaker: s.speaker, text: s.text,
      start: s.start, end: s.end
    }));
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

  function preserveScrollAndRender(activeId = null) {
    const prev = segmentsDiv.scrollTop;
    renderSegments();
    segmentsDiv.scrollTop = prev;
    if (activeId) {
      const idx = findIndexById(activeId);
      if (idx !== -1) setActiveSegment(idx, 'auto', 'nearest');
    }
  }


  function restoreSegmentsState(state, activeSegId = null, playerTime = null) {
    try { if (typeof closeSpeakerDropdown === 'function') closeSpeakerDropdown(); } catch { }

    const prev = segmentsDiv.scrollTop;

    segments = cloneSegmentsState(state);
    seg1.end = seg2.start;

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    enforceTiming({ sort: false });
    renderSegments();

    segmentsDiv.scrollTop = prev;

    const idx = activeSegId ? findIndexById(activeSegId) : -1;
    if (idx !== -1) setActiveSegment(idx, 'auto', 'nearest');

    if (typeof playerTime === 'number' && Number.isFinite(playerTime)) {
      player.currentTime = Math.max(0, playerTime);
    }

    scheduleDirtyCheck();
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
    try {
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
          try {
            const idx2 = findIndexById(targetId);
            if (idx2 >= 0) setActiveSegment(idx2, 'auto', 'center');
            const seg = segments[idx2];
            if (seg && topicsView && typeof topicsView.setActiveTime === 'function') {
              try { topicsView.setActiveTime(seg.start, true, 'auto'); } catch { }
            }
          } catch { }
        }, 0);
      }
    } catch { }
  }



  function affectedIdsFromHistoryAction(a) {
    const out = [];
    try {
      const m = a && a.meta ? a.meta : null;
      if (!m) return out;
      const add = (v) => { if (!v) return; if (!out.includes(v)) out.push(v); };
      add(m.segId);
      add(m.newSegId);
      add(m.firstSegId);
      if (Array.isArray(m.segIds)) for (const id of m.segIds) add(id);
      if (Array.isArray(m.ids)) for (const id of m.ids) add(id);
    } catch { }
    return out;
  }

  function doUndo() {
    if (!canUndo()) return;
    beginHistoryMutation();
    const a = undoStack.pop();
    a.undo();
    redoStack.push(a);
    try {
      const ids = affectedIdsFromHistoryAction(a);
      if (ids && ids.length) {
        forceVisibleIfFilteredOut(ids, 'Change moved segments outside the current filter.');
        if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters();
      }
    } catch { }
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
    try {
      const ids = affectedIdsFromHistoryAction(a);
      if (ids && ids.length) {
        forceVisibleIfFilteredOut(ids, 'Change moved segments outside the current filter.');
        if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters();
      }
    } catch { }
    scheduleDirtyCheck();
    focusAfterHistoryAction(a);
    renderHistory();
  }


  // Suppress highlight-following from timeupdate for a brief period (used for undo/redo focus)
  let suppressTimeSyncUntil = 0;
  function suppressTimeSync(ms = 350) { suppressTimeSyncUntil = Date.now() + ms; }
  const SETTINGS_KEY = 'transcript_editor_settings_v1';
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
  try { loadSettings(); } catch { }
  try { syncSettingsUI(); } catch { }


  function beginHistoryMutation() {
    // Any user-initiated, undoable mutation should pause playback first to avoid racey UI updates
    try { player.pause(); } catch { }
    suppressTimeSync(450);
  }



  let loadedJsonFileName = null;
  let exportFileName = null;
  let lastSavedAt = null;
  let srtSaveHandle = null; // FileSystemFileHandle when available (enables true Save without re-prompt)
  let transcriptLoadKind = null; // 'disk' | 'fetch' | null (controls Save behavior)

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
    transcriptLoadKind: { get() { return transcriptLoadKind; }, set(v) { transcriptLoadKind = v; } },
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
  ctx.buildJsonFromSegments = function () { return buildJsonFromSegments(); };
  ctx.setActiveSegment = function (i, sb, bl, fs) { return setActiveSegment(i, sb, bl, fs); };
  ctx.pushHistory = function (a) { return pushHistory(a); };
  ctx.beginHistoryMutation = function () { return beginHistoryMutation(); };
  ctx.flushPendingText = function (sid, opts) { return flushPendingText(sid, opts); };
  ctx.updateRowBySegId = function (id) { return updateRowBySegId(id); };
  ctx.scheduleDirtyCheck = function (opts) { return scheduleDirtyCheck(opts); };
  ctx.forceVisibleIfFilteredOut = function (ids, reason, opts) { return forceVisibleIfFilteredOut(ids, reason, opts); };
  ctx.scheduleApplyFilters = function () { return scheduleApplyFilters(); };
  ctx.filterIsActive = function () { return filterIsActive(); };
  ctx.matchesFilter = function (seg) { return matchesFilter(seg); };
  ctx.recomputeChangedSegIds = function () { return recomputeChangedSegIds(); };
  ctx.pruneForcedVisibleIds = function () { return pruneForcedVisibleIds(); };
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

  function timecodeToSeconds(tc) {
    const parts = String(tc).trim().split(':');
    if (parts.length === 3) {
      const h = Number(parts[0]) || 0;
      const m = Number(parts[1]) || 0;
      const s = parseFloat(parts[2]) || 0;
      return h * 3600 + m * 60 + s;
    }
    if (parts.length === 2) {
      const m = Number(parts[0]) || 0;
      const s = parseFloat(parts[1]) || 0;
      return m * 60 + s;
    }
    return parseFloat(tc) || 0;
  }


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


  function nowHHMMSS() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0') + ":" + String(d.getSeconds()).padStart(2, '0');
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

    try { if (typeof rebuildSegmentStarts === 'function') rebuildSegmentStarts(); } catch { }
  }

  // Preserve legacy call sites: recomputeEnds() no longer derives ends; it only clamps overlaps.
  function recomputeEnds() {
    enforceTiming({ sort: false });
  }

  function buildSegmentsFromJson() {
    segments = [];
    globalSeq = 0;

    // Bij opnieuw inlezen kunnen meerdere regels exact dezelfde starttijd (HH:MM:SS) hebben.
    // We alloceren dan interne milliseconde-slots binnen dezelfde afgeronde seconde,
    // zodat sortering/segment-einden stabiel blijven.
    const msAlloc = new Map(); // baseSec -> next slot counter

    function allocStart(baseSec) {
      const n = msAlloc.get(baseSec) ?? 0;
      // verdeel over 0..499, daarna -1..-499 (totaal 999 unieke slots)
      let ms;
      if (n <= 499) ms = n;
      else if (n <= 998) ms = -(n - 499);
      else ms = (n % 999); // fallback (extreem zeldzaam)
      msAlloc.set(baseSec, n + 1);
      return baseSec + (ms / 1000);
    }

    for (const [blockId, lines] of Object.entries(rawJson)) {
      lines.forEach((line) => {
        const m = String(line).match(/^\(([^,]+),\s*([^)]+)\)\s*(.*)$/);
        let speaker, tc, text;
        if (m) { speaker = m[1].trim(); tc = m[2].trim(); text = m[3]; }
        else { speaker = ''; tc = '00:00:00'; text = line; }

        const baseSec = Math.round(timecodeToSeconds(tc));
        const start = allocStart(baseSec);
        segments.push({
          id: `seg_${globalSeq++}`,
          seq: globalSeq,
          blockId,
          speaker,
          text,
          start,
          end: start + 5
        });
      });
    }

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    enforceTiming({ sort: false });
  }

  function buildJsonFromSegments() {
    const grouped = {};
    const byBlock = new Map();
    for (const seg of segments) {
      if (!byBlock.has(seg.blockId)) byBlock.set(seg.blockId, []);
      byBlock.get(seg.blockId).push(seg);
    }
    for (const [blockId, segs] of byBlock.entries()) {
      segs.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
      grouped[blockId] = segs.map(s => `(${s.speaker}, ${secondsToTimecodeWhole(s.start)}) ${s.text}`);
    }
    return grouped;
  }

  function suggestExportName() {
    if (exportFileName) return exportFileName;
    if (loadedJsonFileName) {
      if (loadedJsonFileName.toLowerCase().endsWith('.json')) return loadedJsonFileName.replace(/\.json$/i, '_edited.json');
      return loadedJsonFileName + '_edited.json';
    }
    return 'transcript_edited.json';
  }

  function sanitizeFileName(name) {
    name = String(name || '').trim();
    if (!name) name = suggestExportName();
    if (!name.toLowerCase().endsWith('.json')) name += '.json';
    name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
    return name;
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
    if (!segments.length) { pill.textContent = 'Segments changed: 0'; try { updateDonePill(); } catch { } return; }
    const count = changedSegIds.size;
    pill.textContent = `Segments changed: ${count}`;
    try { updateDonePill(); } catch { }
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
        try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
      }
    }, 120);
  }

  // --- Speaker dropdown (editable combobox) ---
  let speakerDropdownEl = null;
  let speakerDropdownTargetInput = null;
  let speakerDropdownTargetSeg = null;


  let speakerDropdownIndex = -1;
  let speakerDropdownOptions = [];
  let speakerDropdownSpeakers = [];

  function setSpeakerDropdownIndex(newIdx) {
    if (!speakerDropdownEl || !speakerDropdownOptions.length) return;
    const max = speakerDropdownOptions.length - 1;
    if (newIdx < 0) newIdx = 0;
    if (newIdx > max) newIdx = max;

    speakerDropdownIndex = newIdx;
    for (let i = 0; i < speakerDropdownOptions.length; i++) {
      speakerDropdownOptions[i].classList.toggle('active', i === speakerDropdownIndex);
    }
    // keep selected in view
    const el = speakerDropdownOptions[speakerDropdownIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function applySpeakerChoice(sp) {
    beginHistoryMutation();

    if (!speakerDropdownTargetInput || !speakerDropdownTargetSeg) return;

    const input = speakerDropdownTargetInput;
    const seg = speakerDropdownTargetSeg;

    const before = (input.dataset.before ?? (seg.speaker || ''));
    const after = sp;

    // Apply immediately
    input.value = after;
    seg.speaker = after;
    input.dataset.before = after;
    scheduleDirtyCheck();
    try { forceVisibleIfFilteredOut([seg.id], 'Edited speaker moved segment outside the current filter.'); } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    if (before !== after) {
      const id = seg.id;

      const apply = (val) => {
        const s = segments.find(x => x.id === id);
        if (!s) return;
        s.speaker = val;
        updateRowBySegId(id);
        try { scheduleDirtyCheck(); } catch { }
        try { forceVisibleIfFilteredOut([id], 'Edited speaker moved segment outside the current filter.'); } catch { }
        try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
      };

      pushHistory({
        label: 'Set speaker',
        summary: `${safePreview(before, 20)}→${safePreview(after, 20)} (seg=${id})`,
        meta: { segId: id, from: before, to: after },
        do: () => apply(after),
        undo: () => apply(before)
      });
    }

    closeSpeakerDropdown();
    input.focus({ preventScroll: true });
  }

  function applySpeakerSelected() {
    if (!speakerDropdownSpeakers.length) return;
    const idx = (speakerDropdownIndex >= 0) ? speakerDropdownIndex : 0;
    const sp = speakerDropdownSpeakers[idx];
    if (sp) applySpeakerChoice(sp);
  }
  let scrollFreezePrevOverflow = null;
  let scrollFreezePrevScrollTop = 0;

  function freezeSegmentsScroll() {
    if (scrollFreezePrevOverflow !== null) return; // already frozen
    scrollFreezePrevOverflow = segmentsDiv.style.overflowY || '';
    scrollFreezePrevScrollTop = segmentsDiv.scrollTop;
    segmentsDiv.style.overflowY = 'hidden';
  }

  function unfreezeSegmentsScroll() {
    if (scrollFreezePrevOverflow === null) return;
    segmentsDiv.style.overflowY = scrollFreezePrevOverflow;
    segmentsDiv.scrollTop = scrollFreezePrevScrollTop;
    scrollFreezePrevOverflow = null;
  }

  function getAllUniqueSpeakers() {
    const set = new Set();
    for (const s of segments) {
      const sp = (s.speaker || '').trim();
      if (sp) set.add(sp);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'nl'));
  }

  function closeSpeakerDropdown() {
    if (speakerDropdownEl) {
      speakerDropdownEl.remove();
      speakerDropdownEl = null;
      speakerDropdownTargetInput = null;
      speakerDropdownTargetSeg = null;
    }
    unfreezeSegmentsScroll();
  }

  function openSpeakerDropdown(ev, inputEl, seg) {
    // Stop playback & stop autoscroll ASAP
    player.pause();
    // Close existing dropdown first
    closeSpeakerDropdown();
    freezeSegmentsScroll();

    speakerDropdownTargetInput = inputEl;
    speakerDropdownTargetSeg = seg;

    const dd = document.createElement('div');
    dd.className = 'speaker-dropdown';

    speakerDropdownOptions = [];
    speakerDropdownSpeakers = [];
    speakerDropdownIndex = -1;

    const speakers = getAllUniqueSpeakers();
    speakerDropdownSpeakers = speakers;

    if (!speakers.length) {
      const opt = document.createElement('div');
      opt.className = 'speaker-option';
      opt.textContent = '(geen speakers gevonden)';
      opt.style.color = 'var(--muted)';
      dd.appendChild(opt);
    } else {
      for (let i = 0; i < speakers.length; i++) {
        const sp = speakers[i];
        const opt = document.createElement('div');
        opt.className = 'speaker-option';
        opt.textContent = sp;

        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applySpeakerChoice(sp);
        });

        dd.appendChild(opt);
        speakerDropdownOptions.push(opt);
      }
    }

    document.body.appendChild(dd);
    speakerDropdownEl = dd;

    // Position: near mouse (as requested), but keep on-screen
    const margin = 8;
    let left = (typeof ev.clientX === 'number') ? ev.clientX : 0;
    let top = (typeof ev.clientY === 'number') ? (ev.clientY + 8) : 0;

    // measure after added to DOM
    const rect = dd.getBoundingClientRect();
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);

    dd.style.left = left + 'px';
    dd.style.top = top + 'px';

    // initial selection: match current value, else first
    if (speakerDropdownOptions.length) {
      const cur = (inputEl.value || '').trim();
      let idx = 0;
      if (cur) {
        const found = speakerDropdownSpeakers.findIndex(s => s === cur);
        if (found >= 0) idx = found;
      }
      setSpeakerDropdownIndex(idx);
    }

    // Prevent wheel scroll from leaking (extra safety)
    dd.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  // Close dropdown on outside click / Escape
  document.addEventListener('mousedown', (e) => {
    if (!speakerDropdownEl) return;
    const t = e.target;
    if (speakerDropdownEl.contains(t)) return;
    if (speakerDropdownTargetInput && speakerDropdownTargetInput === t) return;
    closeSpeakerDropdown();
  }, true);


  // --- UI ---
  function updateHeaderUI(forceDirty = null) {
    const hasData = segments.length > 0;
    const nameForTitle = (exportFileName || suggestExportName());

    if (!hasData) {
      saveBtn.disabled = true;
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
    try {
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
    } catch (e) { }

    rows.forEach((el, idx) => el.classList.toggle('active', idx === index));
    currentSegmentIndex = index;


    // Mirror active highlight into Text View (if rendered)
    try { textView.setActive(segments[index].id, behavior, forceScroll); } catch { }

    // Mirror to Topics View as well (so it jumps if we jump)
    if (segments[index]) {
      try { topicsView.setActiveTime(segments[index].start, true, behavior); } catch { }
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

  function collapseTextarea(el) {
    if (!el) return;
    el.style.height = TEXTAREA_BASE_HEIGHT + 'px';
    el.style.overflowY = 'hidden';
  }

  // Chunked textarea sizing (avoids long stalls after split/undo/resize)
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
    try {
      const list = segmentsDiv.querySelectorAll('.text-input');
      for (const el of list) queueTextareaSizing(el);
    } catch { }
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
      try { forceVisibleIfFilteredOut([seg.id], 'Updated done status moved segment outside the current filter.'); } catch { }
      try { if (matchesFilter(seg)) forcedVisibleIds.delete(seg.id); } catch { }
      try { pruneForcedVisibleIds(); } catch { }

      applyDoneUI();
      updateDonePill();
      saveDoneToStorage();
      try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
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
          try { scheduleDirtyCheck(); } catch { }
          try { forceVisibleIfFilteredOut([segId], 'Edited speaker moved segment outside the current filter.'); } catch { }
          try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
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
      if (filterIsActive() && filterState.changedMode === 'unchanged') {
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
      try { flushPendingText(id, { showFilterNotice: true }); } catch { }

      // Ensure "outside filter" is evaluated on *your* blur, even if we already flushed history silently.
      try { recomputeChangedSegIds(); updateSegmentsChangedPill(); } catch { }
      try { forceVisibleIfFilteredOut([id], 'Edited text moved segment outside the current filter.'); } catch { }
      try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
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
      try {
        if (document.activeElement === textArea) {
          e.preventDefault();
          e.stopPropagation();
          splitBtn.dataset.skipClick = '1';
          const i = getIdx();
          setActiveSegment(i, 'auto', 'center');
          splitSegment(i, textArea);
        }
      } catch { }
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
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
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
      try { options.updateProject(options.jobId, { lastViewMode: editorMode }); } catch (e) { }
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
        try { topicsView.setActiveTime(player.currentTime, true, 'auto'); } catch { }
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
  function askForSplitTimeWhole(seg, opts) { return _askForSplitTimeWhole(ctx, seg, opts); }
  function applySplitNoHistory(seg1Id, seg1TextAfter, seg2Snapshot, opts) { return _applySplitNoHistory(ctx, seg1Id, seg1TextAfter, seg2Snapshot, opts); }
  function undoSplitNoHistory(seg1Id, seg1TextBefore, seg2Id, seg1EndBefore, opts) { return _undoSplitNoHistory(ctx, seg1Id, seg1TextBefore, seg2Id, seg1EndBefore, opts); }
  function joinTextsForJoin(aText, bText) { return _joinTextsForJoin(aText, bText); }
  function applyJoinNoHistory(prevId, currId, prevTextAfter, opts) { return _applyJoinNoHistory(ctx, prevId, currId, prevTextAfter, opts); }
  function undoJoinNoHistory(prevId, prevTextBefore, prevEndBefore, currSnapshot, opts) { return _undoJoinNoHistory(ctx, prevId, prevTextBefore, prevEndBefore, currSnapshot, opts); }
  function joinWithPrevious(idx) { return _joinWithPrevious(ctx, idx); }
  function splitSegment(idx, textAreaEl) { return _splitSegment(ctx, idx, textAreaEl); }

  // Active highlight while playing

  // Recompute textarea heights on resize (debounced)
  let _resizeT = null;
  window.addEventListener('resize', () => {
    if (_resizeT) clearTimeout(_resizeT);
    _resizeT = setTimeout(() => {
      try { updateTextareaSizing(); } catch { }
    }, 120);
  });

  // timeupdate highlight is handled by playbackLoop() (rAF)

  // Load transcript (SRT)
  async function _loadTranscriptSrtText(srtText, displayName, { handle = null, sourceKind = 'disk' } = {}) {
    try { const b = document.getElementById("localSaveBanner"); if (b) b.classList.add("hidden"); } catch { }
    try { setChosenFileLabel(transcriptBtnLabelEl, displayName, 'Choose transcript', 'transcript'); } catch { }
    try { chosenTranscriptName = displayName || null; } catch { }
    try { updateFileSummaryLabel(); } catch { }

    rawJson = null; // Option B: SRT-only disk load
    loadedJsonFileName = displayName || null;
    exportFileName = (sourceKind === 'disk') ? (displayName || null) : null;
    lastSavedAt = null;

    srtSaveHandle = handle || null; // if present, enables true Save without prompting
    transcriptLoadKind = sourceKind;

    buildSegmentsFromSrtText(String(srtText || ''));
    loadDoneFromStorage();
    renderSegments();

    // Try extracting embedded topics
    const meta = extractMetadata(String(srtText || ''));
    if (meta && meta.topics && Array.isArray(meta.topics) && meta.topics.length > 0) {
      topicsView.topics = meta.topics;
      topicsView.render();
      if (topicsView.container) topicsView.container.classList.remove('hidden');
      const _sp1 = document.getElementById('docViewSplitter');
      if (_sp1) _sp1.classList.remove('hidden');
    } else {
      // Clear topics if none found in this file
      topicsView.topics = [];
      topicsView.render();
      if (topicsView.container) topicsView.container.classList.add('hidden');
      const _sp2 = document.getElementById('docViewSplitter');
      if (_sp2) _sp2.classList.add('hidden');
    }

    // After loading a transcript from disk/network, default the active highlight to the first segment
    try {
      if (segments && segments.length) {
        currentSegmentIndex = 0;
        setActiveSegment(0, 'auto', 'start', true);
      } else {
        currentSegmentIndex = -1;
      }
    } catch { }

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
        await _loadTranscriptSrtText(srtText, handle.name || file.name || "transcript.srt", { handle, sourceKind: 'disk' });
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
      _loadTranscriptSrtText(srtText, file.name || "transcript.srt", { handle: null, sourceKind: 'disk' });
    };
    reader.readAsText(file, 'utf-8');
  });


  // Load audio
  audioInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { const b = document.getElementById("localSaveBanner"); if (b) b.classList.add("hidden"); } catch { }
    setChosenFileLabel(audioBtnLabelEl, file.name, 'Choose audio', 'audio');
    chosenAudioName = file.name || null;
    updateFileSummaryLabel();
    const url = URL.createObjectURL(file);
    player.src = url;
  });

  /* SAVE_AS_SRT_V1 — delegated to editorSave.js */
  // secondsToSrtTimecode is imported directly from editorSave.js

  function buildSrtFromSegments() { return _buildSrt(ctx); }
  function suggestSrtName() { return _suggestSrtName(ctx); }
  function sanitizeSrtFileName(name) { return _sanitizeSrtFileName(name, ctx); }
  function _downloadText(text, filename, mime) { return downloadTextBlob(text, filename, mime); }
  async function saveSrtLocally(forceSaveAs = false) { return _saveSrtLocally(forceSaveAs, ctx); }
  function downloadSrt(filename, text) { return _downloadSrt(filename, text, ctx); }
  function doExport(finalName) { return _doExport(finalName, ctx); }

  function updateSaveLocalHint() {
    const el = document.getElementById("saveLocalHint");
    if (!el) return;
    el.textContent = "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("saveLocalBtn");
    if (btn) btn.addEventListener("click", () => saveSrtLocally());
    updateSaveLocalHint();
  });

  function openSaveModal() {
    if (!segments.length) return;
    saveNameIn.value = suggestExportName();
    saveModal.classList.remove('hidden');
    setTimeout(() => { saveNameIn.focus(); saveNameIn.select(); }, 0);
  }

  function closeSaveModal() { saveModal.classList.add('hidden'); }


  saveBtn.addEventListener('click', () => saveSrtLocally(false));
  if (saveAsBtn) saveAsBtn.addEventListener('click', () => saveSrtLocally(true));
  exportDocBtn && exportDocBtn.addEventListener('click', () => showToast('Not yet implemented'));


  cancelSaveBtn.addEventListener('click', () => closeSaveModal());
  confirmSaveBtn.addEventListener('click', () => {
    const finalName = sanitizeFileName(saveNameIn.value);
    closeSaveModal();
    doExport(finalName);
  });

  // Modal: click outside to close
  saveModal.addEventListener('click', (e) => { if (e.target === saveModal) closeSaveModal(); });

  // Modal: Enter to confirm, Esc to close
  saveNameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const finalName = sanitizeFileName(saveNameIn.value);
      closeSaveModal();
      doExport(finalName);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSaveModal();
    }
  });

  // Hotkeys
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const isEditing = tag === 'INPUT' || tag === 'TEXTAREA';

    // App-level undo/redo (we vangen Ctrl+Z/Y altijd af; native undo/redo is uitgeschakeld)
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      // Allow native undo/redo inside the timestamp field while editing
      // (otherwise Ctrl+Z has no effect until you commit the timestamp).
      try {
        if (isEditing && e.target && e.target.classList && e.target.classList.contains('time-input')) {
          return;
        }
      } catch { }
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        // Commit lopende text-edits zodat undo zinvol is
        if (isEditing) {
          const row = e.target.closest?.('.segment');
          const sid = row?.dataset?.id || null;
          flushPendingText(sid);
        } else {
          flushPendingText();
        }
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (k === 'y') {
        e.preventDefault();
        flushPendingText();
        doRedo();
        return;
      }
    }


    if ((e.key === 's' || e.key === 'S') && e.ctrlKey) {
      e.preventDefault();
      saveSrtLocally(false);
      return;
    }
    if ((e.key === 'f' || e.key === 'F') && e.ctrlKey) {
      e.preventDefault();
      openFindModal();
      return;
    }


    if (!saveModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); hideSaveModal(); }
      if (e.key === 'Enter') { e.preventDefault(); doSaveWithCurrentName(); }
      return;
    }
    if (historyModal && !historyModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeHistoryModal(); }
      return;
    }// Als speaker-dropdown open is: pijlen navigeren, Enter selecteert, ESC sluit

    if (findModal && !findModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeFindModal(); }
      return;
    }
    if (replaceAllModal && !replaceAllModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeReplaceAllConfirm(); }
      return;
    }

    if (helpModal && !helpModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeHelpModal(); }
      return;
    }

    if (filterModal && !filterModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeFilterModal(); }
      // while filter is open, don't run player hotkeys
      return;
    }
    if (speakerDropdownEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSpeakerDropdown();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSpeakerDropdownIndex((speakerDropdownIndex < 0 ? 0 : speakerDropdownIndex + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSpeakerDropdownIndex((speakerDropdownIndex < 0 ? 0 : speakerDropdownIndex - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        applySpeakerSelected();
        return;
      }
      // Tab of andere keys: laat focus/typing met rust, maar voorkom player-hotkeys
      return;
    }
    // F1 => play/pause (ook tijdens editen). We blurren inputs zodat pijltjes weer seek doen.
    if (e.key === 'F1') {
      e.preventDefault();
      if (player && player.paused && !ensureAudioLoadedForPlay()) return;

      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        ae.blur();
        // focus een neutraal element zodat we niet terug in edit mode schieten
        segmentsDiv.focus({ preventScroll: true });
      }

      // Als we gaan "playen": eerst huidige highlight weer in beeld (center) zetten
      if (player.paused) {
        let idx = currentSegmentIndex;
        const t = player.currentTime;

        // Als huidige index onbekend is of niet matcht met de huidige tijd, bepaal hem opnieuw
        if (idx === -1 || !segments[idx] || !(t >= segments[idx].start && t < segments[idx].end)) {
          idx = -1;
          for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            if (t >= s.start && t < s.end) { idx = i; break; }
          }
        }

        if (idx !== -1) {
          setActiveSegment(idx, 'auto'); // zonder animatie, direct centreren
        }

        try { snapToVisibleIfNeeded(); } catch { }
        try { snapToVisibleIfNeeded(); } catch { }
        player.play();
      } else {
        player.pause();
      }
      return;
    }

    // F9 => Toggle Done for active segment. Works even while editing.
    if (e.key === 'F9') {
      e.preventDefault();
      const ae = document.activeElement;
      let idx = currentSegmentIndex;
      try {
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          const row = ae.closest && ae.closest('.segment');
          if (row && row.dataset && row.dataset.id) {
            const i2 = findIndexById(row.dataset.id);
            if (i2 !== -1) idx = i2;
          }
        }
      } catch { }
      if (idx >= 0 && idx < segments.length) {
        const seg = segments[idx];
        if (doneSegIds.has(seg.id)) doneSegIds.delete(seg.id);
        else doneSegIds.add(seg.id);

        try { forceVisibleIfFilteredOut([seg.id], 'Updated done status moved segment outside the current filter.'); } catch { }
        try { if (matchesFilter(seg)) forcedVisibleIds.delete(seg.id); } catch { }
        try { pruneForcedVisibleIds(); } catch { }

        try {
          const row = rowById.get(seg.id) || segmentsDiv.querySelector(`.segment[data-id="${seg.id}"]`);
          if (row) {
            row.classList.toggle('done', doneSegIds.has(seg.id));
            const btn = row.querySelector('.done-btn');
            if (btn) {
              btn.textContent = doneSegIds.has(seg.id) ? '☑' : '☐';
              btn.setAttribute('aria-pressed', doneSegIds.has(seg.id) ? 'true' : 'false');
            }
          }
        } catch { }

        // Mirror Done styling into Text view (subtle)
        try {
          const tv = (tvSpanById && tvSpanById.get(seg.id)) ? tvSpanById.get(seg.id) : null;
          if (tv) tv.classList.toggle('done', doneSegIds.has(seg.id));
        } catch { }

        updateDonePill();
        saveDoneToStorage();
        try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
      }
      return;
    }

    // F3 => Join with previous (A + B). Works even while editing.

    // F2 => Repeat the active segment (nested over any active A→B loop). Works even while editing.
    if (e.key === 'F2') {
      e.preventDefault();
      const wasPaused = (() => { try { return !!(player && player.paused); } catch { return true; } })();
      // If not currently playing, ensure audio is loaded (shows toast if not).
      if (wasPaused) {
        try { if (!ensureAudioLoadedForPlay()) return; } catch { }
      }

      const ae = document.activeElement;

      // If audio is currently playing, repeat the *currently playing* segment,
      // even if focus is still in an older input/textarea.
      const isPlaying = (() => {
        try { return player && !player.paused && !player.ended; } catch { return false; }
      })();

      let idx = currentSegmentIndex;
      if (!isPlaying) {
        try {
          if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
            const row = ae.closest?.('.segment');
            const di = row ? parseInt(row.dataset.index, 10) : NaN;
            if (Number.isFinite(di)) idx = di;
          }
        } catch { }
      }

      if (idx >= 0 && idx < segments.length) {
        try { setActiveSegment(idx, 'auto', 'center'); } catch { }
        toggleRepeatSeg(idx);
        // If we just enabled repeat while paused, start playback immediately.
        try {
          if (wasPaused && repeatSegState && repeatSegState.active) {
            if (player && player.paused) player.play();
          }
        } catch { }
      }
      return;
    }

    // In Text view, editing operations (Join/Split) are disabled (read-only mode).
    if (editorMode === 'text' && (e.key === 'F3' || e.key === 'F4')) {
      e.preventDefault();
      return;
    }

    if (e.key === 'F3') {
      e.preventDefault();
      const ae = document.activeElement;
      let idx = currentSegmentIndex;
      try {
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          const row = ae.closest?.('.segment');
          const sid = row?.dataset?.id || null;
          flushPendingText(sid);
          const di = row ? parseInt(row.dataset.index, 10) : NaN;
          if (Number.isFinite(di)) idx = di;
        } else {
          flushPendingText();
        }
      } catch { }
      if (idx >= 0) joinWithPrevious(idx);
      return;
    }

    // F4 => Split segment. Works even while editing.
    if (e.key === 'F4') {
      e.preventDefault();
      const ae = document.activeElement;
      let idx = currentSegmentIndex;
      let ta = null;
      try {
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          const row = ae.closest?.('.segment');
          const sid = row?.dataset?.id || null;
          flushPendingText(sid);
          const di = row ? parseInt(row.dataset.index, 10) : NaN;
          if (Number.isFinite(di)) idx = di;
          if (ae.tagName === 'TEXTAREA' && ae.classList && ae.classList.contains('text-input')) {
            ta = ae; // cursor split
          }
        } else {
          flushPendingText();
        }
      } catch { }

      if (idx >= 0) {
        try { setActiveSegment(idx, 'auto', 'center'); } catch { }
        // If `ta` is not the focused textarea, we use the timestamp prompt/auto-assign logic.
        splitSegment(idx, ta);
      }
      return;
    }


    // F6 => Repeat loop: set start, set end, clear. Works even while editing.
    if (e.key === 'F6') {
      e.preventDefault();
      const ae = document.activeElement;
      let idx = currentSegmentIndex;
      try {
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          const row = ae.closest?.('.segment');
          const di = row ? parseInt(row.dataset.index, 10) : NaN;
          if (Number.isFinite(di)) idx = di;
        }
      } catch { }
      if (idx >= 0) handleLoopHotkey(idx);
      return;
    }


    // Segment list navigation (when NOT editing text): ArrowUp/ArrowDown/Home/End move the active segment
    if (!isEditing && editorMode === 'segments') {
      const k = e.key;
      const wantsNav = (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown');
      if (wantsNav && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const rows = segmentsDiv ? segmentsDiv.querySelectorAll('.segment') : null;
        if (rows && rows.length) {
          const isVisible = (i) => {
            try { return !!rows[i] && !rows[i].classList.contains('filtered-out'); } catch { return false; }
          };
          const nextVisible = (fromIdx, dir) => {
            let i = fromIdx;
            for (let guard = 0; guard < rows.length + 2; guard++) {
              i += dir;
              if (i < 0 || i >= rows.length) return -1;
              if (isVisible(i)) return i;
            }
            return -1;
          };

          // Base index: current active if visible; else try by audio time; else first visible
          let idx = currentSegmentIndex;
          if (!(idx >= 0 && idx < rows.length) || !isVisible(idx)) {
            idx = -1;
            try {
              const ti = findSegmentIndexAtTime(player ? player.currentTime : 0);
              if (ti !== -1 && isVisible(ti)) idx = ti;
            } catch { }
            if (idx === -1) idx = nextVisible(-1, +1);
            if (idx === -1) return; // nothing visible; let browser handle
          }

          let newIdx = idx;
          let block = 'nearest';
          let forceScroll = false;

          if (k === 'ArrowDown' || k === 'ArrowRight') {
            const ni = nextVisible(idx, +1);
            if (ni !== -1) newIdx = ni;
          } else if (k === 'ArrowUp' || k === 'ArrowLeft') {
            const ni = nextVisible(idx, -1);
            if (ni !== -1) newIdx = ni;
          } else if (k === 'PageDown') {
            const STEP = 10;
            let cur = idx;
            for (let s = 0; s < STEP; s++) {
              const ni = nextVisible(cur, +1);
              if (ni === -1) break;
              cur = ni;
            }
            if (cur !== idx) { newIdx = cur; forceScroll = true; }
          } else if (k === 'PageUp') {
            const STEP = 10;
            let cur = idx;
            for (let s = 0; s < STEP; s++) {
              const ni = nextVisible(cur, -1);
              if (ni === -1) break;
              cur = ni;
            }
            if (cur !== idx) { newIdx = cur; forceScroll = true; }
          } else if (k === 'Home') {
            const ni = nextVisible(-1, +1);
            if (ni !== -1) newIdx = ni;
            block = 'start';
            forceScroll = true;
          } else if (k === 'End') {
            const ni = nextVisible(rows.length, -1);
            if (ni !== -1) newIdx = ni;
            block = 'end';
            forceScroll = true;
          }

          if (newIdx !== idx || k === 'Home' || k === 'End') {
            e.preventDefault();
            // User navigation should pause playback to avoid fighting playback-driven highlighting
            try { if (player && !player.paused) player.pause(); } catch { }
            try { if (player && segments[newIdx] && Number.isFinite(segments[newIdx].start)) player.currentTime = segments[newIdx].start; } catch { }
            const beh = (k === 'Home' || k === 'End') ? 'auto' : 'auto';
            // For Home/End: jump the scroll container immediately to avoid long smooth scrolling
            try {
              if (k === 'Home') segmentsDiv.scrollTop = 0;
              if (k === 'End') segmentsDiv.scrollTop = segmentsDiv.scrollHeight;
            } catch { }
            // For Home/End, jump the scroll container immediately to avoid long animated travel
            try {
              if ((k === 'Home' || k === 'End') && segmentsDiv) {
                segmentsDiv.scrollTop = (k === 'Home') ? 0 : segmentsDiv.scrollHeight;
              }
            } catch { }
            setActiveSegment(newIdx, beh, block, forceScroll || !!e.repeat);
            return;
          }
        }
      }
    }

    if (isEditing) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (player && player.paused && !ensureAudioLoadedForPlay()) return;

        // Bij pauze -> play: eerst huidige highlight weer in beeld (center) zetten
        if (player.paused) {
          let idx = currentSegmentIndex;
          const t = player.currentTime;

          if (idx === -1 || !segments[idx] || !(t >= segments[idx].start && t < segments[idx].end)) {
            idx = -1;
            for (let i = 0; i < segments.length; i++) {
              const s = segments[i];
              if (t >= s.start && t < s.end) { idx = i; break; }
            }
          }

          if (idx !== -1) setActiveSegment(idx, 'auto');
          try { snapToVisibleIfNeeded(); } catch { }
          player.play();
        } else {
          player.pause();
        }
        break;
      case 'ArrowLeft':
        if (editorMode === 'segments') break; // handled as list navigation when not editing
        e.preventDefault();
        seekRelative(-3);
        break;
      case 'ArrowRight':
        if (editorMode === 'segments') break; // handled as list navigation when not editing
        e.preventDefault();
        seekRelative(3);
        break;

    }
  });

  function seekRelative(delta) {
    if (!player.duration) return;
    let t = player.currentTime + delta;
    if (t < 0) t = 0;
    if (t > player.duration) t = player.duration;
    player.currentTime = t;
  }

  function jumpToRelativeSegment(step) {
    if (!segments.length) return;

    let idx = currentSegmentIndex;
    if (idx === -1) {
      const t = player.currentTime;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        if (t >= s.start && t < s.end) { idx = i; break; }
      }
      if (idx === -1) idx = 0;
    }

    let newIdx = idx + step;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= segments.length) newIdx = segments.length - 1;

    player.pause();
    player.currentTime = segments[newIdx].start;
    setActiveSegment(newIdx, 'smooth');
  }

  // Warn on close if dirty
  window.addEventListener('beforeunload', (e) => {
    if (!segments.length) return;
    if (!isDirtyNow()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  try { loadSettings(); } catch { }
  try { syncSettingsUI(); } catch { }
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
        try {
          player.src = audioUrl;

          const tail = (() => {
            try { return decodeURIComponent(audioUrl.split("/").pop() || "audio"); }
            catch { return (audioUrl.split("/").pop() || "audio"); }
          })();

          const aName = audioName || tail;
          setChosenFileLabel(audioBtnLabelEl, aName, "Choose audio", "audio");
          chosenAudioName = aName;
          updateFileSummaryLabel();
        } catch { }
      }

      if (srtContent) {
        // Local file content provided directly
        const tName = options.transcriptName || 'Local Project';
        try {
          setChosenFileLabel(transcriptBtnLabelEl, tName, "Choose transcript", "transcript");
          chosenTranscriptName = tName;
          loadedJsonFileName = tName;
          srtSaveHandle = null;
          exportFileName = null;
          transcriptLoadKind = 'local';
          updateFileSummaryLabel();
        } catch { }

        rawJson = null;
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

        try {
          setChosenFileLabel(transcriptBtnLabelEl, tName, "Choose transcript", "transcript");
          chosenTranscriptName = tName;
          loadedJsonFileName = tName; // used for default Save-As name
          // Server-loaded transcript: no write-back handle yet (design later)
          srtSaveHandle = null;
          exportFileName = null;
          transcriptLoadKind = 'fetch';
          updateFileSummaryLabel();
        } catch { }

        rawJson = null; // indicates this session isn't driven by the old JSON format
        buildSegmentsFromSrtText(srtText);
        loadDoneFromStorage();
        renderSegments();
        // Initial sync to saved startTime (if provided)
        if (typeof startTime === 'number' && Number.isFinite(startTime)) {
          setTimeout(() => {
            const idx = findSegmentIndexAtTime(startTime);
            if (idx >= 0) setActiveSegment(idx, 'auto', 'center', true); // Use 'auto' for instant jump on load
            if (topicsView && typeof topicsView.setActiveTime === 'function') {
              try { topicsView.setActiveTime(startTime, true, 'auto'); } catch { }
            }
          }, 100);
        }
        updateDonePill();
        setCleanNow();

        // Process embedded topics (now injected by server)
        const meta = extractMetadata(srtText);
        if (meta && meta.topics && Array.isArray(meta.topics) && meta.topics.length > 0) {
          topicsView.topics = meta.topics;
          topicsView.render();
          if (topicsView.container) topicsView.container.classList.remove('hidden');
          const _sp3 = document.getElementById('docViewSplitter');
          if (_sp3) _sp3.classList.remove('hidden');
        } else {
          // Try legacy separate load if embedded missing (optional fallback, likely unneeded now)
          // For now, assume server injection keeps it simple.
          topicsView.topics = [];
          topicsView.render();
          if (topicsView.container) topicsView.container.classList.add('hidden');
          const _sp4 = document.getElementById('docViewSplitter');
          if (_sp4) _sp4.classList.add('hidden');
        }
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


  // Mobile Menu Logic
  const activeMenuBtn = document.getElementById('mobileMenuBtn');
  const headerFileActions = document.getElementById('headerFileActions');

  if (activeMenuBtn && headerFileActions) {
    activeMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      headerFileActions.classList.toggle('show-menu');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!headerFileActions.contains(e.target) && e.target !== activeMenuBtn) {
        headerFileActions.classList.remove('show-menu');
      }
    });

    // Close menu when clicking an action inside it
    headerFileActions.addEventListener('click', () => {
      headerFileActions.classList.remove('show-menu');
    });
    // ... (Bottom of file) ...
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
