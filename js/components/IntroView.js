export class IntroView {
    constructor(app) {
        this.app = app;
        this.container = null;
    }

    mount(container, data) {
        this.container = container;
        this.render();
        this.bindEvents();

        if (data && data.section) {
            setTimeout(() => this.scrollToSection(data.section), 100);
        } else {
            // Default to first section visually
            setTimeout(() => this.scrollToSection('section-upload', false), 50);
        }
    }

    unmount() {
        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    render() {
        this.container.innerHTML = `
            <div class="intro-view">
                <div class="intro-hero">
                    <h1>Omniscripta</h1>
                    <p class="intro-subtitle">Audio transcription, editing, and processing tool.</p>
                </div>
                
                <div class="intro-tabs-container">
                    <nav class="intro-tabs" id="introTabs">
                        <a href="#section-upload" class="intro-tab active" data-target="section-upload">Upload Audio</a>
                        <a href="#section-live" class="intro-tab" data-target="section-live">Live Recording</a>
                        <a href="#section-editor" class="intro-tab" data-target="section-editor">Editor</a>
                        <a href="#section-document" class="intro-tab" data-target="section-document">Document & Export</a>
                    </nav>
                </div>

                <div class="intro-content">
                    
                    <section id="section-upload" class="intro-section">
                        <div class="intro-text">
                            <h2>Upload Audio</h2>
                            <p>Select media files for transcription. Supported formats: MP3, WAV, M4A, WEBM. Outputs text with timestamps and speaker labels.</p>
                        </div>
                        <div class="intro-media">
                            <div class="intro-screenshot-placeholder">
                                <span class="material-symbols-outlined" style="font-size: 48px; color: var(--border); margin-bottom: 8px;">image</span>
                                <span style="color: var(--text-secondary); font-size: 0.9rem;">Upload Interface Screenshot</span>
                            </div>
                            <div class="intro-media-caption">
                                <a href="#" id="introBtnUpload" class="intro-link">Test it yourself &rarr;</a>
                            </div>
                        </div>
                    </section>
                    
                    <section id="section-live" class="intro-section">
                        <div class="intro-text">
                            <h2>Live Recording</h2>
                            <p>Microphone input mode. Generates rolling text transcription from live audio.</p>
                        </div>
                        <div class="intro-media">
                            <div class="intro-screenshot-placeholder">
                                <span class="material-symbols-outlined" style="font-size: 48px; color: var(--border); margin-bottom: 8px;">image</span>
                                <span style="color: var(--text-secondary); font-size: 0.9rem;">Live Recording Screenshot</span>
                            </div>
                            <div class="intro-media-caption">
                                <a href="#" id="introBtnLive" class="intro-link">Test it yourself &rarr;</a>
                            </div>
                        </div>
                    </section>

                    <section id="section-editor" class="intro-section">
                        <div class="intro-text">
                            <h2>Editor</h2>
                            <p>Text editor synchronized with audio playback. Click words to seek audio. Editable text, speaker labels, and timestamps.</p>
                        </div>
                        <div class="intro-media">
                            <div class="intro-screenshot-placeholder">
                                <span class="material-symbols-outlined" style="font-size: 48px; color: var(--border); margin-bottom: 8px;">image</span>
                                <span style="color: var(--text-secondary); font-size: 0.9rem;">Editor Interface Screenshot</span>
                            </div>
                            <div class="intro-media-caption">
                                <a href="#" id="introBtnEditor" class="intro-link">Test it yourself &rarr;</a>
                                <span class="intro-hint" style="margin-left: 8px;">(Requires a transcript to edit)</span>
                            </div>
                        </div>
                    </section>

                    <section id="section-document" class="intro-section">
                        <div class="intro-text">
                            <h2>Document & Export</h2>
                            <p>Read transcripts as formatted text documents. Includes automatically generated topic lists and multiple export formatting options.</p>
                        </div>
                        <div class="intro-media">
                            <div class="intro-screenshot-placeholder">
                                <span class="material-symbols-outlined" style="font-size: 48px; color: var(--border); margin-bottom: 8px;">image</span>
                                <span style="color: var(--text-secondary); font-size: 0.9rem;">Document View Screenshot</span>
                            </div>
                            <div class="intro-media-caption">
                                <a href="#" id="introBtnDocument" class="intro-link">Test it yourself &rarr;</a>
                                <span class="intro-hint" style="margin-left: 8px;">(Requires a transcript)</span>
                            </div>
                        </div>
                    </section>

                </div>
            </div>
        `;
    }

    bindEvents() {
        // Smooth scroll for tabs
        const tabs = this.container.querySelectorAll('.intro-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = tab.dataset.target;

                // Push history state so the user can use the browser's back button to scroll up
                window.history.pushState({ view: 'intro', data: { section: targetId } }, '', '#intro-' + targetId);

                this.scrollToSection(targetId);
            });
        });

        // CTA buttons
        const btnUpload = this.container.querySelector('#introBtnUpload');
        const btnLive = this.container.querySelector('#introBtnLive');
        const btnEditor = this.container.querySelector('#introBtnEditor');
        const btnDocument = this.container.querySelector('#introBtnDocument');

        if (btnUpload) btnUpload.addEventListener('click', (e) => { e.preventDefault(); this.app.navigateTo('upload'); });
        if (btnLive) btnLive.addEventListener('click', (e) => { e.preventDefault(); this.app.navigateTo('live'); });
        if (btnEditor) btnEditor.addEventListener('click', (e) => { e.preventDefault(); this.app.navigateTo('upload'); });
        if (btnDocument) btnDocument.addEventListener('click', (e) => { e.preventDefault(); this.app.navigateTo('upload'); });
    }

    scrollToSection(targetId, performScroll = true) {
        // Default to first section if empty or top
        const effectiveId = (!targetId || targetId === 'top') ? 'section-upload' : targetId;

        // Update active tab visually based on the requested target
        const tabs = this.container.querySelectorAll('.intro-tab');
        tabs.forEach(tab => {
            tab.classList.remove('active');
            if (tab.dataset.target === effectiveId) {
                tab.classList.add('active');
            }
        });

        if (!performScroll) return;

        if (!targetId || targetId === 'top') {
            this.container.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }

        const targetEl = this.container.querySelector('#' + targetId);
        if (targetEl) {
            // Calculate offset manually
            const containerRect = this.container.getBoundingClientRect();
            const targetRect = targetEl.getBoundingClientRect();
            const tabsContainer = this.container.querySelector('.intro-tabs-container');
            const offset = targetRect.top - containerRect.top + this.container.scrollTop - (tabsContainer ? tabsContainer.offsetHeight : 60);

            this.container.scrollTo({
                top: offset,
                behavior: 'smooth'
            });
        }
    }
}
