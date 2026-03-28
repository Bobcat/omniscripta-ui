import { ModalController } from "@spa-foundation/core";
import { normSpeaker } from "../utils.js";

export function isFilterActive(filterState) {
    return (filterState.speakers.size > 0) || (filterState.changedMode !== 'all') || (filterState.doneMode !== 'all');
}

export function matchesFilter({
    segment,
    filterState,
    changedSegIds,
    doneSegIds,
}) {
    if (!segment) return false;
    if (filterState.speakers.size) {
        const speaker = normSpeaker(segment.speaker);
        if (!filterState.speakers.has(speaker)) return false;
    }
    if (filterState.changedMode !== 'all') {
        const isChanged = changedSegIds.has(segment.id);
        if (filterState.changedMode === 'changed' && !isChanged) return false;
        if (filterState.changedMode === 'unchanged' && isChanged) return false;
    }
    if (filterState.doneMode !== 'all') {
        const isDone = doneSegIds.has(segment.id);
        if (filterState.doneMode === 'done' && !isDone) return false;
        if (filterState.doneMode === 'undone' && isDone) return false;
    }
    return true;
}

export function isVisibleNow({
    segment,
    filterState,
    changedSegIds,
    doneSegIds,
    forcedVisibleIds,
}) {
    if (!isFilterActive(filterState)) return true;
    return matchesFilter({ segment, filterState, changedSegIds, doneSegIds }) || forcedVisibleIds.has(segment.id);
}

export function clearFilterState({
    filterState,
    forcedVisibleIds,
    hideFilterNotice,
    syncFilterUIFromState,
    syncModeButtons,
    scheduleApplyFilters,
}) {
    filterState.speakers.clear();
    filterState.changedMode = 'all';
    filterState.doneMode = 'all';
    forcedVisibleIds.clear();
    hideFilterNotice();
    syncFilterUIFromState();
    syncModeButtons();
    scheduleApplyFilters();
}

export function showFilterNotice({
    filterNotice,
    filterNoticeText,
    message,
}) {
    if (!filterNotice || !filterNoticeText) return;
    filterNoticeText.textContent = message || '';
    filterNotice.classList.remove('hidden');
}

export function hideFilterNotice({
    filterNotice,
    filterNoticeText,
}) {
    if (!filterNotice) return;
    filterNotice.classList.add('hidden');
    if (filterNoticeText) filterNoticeText.textContent = '';
}

export function setChangedMode(filterState, mode) {
    filterState.changedMode = (mode === 'changed' || mode === 'unchanged') ? mode : 'all';
}

export function setDoneMode(filterState, mode) {
    filterState.doneMode = (mode === 'done' || mode === 'undone') ? mode : 'all';
}

export function pruneForcedVisibleIds({
    forcedVisibleIds,
    hideFilterNotice,
    segments,
    matchesFilter,
    findIndexById,
}) {
    if (!forcedVisibleIds.size) {
        hideFilterNotice();
        return;
    }

    if (forcedVisibleIds.size > 24) {
        const keep = new Set();
        for (const segment of segments) {
            if (!segment) continue;
            if (forcedVisibleIds.has(segment.id) && !matchesFilter(segment)) keep.add(segment.id);
        }
        forcedVisibleIds.clear();
        for (const id of keep) forcedVisibleIds.add(id);
    } else {
        for (const id of Array.from(forcedVisibleIds)) {
            const index = findIndexById(id);
            if (index === -1) {
                forcedVisibleIds.delete(id);
                continue;
            }
            const segment = segments[index];
            if (matchesFilter(segment)) forcedVisibleIds.delete(id);
        }
    }

    if (!forcedVisibleIds.size) hideFilterNotice();
}

export function forceVisibleIfFilteredOut({
    ids,
    reason,
    options = {},
    filterIsActive,
    forcedVisibleIds,
    segments,
    matchesFilter,
    findIndexById,
    showFilterNotice,
}) {
    if (!filterIsActive()) return;

    const silent = !!(options && options.silent);
    const arr = (ids || []).filter(Boolean);
    if (!arr.length) return;

    let needsNotice = false;

    if (arr.length > 24) {
        const wanted = new Set(arr);
        for (const segment of segments) {
            if (!segment) continue;
            if (!wanted.has(segment.id)) continue;
            if (!matchesFilter(segment)) {
                needsNotice = true;
                if (!forcedVisibleIds.has(segment.id)) {
                    forcedVisibleIds.add(segment.id);
                }
            }
        }
    } else {
        for (const id of arr) {
            const index = findIndexById(id);
            if (index === -1) continue;
            const segment = segments[index];
            if (!matchesFilter(segment)) {
                needsNotice = true;
                if (!forcedVisibleIds.has(id)) {
                    forcedVisibleIds.add(id);
                }
            }
        }
    }

    if (needsNotice && !silent) {
        showFilterNotice(reason || 'Some changes are outside the current filter.');
    }
}

