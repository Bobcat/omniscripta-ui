/**
 * editorFind.js — Find / Replace functions extracted from editor.js
 *
 * Functions receive a `ctx` object for shared editor state.
 * DOM elements are looked up via ctx or getElementById.
 */
import { safePreview } from "../../utils.js";

// ========================
// Pure utilities (no ctx)
// ========================

export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getFieldValue(seg, field) {
    if (field === 'speaker') return (seg.speaker || '');
    return (seg.text || '');
}

export function setFieldValue(seg, field, value) {
    if (field === 'speaker') seg.speaker = value;
    else seg.text = value;
}

export function applyReplacementString(matchObj, replaceStr, allowDollarExpansion) {
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

// ========================
// Functions using ctx
// ========================

/**
 * ctx properties needed by find/replace:
 *   segments, currentSegmentIndex, filterState, forcedVisibleIds,
 *   pendingTextEdits, segmentsDiv,
 *   findModal, findInput, replaceInput, findStatus,
 *   optRegex, optCase, optWords, optWrap,
 *   replaceAllModal, raSummary,
 *   currentFind (r/w), lastFindQuery (r/w), lastFindIndex (r/w),
 *   pendingReplaceAll (r/w),
 *   setActiveSegment(), pushHistory(), beginHistoryMutation(),
 *   flushPendingText(), updateRowBySegId(), scheduleDirtyCheck(),
 *   forceVisibleIfFilteredOut(), scheduleApplyFilters(),
 *   filterIsActive(), matchesFilter(),
 *   recomputeChangedSegIds(), pruneForcedVisibleIds(),
 *   resetFindDrag(), onFindDragUp(), player
 */

export function setFindStatus(ctx, msg, isError = false) {
    if (!ctx.findStatus) return;
    ctx.findStatus.textContent = msg || '';
    ctx.findStatus.classList.toggle('error', !!isError);
}

function getScope() {
    const r = document.querySelector('input[name="findScope"]:checked');
    return r ? r.value : 'text';
}

function getFindSig(ctx) {
    return JSON.stringify({
        f: ctx.findInput?.value ?? '',
        r: ctx.replaceInput?.value ?? '',
        re: !!ctx.optRegex?.checked,
        cs: !!ctx.optCase?.checked,
        ww: !!ctx.optWords?.checked,
        wr: !!ctx.optWrap?.checked,
        sc: getScope()
    });
}

export function compileFindRegex(ctx) {
    const raw = (ctx.findInput?.value ?? '').trim();
    if (!raw) return { ok: false, err: 'Enter text to find.' };

    let pat = raw;
    const useRegex = !!ctx.optRegex?.checked;

    if (!useRegex) pat = escapeRegExp(pat);
    if (!!ctx.optWords?.checked) pat = `\\b(?:${pat})\\b`;

    const flags = `g${(ctx.optCase?.checked ? '' : 'i')}u`;

    try {
        const re = new RegExp(pat, flags);
        return { ok: true, re, pat, useRegex };
    } catch (e) {
        return { ok: false, err: `Invalid regex: ${e.message}` };
    }
}

export function getVisibleSegmentIndices(ctx) {
    if (!ctx.segments || !ctx.segments.length) return [];
    if (typeof ctx.filterIsActive !== 'function' || !ctx.filterIsActive()) {
        const out = new Array(ctx.segments.length);
        for (let i = 0; i < ctx.segments.length; i++) out[i] = i;
        return out;
    }
    const usesChanged = (ctx.filterState && (ctx.filterState.changedMode !== 'all')) || (ctx.forcedVisibleIds && ctx.forcedVisibleIds.size);
    if (usesChanged) ctx.recomputeChangedSegIds();
    ctx.pruneForcedVisibleIds();

    const out = [];
    for (let i = 0; i < ctx.segments.length; i++) {
        const seg = ctx.segments[i];
        if (!seg) continue;
        if (ctx.matchesFilter(seg) || ctx.forcedVisibleIds.has(seg.id)) out.push(i);
    }
    return out;
}

function focusAndSelectMatch(ctx, segIndex, field, start, end) {
    if (segIndex < 0 || segIndex >= ctx.segments.length) return;

    ctx.setActiveSegment(segIndex, 'auto', 'nearest');

    const row = ctx.segmentsDiv.querySelector(`.segment[data-index="${segIndex}"]`);
    if (!row) return;

    const el = (field === 'speaker') ? row.querySelector('.speaker-input') : row.querySelector('.text-input');
    if (!el) return;

    el.focus({ preventScroll: true });
    try { el.setSelectionRange(start, end); } catch { }
}

export function countAllMatches(ctx, reObj, scope) {
    let count = 0;
    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);

    const visIdxs = getVisibleSegmentIndices(ctx);

    for (const si of visIdxs) {
        const seg = ctx.segments[si];
        if (!seg) continue;
        for (const f of fields) {
            const s = getFieldValue(seg, f);
            if (!s) continue;
            reObj.lastIndex = 0;
            let m;
            while ((m = reObj.exec(s)) !== null) {
                if (m[0].length === 0) { reObj.lastIndex += 1; continue; }
                count++;
            }
        }
    }
    reObj.lastIndex = 0;
    return count;
}

