
import { secondsToTimecodeWhole } from "../utils.js";

export class AudioPlayer {
    constructor(options) {
        this.audioElement = options.audioElement; // The native <audio>
        this.container = options.container;       // Where to render the custom UI
        this.onSeek = options.onSeek;             // Callback when user seeks via UI

        this.isPlaying = false;
        this.duration = 0;
        this.currentTime = 0;

        this.render();
        this.attachEvents();
    }

    render() {
        this.container.innerHTML = `
      <div class="custom-player-wrapper">
        <button class="cp-btn cp-play" type="button" aria-label="Play/Pause">
            <svg class="icon-play" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <svg class="icon-pause hidden" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        
        <div class="cp-time-current">00:00</div>
        
        <div class="cp-timeline-wrapper">
            <div class="cp-track-bg"></div>
            <div class="cp-progress-bar"></div>
            <input type="range" class="cp-timeline" min="0" max="100" value="0" step="0.1" aria-label="Seek">
        </div>
        
        <div class="cp-time-total">00:00</div>
        
        <select class="cp-speed" title="Playback Speed" aria-label="Playback Speed">
            <option value="0.5">0.5x</option>
            <option value="0.8">0.8x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
        </select>
      </div>
    `;

        this.ui = {
            playBtn: this.container.querySelector('.cp-play'),
            iconPlay: this.container.querySelector('.icon-play'),
            iconPause: this.container.querySelector('.icon-pause'),
            timeCurrent: this.container.querySelector('.cp-time-current'),
            timeTotal: this.container.querySelector('.cp-time-total'),
            timeline: this.container.querySelector('.cp-timeline'),
            progressBar: this.container.querySelector('.cp-progress-bar'),
            speedSelect: this.container.querySelector('.cp-speed')
        };
    }

    attachEvents() {
        // Safety check
        if (!this.audioElement) {
            console.error("AudioPlayer: No audio element provided.");
            return;
        }

        // UI -> Audio interactions
        this.ui.playBtn.addEventListener('click', () => {
            if (this.audioElement.paused) {
                this.audioElement.play();
            } else {
                this.audioElement.pause();
            }
        });

        // Speed Control (dropdown)
        this.ui.speedSelect.addEventListener('change', () => {
            const rate = parseFloat(this.ui.speedSelect.value) || 1.0;
            this.audioElement.playbackRate = rate;
        });

        // Timeline seeking (input event for drag, change for final drop)
        this.ui.timeline.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            const time = (pct / 100) * this.duration;
            // Update visual time immediately while dragging
            this.ui.timeCurrent.textContent = secondsToTimecodeWhole(time);
            this.updateProgressBar(pct);
        });

        this.ui.timeline.addEventListener('change', (e) => {
            const pct = parseFloat(e.target.value);
            const time = (pct / 100) * this.duration;
            this.audioElement.currentTime = time;
            if (this.onSeek) this.onSeek(time);
        });

        // Audio -> UI Sync
        this.audioElement.addEventListener('play', () => this.setPlayState(true));
        this.audioElement.addEventListener('pause', () => this.setPlayState(false));

        this.audioElement.addEventListener('timeupdate', () => {
            this.currentTime = this.audioElement.currentTime;
            this.updateTimeUI();
        });

        this.audioElement.addEventListener('ratechange', () => {
            const r = this.audioElement.playbackRate || 1.0;
            if (this.ui.speedSelect) this.ui.speedSelect.value = String(r);
        });

        this.audioElement.addEventListener('durationchange', () => {
            this.duration = this.audioElement.duration || 0;
            this.ui.timeTotal.textContent = secondsToTimecodeWhole(this.duration);
        });

        // Initial sync
        if (!this.audioElement.paused) this.setPlayState(true);
        if (this.audioElement.playbackRate) {
            this.ui.speedSelect.value = String(this.audioElement.playbackRate);
        }
    }

    setPlayState(isPlaying) {
        this.isPlaying = isPlaying;
        if (isPlaying) {
            this.ui.iconPlay.classList.add('hidden');
            this.ui.iconPause.classList.remove('hidden');
        } else {
            this.ui.iconPlay.classList.remove('hidden');
            this.ui.iconPause.classList.add('hidden');
        }
    }

    updateTimeUI() {
        if (!this.duration) return;
        const pct = (this.currentTime / this.duration) * 100;

        // Only update timeline value if user is NOT currently dragging it
        // (Check activeElement or a dragging flag if strictness needed. 
        //  For range inputs, usually safe to update unless focused?)
        // Actually, updating value while user drags fights the user.
        if (document.activeElement !== this.ui.timeline) {
            this.ui.timeline.value = pct;
            this.updateProgressBar(pct);
            this.ui.timeCurrent.textContent = secondsToTimecodeWhole(this.currentTime);
        }
    }

    updateProgressBar(percentage) {
        // Custom CSS variable or width for the filled part
        // We can use a linear-gradient on the track or a separate div
        this.ui.progressBar.style.width = `${percentage}%`;
    }
}