function makeChip(label, onClose) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';

    const textEl = document.createElement('span');
    textEl.textContent = label;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'x';
    closeBtn.textContent = '×';
    closeBtn.title = 'Remove filter';
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onClose) onClose();
    });

    chip.appendChild(textEl);
    chip.appendChild(closeBtn);
    return chip;
}

export function updateFilterBarUI({
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
}) {
    if (!filterBar) return;
    const active = isFilterActive(filterState);
    filterBar.classList.toggle('hidden', !active);

    if (filterBtn) {
        filterBtn.textContent = active ? 'Filter*' : 'Filter';
    }

    if (filterChipsEl) {
        filterChipsEl.innerHTML = '';

        const speakers = Array.from(filterState.speakers.values());
        const max = 4;
        for (let i = 0; i < Math.min(max, speakers.length); i++) {
            const speaker = speakers[i];
            const label = `Speaker: ${speaker || '(empty)'}`;
            filterChipsEl.appendChild(makeChip(label, () => {
                filterState.speakers.delete(speaker);
                syncFilterUIFromState();
                scheduleApplyFilters();
            }));
        }
        if (speakers.length > max) {
            const extra = speakers.length - max;
            const chip = document.createElement('span');
            chip.className = 'filter-chip';
            chip.textContent = `+${extra} more`;
            chip.title = 'Open Filter to edit';
            chip.addEventListener('click', () => openFilterModal());
            filterChipsEl.appendChild(chip);
        }

        if (filterState.changedMode !== 'all') {
            const label = (filterState.changedMode === 'changed') ? 'Changed only' : 'Unchanged only';
            filterChipsEl.appendChild(makeChip(label, () => {
                setChangedMode(filterState, 'all');
                syncFilterUIFromState();
                scheduleApplyFilters();
            }));
        }
        if (filterState.doneMode !== 'all') {
            const label = (filterState.doneMode === 'done') ? 'Done only' : 'Undone only';
            filterChipsEl.appendChild(makeChip(label, () => {
                setDoneMode(filterState, 'all');
                syncFilterUIFromState();
                scheduleApplyFilters();
            }));
        }

        if (active) {
            const label = filterState.playbackFiltered ? 'Play: visible only' : 'Play: all';
            const chip = document.createElement('span');
            chip.className = 'filter-chip';
            chip.textContent = label;
            chip.title = 'Toggle in Filter...';
            chip.addEventListener('click', () => openFilterModal());
            filterChipsEl.appendChild(chip);
        }
    }

    if (filterCountEl) {
        if (!isFilterActive(filterState)) filterCountEl.textContent = '';
        else filterCountEl.textContent = `Showing ${visibleCount} / ${total}`;
    }
}

export function rebuildFilterSpeakerOptions({
    filterSpeakersList,
    segments,
    filterState,
    scheduleApplyFilters,
}) {
    if (!filterSpeakersList) return;
    const counts = new Map();
    for (const segment of segments) {
        const key = normSpeaker(segment.speaker);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const keys = Array.from(counts.keys());
    keys.sort((a, b) => {
        if (!a && b) return 1;
        if (a && !b) return -1;
        return a.localeCompare(b);
    });

    filterSpeakersList.innerHTML = '';
    for (const key of keys) {
        const labelEl = document.createElement('label');
        labelEl.className = 'chk';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = key;
        cb.checked = filterState.speakers.has(key);

        cb.addEventListener('change', () => {
            if (cb.checked) filterState.speakers.add(key);
            else filterState.speakers.delete(key);
            scheduleApplyFilters();
        });

        const textEl = document.createElement('span');
        const name = key || '(empty)';
        textEl.textContent = `${name} (${counts.get(key) || 0})`;

        labelEl.appendChild(cb);
        labelEl.appendChild(textEl);
        filterSpeakersList.appendChild(labelEl);
    }

    if (!keys.length) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'muted';
        emptyEl.textContent = '(no speakers found)';
        filterSpeakersList.appendChild(emptyEl);
    }
}

export function syncFilterUIFromState({
    rebuildFilterSpeakerOptions,
    filterState,
    playFilteredToggle,
}) {
    rebuildFilterSpeakerOptions();

    const radios = document.querySelectorAll('input[name="changedMode"]');
    radios.forEach(r => r.checked = (r.value === filterState.changedMode));

    const doneRadios = document.querySelectorAll('input[name="doneMode"]');
    doneRadios.forEach(r => r.checked = (r.value === filterState.doneMode));

    if (playFilteredToggle) playFilteredToggle.checked = !!filterState.playbackFiltered;
}

export function openFilterModal({
    filterModal,
    player,
    syncFilterUIFromState,
    closeFilterBtn,
}) {
    if (!filterModal) return;
    player.pause();
    syncFilterUIFromState();
    filterModal.classList.remove('hidden');
    setTimeout(() => { try { closeFilterBtn.focus(); } catch { } }, 0);
}

export function closeFilterModal({
    filterModal,
}) {
    if (!filterModal) return;
    filterModal.classList.add('hidden');
}

