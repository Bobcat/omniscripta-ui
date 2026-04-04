
import { secondsToTimecodeWhole } from '../utils.js';
import { buildSpeakerParagraphs } from '../text/paragraphs.js';

const COMPACT_META_BREAKPOINT_PX = 760;

export class TextView {
    constructor({ containerId, onSeek, getSegments }) {
        this.container = document.getElementById(containerId);
        this.onSeek = onSeek;
        this.getSegments = getSegments; // Function to get current segments list
        this.spanById = new Map();
        this.activeSegId = null;
        this.resizeObserver = null;

        if (this.container && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.updateLayoutMode());
            this.resizeObserver.observe(this.container);
            this.updateLayoutMode();
        }
    }

    render(segs, doneSegIds) {
        if (!this.container) return;

        this.updateLayoutMode();
        this.spanById.clear();
        this.activeSegId = null;
        this.container.innerHTML = '';

        if (!segs || !segs.length) return;

        const frag = document.createDocumentFragment();

        // Quick map for gap detection
        const idxById = new Map();
        const fullList = this.getSegments();
        for (let k = 0; k < fullList.length; k++) idxById.set(fullList[k].id, k);

        const rows = [];
        let prevOrigIdx = null;
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const spk = seg.speaker || 'SPEAKER';
            const origIdx = idxById.get(seg.id);
            const hasGap = (prevOrigIdx !== null && origIdx !== (prevOrigIdx + 1));
            rows.push({
                text: seg.text || '',
                speaker: spk,
                forceBreakBefore: hasGap,
                segment: seg,
            });
            prevOrigIdx = origIdx;
        }

        const { paragraphs } = buildSpeakerParagraphs(rows, {
            rules: {
                blockEverySegments: 3,
                blockMinChars: 120,
                blockMinWords: 20,
                allowLooseBreak: false,
            },
        });
        let prevParagraphSpeaker = null;
        let prevBlockEl = null;
        for (const paragraph of paragraphs) {
            const items = Array.isArray(paragraph.items) ? paragraph.items : [];
            const firstSeg = items[0] && items[0].segment ? items[0].segment : null;
            if (!firstSeg) continue;

            const currentSpeaker = String(paragraph.speaker || 'SPEAKER').trim() || 'SPEAKER';
            const showMeta = !(prevParagraphSpeaker && prevParagraphSpeaker === currentSpeaker);
            const b = this.createBlock(firstSeg.start, showMeta ? currentSpeaker : '', { showMeta });
            if (!showMeta && prevBlockEl) {
                // Keep speaker-to-speaker spacing as-is, but tighten paragraph-to-paragraph spacing.
                prevBlockEl.classList.add('tv-block-before-paragraph-continue');
            }
            const textEl = b.textEl;
            frag.appendChild(b.block);

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const seg = item && item.segment ? item.segment : null;
                if (!seg) continue;

                const span = document.createElement('span');
                span.className = 'tv-seg';
                span.dataset.segid = seg.id;
                span.textContent = String(item.text || '').trim();

                if (doneSegIds && doneSegIds.has(seg.id)) span.classList.add('done');

                span.onclick = (e) => {
                    e.stopPropagation();
                    if (this.onSeek) this.onSeek(seg.start, seg.id);
                };

                this.spanById.set(seg.id, span);
                textEl.appendChild(span);

                if (i < items.length - 1) {
                    textEl.appendChild(document.createTextNode(' '));
                }
            }

            prevParagraphSpeaker = currentSpeaker;
            prevBlockEl = b.block;
        }

        this.container.appendChild(frag);
    }

    updateLayoutMode() {
        if (!this.container) return;
        const width = this.container.clientWidth || 0;
        this.container.classList.toggle('tv-compact-meta', width > 0 && width < COMPACT_META_BREAKPOINT_PX);
    }

    createBlock(start, speaker, { showMeta = true } = {}) {
        const block = document.createElement('div');
        block.className = 'tv-block';
        if (!showMeta) block.classList.add('tv-block-paragraph-continue');

        const meta = document.createElement('div');
        meta.className = 'tv-meta';
        if (!showMeta) {
            meta.classList.add('tv-meta-empty');
            meta.setAttribute('aria-hidden', 'true');
        }

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