export function findNext(ctx, fromReplace = false) {
    ctx.flushPendingText();

    const compiled = compileFindRegex(ctx);
    if (!compiled.ok) { setFindStatus(ctx, compiled.err, true); ctx.currentFind = null; return false; }
    const { re } = compiled;
    const scope = getScope();
    const wrap = !!ctx.optWrap?.checked;

    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);
    const sig = getFindSig(ctx);

    const visIdxs = getVisibleSegmentIndices(ctx);
    if (!visIdxs.length) {
        ctx.currentFind = null;
        setFindStatus(ctx, 'No visible segments.');
        return false;
    }

    const posByIndex = new Map();
    for (let p = 0; p < visIdxs.length; p++) posByIndex.set(visIdxs[p], p);

    let startSeg = (ctx.currentSegmentIndex >= 0) ? ctx.currentSegmentIndex : 0;
    let startPos = 0;
    let startFieldIdx = 0;

    if (ctx.currentFind && ctx.currentFind.sig === sig) {
        startSeg = ctx.currentFind.segIndex;
        startFieldIdx = fields.indexOf(ctx.currentFind.field);
        if (startFieldIdx < 0) startFieldIdx = 0;
        startPos = ctx.currentFind.end;
    } else {
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

    const total = countAllMatches(ctx, re, scope);

    let startPosInVis = posByIndex.get(startSeg);
    if (startPosInVis === undefined) {
        startPosInVis = visIdxs.findIndex((si) => si >= startSeg);
        if (startPosInVis === -1) startPosInVis = visIdxs.length;
        startPos = 0;
        startFieldIdx = 0;
    }

    const scan = (posFrom) => {
        for (let p = posFrom; p < visIdxs.length; p++) {
            const si = visIdxs[p];
            const seg = ctx.segments[si];
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

                    ctx.currentFind = { sig, segId: seg.id, field, start, end, match: m, segIndex: si };
                    focusAndSelectMatch(ctx, si, field, start, end);

                    setFindStatus(ctx, total ? `Match found (${total} total)` : 'Match found');
                    return true;
                }
            }
        }
        return false;
    };

    if (scan(startPosInVis)) return true;
    if (wrap) {
        startSeg = visIdxs[0];
        startPos = 0;
        startFieldIdx = 0;
        ctx.currentFind = null;
        if (scan(0)) return true;
    }

    ctx.currentFind = null;
    setFindStatus(ctx, 'No matches.');
    return false;
}