export function applyFilterFromModalControls({
    filterState,
    playFilteredToggle,
    scheduleApplyFilters,
}) {
    const changedRadio = document.querySelector('input[name="changedMode"]:checked');
    setChangedMode(filterState, changedRadio ? changedRadio.value : 'all');
    const doneRadio = document.querySelector('input[name="doneMode"]:checked');
    setDoneMode(filterState, doneRadio ? doneRadio.value : 'all');
    if (playFilteredToggle) filterState.playbackFiltered = !!playFilteredToggle.checked;
    scheduleApplyFilters();
}

function isFilterModalChangeTarget(target) {
    if (!target) return false;
    return target.name === 'changedMode' || target.name === 'doneMode' || target.id === 'playFilteredToggle';
}

export function wireFilterControlEvents({
    filterBtn,
    openFilterModal,
    closeFilterBtn,
    closeFilterModal,
    filterModal,
    applyFilterFromModalControls,
    filterClearBtn3,
    filterClearBtn,
    clearFilterState,
    filterStrictBtn,
    forcedVisibleIds,
    hideFilterNotice,
    scheduleApplyFilters,
}) {
    if (filterBtn) filterBtn.addEventListener('click', openFilterModal);
    if (closeFilterBtn) closeFilterBtn.addEventListener('click', closeFilterModal);
    if (filterModal) {
        new ModalController(filterModal, {
            backdropEvent: 'click',
            onBackdrop: () => closeFilterModal()
        });
        filterModal.addEventListener('change', (e) => {
            if (isFilterModalChangeTarget(e.target)) applyFilterFromModalControls();
        });
    }

    if (filterClearBtn3) filterClearBtn3.addEventListener('click', () => { clearFilterState(); });
    if (filterClearBtn) filterClearBtn.addEventListener('click', () => { clearFilterState(); });

    if (filterStrictBtn) {
        filterStrictBtn.addEventListener('click', () => {
            forcedVisibleIds.clear();
            hideFilterNotice();
            scheduleApplyFilters();
        });
    }
}

export function createFilterApplyScheduler({
    segmentsDiv,
    getSegments,
    setVisibleResults,
    filterBar,
    filterBtn,
    hideFilterNotice,
    rebuildSegmentStarts,
    isFilterActive,
    getFilterState,
    getForcedVisibleIds,
    recomputeChangedSegIds,
    pruneForcedVisibleNow,
    getRowBySegId,
    getEditingTextSegId,
    matchesFilterNow,
    canJoinAtIndex,
    updateFilterBarUI,
    getEditorMode,
    renderTextView,
}) {
    let filterApplyRaf = 0;
    let filterApplying = false;
    let filterApplyPending = false;
    let filterApplyToken = 0;

    function scheduleApplyFilters() {
        filterApplyPending = true;
        if (filterApplying) return;
        if (filterApplyRaf) return;
        filterApplyRaf = requestAnimationFrame(() => {
            filterApplyRaf = 0;
            if (!filterApplyPending) return;
            filterApplyPending = false;
            applyFiltersToDOM();
        });
    }

    function applyFiltersToDOM() {
        if (!segmentsDiv) return;
        filterApplying = true;
        const token = ++filterApplyToken;
        const segments = getSegments();

        if (!segments.length) {
            setVisibleResults([], []);
            if (filterBar) filterBar.classList.add('hidden');
            if (filterBtn) filterBtn.textContent = 'Filter';
            hideFilterNotice();
            filterApplying = false;
            if (filterApplyPending) scheduleApplyFilters();
            return;
        }

        rebuildSegmentStarts();

        const filterState = getFilterState();
        const forcedVisibleIds = getForcedVisibleIds();
        const active = isFilterActive();
        const usesChanged = (filterState.changedMode !== 'all') || forcedVisibleIds.size;
        if (usesChanged) {
            recomputeChangedSegIds();
        }

        pruneForcedVisibleNow();

        const total = segments.length;
        const newVisStarts = [];
        const newVisIds = [];
        let visibleCount = 0;

        const BUDGET_MS = 10;
        const MAX_PER_FRAME = 1200;

        let i = 0;
        function step() {
            if (token !== filterApplyToken) {
                filterApplying = false;
                if (filterApplyPending) scheduleApplyFilters();
                return;
            }

            const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            let n = 0;

            while (i < total && n < MAX_PER_FRAME) {
                const seg = segments[i];
                const row = getRowBySegId(seg.id);
                const editingTextSegId = getEditingTextSegId();
                const show = (!active) ? true : (matchesFilterNow(seg) || forcedVisibleIds.has(seg.id) || (editingTextSegId && seg.id === editingTextSegId));

                if (row) {
                    row.classList.toggle('filtered-out', !show);
                    const forced = active && forcedVisibleIds.has(seg.id) && !matchesFilterNow(seg);
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

            setVisibleResults(newVisStarts, newVisIds);
            updateFilterBarUI(visibleCount, total);

            if (getEditorMode() === 'text') renderTextView();

            filterApplying = false;
            if (filterApplyPending) scheduleApplyFilters();
        }

        step();
    }

    return scheduleApplyFilters;
}
