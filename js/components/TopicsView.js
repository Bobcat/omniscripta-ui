
import { _srtTcToSeconds } from '../utils.js';

export class TopicsView {
    constructor({ containerId, onSeek, getJobId }) {
        this.container = document.getElementById(containerId); // This might be a placeholder div
        this.onSeek = onSeek;
        this.getJobId = getJobId;
        this.topics = [];
    }

    async load(srtUrl) {
        if (!this.container) return;
        this.container.innerHTML = '';
        this.container.classList.add('hidden');

        if (!srtUrl) return;

        try {
            // Strategy: 
            // 1. We have ".../job_ID/whisperx/file.srt" (or something similar)
            // 2. We want ".../job_ID/job.json" to find the original filename
            // 3. We want ".../job_ID/result/orig_filename_topics_v1_merged.json"

            // Step 1: Find job root. Assume structure ends in "/whisperx/..."
            // If not, we fall back to simple replacement.
            let jobRoot = null;
            if (srtUrl.includes('/whisperx/')) {
                jobRoot = srtUrl.split('/whisperx/')[0];
            }

            let topicsUrl = null;

            if (jobRoot) {
                // Fetch job.json
                const jobRes = await fetch(`${jobRoot}/job.json`);
                if (jobRes.ok) {
                    const jobData = await jobRes.json();
                    if (jobData && jobData.orig_filename) {
                        // orig_filename = "myfile.mp3" -> basename = "myfile"
                        // topics = "myfile_topics_v1_merged.json"
                        // location = jobRoot + "/result/" + topics
                        const base = jobData.orig_filename.substring(0, jobData.orig_filename.lastIndexOf('.')) || jobData.orig_filename;
                        topicsUrl = `${jobRoot}/result/${base}_topics_v1_merged.json`;
                    }
                }
            }

            // Fallback if job.json strategy failed or structure didn't match
            if (!topicsUrl) {
                console.warn("Could not deduce topics path via job.json, trying fallback.");
                topicsUrl = srtUrl.replace(/\.srt$/i, '_topics_v1_merged.json');
            }

            const res = await fetch(topicsUrl);
            if (!res.ok) throw new Error(`Topics not found at ${topicsUrl}`);
            const data = await res.json();

            if (data && data.rows && Array.isArray(data.rows)) {
                this.topics = data.rows;
                this.render();
                // Visibility is handled by render() checking topics length
            }
        } catch (e) {
            console.warn("Could not load topics:", e);
            // Ensure hidden if failed
            this.container.classList.add('hidden');
        }
    }

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

            list.appendChild(item);
        }

        this.container.appendChild(list);
    }
}