export function replaceCurrent(ctx) {
    ctx.beginHistoryMutation();
    ctx.flushPendingText();

    const compiled = compileFindRegex(ctx);
    if (!compiled.ok) { setFindStatus(ctx, compiled.err, true); return; }
    const scope = getScope();
    const sig = getFindSig(ctx);

    if (!ctx.currentFind || ctx.currentFind.sig !== sig) {
        if (!findNext(ctx, true)) return;
    }

    const seg = ctx.segments.find(s => s.id === ctx.currentFind.segId);
    const si = ctx.currentFind.segIndex;
    if (!seg) { ctx.currentFind = null; return; }

    const field = ctx.currentFind.field;
    const before = getFieldValue(seg, field);
    const start = ctx.currentFind.start;
    const end = ctx.currentFind.end;

    const replRaw = (ctx.replaceInput?.value ?? '');
    const allowExpansion = !!ctx.optRegex?.checked;
    const replacement = applyReplacementString(ctx.currentFind.match, replRaw, allowExpansion);

    const after = before.slice(0, start) + replacement + before.slice(end);

    if (after === before) {
        setFindStatus(ctx, 'No change.');
        findNext(ctx, true);
        return;
    }

    const id = seg.id;

    const apply = (val) => {
        const s = ctx.segments.find(x => x.id === id);
        if (!s) return;
        setFieldValue(s, field, val);
        if (field === 'text') {
            const p = ctx.pendingTextEdits.get(id);
            if (p && p.timer) clearTimeout(p.timer);
            ctx.pendingTextEdits.delete(id);
        }
        ctx.updateRowBySegId(id);
        ctx.scheduleDirtyCheck();
        ctx.forceVisibleIfFilteredOut([id], 'Edit moved segment outside the current filter.');
        ctx.scheduleApplyFilters();
    };

    apply(after);
    ctx.scheduleDirtyCheck();

    ctx.pushHistory({
        label: 'Replace',
        summary: `${safePreview((ctx.findInput?.value ?? ''), 18)}→${safePreview(replRaw, 18)} (seg=${id})`,
        meta: { segId: id, field, find: (ctx.findInput?.value ?? ''), replace: replRaw, regex: !!ctx.optRegex?.checked, caseSensitive: !!ctx.optCase?.checked, wholeWords: !!ctx.optWords?.checked },
        do: () => apply(after),
        undo: () => apply(before)
    });

    ctx.currentFind = null;
    setFindStatus(ctx, 'Replaced.');
    findNext(ctx, true);
}

export function openReplaceAllConfirm(ctx) {
    ctx.flushPendingText();

    const compiled = compileFindRegex(ctx);
    if (!compiled.ok) { setFindStatus(ctx, compiled.err, true); return; }

    const scope = getScope();
    const total = countAllMatches(ctx, compiled.re, scope);

    if (total === 0) { setFindStatus(ctx, 'No matches.'); return; }

    const findText = (ctx.findInput?.value ?? '').trim();
    const replaceText = (ctx.replaceInput?.value ?? '');

    ctx.pendingReplaceAll = { compiled, scope, total, findText, replaceText };

    if (ctx.raSummary) {
        const scopeLabel = (scope === 'text') ? 'Text' : (scope === 'speaker' ? 'Speakers' : 'Text + speakers');
        ctx.raSummary.textContent = `Replace ${total} matches in ${scopeLabel}: "${findText}" → "${replaceText}"`;
    }

    if (ctx.replaceAllModal) ctx.replaceAllModal.classList.remove('hidden');
}

export function closeReplaceAllConfirm(ctx) {
    ctx.pendingReplaceAll = null;
    if (ctx.replaceAllModal) ctx.replaceAllModal.classList.add('hidden');
}

