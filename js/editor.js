import { loadSettings as apiLoadSettings, saveSettings as apiSaveSettings, fetchJobStatus as apiFetchJobStatus, fetchSrt as apiFetchSrt, getApiUrl } from "./api.js";
import { safePreview, normSpeaker, secondsToTimecodeWhole, hashString, _srtTcToSeconds, _parseSrt, extractMetadata, embedMetadata } from "./utils.js";
import { TextView } from "./components/TextView.js";
import { TopicsView } from "./components/TopicsView.js";
import { AudioPlayer } from "./components/AudioPlayer.js";
// ... imports ...
export function mountEditor(options = {}) {
  // Capture options if needed
  const { jobId, audioUrl, srtUrlPreview, startTime } = options;

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

  function isFindOpen() { return findModal && !findModal.classList.contains('hidden'); }

  function setFindStatus(msg, isError = false) {
    if (!findStatus) return;
    findStatus.textContent = msg || '';
    findStatus.classList.toggle('error', !!isError);
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getScope() {
    const r = document.querySelector('input[name="findScope"]:checked');
    return r ? r.value : 'text';
  }

  function getFindSig() {
    return JSON.stringify({
      f: findInput?.value ?? '',
      r: replaceInput?.value ?? '',
      re: !!optRegex?.checked,
      cs: !!optCase?.checked,
      ww: !!optWords?.checked,
      wr: !!optWrap?.checked,
      sc: getScope()
    });
  }

  function compileFindRegex() {
    const raw = (findInput?.value ?? '').trim();
    if (!raw) return { ok: false, err: 'Enter text to find.' };

    let pat = raw;
    const useRegex = !!optRegex?.checked;

    if (!useRegex) pat = escapeRegExp(pat);
    if (!!optWords?.checked) pat = `\\b(?:${pat})\\b`;

    const flags = `g${(optCase?.checked ? '' : 'i')}u`;

    try {
      const re = new RegExp(pat, flags);
      return { ok: true, re, pat, useRegex };
    } catch (e) {
      return { ok: false, err: `Invalid regex: ${e.message}` };
    }
  }

  function getFieldValue(seg, field) {
    if (field === 'speaker') return (seg.speaker || '');
    return (seg.text || '');
  }

  function setFieldValue(seg, field, value) {
    if (field === 'speaker') seg.speaker = value;
    else seg.text = value;
  }

  // Find/Replace scope: only segments that are currently shown (respect active filter)
  function getVisibleSegmentIndices() {
    if (!segments || !segments.length) return [];
    if (typeof filterIsActive !== 'function' || !filterIsActive()) {
      const out = new Array(segments.length);
      for (let i = 0; i < segments.length; i++) out[i] = i;
      return out;
    }
    // Keep change-tracking up-to-date when filtering on changed/unchanged
    try {
      const usesChanged = (filterState && (filterState.changedMode !== 'all')) || (typeof forcedVisibleIds !== 'undefined' && forcedVisibleIds.size);
      if (usesChanged) recomputeChangedSegIds();
    } catch { }
    try { pruneForcedVisibleIds(); } catch { }

    const out = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if (matchesFilter(seg) || forcedVisibleIds.has(seg.id)) out.push(i);
    }
    return out;
  }

  function focusAndSelectMatch(segIndex, field, start, end) {
    if (segIndex < 0 || segIndex >= segments.length) return;

    setActiveSegment(segIndex, 'auto', 'nearest');

    const row = segmentsDiv.querySelector(`.segment[data-index="${segIndex}"]`);
    if (!row) return;

    const el = (field === 'speaker') ? row.querySelector('.speaker-input') : row.querySelector('.text-input');
    if (!el) return;

    el.focus({ preventScroll: true });
    try { el.setSelectionRange(start, end); } catch { }
  }

  function countAllMatches(reObj, scope) {
    let count = 0;
    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);

    const visIdxs = getVisibleSegmentIndices();

    for (const si of visIdxs) {
      const seg = segments[si];
      if (!seg) continue;
      for (const f of fields) {
        const s = getFieldValue(seg, f);
        if (!s) continue;
        reObj.lastIndex = 0;
        let m;
        while ((m = reObj.exec(s)) !== null) {
          // avoid infinite loops on empty matches
          if (m[0].length === 0) { reObj.lastIndex += 1; continue; }
          count++;
        }
      }
    }
    reObj.lastIndex = 0;
    return count;
  }

  function findNext(fromReplace = false) {
    flushPendingText(); // commit any debounced edits

    const compiled = compileFindRegex();
    if (!compiled.ok) { setFindStatus(compiled.err, true); currentFind = null; return false; }
    const { re } = compiled;
    const scope = getScope();
    const wrap = !!optWrap?.checked;

    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);
    const sig = getFindSig();

    const visIdxs = getVisibleSegmentIndices();
    if (!visIdxs.length) {
      currentFind = null;
      setFindStatus('No visible segments.');
      return false;
    }

    // Map: segmentIndex -> position in visIdxs
    const posByIndex = new Map();
    for (let p = 0; p < visIdxs.length; p++) posByIndex.set(visIdxs[p], p);

    // Starting point
    let startSeg = (currentSegmentIndex >= 0) ? currentSegmentIndex : 0;
    let startPos = 0;
    let startFieldIdx = 0;

    // If we have a current match with same signature, continue after it
    if (currentFind && currentFind.sig === sig) {
      startSeg = currentFind.segIndex;
      startFieldIdx = fields.indexOf(currentFind.field);
      if (startFieldIdx < 0) startFieldIdx = 0;
      startPos = currentFind.end;
    } else {
      // If focused in an input, use its cursor pos
      const ae = document.activeElement;
      if (ae && (ae.classList?.contains('text-input') || ae.classList?.contains('speaker-input'))) {
        const row = ae.closest('.segment');
        if (row) {
          const idx = parseInt(row.dataset.index, 10);
          if (!Number.isNaN(idx)) startSeg = idx;
          startPos = (typeof ae.selectionEnd === 'number') ? ae.selectionEnd : 0;
          startFieldIdx = ae.classList.contains('speaker-input') ? fields.indexOf('speaker') : fields.indexOf('text');
          if (startFieldIdx < 0) startFieldIdx = 0;
        }
      }
    }

    const total = countAllMatches(re, scope);

    // If the starting segment is not visible, start from the next visible segment
    let startPosInVis = posByIndex.get(startSeg);
    if (startPosInVis === undefined) {
      startPosInVis = visIdxs.findIndex((si) => si >= startSeg);
      if (startPosInVis === -1) startPosInVis = visIdxs.length; // none after; will wrap if enabled
      startPos = 0;
      startFieldIdx = 0;
    }

    const scan = (posFrom) => {
      for (let p = posFrom; p < visIdxs.length; p++) {
        const si = visIdxs[p];
        const seg = segments[si];
        if (!seg) continue;

        for (let fi = 0; fi < fields.length; fi++) {
          const field = fields[fi];
          const text = getFieldValue(seg, field);
          if (!text) continue;

          re.lastIndex = 0;
          const fromPos = (si === startSeg && fi === startFieldIdx) ? startPos : 0;
          re.lastIndex = fromPos;

          let m;
          while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex += 1; continue; }
            const start = m.index;
            const end = m.index + m[0].length;
            if (start < fromPos) continue;

            currentFind = { sig, segId: seg.id, field, start, end, match: m, segIndex: si };
            focusAndSelectMatch(si, field, start, end);

            setFindStatus(total ? `Match found (${total} total)` : 'Match found');
            return true;
          }
        }
      }
      return false;
    };

    if (scan(startPosInVis)) return true;
    if (wrap) {
      // wrap around to the start of the visible selection
      startSeg = visIdxs[0];
      startPos = 0;
      startFieldIdx = 0;
      currentFind = null;
      if (scan(0)) return true;
    }

    currentFind = null;
    setFindStatus('No matches.');
    return false;
  }


  function applyReplacementString(matchObj, replaceStr, allowDollarExpansion) {
    if (!allowDollarExpansion) return replaceStr;

    const whole = matchObj[0] ?? '';
    const groups = matchObj;
    const named = matchObj.groups || {};

    return String(replaceStr).replace(/\$(\$|&|<[^>]+>|\d{1,2})/g, (full, token) => {
      if (token === '$') return '$';
      if (token === '&') return whole;
      if (token.startsWith('<')) {
        const name = token.slice(1, -1);
        return (named && Object.prototype.hasOwnProperty.call(named, name)) ? (named[name] ?? '') : '';
      }
      const n = parseInt(token, 10);
      if (!Number.isNaN(n) && n >= 0) return groups[n] ?? '';
      return full;
    });
  }

  function replaceCurrent() {
    beginHistoryMutation();

    flushPendingText();

    const compiled = compileFindRegex();
    if (!compiled.ok) { setFindStatus(compiled.err, true); return; }
    const scope = getScope();
    const sig = getFindSig();

    if (!currentFind || currentFind.sig !== sig) {
      if (!findNext(true)) return;
    }

    const seg = segments.find(s => s.id === currentFind.segId);
    const si = currentFind.segIndex;
    if (!seg) { currentFind = null; return; }

    const field = currentFind.field;
    const before = getFieldValue(seg, field);
    const start = currentFind.start;
    const end = currentFind.end;

    const replRaw = (replaceInput?.value ?? '');
    const allowExpansion = !!optRegex?.checked;
    const replacement = applyReplacementString(currentFind.match, replRaw, allowExpansion);

    const after = before.slice(0, start) + replacement + before.slice(end);

    if (after === before) {
      setFindStatus('No change.');
      findNext(true);
      return;
    }

    const id = seg.id;

    const apply = (val) => {
      const s = segments.find(x => x.id === id);
      if (!s) return;
      setFieldValue(s, field, val);
      // clear pending text edit for this segment (if any)
      if (field === 'text') {
        const p = pendingTextEdits.get(id);
        if (p && p.timer) clearTimeout(p.timer);
        pendingTextEdits.delete(id);
      }
      updateRowBySegId(id);
      try { scheduleDirtyCheck(); } catch { }
      try { forceVisibleIfFilteredOut([id], 'Edit moved segment outside the current filter.'); } catch { }
      try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
    };

    apply(after);
    scheduleDirtyCheck();

    pushHistory({
      label: 'Replace',
      summary: `${safePreview((findInput?.value ?? ''), 18)}→${safePreview(replRaw, 18)} (seg=${id})`,
      meta: { segId: id, field, find: (findInput?.value ?? ''), replace: replRaw, regex: !!optRegex?.checked, caseSensitive: !!optCase?.checked, wholeWords: !!optWords?.checked },
      do: () => apply(after),
      undo: () => apply(before)
    });

    // update current match position to after replacement, then find next
    currentFind = null;
    setFindStatus('Replaced.');
    findNext(true);
  }

  let pendingReplaceAll = null; // {compiled, scope, total, findText, replaceText}

  function openReplaceAllConfirm() {
    flushPendingText();

    const compiled = compileFindRegex();
    if (!compiled.ok) { setFindStatus(compiled.err, true); return; }

    const scope = getScope();
    const total = countAllMatches(compiled.re, scope);

    if (total === 0) { setFindStatus('No matches.'); return; }

    const findText = (findInput?.value ?? '').trim();
    const replaceText = (replaceInput?.value ?? '');

    pendingReplaceAll = { compiled, scope, total, findText, replaceText };

    if (raSummary) {
      const scopeLabel = (scope === 'text') ? 'Text' : (scope === 'speaker' ? 'Speakers' : 'Text + speakers');
      raSummary.textContent = `Replace ${total} matches in ${scopeLabel}: “${findText}” → “${replaceText}”`;
    }

    if (replaceAllModal) replaceAllModal.classList.remove('hidden');
  }

  function closeReplaceAllConfirm() {
    pendingReplaceAll = null;
    if (replaceAllModal) replaceAllModal.classList.add('hidden');
  }

  function doReplaceAllConfirmed() {
    beginHistoryMutation();

    flushPendingText();
    if (!pendingReplaceAll) { closeReplaceAllConfirm(); return; }

    const { compiled, scope, total, replaceText } = pendingReplaceAll;
    const re = compiled.re;
    const useRegex = !!optRegex?.checked;

    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);

    const changes = []; // {segId, field, before, after}

    const visIdxs = getVisibleSegmentIndices();

    for (const si of visIdxs) {
      const seg = segments[si];
      for (const field of fields) {
        const before = getFieldValue(seg, field);
        if (!before) continue;

        re.lastIndex = 0;
        const after = before.replace(re, useRegex ? replaceText : () => replaceText);

        if (after !== before) {
          changes.push({ segId: seg.id, field, before, after });
          setFieldValue(seg, field, after);

          if (field === 'text') {
            const p = pendingTextEdits.get(seg.id);
            if (p && p.timer) clearTimeout(p.timer);
            pendingTextEdits.delete(seg.id);
          }
        }
      }
    }
    re.lastIndex = 0;

    // Update UI for changed segs
    for (const c of changes) updateRowBySegId(c.segId);
    scheduleDirtyCheck();

    try {
      const ids = Array.from(new Set(changes.map(c => c.segId)));
      forceVisibleIfFilteredOut(ids, 'Replace all created changes outside the current filter.');
    } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    const applyAll = (toAfter) => {
      for (const c of changes) {
        const seg = segments.find(s => s.id === c.segId);
        if (!seg) continue;
        setFieldValue(seg, c.field, toAfter ? c.after : c.before);

        if (c.field === 'text') {
          const p = pendingTextEdits.get(c.segId);
          if (p && p.timer) clearTimeout(p.timer);
          pendingTextEdits.delete(c.segId);
        }

        updateRowBySegId(c.segId);
      }
      scheduleDirtyCheck();
      try {
        const ids = Array.from(new Set(changes.map(c => c.segId)));
        forceVisibleIfFilteredOut(ids, 'Replace all created changes outside the current filter.');
      } catch { }
      try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }
    };

    pushHistory({
      label: 'Replace all',
      summary: `${changes.length} segments (${total} matches)`,
      meta: { firstSegId: (changes[0] ? changes[0].segId : null), find: pendingReplaceAll.findText, replace: pendingReplaceAll.replaceText, scope, matches: total, segmentsChanged: changes.length, regex: !!optRegex?.checked, caseSensitive: !!optCase?.checked, wholeWords: !!optWords?.checked },
      do: () => applyAll(true),
      undo: () => applyAll(false)
    });

    closeReplaceAllConfirm();
    currentFind = null;
    setFindStatus(`Replaced ${total} matches.`);
  }


  function getTranscriptSelectionText() {
    try {
      // If focus is in a transcript textarea, prefer its selection (window.getSelection() won't capture it)
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('text-input') &&
        typeof ae.selectionStart === 'number' && typeof ae.selectionEnd === 'number' &&
        ae.selectionEnd > ae.selectionStart) {
        const txt = String(ae.value || '').slice(ae.selectionStart, ae.selectionEnd).trim();
        if (txt) return txt;
      }

      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) return '';
      const txt = String(sel.toString() || '').trim();
      if (!txt) return '';
      const a = sel.anchorNode;
      const f = sel.focusNode;
      if (segmentsDiv && a && f && segmentsDiv.contains(a) && segmentsDiv.contains(f)) return txt;
      return '';
    } catch { return ''; }
  }

  function openFindModal() {
    // Capture selection first (flush/blur may clear selection)
    const selText = getTranscriptSelectionText();
    flushPendingText();
    if (player) player.pause();
    resetFindDrag();

    // Start fresh: empty fields, or use currently selected transcript text
    if (findInput) findInput.value = selText || '';
    if (replaceInput) replaceInput.value = '';
    if (findStatus) findStatus.textContent = '';
    lastFindQuery = null;
    lastFindIndex = -1;
    currentFind = null;
    setFindStatus('');
    if (findModal) {
      findModal.classList.remove('hidden');
    }
    setTimeout(() => findInput?.focus(), 0);
  }

  function closeFindModal() {
    onFindDragUp();

    currentFind = null;
    setFindStatus('');
    if (findModal) findModal.classList.add('hidden');
    if (replaceAllModal) replaceAllModal.classList.add('hidden');
  }

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

  // Keyboard: Enter in Find input -> Find next; Enter in Replace input -> Replace; Esc closes modal.
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

    const canPicker = (typeof window.showSaveFilePicker === "function" && window.isSecureContext);
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

  function getRowBySegId(segId) {
    return rowById.get(segId) || segmentsDiv.querySelector(`.segment[data-id="${segId}"]`);
  }

  function reindexAllRows() {
    for (let i = 0; i < segments.length; i++) {
      const id = segments[i].id;
      const row = getRowBySegId(id);
      if (row) {
        row.dataset.index = String(i);
        if (!rowById.has(id)) rowById.set(id, row);
      }
    }
  }

  function insertRowAtIndex(row, index) {
    if (!row) return;
    if (index <= 0) {
      segmentsDiv.insertBefore(row, segmentsDiv.firstChild);
      return;
    }
    const prevId = segments[index - 1]?.id;
    const prevRow = prevId ? getRowBySegId(prevId) : null;
    if (prevRow) {
      segmentsDiv.insertBefore(row, prevRow.nextSibling);
    } else {
      segmentsDiv.appendChild(row);
    }
  }

  function removeRowBySegId(segId) {
    const row = getRowBySegId(segId);
    if (row && row.parentNode) row.remove();
    rowById.delete(segId);
  }

  function moveRowBySegIdToIndex(segId, index) {
    const row = getRowBySegId(segId);
    if (!row) return;
    const childAt = segmentsDiv.children[index];
    if (childAt === row) return;
    insertRowAtIndex(row, index);
  }

  function applySegStartNoHistory(segId, newStart, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const focus = (opts.focus !== false);
    const scrollBehavior = (opts.scrollBehavior === undefined) ? 'auto' : opts.scrollBehavior;
    const block = opts.block || 'nearest';

    const prevScroll = preserveScroll ? segmentsDiv.scrollTop : null;

    const oldIndex = findIndexById(segId);
    const seg = segments.find(s => s.id === segId);
    if (!seg) return -1;

    seg.start = newStart;

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    enforceTiming({ sort: false });

    const newIndex = findIndexById(segId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      moveRowBySegIdToIndex(segId, newIndex);
    }

    reindexAllRows();
    updateRowBySegId(segId);

    if (preserveScroll && prevScroll !== null) segmentsDiv.scrollTop = prevScroll;

    if (focus && newIndex !== -1) {
      setActiveSegment(newIndex, scrollBehavior, block);
    }

    // filtering: keep edits visible even if they fall outside the active filter
    try { scheduleDirtyCheck(); } catch { }
    try { forceVisibleIfFilteredOut([segId], 'Edited timestamp moved segment outside the current filter.'); } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    return newIndex;
  }

  function canJoinAtIndex(idx) {
    if (idx <= 0 || idx >= segments.length) return false;
    if (!filterIsActive()) return true;
    const prev = segments[idx - 1];
    if (!prev) return false;
    const prow = getRowBySegId(prev.id);
    return !!(prow && !prow.classList.contains('filtered-out'));
  }


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




  function askForSplitTimeWhole(seg, opts = {}) {
    const forceAuto = !!opts.forceAuto;

    const t = (typeof player.currentTime === 'number' && !Number.isNaN(player.currentTime))
      ? player.currentTime
      : (seg.start + (seg.end - seg.start) / 2);

    const defaultSecRaw = Math.round(t);

    const minInt = Math.ceil(seg.start + 0.001);
    const maxInt = Math.floor(seg.end - 0.001);

    const autoAllocWithinSecond = () => {
      // No valid whole-second slot exists (or forced auto): allocate a unique ms-slot
      // within the current rounded second so the display time stays the same.
      const baseSec = Math.round(seg.start);
      const curMs = Math.round((seg.start - baseSec) * 1000);

      // Prefer after the current ms so the new segment naturally sorts after.
      let candidate = allocUniqueStartWithinSecond(baseSec, null, curMs + 1);

      // As a safety net, ensure we stay inside the segment boundaries.
      if (!(candidate > seg.start && candidate < seg.end)) {
        // Try a couple more steps forward.
        candidate = allocUniqueStartWithinSecond(baseSec, null, curMs + 2);
      }
      if (!(candidate > seg.start && candidate < seg.end)) {
        // Extreme edge case: fall back to a tiny epsilon after start.
        const eps = Math.min(seg.end - 0.001, seg.start + 0.001);
        return (Number.isFinite(eps) ? eps : seg.start);
      }
      return candidate;
    };

    if (forceAuto) return autoAllocWithinSecond();

    // If there is no valid whole-second slot inside this segment, auto-allocate within the same display second.
    if (minInt > maxInt) return autoAllocWithinSecond();

    let defaultSec = defaultSecRaw;
    if (defaultSec < minInt) defaultSec = minInt;
    if (defaultSec > maxInt) defaultSec = maxInt;
    const defaultTc = secondsToTimecodeWhole(defaultSec);

    const msg =
      `New segment start time (whole second, within this segment):
- Format: HH:MM:SS (or seconds, e.g. 83)
- Leave empty = ${defaultTc}

Valid range: ${secondsToTimecodeWhole(minInt)} — ${secondsToTimecodeWhole(maxInt)}`;

    const input = prompt(msg, defaultTc);
    if (input === null) return null;

    const trimmed = String(input).trim();
    let sec = defaultSec;
    if (trimmed !== '') {
      let raw;
      try { raw = trimmed.includes(':') ? timecodeToSeconds(trimmed) : parseFloat(trimmed); }
      catch { raw = NaN; }
      if (!Number.isFinite(raw)) {
        alert('Invalid time. Use HH:MM:SS or seconds (e.g. 83).');
        return null;
      }
      sec = Math.round(raw);
    }

    if (sec < minInt) sec = minInt;
    if (sec > maxInt) sec = maxInt;
    return sec;
  }

  function applySplitNoHistory(seg1Id, seg1TextAfter, seg2Snapshot, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const focusNew = !!opts.focusNew;

    const prevScroll = preserveScroll ? segmentsDiv.scrollTop : null;

    const seg1 = segments.find(s => s.id === seg1Id);
    if (!seg1) return;

    // Apply
    seg1.text = seg1TextAfter;

    // Ensure seg2 exists (use a fresh object so history snapshot can't be mutated later)
    let seg2 = segments.find(s => s.id === seg2Snapshot.id);
    if (!seg2) {
      seg2 = {
        id: seg2Snapshot.id,
        seq: seg2Snapshot.seq,
        blockId: seg2Snapshot.blockId,
        speaker: seg2Snapshot.speaker,
        text: seg2Snapshot.text,
        start: seg2Snapshot.start,
        end: seg2Snapshot.end
      };
      segments.push(seg2);
    } else {
      // If it already exists (rare), sync it
      seg2.blockId = seg2Snapshot.blockId;
      seg2.speaker = seg2Snapshot.speaker;
      seg2.text = seg2Snapshot.text;
      seg2.start = seg2Snapshot.start;
      seg2.end = seg2Snapshot.end;
    }

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    enforceTiming({ sort: false });

    // DOM: update seg1 row (text), insert/move seg2 row
    updateRowBySegId(seg1Id);

    const seg2Index = findIndexById(seg2Snapshot.id);
    if (seg2Index !== -1) {
      let row2 = getRowBySegId(seg2Snapshot.id);
      if (!row2) {
        row2 = createSegmentRow(segments[seg2Index], seg2Index);
      }
      insertRowAtIndex(row2, seg2Index);
      rowById.set(seg2Snapshot.id, row2);

      // Size the new textarea soon (chunked)
      try {
        const ta = row2.querySelector('.text-input');
        if (ta) queueTextareaSizing(ta);
      } catch { }
    }

    reindexAllRows();
    scheduleDirtyCheck();

    // filtering: keep split results visible even if they fall outside the active filter
    try { forceVisibleIfFilteredOut([seg1Id, seg2Snapshot.id], 'Split created segments outside the current filter.'); } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) segmentsDiv.scrollTop = prevScroll;

    if (focusNew && seg2Index !== -1) {
      setActiveSegment(seg2Index, 'auto', 'nearest');
      player.pause();
      player.currentTime = segments[seg2Index].start;

      const focusNewTa = () => {
        const rowEl = getRowBySegId(seg2Snapshot.id);
        const ta = rowEl ? rowEl.querySelector('.text-input') : null;
        if (ta) {
          ta.focus({ preventScroll: true });
          try { ta.setSelectionRange(0, 0); } catch { }
        }
      };
      // Two rAFs to ensure we win against click-focus and DOM insertion timing.
      requestAnimationFrame(() => requestAnimationFrame(focusNewTa));
    }
  }

  function undoSplitNoHistory(seg1Id, seg1TextBefore, seg2Id, seg1EndBefore, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const prevScroll = preserveScroll ? segmentsDiv.scrollTop : null;

    // Remove seg2
    const idx2 = findIndexById(seg2Id);
    if (idx2 !== -1) segments.splice(idx2, 1);

    // Restore seg1 text
    const seg1 = segments.find(s => s.id === seg1Id);
    if (seg1) {
      seg1.text = seg1TextBefore;
      // Restore seg1 end (pre-split)
      if (typeof seg1EndBefore === 'number' && Number.isFinite(seg1EndBefore)) seg1.end = seg1EndBefore;
    }

    segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    enforceTiming({ sort: false });

    // DOM updates
    removeRowBySegId(seg2Id);
    updateRowBySegId(seg1Id);
    reindexAllRows();
    scheduleDirtyCheck();
    try { forceVisibleIfFilteredOut([seg1Id], 'Undo created a segment outside the current filter.'); } catch { }

    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) segmentsDiv.scrollTop = prevScroll;
  }

  function joinTextsForJoin(aText, bText) {
    const aRaw = (aText ?? '');
    const bRaw = (bText ?? '');
    const a = String(aRaw).replace(/[ \t\r]+$/g, '');
    const b = String(bRaw).replace(/^[ \t\r\n]+/g, '');
    if (!a) return { text: b, cursorPos: 0 };
    if (!b) return { text: a, cursorPos: a.length };

    let sep = ' ';
    if (/\n$/.test(a)) sep = '';
    if (/[-–—]$/.test(a)) sep = '';
    if (/^[,.;:!?)}\]]/.test(b)) sep = '';

    const text = a + sep + b;
    const cursorPos = a.length + sep.length;
    return { text, cursorPos };
  }

  function applyJoinNoHistory(prevId, currId, prevTextAfter, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const activatePrev = (opts.activatePrev !== false);
    const focusTextarea = !!opts.focusTextarea;
    const cursorPos = (typeof opts.cursorPos === 'number') ? opts.cursorPos : null;
    const prevScroll = preserveScroll ? segmentsDiv.scrollTop : null;

    const prevIdx = findIndexById(prevId);
    const currIdx = findIndexById(currId);
    if (prevIdx === -1 || currIdx === -1) return;
    if (currIdx !== prevIdx + 1) return;

    const prevSeg = segments[prevIdx];
    if (!prevSeg) return;

    prevSeg.text = prevTextAfter ?? '';

    // Timing: preserve the joined range by extending prevSeg.end to currSeg.end.
    const currSeg = segments[currIdx];
    if (currSeg && typeof currSeg.end === 'number' && Number.isFinite(currSeg.end)) {
      prevSeg.end = currSeg.end;
    }

    segments.splice(currIdx, 1);

    enforceTiming({ sort: false });

    // DOM updates
    removeRowBySegId(currId);
    updateRowBySegId(prevId);
    reindexAllRows();
    // Refresh Join button state for neighbors (indices may have changed)
    try { updateRowBySegId(prevId); } catch { }
    const _nextAfterJoin = segments[prevIdx + 1];
    if (_nextAfterJoin) { try { updateRowBySegId(_nextAfterJoin.id); } catch { } }
    scheduleDirtyCheck();

    // Keep join result visible even if it no longer matches the active filter
    try { recomputeChangedSegIds(); } catch { }
    try { forceVisibleIfFilteredOut([prevId], 'Join moved segment outside the current filter.'); } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) segmentsDiv.scrollTop = prevScroll;

    if (activatePrev) {
      setActiveSegment(prevIdx, 'auto', 'center');
      player.pause();

      if (focusTextarea) {
        setTimeout(() => {
          const rowEl = getRowBySegId(prevId);
          const ta = rowEl ? rowEl.querySelector('.text-input') : null;
          if (ta) {
            ta.focus({ preventScroll: true });
            if (cursorPos !== null) {
              const pos = Math.max(0, Math.min(cursorPos, ta.value.length));
              try { ta.setSelectionRange(pos, pos); } catch { }
            }
          }
        }, 0);
      } else {
        // Ensure we don't accidentally leave focus in a textarea after DOM surgery
        try {
          const ae = document.activeElement;
          if (ae && ae.classList && ae.classList.contains('text-input')) ae.blur();
        } catch { }
      }
    }
  }

  function undoJoinNoHistory(prevId, prevTextBefore, prevEndBefore, currSnapshot, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const activateCurr = (opts.activateCurr !== false);
    const focusTextarea = !!opts.focusTextarea;
    const prevScroll = preserveScroll ? segmentsDiv.scrollTop : null;

    const prevIdx = findIndexById(prevId);
    if (prevIdx === -1) return;

    const prevSeg = segments[prevIdx];
    if (!prevSeg) return;

    prevSeg.text = prevTextBefore ?? '';
    if (typeof prevEndBefore === 'number' && Number.isFinite(prevEndBefore)) prevSeg.end = prevEndBefore;

    const snap = Object.assign({}, currSnapshot);
    segments.splice(prevIdx + 1, 0, snap);

    enforceTiming({ sort: false });

    // DOM updates
    updateRowBySegId(prevId);

    const currIdx = prevIdx + 1;
    let row2 = getRowBySegId(snap.id);
    if (!row2) row2 = createSegmentRow(segments[currIdx], currIdx);
    insertRowAtIndex(row2, currIdx);
    rowById.set(snap.id, row2);

    try {
      const ta2 = row2.querySelector('.text-input');
      if (ta2) queueTextareaSizing(ta2);
    } catch { }

    reindexAllRows();
    // Refresh Join button state for neighbors after restoring a row
    try { updateRowBySegId(prevId); } catch { }
    try { updateRowBySegId(snap.id); } catch { }
    const _nextAfterUndoJoin = segments[currIdx + 1];
    if (_nextAfterUndoJoin) { try { updateRowBySegId(_nextAfterUndoJoin.id); } catch { } }
    scheduleDirtyCheck();

    try { recomputeChangedSegIds(); } catch { }
    try { forceVisibleIfFilteredOut([prevId, snap.id], 'Undo restored a segment outside the current filter.'); } catch { }
    try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) segmentsDiv.scrollTop = prevScroll;

    if (activateCurr) {
      setActiveSegment(currIdx, 'auto', 'center');
      player.pause();

      if (focusTextarea) {
        setTimeout(() => {
          const rowEl = getRowBySegId(snap.id);
          const ta = rowEl ? rowEl.querySelector('.text-input') : null;
          if (ta) {
            ta.focus({ preventScroll: true });
            try { ta.setSelectionRange(0, 0); } catch { }
          }
        }, 0);
      } else {
        // Never leave focus in a textarea after undo unless explicitly requested
        try {
          const ae = document.activeElement;
          if (ae && ae.classList && ae.classList.contains('text-input')) ae.blur();
        } catch { }
      }
    }
  }

  function joinWithPrevious(idx) {
    const hadTextFocus = (() => {
      try {
        const ae = document.activeElement;
        return !!(ae && ae.classList && ae.classList.contains('text-input'));
      } catch { return false; }
    })();

    beginHistoryMutation();

    if (idx <= 0 || idx >= segments.length) return;

    // In filter mode: only allow when the true previous segment is visible in the UI.
    if (filterIsActive()) {
      const prev = segments[idx - 1];
      const prow = prev ? getRowBySegId(prev.id) : null;
      if (!prow || prow.classList.contains('filtered-out')) return;
    }

    const prevSeg = segments[idx - 1];
    const currSeg = segments[idx];
    if (!prevSeg || !currSeg) return;

    const prevId = prevSeg.id;
    const currId = currSeg.id;

    // Commit pending debounced edits on both rows before joining
    try { flushPendingText(prevId); } catch { }
    try { flushPendingText(currId); } catch { }

    const prevTextBefore = prevSeg.text || '';
    const prevEndBefore = prevSeg.end;
    const currSnapshot = Object.assign({}, currSeg);

    const res = joinTextsForJoin(prevTextBefore, currSnapshot.text || '');
    const prevTextAfter = res.text;
    const cursorPos = res.cursorPos;

    const beforeTime = player.currentTime;

    pushHistory({
      label: 'Join',
      summary: `${secondsToTimecodeWhole(currSeg.start)} (seg=${currId})`,
      meta: { segId: prevId, ids: [prevId, currId], prevId, currId },
      do: () => {
        applyJoinNoHistory(prevId, currId, prevTextAfter, { preserveScroll: true, activatePrev: true, focusTextarea: true, cursorPos });
        if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) player.currentTime = beforeTime;
      },
      undo: () => {
        undoJoinNoHistory(prevId, prevTextBefore, prevEndBefore, currSnapshot, { preserveScroll: true, activateCurr: true, focusTextarea: false });
        if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) player.currentTime = beforeTime;
      }
    });

    // Apply immediately (pushHistory does not auto-run action.do()).
    applyJoinNoHistory(prevId, currId, prevTextAfter, { preserveScroll: true, activatePrev: true, focusTextarea: true, cursorPos });
    if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) player.currentTime = beforeTime;
  }


  function splitSegment(idx, textAreaEl) {
    beginHistoryMutation();

    if (idx < 0 || idx >= segments.length) return;
    const seg = segments[idx];
    const seg1Id = seg.id;

    // Commit any pending debounced edits on this row before splitting
    try { flushPendingText(seg1Id); } catch { }

    const hasFocus = (textAreaEl && document.activeElement === textAreaEl);

    const isCursorSplit = (hasFocus && textAreaEl && typeof textAreaEl.selectionStart === 'number');

    // Split behavior:
    // - If we are splitting at a text cursor (focused textarea), we move text after the cursor to a new segment.
    // - Timestamp choice:

    // - If Auto-assign is enabled: always allocate x+ms (no prompt).
    // - Otherwise: prompt for a whole-second timestamp within the current segment,
    //   except when no whole-second slot exists (then we auto-allocate x+ms).
    const splitT = (autoAssignSplitTs)
      ? askForSplitTimeWhole(seg, { forceAuto: true })
      : askForSplitTimeWhole(seg);
    if (splitT === null) return;

    const beforeActiveId = getActiveSegId();
    const beforeTime = player.currentTime;

    const beforeText = seg.text || '';
    let t1 = beforeText;
    let t2 = '';

    if (isCursorSplit) {
      const pos = textAreaEl.selectionStart;
      t1 = beforeText.slice(0, pos).trimEnd();
      t2 = beforeText.slice(pos).trimStart();
    }

    const newId = `seg_${globalSeq++}`;
    const seg2Snapshot = {
      id: newId,
      seq: globalSeq,
      blockId: seg.blockId,
      speaker: seg.speaker || '',
      text: t2,
      start: splitT,
      end: seg.end
    };

    // Apply split now (fast, incremental DOM)
    applySplitNoHistory(seg1Id, t1, seg2Snapshot, { preserveScroll: true, focusNew: true });

    const afterActiveId = getActiveSegId();
    const afterTime = player.currentTime;

    pushHistory({
      label: 'Split',
      summary: `${secondsToTimecodeWhole(splitT)} (seg=${seg1Id})`,
      meta: {
        segId: seg1Id,
        newSegId: seg2Snapshot.id,
        splitAt: secondsToTimecodeWhole(splitT),
        splitSec: Math.round(splitT),
      },
      do: () => {
        applySplitNoHistory(seg1Id, t1, seg2Snapshot, { preserveScroll: true, focusNew: false });
        if (typeof afterTime === 'number' && Number.isFinite(afterTime)) player.currentTime = afterTime;
      },
      undo: () => {
        undoSplitNoHistory(seg1Id, beforeText, seg2Snapshot.id, seg2Snapshot.end, { preserveScroll: true });
        if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) player.currentTime = beforeTime;
      }
    });
  }

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
    } else {
      // Clear topics if none found in this file
      topicsView.topics = [];
      topicsView.render();
      if (topicsView.container) topicsView.container.classList.add('hidden');
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
      const canOpen = (window.isSecureContext && typeof window.showOpenFilePicker === "function");
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


  /* SAVE_AS_SRT_V1 */
  function secondsToSrtTimecode(sec) {
    const msTotal = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const hh = Math.floor(msTotal / 3600000);
    const mm = Math.floor((msTotal % 3600000) / 60000);
    const ss = Math.floor((msTotal % 60000) / 1000);
    const ms = msTotal % 1000;
    return String(hh).padStart(2, '0') + ":" + String(mm).padStart(2, '0') + ":" + String(ss).padStart(2, '0') + "," + String(ms).padStart(3, '0');
  }

  function buildSrtFromSegments() {
    const segs = [...segments].sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const start = secondsToSrtTimecode(s.start);
      let endSec = Number(s.end);
      if (!Number.isFinite(endSec) || endSec <= Number(s.start)) endSec = Number(s.start) + 0.5;
      const end = secondsToSrtTimecode(endSec);

      const speaker = (s.speaker || "").trim();
      const text = String(s.text || "").trim();
      const line = speaker ? (speaker + ": " + text) : text;

      out.push(String(i + 1));
      out.push(start + " --> " + end);
      out.push(line);
      out.push(""); // blank line
    }
    return out.join("\n");
  }

  function suggestSrtName() {
    const norm = (name) => {
      if (!name) return null;
      let n = String(name).trim();
      if (!n) return null;
      // Fix common legacy / accidental combos
      n = n.replace(/\.srt\.json$/i, ".srt");
      if (n.toLowerCase().endsWith(".json")) n = n.replace(/\.json$/i, ".srt");
      if (!n.toLowerCase().endsWith(".srt")) n = n + ".srt";
      return n;
    };

    // Prefer the most recent save name (so subsequent saves keep using it)
    const fromExport = norm(exportFileName);
    if (fromExport) return fromExport;

    // Prefer current loaded transcript name if it ends with .srt
    const fromLoaded = norm(loadedJsonFileName);
    if (fromLoaded) return fromLoaded;

    return "transcript.srt";
  }


  function sanitizeSrtFileName(name) {
    name = String(name || '').trim();
    if (!name) name = suggestSrtName();
    // Normalize to .srt and fix accidental .srt.json
    name = name.replace(/\.srt\.json$/i, ".srt");
    if (name.toLowerCase().endsWith(".json")) name = name.replace(/\.json$/i, ".srt");
    if (!name.toLowerCase().endsWith(".srt")) name += ".srt";
    // Replace invalid filename chars (cross-platform safe)
    name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
    return name;
  }

  function _downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "transcript.srt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveSrtLocally(forceSaveAs = false) {
    if (!segments.length) return;

    const sourceKind = (typeof transcriptLoadKind !== 'undefined' ? transcriptLoadKind : null);
    const isDiskSource = (sourceKind === 'disk');

    const finalName = sanitizeSrtFileName(suggestSrtName());
    const srtText = buildSrtFromSegments();

    const canPicker = (typeof window.showSaveFilePicker === "function" && window.isSecureContext);

    try {
      if (canPicker) {
        // ... existing picker logic ...
        let handle = srtSaveHandle;
        if (forceSaveAs) {
          handle = await window.showSaveFilePicker({ suggestedName: finalName, types: [{ description: "SubRip (.srt)", accept: { "text/plain": [".srt"] } }] });
          srtSaveHandle = handle;
        } else if (!handle) {
          // No handle? Ask for one.
          handle = await window.showSaveFilePicker({ suggestedName: finalName, types: [{ description: "SubRip (.srt)", accept: { "text/plain": [".srt"] } }] });
          srtSaveHandle = handle;
        }

        // B2 behavior: request write permission on first *Save* (not on Open).
        try {
          if (!forceSaveAs && typeof handle.queryPermission === "function" && typeof handle.requestPermission === "function") {
            const qp = await handle.queryPermission({ mode: "readwrite" });
            if (qp !== "granted") {
              const rp = await handle.requestPermission({ mode: "readwrite" });
              if (rp !== "granted") {
                if (typeof showToast === "function") showToast("No write permission for this file.");
                return;
              }
            }
          }
        } catch { }

        const writable = await handle.createWritable();

        // Embed topics if available
        let contentToWrite = srtText;
        if (topicsView.topics && topicsView.topics.length > 0) {
          contentToWrite = embedMetadata(srtText, { topics: topicsView.topics });
        }

        await writable.write(contentToWrite);
        await writable.close();

        lastSavedAt = nowHHMMSS();
        setCleanNow();
        showToast(`Saved: ${handle.name}`);

      } else {
        // Fallback: Download
        downloadSrt(finalName, srtText);
      }
    } catch (e) {
      console.error(e);
      if (e.name !== 'AbortError') {
        if (typeof showToast === 'function') showToast(`Save failed: ${e.message}`);
      }
    }
  }

  function downloadSrt(filename, text) {
    // Embed topics if available
    let content = text;
    if (topicsView.topics && topicsView.topics.length > 0) {
      content = embedMetadata(text, { topics: topicsView.topics });
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    lastSavedAt = nowHHMMSS();
    setCleanNow();
  }



  function updateSaveLocalHint() {
    // Hint removed by design (too noisy); keep function as no-op for backwards compatibility.
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

  function doExport(finalName) {

    const outObj = buildJsonFromSegments();
    const blob = new Blob([JSON.stringify(outObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    exportFileName = finalName;
    lastSavedAt = nowHHMMSS();

    setCleanNow();
  }

  // Save button opens modal
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

      // Transcript autoload (.srt)
      if (srtUrl) {
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
        } else {
          // Try legacy separate load if embedded missing (optional fallback, likely unneeded now)
          // For now, assume server injection keeps it simple.
          topicsView.topics = [];
          topicsView.render();
          if (topicsView.container) topicsView.container.classList.add('hidden');
        }
      }
    } catch (e) {
      console.error(e);
      // Silent fail is ok; editor remains usable with manual choices
    }
  }

  // Set up UI state based on security context
  setTimeout(() => {
    const canPicker = (typeof window.showSaveFilePicker === "function" && window.isSecureContext);
    if (!canPicker) {
      if (document.getElementById('saveAsBtn')) document.getElementById('saveAsBtn').style.display = 'none';
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
