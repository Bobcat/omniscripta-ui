export function createSpeakerDropdownController({
    segmentsDiv,
    player,
    getSegments,
    beginHistoryMutation,
    scheduleDirtyCheck,
    forceVisibleIfFilteredOut,
    scheduleApplyFilters,
    updateRowBySegId,
    pushHistory,
    safePreview,
}) {
    let speakerDropdownEl = null;
    let speakerDropdownTargetInput = null;
    let speakerDropdownTargetSeg = null;

    let speakerDropdownIndex = -1;
    let speakerDropdownOptions = [];
    let speakerDropdownSpeakers = [];

    let scrollFreezePrevOverflow = null;
    let scrollFreezePrevScrollTop = 0;

    function setSpeakerDropdownIndex(newIdx) {
        if (!speakerDropdownEl || !speakerDropdownOptions.length) return;
        const max = speakerDropdownOptions.length - 1;
        if (newIdx < 0) newIdx = 0;
        if (newIdx > max) newIdx = max;

        speakerDropdownIndex = newIdx;
        for (let i = 0; i < speakerDropdownOptions.length; i++) {
            speakerDropdownOptions[i].classList.toggle('active', i === speakerDropdownIndex);
        }
        const el = speakerDropdownOptions[speakerDropdownIndex];
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function freezeSegmentsScroll() {
        if (scrollFreezePrevOverflow !== null) return;
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
        for (const s of getSegments()) {
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

    function applySpeakerChoice(sp) {
        beginHistoryMutation();

        if (!speakerDropdownTargetInput || !speakerDropdownTargetSeg) return;

        const input = speakerDropdownTargetInput;
        const seg = speakerDropdownTargetSeg;
        const before = (input.dataset.before ?? (seg.speaker || ''));
        const after = sp;

        input.value = after;
        seg.speaker = after;
        input.dataset.before = after;
        scheduleDirtyCheck();
        try { forceVisibleIfFilteredOut([seg.id], 'Edited speaker moved segment outside the current filter.'); } catch { }
        try { if (typeof scheduleApplyFilters === 'function') scheduleApplyFilters(); } catch { }

        if (before !== after) {
            const id = seg.id;
            const apply = (val) => {
                const segments = getSegments();
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

    function openSpeakerDropdown(ev, inputEl, seg) {
        player.pause();
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

        const margin = 8;
        let left = (typeof ev.clientX === 'number') ? ev.clientX : 0;
        let top = (typeof ev.clientY === 'number') ? (ev.clientY + 8) : 0;

        const rect = dd.getBoundingClientRect();
        if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
        if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);

        dd.style.left = left + 'px';
        dd.style.top = top + 'px';

        if (speakerDropdownOptions.length) {
            const cur = (inputEl.value || '').trim();
            let idx = 0;
            if (cur) {
                const found = speakerDropdownSpeakers.findIndex(s => s === cur);
                if (found >= 0) idx = found;
            }
            setSpeakerDropdownIndex(idx);
        }

        dd.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }

    function onDocumentMouseDown(e) {
        if (!speakerDropdownEl) return;
        const t = e.target;
        if (speakerDropdownEl.contains(t)) return;
        if (speakerDropdownTargetInput && speakerDropdownTargetInput === t) return;
        closeSpeakerDropdown();
    }
    document.addEventListener('mousedown', onDocumentMouseDown, true);

    return {
        setSpeakerDropdownIndex,
        applySpeakerSelected,
        closeSpeakerDropdown,
        openSpeakerDropdown,
        getSpeakerDropdownEl: () => speakerDropdownEl,
        getSpeakerDropdownIndex: () => speakerDropdownIndex,
    };
}