export function doReplaceAllConfirmed(ctx) {
    ctx.beginHistoryMutation();
    ctx.flushPendingText();
    if (!ctx.pendingReplaceAll) { closeReplaceAllConfirm(ctx); return; }

    const { compiled, scope, total, replaceText } = ctx.pendingReplaceAll;
    const re = compiled.re;
    const useRegex = !!ctx.optRegex?.checked;

    const fields = (scope === 'both') ? ['text', 'speaker'] : (scope === 'speaker' ? ['speaker'] : ['text']);

    const changes = [];

    const visIdxs = getVisibleSegmentIndices(ctx);

    for (const si of visIdxs) {
        const seg = ctx.segments[si];
        for (const field of fields) {
            const before = getFieldValue(seg, field);
            if (!before) continue;

            re.lastIndex = 0;
            const after = before.replace(re, useRegex ? replaceText : () => replaceText);

            if (after !== before) {
                changes.push({ segId: seg.id, field, before, after });
                setFieldValue(seg, field, after);

                if (field === 'text') {
                    const p = ctx.pendingTextEdits.get(seg.id);
                    if (p && p.timer) clearTimeout(p.timer);
                    ctx.pendingTextEdits.delete(seg.id);
                }
            }
        }
    }
    re.lastIndex = 0;

    for (const c of changes) ctx.updateRowBySegId(c.segId);
    ctx.scheduleDirtyCheck();

    const ids = Array.from(new Set(changes.map(c => c.segId)));
    ctx.forceVisibleIfFilteredOut(ids, 'Replace all created changes outside the current filter.');
    ctx.scheduleApplyFilters();

    const applyAll = (toAfter) => {
        for (const c of changes) {
            const seg = ctx.segments.find(s => s.id === c.segId);
            if (!seg) continue;
            setFieldValue(seg, c.field, toAfter ? c.after : c.before);

            if (c.field === 'text') {
                const p = ctx.pendingTextEdits.get(c.segId);
                if (p && p.timer) clearTimeout(p.timer);
                ctx.pendingTextEdits.delete(c.segId);
            }

            ctx.updateRowBySegId(c.segId);
        }
        ctx.scheduleDirtyCheck();
        ctx.forceVisibleIfFilteredOut(ids, 'Replace all created changes outside the current filter.');
        ctx.scheduleApplyFilters();
    };

    ctx.pushHistory({
        label: 'Replace all',
        summary: `${changes.length} segments (${total} matches)`,
        meta: { firstSegId: (changes[0] ? changes[0].segId : null), find: ctx.pendingReplaceAll.findText, replace: ctx.pendingReplaceAll.replaceText, scope, matches: total, segmentsChanged: changes.length, regex: !!ctx.optRegex?.checked, caseSensitive: !!ctx.optCase?.checked, wholeWords: !!ctx.optWords?.checked },
        do: () => applyAll(true),
        undo: () => applyAll(false)
    });

    closeReplaceAllConfirm(ctx);
    ctx.currentFind = null;
    setFindStatus(ctx, `Replaced ${total} matches.`);
}

export function getTranscriptSelectionText(ctx) {
    try {
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
        if (ctx.segmentsDiv && a && f && ctx.segmentsDiv.contains(a) && ctx.segmentsDiv.contains(f)) return txt;
        return '';
    } catch { return ''; }
}

export function openFindModal(ctx) {
    const selText = getTranscriptSelectionText(ctx);
    ctx.flushPendingText();
    if (ctx.player) ctx.player.pause();
    ctx.resetFindDrag();

    if (ctx.findInput) ctx.findInput.value = selText || '';
    if (ctx.replaceInput) ctx.replaceInput.value = '';
    if (ctx.findStatus) ctx.findStatus.textContent = '';
    ctx.lastFindQuery = null;
    ctx.lastFindIndex = -1;
    ctx.currentFind = null;
    setFindStatus(ctx, '');
    if (ctx.findModal) {
        ctx.findModal.classList.remove('hidden');
    }
    setTimeout(() => ctx.findInput?.focus(), 0);
}

export function closeFindModal(ctx) {
    ctx.onFindDragUp();

    ctx.currentFind = null;
    setFindStatus(ctx, '');
    if (ctx.findModal) ctx.findModal.classList.add('hidden');
    if (ctx.replaceAllModal) ctx.replaceAllModal.classList.add('hidden');
}
