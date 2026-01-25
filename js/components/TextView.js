
import { secondsToTimecodeWhole } from '../utils.js';

export class TextView {
    constructor({ containerId, onSeek, getSegments }) {
        this.container = document.getElementById(containerId);
        this.onSeek = onSeek;
        this.getSegments = getSegments; // Function to get current segments list
        this.spanById = new Map();
        this.activeSegId = null;
        this.curSpeaker = null;
    }

    render(segs, doneSegIds) {
        if (!this.container) return;

        this.spanById.clear();
        this.activeSegId = null;
        this.container.innerHTML = '';

        if (!segs || !segs.length) return;

        this.curSpeaker = null;
        const frag = document.createDocumentFragment();

        // Quick map for gap detection
        const idxById = new Map();
        const fullList = this.getSegments();
        for (let k = 0; k < fullList.length; k++) idxById.set(fullList[k].id, k);

        let prevOrigIdx = null;

        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const spk = seg.speaker || 'SPEAKER';
            const origIdx = idxById.get(seg.id);
            const hasGap = (prevOrigIdx !== null && origIdx !== (prevOrigIdx + 1));

            if (spk !== this.curSpeaker || hasGap) {
                this.curSpeaker = spk;
                const block = this.createBlock(seg.start, spk);
                // We append the block's text container to accessible later? 
                // Actually, createBlock returns the block, but we need the text container inside it to append spans.
                // Let's adjust createBlock to return {block, textEl}
            }

            // Wait, the loop above needs to persist the current textEl to append subsequent segments.
            // Let's refactor similar to original app.js logic but cleaner.
        }

        // Re-implementation of render loop
        let block = null;
        let textEl = null;
        this.curSpeaker = null;
        prevOrigIdx = null;

        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const spk = seg.speaker || 'SPEAKER';
            const origIdx = idxById.get(seg.id);
            const hasGap = (prevOrigIdx !== null && origIdx !== (prevOrigIdx + 1));

            if (spk !== this.curSpeaker || hasGap) {
                this.curSpeaker = spk;
                const b = this.createBlock(seg.start, spk);
                block = b.block;
                textEl = b.textEl;
                frag.appendChild(block);
            }

            const span = document.createElement('span');
            span.className = 'tv-seg';
            span.dataset.segid = seg.id;
            span.textContent = (seg.text || '').trim();

            if (doneSegIds && doneSegIds.has(seg.id)) span.classList.add('done');

            span.onclick = (e) => {
                e.stopPropagation();
                if (this.onSeek) this.onSeek(seg.start, seg.id);
            };

            this.spanById.set(seg.id, span);
            textEl.appendChild(span);

            // Add space if adjacent
            if (i < segs.length - 1) {
                const next = segs[i + 1];
                const nextSpk = next.speaker || 'SPEAKER';
                const nextOrigIdx = idxById.get(next.id);
                if (nextSpk === this.curSpeaker && nextOrigIdx === (origIdx + 1)) {
                    textEl.appendChild(document.createTextNode(' '));
                }
            }
            prevOrigIdx = origIdx;
        }

        this.container.appendChild(frag);
    }

    createBlock(start, speaker) {
        const block = document.createElement('div');
        block.className = 'tv-block';

        const meta = document.createElement('div');
        meta.className = 'tv-meta';

        const metaRow = document.createElement('div');
        metaRow.className = 'tv-meta-row';

        const tEl = document.createElement('span');
        tEl.className = 'tv-time';
        tEl.textContent = secondsToTimecodeWhole(start || 0);

        const spkEl = document.createElement('span');
        spkEl.className = 'tv-speaker';
        spkEl.textContent = speaker;

        metaRow.appendChild(tEl);
        metaRow.appendChild(spkEl);
        meta.appendChild(metaRow);

        const textEl = document.createElement('div');
        textEl.className = 'tv-text';

        block.appendChild(meta);
        block.appendChild(textEl);

        return { block, textEl };
    }

    setActive(segId, scrollBehavior = 'smooth', forceScroll = false) {
        if (!this.container) return;

        // Clear old active
        if (this.activeSegId && this.activeSegId !== segId) {
            const old = this.spanById.get(this.activeSegId);
            if (old) old.classList.remove('active');
        }

        this.activeSegId = segId;
        if (!segId) return;

        const el = this.spanById.get(segId);
        if (!el) return;

        el.classList.add('active');

        if (scrollBehavior !== null) {
            const c = this.container.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            const pad = 20;
            const inView = (r.top >= c.top + pad) && (r.bottom <= c.bottom - pad);
            if (forceScroll || !inView) {
                el.scrollIntoView({ block: 'center', behavior: scrollBehavior || 'auto' });
            }
        }
    }

    updateLoopBadges(startId, endId, mode) {
        // Clear old badges handled via CSS attribute selectors
        // We need to iterate all relevant spans or keep track of them?
        // Simpler: querySelectorAll inside container
        if (!this.container) return;
        const old = this.container.querySelectorAll('.tv-seg[data-loopmark], .tv-seg[data-repeatmark]');
        old.forEach(el => {
            el.removeAttribute('data-loopmark');
            el.removeAttribute('data-repeatmark');
        });

        if (!mode || mode === 'off') return;

        const mark = (id, char) => {
            const el = this.spanById.get(id);
            if (el) {
                let val = el.getAttribute('data-loopmark') || '';
                if (val && !val.includes(char)) val += char;
                else if (!val) val = char;
                el.setAttribute('data-loopmark', val);
            }
        };

        if (startId) mark(startId, 'A');
        if (mode === 'active' && endId) mark(endId, 'B');
    }

    updateRepeatBadge(segId) {
        if (!this.container) return;
        // Clear all repeat marks
        const old = this.container.querySelectorAll('.tv-seg[data-repeatmark]');
        old.forEach(el => el.removeAttribute('data-repeatmark'));

        if (!segId) return;
        const el = this.spanById.get(segId);
        if (el) el.setAttribute('data-repeatmark', 'R');
    }
}
