/**
 * editorSegments.js — Segment split/join/row-management operations extracted from editor.js
 *
 * Functions receive a `ctx` object for shared editor state.
 * Pure utility functions take explicit parameters.
 */
import { secondsToTimecodeWhole } from "./utils.js";
import { secondsToSrtTimecode } from "./editorSave.js";

// ========================
// Pure utilities (no ctx)
// ========================

export function joinTextsForJoin(aText, bText) {
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

// ========================
// Row management (ctx)
// ========================

/**
 * ctx properties needed by segment operations:
 *   segments, currentSegmentIndex, globalSeq (r/w), editingTextSegId (r/w),
 *   autoAssignSplitTs,
 *   rowById, segmentsDiv, player, undoStack, redoStack,
 *   setActiveSegment(), pushHistory(), beginHistoryMutation(),
 *   flushPendingText(), updateRowBySegId(), scheduleDirtyCheck(),
 *   forceVisibleIfFilteredOut(), scheduleApplyFilters(),
 *   filterIsActive(), matchesFilter(),
 *   recomputeChangedSegIds(),
 *   getRowBySegId() — self-referencing for internal calls,
 *   createSegmentRow(), enforceTiming(),
 *   findIndexById(), getActiveSegId(),
 *   allocUniqueStartWithinSecond(), timecodeToSeconds(),
 *   queueTextareaSizing()
 */

export function getRowBySegId(ctx, segId) {
    return ctx.rowById.get(segId) || ctx.segmentsDiv.querySelector(`.segment[data-id="${segId}"]`);
}

export function reindexAllRows(ctx) {
    for (let i = 0; i < ctx.segments.length; i++) {
        const id = ctx.segments[i].id;
        const row = getRowBySegId(ctx, id);
        if (row) {
            row.dataset.index = String(i);
            if (!ctx.rowById.has(id)) ctx.rowById.set(id, row);
        }
    }
}

export function insertRowAtIndex(ctx, row, index) {
    if (!row) return;
    if (index <= 0) {
        ctx.segmentsDiv.insertBefore(row, ctx.segmentsDiv.firstChild);
        return;
    }
    const prevId = ctx.segments[index - 1]?.id;
    const prevRow = prevId ? getRowBySegId(ctx, prevId) : null;
    if (prevRow) {
        ctx.segmentsDiv.insertBefore(row, prevRow.nextSibling);
    } else {
        ctx.segmentsDiv.appendChild(row);
    }
}

export function removeRowBySegId(ctx, segId) {
    const row = getRowBySegId(ctx, segId);
    if (row && row.parentNode) row.remove();
    ctx.rowById.delete(segId);
}

export function moveRowBySegIdToIndex(ctx, segId, index) {
    const row = getRowBySegId(ctx, segId);
    if (!row) return;
    const childAt = ctx.segmentsDiv.children[index];
    if (childAt === row) return;
    insertRowAtIndex(ctx, row, index);
}

export function applySegStartNoHistory(ctx, segId, newStart, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const focus = (opts.focus !== false);
    const scrollBehavior = (opts.scrollBehavior === undefined) ? 'auto' : opts.scrollBehavior;
    const block = opts.block || 'nearest';

    const prevScroll = preserveScroll ? ctx.segmentsDiv.scrollTop : null;

    const oldIndex = ctx.findIndexById(segId);
    const seg = ctx.segments.find(s => s.id === segId);
    if (!seg) return -1;

    seg.start = newStart;

    ctx.segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    ctx.enforceTiming({ sort: false });

    const newIndex = ctx.findIndexById(segId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        moveRowBySegIdToIndex(ctx, segId, newIndex);
    }

    reindexAllRows(ctx);
    ctx.updateRowBySegId(segId);

    if (preserveScroll && prevScroll !== null) ctx.segmentsDiv.scrollTop = prevScroll;

    if (focus && newIndex !== -1) {
        ctx.setActiveSegment(newIndex, scrollBehavior, block);
    }

    // filtering: keep edits visible even if they fall outside the active filter
    try { ctx.scheduleDirtyCheck(); } catch { }
    try { ctx.forceVisibleIfFilteredOut([segId], 'Edited timestamp moved segment outside the current filter.'); } catch { }
    try { ctx.scheduleApplyFilters(); } catch { }

    return newIndex;
}

// ========================
// Join operations (ctx)
// ========================

export function canJoinAtIndex(ctx, idx) {
    if (idx <= 0 || idx >= ctx.segments.length) return false;
    if (!ctx.filterIsActive()) return true;
    const prev = ctx.segments[idx - 1];
    if (!prev) return false;
    const prow = getRowBySegId(ctx, prev.id);
    return !!(prow && !prow.classList.contains('filtered-out'));
}

export function applyJoinNoHistory(ctx, prevId, currId, prevTextAfter, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const activatePrev = (opts.activatePrev !== false);
    const focusTextarea = !!opts.focusTextarea;
    const cursorPos = (typeof opts.cursorPos === 'number') ? opts.cursorPos : null;
    const prevScroll = preserveScroll ? ctx.segmentsDiv.scrollTop : null;

    const prevIdx = ctx.findIndexById(prevId);
    const currIdx = ctx.findIndexById(currId);
    if (prevIdx === -1 || currIdx === -1) return;
    if (currIdx !== prevIdx + 1) return;

    const prevSeg = ctx.segments[prevIdx];
    if (!prevSeg) return;

    prevSeg.text = prevTextAfter ?? '';

    // Timing: preserve the joined range by extending prevSeg.end to currSeg.end.
    const currSeg = ctx.segments[currIdx];
    if (currSeg && typeof currSeg.end === 'number' && Number.isFinite(currSeg.end)) {
        prevSeg.end = currSeg.end;
    }

    ctx.segments.splice(currIdx, 1);

    ctx.enforceTiming({ sort: false });

    // DOM updates
    removeRowBySegId(ctx, currId);
    ctx.updateRowBySegId(prevId);
    reindexAllRows(ctx);
    // Refresh Join button state for neighbors (indices may have changed)
    try { ctx.updateRowBySegId(prevId); } catch { }
    const _nextAfterJoin = ctx.segments[prevIdx + 1];
    if (_nextAfterJoin) { try { ctx.updateRowBySegId(_nextAfterJoin.id); } catch { } }
    ctx.scheduleDirtyCheck();

    // Keep join result visible even if it no longer matches the active filter
    try { ctx.recomputeChangedSegIds(); } catch { }
    try { ctx.forceVisibleIfFilteredOut([prevId], 'Join moved segment outside the current filter.'); } catch { }
    try { ctx.scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) ctx.segmentsDiv.scrollTop = prevScroll;

    if (activatePrev) {
        ctx.setActiveSegment(prevIdx, 'auto', 'center');
        ctx.player.pause();

        if (focusTextarea) {
            setTimeout(() => {
                const rowEl = getRowBySegId(ctx, prevId);
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

export function undoJoinNoHistory(ctx, prevId, prevTextBefore, prevEndBefore, currSnapshot, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const activateCurr = (opts.activateCurr !== false);
    const focusTextarea = !!opts.focusTextarea;
    const prevScroll = preserveScroll ? ctx.segmentsDiv.scrollTop : null;

    const prevIdx = ctx.findIndexById(prevId);
    if (prevIdx === -1) return;

    const prevSeg = ctx.segments[prevIdx];
    if (!prevSeg) return;

    prevSeg.text = prevTextBefore ?? '';
    if (typeof prevEndBefore === 'number' && Number.isFinite(prevEndBefore)) prevSeg.end = prevEndBefore;

    const snap = Object.assign({}, currSnapshot);
    ctx.segments.splice(prevIdx + 1, 0, snap);

    ctx.enforceTiming({ sort: false });

    // DOM updates
    ctx.updateRowBySegId(prevId);

    const currIdx = prevIdx + 1;
    let row2 = getRowBySegId(ctx, snap.id);
    if (!row2) row2 = ctx.createSegmentRow(ctx.segments[currIdx], currIdx);
    insertRowAtIndex(ctx, row2, currIdx);
    ctx.rowById.set(snap.id, row2);

    try {
        const ta2 = row2.querySelector('.text-input');
        if (ta2) ctx.queueTextareaSizing(ta2);
    } catch { }

    reindexAllRows(ctx);
    // Refresh Join button state for neighbors after restoring a row
    try { ctx.updateRowBySegId(prevId); } catch { }
    try { ctx.updateRowBySegId(snap.id); } catch { }
    const _nextAfterUndoJoin = ctx.segments[currIdx + 1];
    if (_nextAfterUndoJoin) { try { ctx.updateRowBySegId(_nextAfterUndoJoin.id); } catch { } }
    ctx.scheduleDirtyCheck();

    try { ctx.recomputeChangedSegIds(); } catch { }
    try { ctx.forceVisibleIfFilteredOut([prevId, snap.id], 'Undo restored a segment outside the current filter.'); } catch { }
    try { ctx.scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) ctx.segmentsDiv.scrollTop = prevScroll;

    if (activateCurr) {
        ctx.setActiveSegment(currIdx, 'auto', 'center');
        ctx.player.pause();

        if (focusTextarea) {
            setTimeout(() => {
                const rowEl = getRowBySegId(ctx, snap.id);
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

export function joinWithPrevious(ctx, idx) {
    const hadTextFocus = (() => {
        try {
            const ae = document.activeElement;
            return !!(ae && ae.classList && ae.classList.contains('text-input'));
        } catch { return false; }
    })();

    ctx.beginHistoryMutation();

    if (idx <= 0 || idx >= ctx.segments.length) return;

    // In filter mode: only allow when the true previous segment is visible in the UI.
    if (ctx.filterIsActive()) {
        const prev = ctx.segments[idx - 1];
        const prow = prev ? getRowBySegId(ctx, prev.id) : null;
        if (!prow || prow.classList.contains('filtered-out')) return;
    }

    const prevSeg = ctx.segments[idx - 1];
    const currSeg = ctx.segments[idx];
    if (!prevSeg || !currSeg) return;

    const prevId = prevSeg.id;
    const currId = currSeg.id;

    // Commit pending debounced edits on both rows before joining
    try { ctx.flushPendingText(prevId); } catch { }
    try { ctx.flushPendingText(currId); } catch { }

    const prevTextBefore = prevSeg.text || '';
    const prevEndBefore = prevSeg.end;
    const currSnapshot = Object.assign({}, currSeg);

    const res = joinTextsForJoin(prevTextBefore, currSnapshot.text || '');
    const prevTextAfter = res.text;
    const cursorPos = res.cursorPos;

    const beforeTime = ctx.player.currentTime;

    ctx.pushHistory({
        label: 'Join',
        summary: `${secondsToTimecodeWhole(currSeg.start)} (seg=${currId})`,
        meta: { segId: prevId, ids: [prevId, currId], prevId, currId },
        do: () => {
            applyJoinNoHistory(ctx, prevId, currId, prevTextAfter, { preserveScroll: true, activatePrev: true, focusTextarea: true, cursorPos });
            if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) ctx.player.currentTime = beforeTime;
        },
        undo: () => {
            undoJoinNoHistory(ctx, prevId, prevTextBefore, prevEndBefore, currSnapshot, { preserveScroll: true, activateCurr: true, focusTextarea: false });
            if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) ctx.player.currentTime = beforeTime;
        }
    });

    // Apply immediately (pushHistory does not auto-run action.do()).
    applyJoinNoHistory(ctx, prevId, currId, prevTextAfter, { preserveScroll: true, activatePrev: true, focusTextarea: true, cursorPos });
    if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) ctx.player.currentTime = beforeTime;
}

// ========================
// Split operations (ctx)
// ========================

export function askForSplitTimeWhole(ctx, seg, opts = {}) {
    const forceAuto = !!opts.forceAuto;

    const t = (typeof ctx.player.currentTime === 'number' && !Number.isNaN(ctx.player.currentTime))
        ? ctx.player.currentTime
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
        let candidate = ctx.allocUniqueStartWithinSecond(baseSec, null, curMs + 1);

        // As a safety net, ensure we stay inside the segment boundaries.
        if (!(candidate > seg.start && candidate < seg.end)) {
            // Try a couple more steps forward.
            candidate = ctx.allocUniqueStartWithinSecond(baseSec, null, curMs + 2);
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
        try { raw = trimmed.includes(':') ? ctx.timecodeToSeconds(trimmed) : parseFloat(trimmed); }
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

export function applySplitNoHistory(ctx, seg1Id, seg1TextAfter, seg2Snapshot, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const focusNew = !!opts.focusNew;

    const prevScroll = preserveScroll ? ctx.segmentsDiv.scrollTop : null;

    const seg1 = ctx.segments.find(s => s.id === seg1Id);
    if (!seg1) return;

    // Apply
    seg1.text = seg1TextAfter;

    // Ensure seg2 exists (use a fresh object so history snapshot can't be mutated later)
    let seg2 = ctx.segments.find(s => s.id === seg2Snapshot.id);
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
        ctx.segments.push(seg2);
    } else {
        // If it already exists (rare), sync it
        seg2.blockId = seg2Snapshot.blockId;
        seg2.speaker = seg2Snapshot.speaker;
        seg2.text = seg2Snapshot.text;
        seg2.start = seg2Snapshot.start;
        seg2.end = seg2Snapshot.end;
    }

    ctx.segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    ctx.enforceTiming({ sort: false });

    // DOM: update seg1 row (text), insert/move seg2 row
    ctx.updateRowBySegId(seg1Id);

    const seg2Index = ctx.findIndexById(seg2Snapshot.id);
    if (seg2Index !== -1) {
        let row2 = getRowBySegId(ctx, seg2Snapshot.id);
        if (!row2) {
            row2 = ctx.createSegmentRow(ctx.segments[seg2Index], seg2Index);
        }
        insertRowAtIndex(ctx, row2, seg2Index);
        ctx.rowById.set(seg2Snapshot.id, row2);

        // Size the new textarea soon (chunked)
        try {
            const ta = row2.querySelector('.text-input');
            if (ta) ctx.queueTextareaSizing(ta);
        } catch { }
    }

    reindexAllRows(ctx);
    ctx.scheduleDirtyCheck();

    // filtering: keep split results visible even if they fall outside the active filter
    try { ctx.forceVisibleIfFilteredOut([seg1Id, seg2Snapshot.id], 'Split created segments outside the current filter.'); } catch { }
    try { ctx.scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) ctx.segmentsDiv.scrollTop = prevScroll;

    if (focusNew && seg2Index !== -1) {
        ctx.setActiveSegment(seg2Index, 'auto', 'nearest');
        ctx.player.pause();
        ctx.player.currentTime = ctx.segments[seg2Index].start;

        const focusNewTa = () => {
            const rowEl = getRowBySegId(ctx, seg2Snapshot.id);
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

export function undoSplitNoHistory(ctx, seg1Id, seg1TextBefore, seg2Id, seg1EndBefore, opts = {}) {
    const preserveScroll = (opts.preserveScroll !== false);
    const prevScroll = preserveScroll ? ctx.segmentsDiv.scrollTop : null;

    // Remove seg2
    const idx2 = ctx.findIndexById(seg2Id);
    if (idx2 !== -1) ctx.segments.splice(idx2, 1);

    // Restore seg1 text
    const seg1 = ctx.segments.find(s => s.id === seg1Id);
    if (seg1) {
        seg1.text = seg1TextBefore;
        // Restore seg1 end (pre-split)
        if (typeof seg1EndBefore === 'number' && Number.isFinite(seg1EndBefore)) seg1.end = seg1EndBefore;
    }

    ctx.segments.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    ctx.enforceTiming({ sort: false });

    // DOM updates
    removeRowBySegId(ctx, seg2Id);
    ctx.updateRowBySegId(seg1Id);
    reindexAllRows(ctx);
    ctx.scheduleDirtyCheck();
    try { ctx.forceVisibleIfFilteredOut([seg1Id], 'Undo created a segment outside the current filter.'); } catch { }

    try { ctx.scheduleApplyFilters(); } catch { }

    if (preserveScroll && prevScroll !== null) ctx.segmentsDiv.scrollTop = prevScroll;
}

export function splitSegment(ctx, idx, textAreaEl) {
    ctx.beginHistoryMutation();

    if (idx < 0 || idx >= ctx.segments.length) return;
    const seg = ctx.segments[idx];
    const seg1Id = seg.id;

    // Commit any pending debounced edits on this row before splitting
    try { ctx.flushPendingText(seg1Id); } catch { }

    const hasFocus = (textAreaEl && document.activeElement === textAreaEl);

    const isCursorSplit = (hasFocus && textAreaEl && typeof textAreaEl.selectionStart === 'number');

    // Split behavior:
    // - If we are splitting at a text cursor (focused textarea), we move text after the cursor to a new segment.
    // - Timestamp choice:

    // - If Auto-assign is enabled: always allocate x+ms (no prompt).
    // - Otherwise: prompt for a whole-second timestamp within the current segment,
    //   except when no whole-second slot exists (then we auto-allocate x+ms).
    const splitT = (ctx.autoAssignSplitTs)
        ? askForSplitTimeWhole(ctx, seg, { forceAuto: true })
        : askForSplitTimeWhole(ctx, seg);
    if (splitT === null) return;

    const beforeActiveId = ctx.getActiveSegId();
    const beforeTime = ctx.player.currentTime;

    const beforeText = seg.text || '';
    let t1 = beforeText;
    let t2 = '';

    if (isCursorSplit) {
        const pos = textAreaEl.selectionStart;
        t1 = beforeText.slice(0, pos).trimEnd();
        t2 = beforeText.slice(pos).trimStart();
    }

    const newId = `seg_${ctx.globalSeq++}`;
    const seg2Snapshot = {
        id: newId,
        seq: ctx.globalSeq,
        blockId: seg.blockId,
        speaker: seg.speaker || '',
        text: t2,
        start: splitT,
        end: seg.end
    };

    // Apply split now (fast, incremental DOM)
    applySplitNoHistory(ctx, seg1Id, t1, seg2Snapshot, { preserveScroll: true, focusNew: true });

    const afterActiveId = ctx.getActiveSegId();
    const afterTime = ctx.player.currentTime;

    ctx.pushHistory({
        label: 'Split',
        summary: `${secondsToTimecodeWhole(splitT)} (seg=${seg1Id})`,
        meta: {
            segId: seg1Id,
            newSegId: seg2Snapshot.id,
            splitAt: secondsToTimecodeWhole(splitT),
            splitSec: Math.round(splitT),
        },
        do: () => {
            applySplitNoHistory(ctx, seg1Id, t1, seg2Snapshot, { preserveScroll: true, focusNew: false });
            if (typeof afterTime === 'number' && Number.isFinite(afterTime)) ctx.player.currentTime = afterTime;
        },
        undo: () => {
            undoSplitNoHistory(ctx, seg1Id, beforeText, seg2Snapshot.id, seg2Snapshot.end, { preserveScroll: true });
            if (typeof beforeTime === 'number' && Number.isFinite(beforeTime)) ctx.player.currentTime = beforeTime;
        }
    });
}
