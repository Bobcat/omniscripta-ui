
import { _srtTcToSeconds } from '../utils.js';

export class TopicsView {
    constructor({ containerId, onSeek }) {
        this.container = document.getElementById(containerId); // This might be a placeholder div
        this.onSeek = onSeek;
        this.topics = [];
    }

    // Old load() logic removed. Topics are now injected by server into SRT metadata and extracted by app.js.
    // This component is now purely for rendering.

    render() {
        if (!this.container) return;
        this.container.innerHTML = '';

        if (!this.topics || this.topics.length === 0) {
            this.container.classList.add('hidden');
            return;
        }
        this.container.classList.remove('hidden');

        const title = document.createElement('h3');
        title.className = 'topics-header';
        title.textContent = 'Topics';
        this.container.appendChild(title);

        const list = document.createElement('div');
        list.className = 'topics-list';

        for (const row of this.topics) {
            // row: { n, topic_title, topic_description, start_time, end_time }
            const item = document.createElement('div');
            item.className = 'topic-item';

            const time = document.createElement('div');
            time.className = 'topic-time';
            time.textContent = row.start_time;

            const content = document.createElement('div');
            content.className = 'topic-content';

            const tTitle = document.createElement('div');
            tTitle.className = 'topic-title';
            tTitle.textContent = row.topic_title;

            const tDesc = document.createElement('div');
            tDesc.className = 'topic-desc';
            tDesc.textContent = row.topic_description;

            content.appendChild(tTitle);
            content.appendChild(tDesc);

            item.appendChild(time);
            item.appendChild(content);

            item.onclick = () => {
                const sec = _srtTcToSeconds(row.start_time);
                if (this.onSeek) this.onSeek(sec);
            };

            // Store parsed seconds for fast lookup
            item.dataset.startSec = _srtTcToSeconds(row.start_time);
            item.dataset.endSec = _srtTcToSeconds(row.end_time);

            list.appendChild(item);
        }

        this.container.appendChild(list);
    }

    setActiveTime(time, forceScroll = false, behavior = 'smooth') {
        if (!this.container) return;
        const items = this.container.getElementsByClassName('topic-item');
        let activeFound = false;

        for (const item of items) {
            const start = parseFloat(item.dataset.startSec);
            const end = parseFloat(item.dataset.endSec);

            // Active if time is within range [start, end)
            if (time >= start && time < end) {
                const wasActive = item.classList.contains('active');
                if (!wasActive || forceScroll) {
                    item.classList.add('active');
                    this.scrollToItem(item, behavior);
                }
                activeFound = true;
            } else {
                item.classList.remove('active');
            }
        }
    }

    scrollToItem(el, behavior = 'smooth') {
        if (!el || !this.container) return;
        el.scrollIntoView({ behavior: behavior, block: 'center' });
    }
}
