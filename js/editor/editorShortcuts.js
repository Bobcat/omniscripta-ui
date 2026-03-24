function isOpen(modal) {
    return !!modal && !modal.classList.contains('hidden');
}

export function handleModalHotkeys({
    event,
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
}) {
    if (isOpen(historyModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeHistoryModal(); }
        return true;
    }

    if (isOpen(findModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeFindModal(); }
        return true;
    }

    if (isOpen(replaceAllModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeReplaceAllConfirm(); }
        return true;
    }

    if (isOpen(helpModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeHelpModal(); }
        return true;
    }

    if (isOpen(settingsModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeSettingsModal(); }
        return true;
    }

    if (isOpen(filterModal)) {
        if (event.key === 'Escape') { event.preventDefault(); closeFilterModal(); }
        return true;
    }

    return false;
}

export function wireEditorHotkeys({
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
    getSpeakerDropdownEl,
    closeSpeakerDropdown,
    getSpeakerDropdownIndex,
    setSpeakerDropdownIndex,
    applySpeakerSelected,
    player,
    ensureAudioLoadedForPlay,
    segmentsDiv,
    getSegments,
    getCurrentSegmentIndex,
    findIndexById,
    setActiveSegment,
    snapToVisibleIfNeeded,
    getDoneSegIds,
    forceVisibleIfFilteredOut,
    matchesFilterNow,
    forcedVisibleIds,
    pruneForcedVisibleNow,
    getRowById,
    updateDonePill,
    saveDoneToStorage,
    scheduleApplyFilters,
    getEditorMode,
    toggleRepeatSeg,
    repeatSegState,
    joinWithPrevious,
    splitSegment,
    handleLoopHotkey,
    findSegmentIndexAtTime,
    seekRelative,
}) {
    const onKeydown = (e) => {
        const tag = e.target.tagName;
        const isEditing = tag === 'INPUT' || tag === 'TEXTAREA';

        if (e.ctrlKey && !e.altKey && !e.metaKey) {
            if (isEditing && e.target && e.target.classList && e.target.classList.contains('time-input')) {
                return;
            }
            const key = e.key.toLowerCase();
            if (key === 'z') {
                e.preventDefault();
                if (isEditing) {
                    const row = e.target.closest?.('.segment');
                    const segmentId = row?.dataset?.id || null;
                    flushPendingText(segmentId);
                } else {
                    flushPendingText();
                }
                if (e.shiftKey) doRedo(); else doUndo();
                return;
            }
            if (key === 'y') {
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

        if (handleModalHotkeys({
            event: e,
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
        })) return;

        const speakerDropdownEl = getSpeakerDropdownEl();
        if (speakerDropdownEl) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSpeakerDropdown();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const speakerDropdownIndex = getSpeakerDropdownIndex();
                setSpeakerDropdownIndex((speakerDropdownIndex < 0 ? 0 : speakerDropdownIndex + 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const speakerDropdownIndex = getSpeakerDropdownIndex();
                setSpeakerDropdownIndex((speakerDropdownIndex < 0 ? 0 : speakerDropdownIndex - 1));
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                applySpeakerSelected();
                return;
            }
            return;
        }

        if (e.key === 'F1') {
            e.preventDefault();
            if (player && player.paused && !ensureAudioLoadedForPlay()) return;

            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                ae.blur();
                segmentsDiv.focus({ preventScroll: true });
            }

            if (player.paused) {
                const segments = getSegments();
                let idx = getCurrentSegmentIndex();
                const time = player.currentTime;

                if (idx === -1 || !segments[idx] || !(time >= segments[idx].start && time < segments[idx].end)) {
                    idx = -1;
                    for (let i = 0; i < segments.length; i++) {
                        const segment = segments[i];
                        if (time >= segment.start && time < segment.end) { idx = i; break; }
                    }
                }

                if (idx !== -1) setActiveSegment(idx, 'auto');
                snapToVisibleIfNeeded();
                player.play();
            } else {
                player.pause();
            }
            return;
        }

        if (e.key === 'F9') {
            e.preventDefault();
            const segments = getSegments();
            const doneSegIds = getDoneSegIds();
            const ae = document.activeElement;
            let idx = getCurrentSegmentIndex();
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                const row = ae.closest && ae.closest('.segment');
                if (row && row.dataset && row.dataset.id) {
                    const i2 = findIndexById(row.dataset.id);
                    if (i2 !== -1) idx = i2;
                }
            }
            if (idx >= 0 && idx < segments.length) {
                const seg = segments[idx];
                if (doneSegIds.has(seg.id)) doneSegIds.delete(seg.id);
                else doneSegIds.add(seg.id);

                forceVisibleIfFilteredOut([seg.id], 'Updated done status moved segment outside the current filter.');
                if (matchesFilterNow(seg)) forcedVisibleIds.delete(seg.id);
                pruneForcedVisibleNow();

                const rowById = getRowById();
                const row = rowById.get(seg.id) || segmentsDiv.querySelector(`.segment[data-id="${seg.id}"]`);
                if (row) {
                    row.classList.toggle('done', doneSegIds.has(seg.id));
                    const btn = row.querySelector('.done-btn');
                    if (btn) {
                        btn.textContent = doneSegIds.has(seg.id) ? '☑' : '☐';
                        btn.setAttribute('aria-pressed', doneSegIds.has(seg.id) ? 'true' : 'false');
                    }
                }

                updateDonePill();
                saveDoneToStorage();
                scheduleApplyFilters();
            }
            return;
        }

        if (getEditorMode() === 'text' && (e.key === 'F3' || e.key === 'F4')) {
            e.preventDefault();
            return;
        }

        if (e.key === 'F2') {
            e.preventDefault();
            const segments = getSegments();
            const wasPaused = !!(player && player.paused);
            if (wasPaused) {
                if (!ensureAudioLoadedForPlay()) return;
            }

            const ae = document.activeElement;
            const isPlaying = !!(player && !player.paused && !player.ended);

            let idx = getCurrentSegmentIndex();
            if (!isPlaying) {
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                    const row = ae.closest?.('.segment');
                    const di = row ? parseInt(row.dataset.index, 10) : NaN;
                    if (Number.isFinite(di)) idx = di;
                }
            }

            if (idx >= 0 && idx < segments.length) {
                setActiveSegment(idx, 'auto', 'center');
                toggleRepeatSeg(idx);
                if (wasPaused && repeatSegState && repeatSegState.active) {
                    if (player && player.paused) player.play();
                }
            }
            return;
        }

        if (e.key === 'F3') {
            e.preventDefault();
            const ae = document.activeElement;
            let idx = getCurrentSegmentIndex();
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                const row = ae.closest?.('.segment');
                const sid = row?.dataset?.id || null;
                flushPendingText(sid);
                const di = row ? parseInt(row.dataset.index, 10) : NaN;
                if (Number.isFinite(di)) idx = di;
            } else {
                flushPendingText();
            }
            if (idx >= 0) joinWithPrevious(idx);
            return;
        }

        if (e.key === 'F4') {
            e.preventDefault();
            const ae = document.activeElement;
            let idx = getCurrentSegmentIndex();
            let ta = null;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                const row = ae.closest?.('.segment');
                const sid = row?.dataset?.id || null;
                flushPendingText(sid);
                const di = row ? parseInt(row.dataset.index, 10) : NaN;
                if (Number.isFinite(di)) idx = di;
                if (ae.tagName === 'TEXTAREA' && ae.classList && ae.classList.contains('text-input')) {
                    ta = ae;
                }
            } else {
                flushPendingText();
            }

            if (idx >= 0) {
                setActiveSegment(idx, 'auto', 'center');
                splitSegment(idx, ta);
            }
            return;
        }

        if (e.key === 'F6') {
            e.preventDefault();
            let idx = getCurrentSegmentIndex();
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
                const row = ae.closest?.('.segment');
                const di = row ? parseInt(row.dataset.index, 10) : NaN;
                if (Number.isFinite(di)) idx = di;
            }
            if (idx >= 0) handleLoopHotkey(idx);
            return;
        }

        if (!isEditing && getEditorMode() === 'segments') {
            const k = e.key;
            const wantsNav = (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown');
            if (wantsNav && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const rows = segmentsDiv ? segmentsDiv.querySelectorAll('.segment') : null;
                if (rows && rows.length) {
                    const isVisible = (i) => {
                        return !!rows[i] && !rows[i].classList.contains('filtered-out');
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

                    const segments = getSegments();
                    let idx = getCurrentSegmentIndex();
                    if (!(idx >= 0 && idx < rows.length) || !isVisible(idx)) {
                        idx = -1;
                        const ti = findSegmentIndexAtTime(player ? player.currentTime : 0);
                        if (ti !== -1 && isVisible(ti)) idx = ti;
                        if (idx === -1) idx = nextVisible(-1, +1);
                        if (idx === -1) return;
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
                        if (player && !player.paused) player.pause();
                        if (player && segments[newIdx] && Number.isFinite(segments[newIdx].start)) player.currentTime = segments[newIdx].start;
                        const behavior = 'auto';
                        if ((k === 'Home' || k === 'End') && segmentsDiv) {
                            segmentsDiv.scrollTop = (k === 'Home') ? 0 : segmentsDiv.scrollHeight;
                        }
                        setActiveSegment(newIdx, behavior, block, forceScroll || !!e.repeat);
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

                if (player.paused) {
                    const segments = getSegments();
                    let idx = getCurrentSegmentIndex();
                    const t = player.currentTime;

                    if (idx === -1 || !segments[idx] || !(t >= segments[idx].start && t < segments[idx].end)) {
                        idx = -1;
                        for (let i = 0; i < segments.length; i++) {
                            const segment = segments[i];
                            if (t >= segment.start && t < segment.end) { idx = i; break; }
                        }
                    }

                    if (idx !== -1) setActiveSegment(idx, 'auto');
                    snapToVisibleIfNeeded();
                    player.play();
                } else {
                    player.pause();
                }
                break;
            case 'ArrowLeft':
                if (getEditorMode() === 'segments') break;
                e.preventDefault();
                seekRelative(-3);
                break;
            case 'ArrowRight':
                if (getEditorMode() === 'segments') break;
                e.preventDefault();
                seekRelative(3);
                break;
        }
    };

    document.addEventListener('keydown', onKeydown);
    return () => {
        document.removeEventListener('keydown', onKeydown);
    };
}
