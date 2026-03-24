import { LiveAudioService, downsampleBuffer, float32ToPcm16LeBuffer } from "../services/LiveAudioService.js";
import { LiveSessionService } from "../services/LiveSessionService.js";
import { TRANSCRIPT_LANGUAGES } from "../constants/languages.js";
import { createMouseDragController } from "../editor/editorDrag.js";

const STATUS_LABELS = {
    idle: "Idle",
    connecting: "Connecting",
    connected: "Connected",
    ready: "Ready",
    listening: "Listening",
    processing: "Processing",
    finalizing: "Finalizing",
    paused: "Paused",
    ended: "Finished",
    disconnected: "Disconnected",
    error: "Error",
};

const LIVE_VAD_PHASE_LABELS = {
    speech: "Speech detected",
    hangover: "",
    silence: "",
    disabled: "",
    unknown: "",
};
const LIVE_VAD_SPEECH_BADGE_MAX_AGE_MS = 220;
const LIVE_VAD_SPEECH_BADGE_HOLD_MS = 900;

const DEV_LIVE_FIXTURES = {
    panel120v1: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (120s)",
        url: "/dev-fixtures/panel_120s_v1_08m09s_10m09s.mp3",
        durationMs: 120000,
        startDelayMs: 700,
        tailDelayMs: 1200,
        mode: "playback",
    },
    panel120v1Inject: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (inject, 120s)",
        url: "/dev-fixtures/panel_120s_v1_08m09s_10m09s.mp3",
        durationMs: 120000,
        startDelayMs: 700,
        tailDelayMs: 1200,
        mode: "inject",
    },
};

const DEV_LIVE_FIXTURE_OPTIONS = [
    {
        value: "panel120v1",
        label: "Panel discussion (120s) · v1",
    },
];

const LIVE_SPEAKER_TAG_PREFIX_RE = /^\s*\[?\s*(speaker[_ ]?\d+|spk[_ ]?\d+)\s*\]?\s*[:\-]/i;
const LIVE_SPEAKER_TAG_GLOBAL_RE = /\[?\s*(speaker[_ ]?\d+|spk[_ ]?\d+)\s*\]?\s*[:\-]\s*/gi;
const DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES = {
    blockEverySegments: 3,
    blockMinChars: 220,
    blockMinWords: 35,
};
const LIVE_LANGUAGE_STORAGE_KEY = "omniscripta_live_language_v1";

export class LiveView {
    constructor(app) {
        this.app = app;
        const ua = String((typeof navigator !== "undefined" && navigator.userAgent) || "");
        const coarsePointer = typeof window !== "undefined"
            && typeof window.matchMedia === "function"
            && !!window.matchMedia("(pointer: coarse)").matches;
        this.isLikelyMobile = /Android|iPhone|iPad|iPod|Mobile|Opera Mini/i.test(ua) || coarsePointer;

        this.remoteState = "idle";
        this.finalSegments = [];
        this.finalSegmentsSignature = "";
        this.previewText = "";
        this.previewSeq = -1;
        this.partialText = "";
        this.developerToolsOpen = false;
        this.vadState = this.createVadState();

        this.audioStreaming = false;
        this.audioPaused = false;

        this.sessionService = null;
        this.audioService = null;

        this.recordingElapsedMs = 0;
        this.recordingStartedAtMs = 0;
        this.recordingTimerId = null;

        this.lastStatsSummary = "";

        this.awaitingLiveResult = false;
        this.resultEnvelope = null;
        this.resultCanExportSrt = false;
        this.resultCanExportWav = false;
        this.resultSrtUrl = "";
        this.resultWavUrl = "";
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
        this.runMetricsSummaryText = "";
        this.qualityTimelineEntries = [];
        this.cadenceStats = this.createCadenceStats();
        this.currentFixtureMeta = null;

        this.fixtureRunActive = false;
        this.fixtureRunToken = 0;
        this.fixtureAudio = null;
        this.fixtureStopTimerId = null;
        this.fixtureWatchdogTimerId = null;
        this.fixtureRunLabel = "";
        this.selectedFixtureKey = DEV_LIVE_FIXTURE_OPTIONS[0] ? DEV_LIVE_FIXTURE_OPTIONS[0].value : "panel120v1";
        this.selectedLanguage = this.loadPreferredLanguage();
        this.languageSelectMeasureCanvas = null;
        this.audioSettingsPanelOpen = false;
        this.audioSettingsDrag = null;
        this.audioSettingsUi = {
            preGain: 1.0,
            noiseSuppression: false,
            autoGainControl: false,
            echoCancellation: false,
        };
        this.devSpeakerLabelsEnabled = true;
        this.liveTranscriptFormatRules = { ...DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES };

        this.el = {};
    }

    getHtml() {
        const langOptions = [
            "<option value=\"\">Auto detect</option>",
            ...TRANSCRIPT_LANGUAGES.map((l) => (`<option value=\"${String(l.code || "")}\">${String(l.flag || "")} ${String(l.name || l.code || "")}</option>`)),
        ].join("");
        return `
      <div class="live-wrap">

        <!-- Main content area (always 100vh) -->
        <div class="live-main">

        <!-- Top bar: badge + timer -->
        <header class="live-header">
          <div class="header-left">
            <span class="live-status-badge status-idle" id="liveStatusBadge">Ready</span>
          </div>
          <div class="header-right">
            <span class="live-vad-badge hidden" id="liveVadBadge" aria-live="polite">Listening...</span>
            <div class="timer timer-top hidden" id="liveDurationTextTop">00:00</div>
          </div>
        </header>

        <!-- Content area (no card, full height) -->
        <div class="live-content-area" id="liveTranscriptArea">

          <!-- Idle placeholder -->
          <div class="live-placeholder" id="livePlaceholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
            <span>Click start to begin recording...</span>

            <!-- Idle: round start button moved inside placeholder -->
            <div class="live-float-idle" id="liveFloatIdle" style="margin-top: 16px;">
              <button class="btn-primary-start" id="liveStartBtn" type="button" title="Start Recording" aria-label="Start Recording"></button>
            </div>
          </div>

          <!-- Transcript text (hidden when idle) -->
          <div id="liveFinalText" class="live-final-text hidden" aria-live="polite" tabindex="0">
            <span id="liveFinalTextMain" class="live-final-text-main"></span><span id="liveFinalTextPreview" class="live-final-text-preview hidden"></span>
          </div>

        </div>

        <!-- Fixed Bottom Controls -->
        <div class="live-bottom-bar" id="liveControlsFloat">

          <!-- Left: Timer + Language -->
          <div class="controls-left">
            <div class="timer hidden" id="liveDurationText">00:00</div>
            <div class="live-language-picker" id="liveLanguagePicker">
              <button
                id="liveAudioSettingsBtn"
                class="live-audio-settings-btn"
                type="button"
                title="Advanced audio options"
                aria-label="Advanced audio options"
                aria-expanded="false"
              >
                <span class="material-symbols-outlined" aria-hidden="true">settings</span>
              </button>
              <select id="liveLanguageSelect" class="live-select live-language-select" title="Auto is recommended unless you are sure about the spoken language.">
                ${langOptions}
              </select>
              <div class="live-language-help" id="liveLanguageHelp">Auto is recommended for unknown or mixed-language speech.</div>
            </div>
          </div>

          <!-- Center: Actions -->
          <div class="controls-center">
            <!-- Listening: Pause + Finish -->
            <div class="live-float-listening hidden" id="liveFloatListening" style="display: flex; gap: 8px;">
              <button class="btn-secondary" id="livePauseBtn" type="button">Pause</button>
              <button class="btn-danger" id="liveStopBtn" type="button">Finish</button>
            </div>

            <!-- Paused: Resume + Finish -->
            <div class="live-float-paused hidden" id="liveFloatPaused" style="display: flex; gap: 8px;">
              <button class="btn-secondary" id="liveResumeBtn" type="button">Resume</button>
              <button class="btn-danger" id="liveStopPausedBtn" type="button">Finish</button>
            </div>

            <!-- Connecting / Finalizing: status message -->
            <div class="live-float-processing hidden" id="liveFloatProcessing">
              <span class="live-float-processing-text" id="liveProcessingText">Connecting...</span>
            </div>
          </div>

          <!-- Right: Exports + Dev Toggle -->
          <div class="controls-right" style="flex-wrap: nowrap; justify-content: flex-end;">
            <!-- Finished: downloads + clear -->
            <div class="live-float-finished hidden" id="liveFloatFinished" style="display: flex; gap: 6px; flex-wrap: nowrap; justify-content: flex-end;">
              <button class="btn-outline btn-compact" id="liveDownloadWavBtn" type="button" disabled>WAV</button>
              <button class="btn-outline btn-compact" id="liveDownloadTxtBtn" type="button" disabled>TXT</button>
              <button class="btn-outline btn-compact" id="liveDownloadSrtBtn" type="button" disabled>SRT</button>
              <button class="btn-outline btn-compact" id="liveClearBtn" type="button" style="color: var(--accent-red); border-color: transparent;">Clear</button>
            </div>

            <div class="spacer" style="width: 1px; height: 24px; background: var(--border-color); margin: 0 8px;"></div>

            <!-- Dev Tools toggle (always visible) -->
            <button class="btn-outline btn-dev-toggle" id="liveDevToggleBtn" type="button" aria-expanded="false" title="Dev Tools">
              <span class="dev-toggle-icon">⚙</span>
              <span class="dev-toggle-text">Dev Tools</span>
            </button>
          </div>

        </div>

        </div>
        <!-- /live-main -->

        <!-- Modeless advanced audio panel -->
        <div class="live-audio-panel hidden" id="liveAudioPanel" role="dialog" aria-modal="false" aria-label="Advanced audio options">
          <div class="live-audio-panel-card" id="liveAudioPanelCard">
            <div class="live-audio-panel-topbar" id="liveAudioPanelDragHandle" title="Drag to move">
              <div class="live-audio-panel-title">Advanced audio</div>
              <div class="live-audio-panel-grip" aria-hidden="true">⋮⋮</div>
            </div>
            <div class="live-audio-panel-body">
              <div class="live-audio-panel-hint">UX only for now. Values on the right are read from the current browser mic track.</div>

              <div class="live-audio-pregain">
                <div class="live-audio-pregain-head">
                  <label for="liveAudioPreGain">Mic pre-gain</label>
                  <span class="live-audio-ui-value" id="liveAudioPreGainUiValue">1.0x</span>
                </div>
                <input id="liveAudioPreGain" type="range" min="0.5" max="3.0" step="0.1" value="1.0" />
              </div>

              <div class="live-audio-toggles">
                <label class="live-audio-toggle">
                  <input id="liveAudioNoiseSuppression" type="checkbox" />
                  <span>Noise suppression</span>
                </label>
                <label class="live-audio-toggle">
                  <input id="liveAudioAutoGainControl" type="checkbox" />
                  <span>Auto gain control</span>
                </label>
                <label class="live-audio-toggle">
                  <input id="liveAudioEchoCancellation" type="checkbox" />
                  <span>Echo cancellation</span>
                </label>
              </div>

              <div class="live-audio-sep"></div>

              <div class="live-audio-kv"><span class="muted">Device</span><span id="liveAudioCurrentDevice">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Input sample rate</span><span id="liveAudioCurrentSampleRate">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Channel count</span><span id="liveAudioCurrentChannelCount">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Capture engine</span><span id="liveAudioCurrentEngine">idle</span></div>
              <div class="live-audio-kv"><span class="muted">Chunk cadence</span><span id="liveAudioCurrentChunkMs">40 ms</span></div>

              <div class="live-audio-panel-actions">
                <button class="mini live-audio-panel-close" id="liveAudioPanelCloseBtn" type="button">Close</button>
              </div>
            </div>
          </div>
        </div>


        <!-- Dev section (hidden by default) -->
        <div class="live-dev-section hidden" id="liveDevSection">

          <!-- Session card -->
          <div class="live-card live-controls">

            <div class="live-session-row">
              <div class="muted">Session ID</div>
              <code id="liveSessionId">(none)</code>
            </div>

            <div class="live-session-row">
              <div class="muted">Fixture (dev)</div>
              <select id="liveFixtureSelect" class="live-select">
                ${DEV_LIVE_FIXTURE_OPTIONS.map((opt) => (
            `<option value="${String(opt.value || "")}">${String(opt.label || opt.value || "")}</option>`
        )).join("")}
              </select>
            </div>

            <div class="live-secondary-row live-secondary-row-2up">
              <button id="liveRunFixturePlayBtn" type="button">Play fixture</button>
              <button id="liveRunFixtureInjectBtn" type="button">Inject fixture</button>
            </div>
          </div>

          <!-- Run/Benchmark card -->
          <div class="live-card live-run-panels">

            <div class="live-partial-row">
              <div class="live-label">Status / processing</div>
              <div class="live-partial-text" id="livePartialText" data-placeholder="Chunk status appears here."></div>
            </div>

            <div class="live-partial-row">
              <div class="live-label">Cadence / snappiness</div>
              <div class="live-partial-text live-quality-report" id="liveCadenceText" data-placeholder="Cadence indicator appears once the visible transcript starts updating."></div>
            </div>

            <div class="live-partial-row">
              <div class="live-label">Run metrics / benchmark</div>
              <div class="live-partial-text live-quality-report" id="liveQualityText" data-placeholder="Quality score appears here for fixture runs."></div>
            </div>
          </div>

        </div>

      </div>
    `;
    }


    mount(container) {
        container.innerHTML = this.getHtml();
        this.captureElements();
        this.initServices();
        this.bindUi();
        this.setSpeakerLabelsEnabled(this.devSpeakerLabelsEnabled);
        void this.loadUiSettings();
        this.renderTranscriptText();
        this.updateDurationDisplay();
        this.updatePartialPlaceholder();
        this.updateCadenceIndicator();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    unmount() {
        if (this.shouldPreserveSessionOnUnmount()) {
            // Keep a running live flow alive when users switch views.
            if (this.audioSettingsDrag) this.audioSettingsDrag.onUp();
            this.audioSettingsPanelOpen = false;
            this.el = {};
            this.updateControls();
            return {};
        }
        if (this.audioSettingsDrag) this.audioSettingsDrag.onUp();
        this.audioSettingsPanelOpen = false;
        this.cleanupSession("view_unmount", { sendStop: false });

        if (this.audioService) {
            try {
                this.audioService.stop();
            } catch {
                // ignore cleanup failures
            }
            this.audioService = null;
        }

        this.stopRecordingTimer({ reset: true });
        this.sessionService = null;
        this.el = {};
        this.updateControls();
        return {};
    }

    shouldPreserveSessionOnUnmount() {
        return !!(this.audioStreaming || this.awaitingLiveResult || this.fixtureRunActive);
    }

    isRecordingActive() {
        return !!this.audioStreaming;
    }

    syncAppLiveNavState() {
        if (this.app && typeof this.app.syncLiveNavState === "function") {
            this.app.syncLiveNavState();
        }
    }

    initServices() {
        if (!this.sessionService) {
            this.sessionService = new LiveSessionService({
                onOpen: () => {
                    this.setStatus("connected", "Connected. Ready for recording.");
                    this.updateControls();
                },
                onClose: (ev) => {
                    const remoteStateBeforeClose = String(this.remoteState || "").toLowerCase();
                    const awaitingResultBeforeClose = !!this.awaitingLiveResult;
                    this.cancelFixtureRun("session_socket_closed");
                    this.appendLog(`Socket closed (code=${ev && ev.code !== undefined ? ev.code : "?"}, reason=${ev && ev.reason ? ev.reason : "none"})`);
                    this.stopAudioCapture({ quiet: true });
                    this.stopRecordingTimer({ reset: false });
                    const hasRenderedTranscript = this.el.finalText
                        ? !!String(this.el.finalText.innerText || "").trim()
                        : false;
                    const hasFinalTranscript = (
                        this.finalSegments.length > 0
                        || !!String(this.previewText || "").trim()
                        || hasRenderedTranscript
                    );
                    const closeNearFinalization = (
                        awaitingResultBeforeClose
                        || remoteStateBeforeClose === "finalizing"
                        || remoteStateBeforeClose === "ended"
                        || remoteStateBeforeClose === "ready"
                    );
                    const keepFinishedState = (
                        (this.resultEnvelope && this.resultEnvelope.ready)
                        || remoteStateBeforeClose === "ended"
                        || (closeNearFinalization && hasFinalTranscript)
                    );
                    if (keepFinishedState) {
                        this.awaitingLiveResult = false;
                        this.remoteState = "ready";
                        this.setStatus("ready", "Transcript ready. Download TXT, SRT, or WAV.");
                        this.updateControls();
                        return;
                    }
                    if (awaitingResultBeforeClose || remoteStateBeforeClose === "finalizing") {
                        this.remoteState = "finalizing";
                        this.setStatus("finalizing", "Connection closed during finalizing.");
                        this.updateControls();
                        return;
                    }
                    this.remoteState = "disconnected";
                    if (this.awaitingLiveResult) {
                        this.setStatus("disconnected", "Connection closed before final transcript was received.");
                    } else {
                        this.setStatus("disconnected", "Disconnected");
                    }
                    this.updateControls();
                },
                onError: () => {
                    this.appendLog("Socket error");
                    this.setStatus("error", "WebSocket error");
                    this.updateControls();
                },
                onMessage: (raw) => {
                    this.handleServerMessage(raw);
                },
                onLog: (line) => {
                    this.appendLog(line);
                },
            });
        }

        if (!this.audioService) {
            this.audioService = new LiveAudioService({
                targetSampleRate: 16000,
                chunkMs: 40,
                onChunk: (chunk) => {
                    if (!this.sessionService || !this.sessionService.isOpen()) return;
                    const sent = this.sessionService.sendAudioChunk(chunk);
                    if (!sent) {
                        this.appendLog("Audio chunk dropped (socket not writable)");
                    }
                },
                onError: (err) => {
                    const msg = err && err.message ? err.message : String(err);
                    this.appendLog(`Audio error: ${msg}`);
                    this.setStatus("error", `Audio error: ${msg}`);
                    if (this.app && typeof this.app.showAlert === "function") {
                        this.app.showAlert("Microphone error", msg);
                    }
                    this.updateControls();
                },
                onLog: (line) => {
                    this.appendLog(line);
                },
            });
        }
    }

    applyUiSettingsEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        const settings = e.settings && typeof e.settings === "object" ? e.settings : {};
        const live = settings.live && typeof settings.live === "object" ? settings.live : {};

        const incomingRules = live.transcript_format_rules;
        if (incomingRules && typeof incomingRules === "object") {
            const next = { ...DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES };
            Object.keys(next).forEach((key) => {
                if (!Object.prototype.hasOwnProperty.call(incomingRules, key)) return;
                const value = Number(incomingRules[key]);
                if (!Number.isFinite(value)) return;
                next[key] = value;
            });
            this.liveTranscriptFormatRules = next;
        }
        if (Object.prototype.hasOwnProperty.call(live, "speaker_labels_default_enabled")) {
            this.setSpeakerLabelsEnabled(!!live.speaker_labels_default_enabled);
        }
        this.renderTranscriptText();
    }

    async loadUiSettings() {
        if (!this.sessionService || typeof this.sessionService.fetchUiSettings !== "function") return;
        try {
            const envelope = await this.sessionService.fetchUiSettings();
            this.applyUiSettingsEnvelope(envelope);
        } catch (err) {
            // Keep defaults silently when UI settings endpoint is unavailable.
        }
    }

    captureElements() {
        this.el.statusBadge = document.getElementById("liveStatusBadge");
        this.el.vadBadge = document.getElementById("liveVadBadge");
        this.el.languagePicker = document.getElementById("liveLanguagePicker");
        this.el.languageSelect = document.getElementById("liveLanguageSelect");
        this.el.languageHelp = document.getElementById("liveLanguageHelp");
        this.el.audioSettingsBtn = document.getElementById("liveAudioSettingsBtn");
        this.el.audioPanel = document.getElementById("liveAudioPanel");
        this.el.audioPanelCard = document.getElementById("liveAudioPanelCard");
        this.el.audioPanelDragHandle = document.getElementById("liveAudioPanelDragHandle");
        this.el.audioPanelCloseBtn = document.getElementById("liveAudioPanelCloseBtn");
        this.el.audioPreGain = document.getElementById("liveAudioPreGain");
        this.el.audioPreGainUiValue = document.getElementById("liveAudioPreGainUiValue");
        this.el.audioNoiseSuppression = document.getElementById("liveAudioNoiseSuppression");
        this.el.audioAutoGainControl = document.getElementById("liveAudioAutoGainControl");
        this.el.audioEchoCancellation = document.getElementById("liveAudioEchoCancellation");
        this.el.audioCurrentDevice = document.getElementById("liveAudioCurrentDevice");
        this.el.audioCurrentSampleRate = document.getElementById("liveAudioCurrentSampleRate");
        this.el.audioCurrentChannelCount = document.getElementById("liveAudioCurrentChannelCount");
        this.el.audioCurrentEngine = document.getElementById("liveAudioCurrentEngine");
        this.el.audioCurrentChunkMs = document.getElementById("liveAudioCurrentChunkMs");
        this.el.durationText = document.getElementById("liveDurationText");
        this.el.durationTextTop = document.getElementById("liveDurationTextTop");
        this.el.sessionId = document.getElementById("liveSessionId");
        this.el.startBtn = document.getElementById("liveStartBtn");
        this.el.pauseBtn = document.getElementById("livePauseBtn");
        this.el.resumeBtn = document.getElementById("liveResumeBtn");
        this.el.stopBtn = document.getElementById("liveStopBtn");
        this.el.stopPausedBtn = document.getElementById("liveStopPausedBtn");
        this.el.clearBtn = document.getElementById("liveClearBtn");
        this.el.fixtureSelect = document.getElementById("liveFixtureSelect");
        this.el.runFixturePlayBtn = document.getElementById("liveRunFixturePlayBtn");
        this.el.runFixtureInjectBtn = document.getElementById("liveRunFixtureInjectBtn");
        this.el.downloadWavBtn = document.getElementById("liveDownloadWavBtn");
        this.el.downloadTxtBtn = document.getElementById("liveDownloadTxtBtn");
        this.el.downloadSrtBtn = document.getElementById("liveDownloadSrtBtn");
        this.el.qualityText = document.getElementById("liveQualityText");
        this.el.cadenceText = document.getElementById("liveCadenceText");
        this.el.devToggleBtn = document.getElementById("liveDevToggleBtn");
        this.el.devSection = document.getElementById("liveDevSection");
        this.el.speakerLabelsToggleBtn = document.getElementById("liveSpeakerLabelsToggleBtn");
        this.el.finalText = document.getElementById("liveFinalText");
        this.el.finalTextMain = document.getElementById("liveFinalTextMain");
        this.el.finalTextPreview = document.getElementById("liveFinalTextPreview");
        this.el.placeholder = document.getElementById("livePlaceholder");
        this.el.floatIdle = document.getElementById("liveFloatIdle");
        this.el.floatListening = document.getElementById("liveFloatListening");
        this.el.floatPaused = document.getElementById("liveFloatPaused");
        this.el.floatFinished = document.getElementById("liveFloatFinished");
        this.el.floatProcessing = document.getElementById("liveFloatProcessing");
        this.el.processingText = document.getElementById("liveProcessingText");
        this.el.partialText = document.getElementById("livePartialText");
    }

    bindUi() {
        if (this.el.languageSelect) {
            this.el.languageSelect.addEventListener("change", () => {
                const next = this.normalizeLanguageCode(this.el.languageSelect.value);
                this.selectedLanguage = next;
                this.persistPreferredLanguage(next);
                this.syncLanguageSelectUi();
                if (this.sessionService && this.sessionService.isOpen()) {
                    this.sessionService.sendControl("set_language", {
                        payload: {
                            language: this.getRequestedSessionLanguage() || "auto",
                        },
                        log: false,
                    });
                }
            });
        }
        if (this.el.audioSettingsBtn) {
            this.el.audioSettingsBtn.addEventListener("click", () => {
                this.toggleAudioSettingsPanel();
            });
        }
        if (this.el.audioPanelCloseBtn) {
            this.el.audioPanelCloseBtn.addEventListener("click", () => this.toggleAudioSettingsPanel(false));
        }
        if (this.el.audioPreGain) {
            this.el.audioPreGain.addEventListener("input", () => {
                const raw = Number(this.el.audioPreGain.value);
                this.audioSettingsUi.preGain = Number.isFinite(raw) ? Math.max(0.5, Math.min(3.0, raw)) : 1.0;
                this.refreshAudioSettingsPanel({ readCurrent: false });
            });
        }
        if (this.el.audioNoiseSuppression) {
            this.el.audioNoiseSuppression.addEventListener("change", () => {
                this.audioSettingsUi.noiseSuppression = !!this.el.audioNoiseSuppression.checked;
            });
        }
        if (this.el.audioAutoGainControl) {
            this.el.audioAutoGainControl.addEventListener("change", () => {
                this.audioSettingsUi.autoGainControl = !!this.el.audioAutoGainControl.checked;
            });
        }
        if (this.el.audioEchoCancellation) {
            this.el.audioEchoCancellation.addEventListener("change", () => {
                this.audioSettingsUi.echoCancellation = !!this.el.audioEchoCancellation.checked;
            });
        }
        this.initAudioSettingsDrag();
        this.refreshAudioSettingsPanel({ readCurrent: true });
        if (this.el.startBtn) {
            this.el.startBtn.addEventListener("click", () => this.startMic());
        }
        if (this.el.pauseBtn) {
            this.el.pauseBtn.addEventListener("click", () => this.pauseMic());
        }
        if (this.el.resumeBtn) {
            this.el.resumeBtn.addEventListener("click", () => this.resumeMic());
        }
        if (this.el.stopBtn) {
            this.el.stopBtn.addEventListener("click", () => this.stopMic());
        }
        if (this.el.stopPausedBtn) {
            this.el.stopPausedBtn.addEventListener("click", () => this.stopMic());
        }
        if (this.el.clearBtn) {
            this.el.clearBtn.addEventListener("click", () => this.clearOutput());
        }
        if (this.el.fixtureSelect) {
            this.el.fixtureSelect.addEventListener("change", () => {
                this.selectedFixtureKey = String(this.el.fixtureSelect.value || "").trim() || this.selectedFixtureKey;
                this.updateControls();
            });
        }
        if (this.el.runFixturePlayBtn) {
            this.el.runFixturePlayBtn.addEventListener("click", () => {
                void this.startSelectedFixtureRun("playback");
            });
        }
        if (this.el.runFixtureInjectBtn) {
            this.el.runFixtureInjectBtn.addEventListener("click", () => {
                void this.startSelectedFixtureRun("inject");
            });
        }
        if (this.el.downloadWavBtn) {
            this.el.downloadWavBtn.addEventListener("click", () => this.downloadLiveTranscript("wav"));
        }
        if (this.el.downloadTxtBtn) {
            this.el.downloadTxtBtn.addEventListener("click", () => this.downloadLiveTranscript("txt"));
        }
        if (this.el.downloadSrtBtn) {
            this.el.downloadSrtBtn.addEventListener("click", () => this.downloadLiveTranscript("srt"));
        }
        if (this.el.devToggleBtn) {
            this.el.devToggleBtn.addEventListener("click", () => this.toggleDeveloperTools());
        }
        if (this.el.speakerLabelsToggleBtn) {
            this.el.speakerLabelsToggleBtn.addEventListener("click", () => {
                this.setSpeakerLabelsEnabled(!this.devSpeakerLabelsEnabled);
            });
        }
    }

    toggleDeveloperTools(forceOpen) {
        const next = typeof forceOpen === "boolean" ? forceOpen : !this.developerToolsOpen;
        this.developerToolsOpen = next;

        if (this.el.devSection) {
            this.el.devSection.classList.toggle("hidden", !next);
        }
        if (this.el.devToggleBtn) {
            // Desktop: update text, mobile: handled by CSS
            const iconSpan = this.el.devToggleBtn.querySelector('.dev-toggle-icon');
            const textSpan = this.el.devToggleBtn.querySelector('.dev-toggle-text');
            if (iconSpan) {
                iconSpan.textContent = next ? "✕" : "⚙";
            }
            if (textSpan) {
                textSpan.textContent = next ? "Hide Dev Tools" : "Dev Tools";
            }
            this.el.devToggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
            this.el.devToggleBtn.title = next ? "Hide Dev Tools" : "Dev Tools";
        }
    }

    setSpeakerLabelsEnabled(enabled) {
        this.devSpeakerLabelsEnabled = !!enabled;
        if (this.el.speakerLabelsToggleBtn) {
            this.el.speakerLabelsToggleBtn.textContent = this.devSpeakerLabelsEnabled ? "On" : "Off";
            this.el.speakerLabelsToggleBtn.setAttribute("aria-pressed", this.devSpeakerLabelsEnabled ? "true" : "false");
        }
        this.renderTranscriptText();
    }

    normalizeLanguageCode(value) {
        const code = String(value || "").trim().toLowerCase();
        if (!code) return "";
        for (let i = 0; i < TRANSCRIPT_LANGUAGES.length; i += 1) {
            const known = String(TRANSCRIPT_LANGUAGES[i] && TRANSCRIPT_LANGUAGES[i].code || "").trim().toLowerCase();
            if (known === code) return known;
        }
        return "";
    }

    loadPreferredLanguage() {
        try {
            const raw = window.localStorage.getItem(LIVE_LANGUAGE_STORAGE_KEY);
            return this.normalizeLanguageCode(raw);
        } catch {
            return "";
        }
    }

    persistPreferredLanguage(code) {
        try {
            const normalized = this.normalizeLanguageCode(code);
            window.localStorage.setItem(LIVE_LANGUAGE_STORAGE_KEY, normalized);
        } catch {
            // ignore persistence issues
        }
    }

    syncLanguageSelectUi() {
        if (!this.el.languageSelect) return;
        const normalized = this.normalizeLanguageCode(this.selectedLanguage);
        this.selectedLanguage = normalized;
        this.el.languageSelect.value = normalized;
        this.updateLanguageHelpVisibility();
        this.fitLanguageSelectToSelectedOption();
    }

    updateLanguageHelpVisibility() {
        if (!this.el.languageHelp) return;
        const isAutoSelected = !this.normalizeLanguageCode(this.selectedLanguage);
        this.el.languageHelp.classList.toggle("hidden", isAutoSelected);
    }

    fitLanguageSelectToSelectedOption() {
        const select = this.el.languageSelect;
        if (!select) return;
        const selectedIndex = Number.isFinite(select.selectedIndex) ? select.selectedIndex : 0;
        const option = select.options && select.options.length > 0
            ? select.options[Math.max(0, selectedIndex)]
            : null;
        const text = String(option && option.text ? option.text : "Auto detect").trim();
        if (!text) return;
        if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;
        try {
            if (!this.languageSelectMeasureCanvas && typeof document !== "undefined") {
                this.languageSelectMeasureCanvas = document.createElement("canvas");
            }
            const canvas = this.languageSelectMeasureCanvas;
            const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
            if (!ctx) return;
            const computed = window.getComputedStyle(select);
            const fontStyle = String(computed.fontStyle || "normal");
            const fontWeight = String(computed.fontWeight || "400");
            const fontSize = String(computed.fontSize || "14px");
            const fontFamily = String(computed.fontFamily || "system-ui");
            ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
            const textWidth = Math.ceil(ctx.measureText(text).width);
            const targetWidthPx = Math.max(86, Math.min(220, textWidth + 40));
            select.style.width = `${targetWidthPx}px`;
        } catch {
            // Keep CSS fallback sizing when measuring is unavailable.
        }
    }

    initAudioSettingsDrag() {
        if (!this.el.audioPanelCard || !this.el.audioPanelDragHandle) return;
        if (!this.audioSettingsDrag) {
            this.audioSettingsDrag = createMouseDragController((x, y) => {
                if (!this.el.audioPanelCard) return;
                this.el.audioPanelCard.style.setProperty("--drag-x", `${x}px`);
                this.el.audioPanelCard.style.setProperty("--drag-y", `${y}px`);
            });
        }
        this.el.audioPanelDragHandle.addEventListener("mousedown", this.audioSettingsDrag.onMouseDown);
    }

    toggleAudioSettingsPanel(forceOpen) {
        const next = typeof forceOpen === "boolean" ? forceOpen : !this.audioSettingsPanelOpen;
        this.audioSettingsPanelOpen = !!next;
        if (this.el.audioSettingsBtn) {
            this.el.audioSettingsBtn.setAttribute("aria-expanded", this.audioSettingsPanelOpen ? "true" : "false");
        }
        if (this.el.audioPanel) {
            this.el.audioPanel.classList.toggle("hidden", !this.audioSettingsPanelOpen);
        }
        if (!this.audioSettingsPanelOpen) {
            if (this.audioSettingsDrag) {
                this.audioSettingsDrag.onUp();
            }
            return;
        }
        this.refreshAudioSettingsPanel({ readCurrent: true });
    }

    readCurrentAudioTrackState() {
        const state = {
            hasActiveTrack: false,
            noiseSuppression: null,
            autoGainControl: null,
            echoCancellation: null,
            sampleRate: null,
            channelCount: null,
            deviceLabel: "",
            engine: String((this.audioService && this.audioService.mode) || "idle"),
            chunkMs: Number(this.audioService && this.audioService.chunkMs) || 0,
        };
        const svc = this.audioService;
        if (!svc || !svc.mediaStream) {
            if ((Number(svc && svc.inputSampleRate) || 0) > 0) {
                state.sampleRate = Number(svc.inputSampleRate);
            }
            return state;
        }
        const tracks = typeof svc.mediaStream.getAudioTracks === "function" ? svc.mediaStream.getAudioTracks() : [];
        const track = tracks && tracks.length ? tracks[0] : null;
        if (!track) {
            if ((Number(svc.inputSampleRate) || 0) > 0) {
                state.sampleRate = Number(svc.inputSampleRate);
            }
            return state;
        }
        state.hasActiveTrack = true;
        const settings = typeof track.getSettings === "function" ? (track.getSettings() || {}) : {};
        const constraints = typeof track.getConstraints === "function" ? (track.getConstraints() || {}) : {};
        const pickBool = (sKey, cKey) => {
            if (Object.prototype.hasOwnProperty.call(settings, sKey)) return settings[sKey] === true;
            if (Object.prototype.hasOwnProperty.call(constraints, cKey)) return constraints[cKey] === true;
            return null;
        };
        state.noiseSuppression = pickBool("noiseSuppression", "noiseSuppression");
        state.autoGainControl = pickBool("autoGainControl", "autoGainControl");
        state.echoCancellation = pickBool("echoCancellation", "echoCancellation");
        const sr = Number(settings.sampleRate || constraints.sampleRate || svc.inputSampleRate || 0);
        const ch = Number(settings.channelCount || constraints.channelCount || 0);
        state.sampleRate = Number.isFinite(sr) && sr > 0 ? sr : null;
        state.channelCount = Number.isFinite(ch) && ch > 0 ? ch : null;
        state.deviceLabel = String(track.label || settings.deviceId || "").trim();
        return state;
    }

    refreshAudioSettingsPanel(options = {}) {
        const readCurrent = options.readCurrent !== false;
        if (this.el.audioPreGain) {
            this.el.audioPreGain.value = String(this.audioSettingsUi.preGain);
        }
        if (this.el.audioPreGainUiValue) {
            this.el.audioPreGainUiValue.textContent = `${this.audioSettingsUi.preGain.toFixed(1)}x`;
        }
        if (this.el.audioNoiseSuppression) this.el.audioNoiseSuppression.checked = !!this.audioSettingsUi.noiseSuppression;
        if (this.el.audioAutoGainControl) this.el.audioAutoGainControl.checked = !!this.audioSettingsUi.autoGainControl;
        if (this.el.audioEchoCancellation) this.el.audioEchoCancellation.checked = !!this.audioSettingsUi.echoCancellation;

        if (!readCurrent) return;
        const now = this.readCurrentAudioTrackState();
        const inactiveText = "Start recording to read";
        const fromTrack = !!now.hasActiveTrack;
        if (this.el.audioCurrentDevice) this.el.audioCurrentDevice.textContent = fromTrack ? (now.deviceLabel || "Not reported") : inactiveText;
        if (this.el.audioCurrentSampleRate) {
            this.el.audioCurrentSampleRate.textContent = fromTrack
                ? ((Number.isFinite(now.sampleRate) && now.sampleRate > 0)
                ? `${Math.round(now.sampleRate)} Hz`
                : "Not reported")
                : inactiveText;
        }
        if (this.el.audioCurrentChannelCount) {
            this.el.audioCurrentChannelCount.textContent = fromTrack
                ? ((Number.isFinite(now.channelCount) && now.channelCount > 0)
                ? `${Math.round(now.channelCount)}`
                : "Not reported")
                : inactiveText;
        }
        if (this.el.audioCurrentEngine) {
            this.el.audioCurrentEngine.textContent = now.engine || "idle";
        }
        if (this.el.audioCurrentChunkMs) {
            this.el.audioCurrentChunkMs.textContent = (Number.isFinite(now.chunkMs) && now.chunkMs > 0)
                ? `${Math.round(now.chunkMs)} ms`
                : "Not reported";
        }
    }

    getRequestedSessionLanguage() {
        const normalized = this.normalizeLanguageCode(this.selectedLanguage);
        return normalized || null;
    }

    clearOutput() {
        this.partialText = "";
        this.lastStatsSummary = "";
        this.resetLiveResultState();
        this.currentFixtureMeta = null;
        this.previewText = "";
        this.remoteState = "idle";

        this.renderTranscriptText();
        if (this.el.partialText) this.el.partialText.textContent = "";
        if (this.el.cadenceText) this.el.cadenceText.textContent = "";
        if (this.el.qualityText) this.el.qualityText.textContent = "";

        this.updatePartialPlaceholder();
        this.updateCadenceIndicator();
        this.updateQualityPlaceholder();
        this.setUiPhase("idle");
        this.updateControls();
    }

    setStatus(kind, text) {
        // setStatus is kept for internal calls; the visible badge is now
        // driven entirely by setUiPhase() via updateControls().
        const normalized = String(kind || "idle").toLowerCase();
        if (!this.audioStreaming) {
            this.remoteState = normalized;
        }
        if (this.el.statusText) {
            this.el.statusText.textContent = String(text || "");
        }
    }


    appendLog(line) {
        if (!this.el.log) return;
        const now = new Date();
        const stamp = now.toISOString().slice(11, 19);
        const msg = `[${stamp}] ${String(line || "")}`;
        this.el.log.textContent = this.el.log.textContent ? `${this.el.log.textContent}\n${msg}` : msg;
        this.el.log.scrollTop = this.el.log.scrollHeight;
    }

    setDevStats(text) {
        this.lastStatsSummary = String(text || "");
        if (this.el.devStats) {
            this.el.devStats.textContent = this.lastStatsSummary || "No stats yet";
            this.el.devStats.title = this.lastStatsSummary || "No stats yet";
        }
    }

    createVadState() {
        return {
            enabled: false,
            phase: "disabled",
            label: "",
            speechHintUntilMs: 0,
            lastSpeechAgeMs: null,
            hangoverMs: null,
            checks: 0,
            speechAllows: 0,
            hangoverAllows: 0,
            silenceSkips: 0,
        };
    }

    _normalizeVadPhase(value) {
        const v = String(value || "").trim().toLowerCase();
        if (v === "speech" || v === "hangover" || v === "silence") return v;
        if (v === "disabled") return "disabled";
        return "unknown";
    }

    _vadLabelForPhase(phase) {
        const p = this._normalizeVadPhase(phase);
        return LIVE_VAD_PHASE_LABELS[p] || LIVE_VAD_PHASE_LABELS.unknown;
    }

    _extractEngineState(result) {
        const r = result && typeof result === "object" ? result : {};
        const runtime = r.engine_runtime && typeof r.engine_runtime === "object" ? r.engine_runtime : {};
        const engineState = runtime.engine_state && typeof runtime.engine_state === "object"
            ? runtime.engine_state
            : runtime;
        return engineState && typeof engineState === "object" ? engineState : {};
    }

    applyVadStateFromResult(result) {
        const nowMs = Date.now();
        const state = this.vadState && typeof this.vadState === "object" ? this.vadState : this.createVadState();
        const engineState = this._extractEngineState(result);
        const vad = engineState.vad && typeof engineState.vad === "object" ? engineState.vad : null;
        if (!vad || vad.enabled !== true) {
            this.vadState = {
                ...state,
                enabled: false,
                phase: "disabled",
                label: "",
                speechHintUntilMs: 0,
            };
            this.updateVadIndicator();
            return;
        }

        const cfg = vad.config && typeof vad.config === "object" ? vad.config : {};
        const st = vad.state && typeof vad.state === "object" ? vad.state : {};
        const ageRaw = Number(st.last_speech_age_ms);
        const ageMs = Number.isFinite(ageRaw) && ageRaw >= 0 ? ageRaw : null;
        const hangoverRaw = Number(cfg.hangover_ms);
        const hangoverMs = Number.isFinite(hangoverRaw) && hangoverRaw >= 0 ? hangoverRaw : null;
        const phase = (ageMs !== null && ageMs <= LIVE_VAD_SPEECH_BADGE_MAX_AGE_MS) ? "speech" : "silence";
        const speechHintUntilMs = phase === "speech"
            ? Math.max(Number(state.speechHintUntilMs || 0), nowMs + LIVE_VAD_SPEECH_BADGE_HOLD_MS)
            : 0;
        this.vadState = {
            ...state,
            enabled: true,
            phase,
            label: this._vadLabelForPhase(phase),
            speechHintUntilMs,
            lastSpeechAgeMs: ageMs,
            hangoverMs,
            checks: Number.isFinite(Number(st.checks)) ? Number(st.checks) : state.checks,
            speechAllows: Number.isFinite(Number(st.speech_checks)) ? Number(st.speech_checks) : state.speechAllows,
            hangoverAllows: Number.isFinite(Number(st.hangover_allows)) ? Number(st.hangover_allows) : state.hangoverAllows,
            silenceSkips: Number.isFinite(Number(st.silence_checks)) ? Number(st.silence_checks) : state.silenceSkips,
        };
        this.updateVadIndicator();
    }

    applyVadStateFromStats(payload) {
        const nowMs = Date.now();
        const p = payload && typeof payload === "object" ? payload : {};
        const g = p.rolling_guardrails && typeof p.rolling_guardrails === "object" ? p.rolling_guardrails : null;
        if (!g) return;

        const nextChecks = Number(g.vad_checks);
        const nextSpeech = Number(g.vad_speech_allows);
        const nextHangover = Number(g.vad_hangover_allows);
        const nextSilence = Number(g.vad_silence_skips);
        if (
            !Number.isFinite(nextChecks)
            || !Number.isFinite(nextSpeech)
            || !Number.isFinite(nextHangover)
            || !Number.isFinite(nextSilence)
        ) {
            return;
        }

        const state = this.vadState && typeof this.vadState === "object" ? this.vadState : this.createVadState();
        const seemsEnabled = !!state.enabled || nextChecks > 0 || nextSpeech > 0 || nextHangover > 0 || nextSilence > 0;
        if (!seemsEnabled) return;
        const prevChecks = Number(state.checks || 0);
        const prevSpeech = Number(state.speechAllows || 0);
        const prevHangover = Number(state.hangoverAllows || 0);
        const prevSilence = Number(state.silenceSkips || 0);
        let phase = this._normalizeVadPhase(state.phase);
        let speechHintUntilMs = Number(state.speechHintUntilMs || 0);
        if (nextSpeech > prevSpeech) {
            phase = "speech";
            speechHintUntilMs = nowMs + LIVE_VAD_SPEECH_BADGE_HOLD_MS;
        } else if (nextSilence > prevSilence) {
            phase = "silence";
            speechHintUntilMs = 0;
        } else if (nextChecks > prevChecks && phase === "unknown") {
            phase = "silence";
            speechHintUntilMs = 0;
        } else if (nextHangover > prevHangover) {
            phase = "silence";
            speechHintUntilMs = 0;
        }

        this.vadState = {
            ...state,
            enabled: true,
            phase,
            label: this._vadLabelForPhase(phase),
            speechHintUntilMs,
            checks: nextChecks,
            speechAllows: nextSpeech,
            hangoverAllows: nextHangover,
            silenceSkips: nextSilence,
        };
        this.updateVadIndicator();
    }

    updateVadIndicator() {
        if (!this.el.vadBadge) return;
        const phase = this._normalizeVadPhase(this.vadState && this.vadState.phase);
        const enabled = !!(this.vadState && this.vadState.enabled);
        const speechHintUntilMs = Number(this.vadState && this.vadState.speechHintUntilMs || 0);
        const nowMs = Date.now();
        const speechActive = phase === "speech" && speechHintUntilMs > nowMs;
        const sessionActive = this.audioStreaming || this.remoteState === "listening";
        const show = enabled && sessionActive && speechActive;
        this.el.vadBadge.classList.toggle("hidden", !show);
        this.el.vadBadge.classList.remove("vad-speech", "vad-hangover", "vad-silence");
        if (!show) return;
        this.el.vadBadge.classList.add("vad-speech");
        this.el.vadBadge.textContent = this._vadLabelForPhase("speech");
    }

    resetLiveResultState() {
        this.awaitingLiveResult = false;
        this.resultEnvelope = null;
        this.resultCanExportWav = false;
        this.resultCanExportSrt = false;
        this.resultWavUrl = "";
        this.resultSrtUrl = "";
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
        this.runMetricsSummaryText = "";
        this.qualityTimelineEntries = [];
        this.previewText = "";
        this.previewSeq = -1;
        this.finalSegments = [];
        this.finalSegmentsSignature = "";
        this.cadenceStats = this.createCadenceStats();
        this.vadState = this.createVadState();
        this.updateVadIndicator();
    }

    createCadenceStats() {
        return {
            startedAtMs: 0,
            firstVisibleUpdateAtMs: 0,
            lastVisibleUpdateAtMs: 0,
            visibleUpdateCount: 0,
            previewChangeCount: 0,
            finalChangeCount: 0,
            gapMs: [],
            lastVisibleSignature: "",
        };
    }

    ensureCadenceStats() {
        if (!this.cadenceStats || typeof this.cadenceStats !== "object") {
            this.cadenceStats = this.createCadenceStats();
        }
        return this.cadenceStats;
    }

    ensureCadenceStarted(atMs = Date.now()) {
        const stats = this.ensureCadenceStats();
        const startedAtMs = Number(atMs);
        if (stats.startedAtMs <= 0 && Number.isFinite(startedAtMs) && startedAtMs > 0) {
            stats.startedAtMs = startedAtMs;
        }
        return stats;
    }

    _normalizeSegmentText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    _segmentsSignature(segments) {
        if (!Array.isArray(segments) || !segments.length) return "";
        const rows = [];
        for (let i = 0; i < segments.length; i += 1) {
            const seg = segments[i] && typeof segments[i] === "object" ? segments[i] : {};
            const text = this._normalizeSegmentText(seg.text);
            const t0Raw = Number(seg.t0_ms);
            const t1Raw = Number(seg.t1_ms);
            const t0 = Number.isFinite(t0Raw) ? Math.max(0, Math.round(t0Raw)) : 0;
            const t1 = Number.isFinite(t1Raw) ? Math.max(t0, Math.round(t1Raw)) : t0;
            rows.push(`${t0}:${t1}:${text}`);
        }
        return rows.join("|");
    }

    _buildVisibleTranscriptState(finalSegments, previewText) {
        const diarizePresentation = this._formatSegmentBlocksDiarizeHardPresentation(finalSegments);
        const finalValue = (diarizePresentation && diarizePresentation.text)
            ? String(diarizePresentation.text)
            : "";
        const previewSuffix = this._formatPreviewSuffixText(finalValue, previewText);
        return {
            finalText: finalValue,
            previewSuffix,
            signature: `${finalValue}\n@@preview@@${previewSuffix}`,
        };
    }

    _percentile(values, fraction) {
        const rows = Array.isArray(values)
            ? values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
            : [];
        if (!rows.length) return null;
        if (rows.length === 1) return rows[0];
        const clamped = Math.max(0, Math.min(1, Number(fraction)));
        const pos = (rows.length - 1) * clamped;
        const lower = Math.floor(pos);
        const upper = Math.ceil(pos);
        if (lower === upper) return rows[lower];
        const weight = pos - lower;
        return rows[lower] + ((rows[upper] - rows[lower]) * weight);
    }

    _formatCadenceDuration(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value) || value < 0) return "n/a";
        if (value < 1000) return `${Math.round(value)}ms`;
        return `${(value / 1000).toFixed(2)}s`;
    }

    recordCadenceVisibleUpdate({ finalChanged = false, previewChanged = false } = {}) {
        const stats = this.ensureCadenceStarted(this.recordingStartedAtMs > 0 ? this.recordingStartedAtMs : Date.now());
        const visibleState = this._buildVisibleTranscriptState(this.finalSegments, this.previewText);
        const signature = String(visibleState.signature || "");
        if (!signature || signature === String(stats.lastVisibleSignature || "")) {
            return false;
        }

        const nowMs = Date.now();
        if (stats.firstVisibleUpdateAtMs <= 0) {
            stats.firstVisibleUpdateAtMs = nowMs;
        }
        if (stats.lastVisibleUpdateAtMs > 0) {
            stats.gapMs.push(Math.max(0, nowMs - stats.lastVisibleUpdateAtMs));
        }
        stats.lastVisibleUpdateAtMs = nowMs;
        stats.lastVisibleSignature = signature;
        stats.visibleUpdateCount += 1;
        if (previewChanged) stats.previewChangeCount += 1;
        if (finalChanged) stats.finalChangeCount += 1;
        return true;
    }

    formatCadenceSummary() {
        const stats = this.ensureCadenceStats();
        const startMs = stats.startedAtMs > 0
            ? stats.startedAtMs
            : (this.recordingStartedAtMs > 0 ? this.recordingStartedAtMs : 0);
        const nowMs = Date.now();

        if (stats.visibleUpdateCount <= 0) {
            if (startMs > 0) {
                return [
                    "Waiting for first visible transcript update...",
                    `Elapsed since start: ${this._formatCadenceDuration(Math.max(0, nowMs - startMs))}`,
                ].join("\n");
            }
            return "";
        }

        const firstLatencyMs = (startMs > 0 && stats.firstVisibleUpdateAtMs > 0)
            ? Math.max(0, stats.firstVisibleUpdateAtMs - startMs)
            : null;
        const medianGapMs = this._percentile(stats.gapMs, 0.5);
        const p95GapMs = this._percentile(stats.gapMs, 0.95);
        const sampleEndMs = stats.lastVisibleUpdateAtMs > 0 ? stats.lastVisibleUpdateAtMs : nowMs;
        const elapsedForRateMs = (startMs > 0 && sampleEndMs > startMs) ? (sampleEndMs - startMs) : 0;
        const updatesPerMin = elapsedForRateMs > 0
            ? (stats.visibleUpdateCount / (elapsedForRateMs / 60000))
            : null;
        const currentGapMs = stats.lastVisibleUpdateAtMs > 0
            ? Math.max(0, nowMs - stats.lastVisibleUpdateAtMs)
            : null;

        const lines = [];
        const medianText = medianGapMs !== null ? this._formatCadenceDuration(medianGapMs) : "n/a";
        const p95Text = p95GapMs !== null ? this._formatCadenceDuration(p95GapMs) : "n/a";
        lines.push(`Median visible gap: ${medianText} | p95 ${p95Text}`);

        const firstLineParts = [];
        if (firstLatencyMs !== null) {
            firstLineParts.push(`First visible update: ${this._formatCadenceDuration(firstLatencyMs)}`);
        }
        if (
            currentGapMs !== null
            && (this.audioStreaming || this.awaitingLiveResult || this.fixtureRunActive)
        ) {
            firstLineParts.push(`Current gap: ${this._formatCadenceDuration(currentGapMs)}`);
        }
        if (firstLineParts.length) {
            lines.push(firstLineParts.join(" | "));
        }

        lines.push(
            `Visible updates: ${stats.visibleUpdateCount}`
            + (updatesPerMin !== null && Number.isFinite(updatesPerMin) ? ` (${updatesPerMin.toFixed(1)}/min)` : "")
        );
        lines.push(`Preview changes: ${stats.previewChangeCount} | final growth: ${stats.finalChangeCount}`);
        return lines.join("\n");
    }

    updateCadenceIndicator() {
        if (!this.el.cadenceText) return;

        const text = String(this.formatCadenceSummary() || "").trim();
        if (text) {
            this.el.cadenceText.textContent = text;
            this.el.cadenceText.setAttribute("data-empty", "0");
            this.el.cadenceText.setAttribute("data-placeholder", "");
            return;
        }

        this.el.cadenceText.textContent = "";
        this.el.cadenceText.setAttribute("data-empty", "1");

        let placeholder = "Cadence indicator is measured client-side from visible transcript updates.";
        if (this.audioStreaming || this.fixtureRunActive || this.awaitingLiveResult || this.remoteState === "finalizing") {
            placeholder = "Cadence indicator appears after the first visible transcript update.";
        } else if (this.resultEnvelope && this.resultEnvelope.ready) {
            placeholder = "No cadence data captured for this run in this browser session.";
        }
        this.el.cadenceText.setAttribute("data-placeholder", placeholder);
    }

    _stripSpeakerTagsFromText(text) {
        return this._normalizeSegmentText(String(text || "").replace(LIVE_SPEAKER_TAG_GLOBAL_RE, " "));
    }

    _speakerLabelFromToken(token) {
        const raw = String(token || "").trim();
        if (!raw) return "";
        const m = raw.match(/(?:speaker|spk)[_ ]?(\d+)/i);
        if (!m) return "";
        const idx = Number(m[1]);
        if (!Number.isFinite(idx) || idx < 0) return "";
        return `Speaker ${idx + 1}`;
    }

    _formatRules() {
        const src = this.liveTranscriptFormatRules && typeof this.liveTranscriptFormatRules === "object"
            ? this.liveTranscriptFormatRules
            : DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES;
        const out = { ...DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES };
        Object.keys(out).forEach((k) => {
            const v = Number(src[k]);
            if (Number.isFinite(v)) out[k] = v;
        });
        return out;
    }

    _countWords(text) {
        const tokens = String(text || "").trim().match(/\S+/g);
        return tokens ? tokens.length : 0;
    }

    _startsWithUppercaseWord(text) {
        return /^[\s"'(\[]*[A-Z][\w'-]*/.test(String(text || ""));
    }

    _endsWithClosedSentence(text) {
        return /[.!?]["')\]]*\s*$/.test(String(text || ""));
    }

    _endsWithSinglePeriodOrTerminalPunctuation(text) {
        const v = String(text || "");
        if (/[!?]["')\]]*\s*$/.test(v)) return true;
        if (!/\.["')\]]*\s*$/.test(v)) return false;
        return !/(?:\.\.\.|…)["')\]]*\s*$/.test(v);
    }

    _capitalizeFirstLetterIfLowercase(text) {
        return String(text || "").replace(/^([\s"'([{<]*)([a-z])/, (_m, lead, letter) => `${lead}${letter.toUpperCase()}`);
    }

    _canBreakAfterSegment(currentText, nextText) {
        const cur = String(currentText || "");
        const next = String(nextText || "");
        if (!this._endsWithClosedSentence(cur)) return false;
        if (/[,;:]\s*$/.test(cur)) return false;
        if (/(\.\.\.|…)\s*$/.test(cur)) return false;
        if (next && !this._startsWithUppercaseWord(next)) return false;
        return true;
    }

    _formatSegmentBlocksDiarizeHardPresentation(finalSegments) {
        if (!Array.isArray(finalSegments) || !finalSegments.length) return { text: "", paragraphs: [] };
        const rules = this._formatRules();

        const segments = [];
        for (let i = 0; i < finalSegments.length; i += 1) {
            const seg = finalSegments[i] && typeof finalSegments[i] === "object" ? finalSegments[i] : {};
            const rawText = String(seg.text || "");
            const text = this._stripSpeakerTagsFromText(rawText);
            if (!text) continue;
            const tagged = rawText.match(LIVE_SPEAKER_TAG_PREFIX_RE);
            const inferredSpeaker = tagged ? String(tagged[1] || "").trim().toUpperCase().replace(" ", "_") : "";
            const speaker = String(seg.speaker || "").trim() || inferredSpeaker;
            segments.push({ text, speaker });
        }
        if (!segments.length) return { text: "", paragraphs: [] };

        const paragraphs = [{ text: segments[0].text, speaker: segments[0].speaker, breakBefore: "start" }];
        let blockSegCount = 1;
        let blockChars = segments[0].text.length;
        let blockWords = this._countWords(segments[0].text);

        for (let i = 1; i < segments.length; i += 1) {
            const prev = segments[i - 1];
            const cur = segments[i];
            const shouldCapitalizeCur = this._endsWithSinglePeriodOrTerminalPunctuation(prev.text);
            const curText = shouldCapitalizeCur ? this._capitalizeFirstLetterIfLowercase(cur.text) : cur.text;
            const speakerChanged = !!(prev.speaker && cur.speaker && prev.speaker !== cur.speaker);
            if (speakerChanged) {
                paragraphs.push({ text: curText, speaker: cur.speaker, breakBefore: "speaker_change" });
                blockSegCount = 1;
                blockChars = curText.length;
                blockWords = this._countWords(curText);
                continue;
            }

            const targetReached = blockSegCount >= Number(rules.blockEverySegments || 0);
            const minReached = (
                blockChars >= Number(rules.blockMinChars || 0)
                || blockWords >= Number(rules.blockMinWords || 0)
            );
            if (targetReached && minReached && this._canBreakAfterSegment(prev.text, curText)) {
                paragraphs.push({ text: curText, speaker: cur.speaker, breakBefore: "heuristic" });
                blockSegCount = 1;
                blockChars = curText.length;
                blockWords = this._countWords(curText);
                continue;
            }

            const tail = paragraphs[paragraphs.length - 1];
            tail.text = tail.text ? `${tail.text} ${curText}` : curText;
            blockSegCount += 1;
            blockChars += curText.length;
            blockWords += this._countWords(curText);
        }

        const normalizedParagraphs = paragraphs
            .map((p) => ({
                text: this._normalizeSegmentText(p.text),
                speaker: String(p.speaker || "").trim(),
                breakBefore: String(p.breakBefore || "heuristic"),
            }))
            .filter((p) => !!p.text);
        const text = normalizedParagraphs.map((p) => p.text).join("\n");
        return { text, paragraphs: normalizedParagraphs };
    }

    _formatPreviewSuffixText(finalText, previewText) {
        const finalValue = String(finalText || "");
        const rawPreview = String(previewText || "").trim();
        if (!rawPreview) return "";
        const previewValue = this.devSpeakerLabelsEnabled
            ? rawPreview
            : this._stripSpeakerTagsFromText(rawPreview);
        if (!previewValue) return "";
        return /\s$/.test(finalValue) ? previewValue : (" " + previewValue);
    }

    _renderFinalMainText(text) {
        if (!this.el.finalTextMain) return;
        const host = this.el.finalTextMain;
        host.textContent = "";

        const value = String(text || "");
        if (!value) return;

        const lines = value.split("\n");
        const frag = document.createDocumentFragment();
        for (let i = 0; i < lines.length; i += 1) {
            if (i > 0) {
                frag.appendChild(document.createElement("br"));
                const spacer = document.createElement("span");
                spacer.className = "live-softbreak-gap";
                spacer.setAttribute("aria-hidden", "true");
                frag.appendChild(spacer);
            }
            frag.appendChild(document.createTextNode(lines[i]));
        }

        host.appendChild(frag);
    }

    _renderFinalMainParagraphs(paragraphs) {
        if (!this.el.finalTextMain) return;
        const host = this.el.finalTextMain;
        host.textContent = "";

        const rows = Array.isArray(paragraphs) ? paragraphs : [];
        if (!rows.length) return;

        const frag = document.createDocumentFragment();
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
            const text = this._normalizeSegmentText(row.text);
            if (!text) continue;
            const breakBefore = String(row.breakBefore || "heuristic");
            if (i > 0) {
                frag.appendChild(document.createElement("br"));
                const spacer = document.createElement("span");
                spacer.className = breakBefore === "speaker_change"
                    ? "live-softbreak-gap live-softbreak-gap-speaker"
                    : "live-softbreak-gap";
                spacer.setAttribute("aria-hidden", "true");
                frag.appendChild(spacer);
            }

            if (this.devSpeakerLabelsEnabled) {
                const label = this._speakerLabelFromToken(row.speaker);
                if (label) {
                    const labelEl = document.createElement("span");
                    labelEl.className = "live-speaker-label";
                    labelEl.textContent = label;
                    frag.appendChild(labelEl);
                }
            }
            frag.appendChild(document.createTextNode(text));
        }
        host.appendChild(frag);
    }

    renderTranscriptText() {
        const diarizePresentation = this._formatSegmentBlocksDiarizeHardPresentation(this.finalSegments);
        const finalValue = (diarizePresentation && diarizePresentation.text)
            ? String(diarizePresentation.text)
            : "";
        const previewSuffix = this._formatPreviewSuffixText(finalValue, this.previewText);

        // Remember if user was at bottom before adding new content
        const wasAtBottom = this._isAtBottom();

        if (diarizePresentation && Array.isArray(diarizePresentation.paragraphs) && diarizePresentation.paragraphs.length) {
            this._renderFinalMainParagraphs(diarizePresentation.paragraphs);
        } else {
            this._renderFinalMainText(finalValue);
        }
        if (this.el.finalTextPreview) {
            this.el.finalTextPreview.textContent = previewSuffix;
            this.el.finalTextPreview.classList.toggle("hidden", !previewSuffix);
        }

        // Only auto-scroll if user was already at bottom
        // If user scrolled back to read, respect that and don't jump
        if (wasAtBottom && this.el.finalText) {
            this.el.finalText.scrollTop = this.el.finalText.scrollHeight;
        }
    }

    _isAtBottom() {
        if (!this.el.finalText) return true;
        const el = this.el.finalText;
        // Within 40px of bottom = "at bottom"
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    }

    getCurrentSessionId() {
        return this.sessionService ? String(this.sessionService.getSessionId() || "").trim() : "";
    }

    formatLiveSummary(result) {
        const r = result && typeof result === "object" ? result : {};
        const total = Number(r.chunks_total || 0);
        const done = Number(r.chunks_done || 0);
        const failed = Number(r.chunks_failed || 0);
        const pending = Number(r.chunks_pending || Math.max(0, total - done - failed));
        const fstate = String(r.finalization_state || "").trim() || "idle";
        const fstateLabel = ({
            idle: "Idle",
            recording: "Recording",
            processing_chunks: "Processing chunks",
            finalizing: "Finalizing",
            recording_finalized: "Recording finalized",
            finalized: "Ready",
            ready: "Ready",
            error: "Error",
        })[fstate] || fstate.replace(/_/g, " ");
        const rev = Number(r.transcript_revision || 0);
        const segs = Array.isArray(r.final_segments) ? r.final_segments : [];
        const chars = segs.reduce((acc, seg) => {
            const text = seg && typeof seg === "object" ? String(seg.text || "").trim() : "";
            return acc + (text ? text.length : 0);
        }, 0);
        const durMs = Number(r.recording_duration_ms || 0);

        const parts = [
            `Processing state: ${fstateLabel}`,
            `Chunks ${done}/${total} (pending ${pending}, failed ${failed})`,
            `Transcript rev ${rev}`,
        ];

        const engineState = this._extractEngineState(r);
        const vadObj = engineState.vad && typeof engineState.vad === "object" ? engineState.vad : null;
        if (vadObj && vadObj.enabled === true) {
            const vadCfg = vadObj.config && typeof vadObj.config === "object" ? vadObj.config : {};
            const vadState = vadObj.state && typeof vadObj.state === "object" ? vadObj.state : {};
            const lastSpeechAgeMsRaw = Number(vadState.last_speech_age_ms);
            const hangoverMsRaw = Number(vadCfg.hangover_ms);
            const checksRaw = Number(vadState.checks);
            const speechRaw = Number(vadState.speech_checks);
            const hangoverRaw = Number(vadState.hangover_allows);
            const silenceRaw = Number(vadState.silence_checks);
            let vadPhase = "silence";
            if (Number.isFinite(lastSpeechAgeMsRaw) && lastSpeechAgeMsRaw >= 0) {
                if (lastSpeechAgeMsRaw <= 250) {
                    vadPhase = "speech";
                } else if (Number.isFinite(hangoverMsRaw) && hangoverMsRaw > 0 && lastSpeechAgeMsRaw <= hangoverMsRaw) {
                    vadPhase = "hangover";
                }
            }
            const vadLabel = this._vadLabelForPhase(vadPhase);
            if (vadLabel) {
                parts.push(`VAD: ${vadLabel}`);
            }
            if (
                Number.isFinite(checksRaw)
                || Number.isFinite(speechRaw)
                || Number.isFinite(hangoverRaw)
                || Number.isFinite(silenceRaw)
            ) {
                parts.push(
                    `VAD counters: checks=${Number.isFinite(checksRaw) ? checksRaw : "?"}`
                    + ` speech=${Number.isFinite(speechRaw) ? speechRaw : "?"}`
                    + ` hangover=${Number.isFinite(hangoverRaw) ? hangoverRaw : "?"}`
                    + ` silence=${Number.isFinite(silenceRaw) ? silenceRaw : "?"}`
                );
            }
        }
        if (durMs > 0) {
            parts.push(`Recording ${(durMs / 1000).toFixed(1)}s`);
        }
        if (chars > 0) {
            parts.push(`${chars} chars`);
        }

        const reasonCounts = r.chunk_reason_counts && typeof r.chunk_reason_counts === "object"
            ? r.chunk_reason_counts
            : null;
        if (reasonCounts && Object.keys(reasonCounts).length) {
            const reasonPairs = Object.entries(reasonCounts).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
            parts.push(`Chunk triggers: ${reasonPairs.map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }

        const rowsCount = Number(r.chunk_results_rows_count || 0);
        const uniqueCount = Number(r.chunk_results_unique_count || 0);
        const dupRows = Number(r.chunk_results_duplicate_index_rows || 0);
        const invalidRows = Number(r.chunk_results_invalid_index_rows || 0);
        if (rowsCount > 0 && (dupRows > 0 || invalidRows > 0 || (uniqueCount > 0 && uniqueCount !== rowsCount))) {
            parts.push(
                `Chunk rows: ${rowsCount} rows / ${uniqueCount || rowsCount} unique`
                + (dupRows > 0 ? ` (duplicates ${dupRows})` : "")
                + (invalidRows > 0 ? ` (invalid-index ${invalidRows})` : "")
            );
        }

        return parts.join("\n");
    }

    formatQualitySummary(envelope) {
        const qenv = envelope && typeof envelope === "object" ? envelope : {};
        const q = qenv.quality && typeof qenv.quality === "object" ? qenv.quality : {};
        const fixture = q.fixture && typeof q.fixture === "object" ? q.fixture : {};
        const score = q.score && typeof q.score === "object" ? q.score : {};
        const run = q.run_metrics && typeof q.run_metrics === "object" ? q.run_metrics : {};

        const fixtureId = String(qenv.fixture_id || fixture.fixture_id || "").trim();
        const uploadScore = Number(score.upload_similarity_score);
        const wordLive = Number(score.word_count_live || 0);
        const wordRef = Number(score.word_count_reference || 0);
        const wordRatio = score.word_count_ratio_live_to_ref;
        const editDist = Number(score.word_edit_distance || 0);
        const recMs = Number(run.recording_duration_ms || 0);
        const stopToReadyMs = run.stop_to_ready_ms == null ? null : Number(run.stop_to_ready_ms);
        const chunksTotal = Number(run.chunks_total || 0);
        const chunksFailed = Number(run.chunks_failed || 0);
        const chunksDone = Number(run.chunks_done || 0);
        const chunksPending = Number(run.chunks_pending || 0);
        const chunkReasons = run.chunk_reason_counts && typeof run.chunk_reason_counts === "object"
            ? run.chunk_reason_counts
            : {};
        const pollErrors = Number(run.poll_error_count || 0);
        const chunkErrors = Number(run.chunk_error_count || 0);
        const gpuProxyTranscribeTimeS = run.gpu_proxy_transcribe_total_s == null ? null : Number(run.gpu_proxy_transcribe_total_s);
        const gpuProxyPipelineTimeS = run.gpu_proxy_pipeline_total_s == null ? null : Number(run.gpu_proxy_pipeline_total_s);
        const gpuProxyTranscribePct = run.gpu_proxy_transcribe_pct_of_recording == null ? null : Number(run.gpu_proxy_transcribe_pct_of_recording);
        const gpuProxyPipelinePct = run.gpu_proxy_pipeline_pct_of_recording == null ? null : Number(run.gpu_proxy_pipeline_pct_of_recording);

        const lines = [];
        if (Number.isFinite(uploadScore)) {
            lines.push(`Upload Similarity Score: ${Math.round(uploadScore)}/100${fixtureId ? ` (${fixtureId})` : ""}`);
        } else {
            lines.push(`Fixture benchmark available${fixtureId ? ` (${fixtureId})` : ""}`);
        }
        lines.push(
            `Words: live ${wordLive} / ref ${wordRef}`
            + (wordRatio === null || wordRatio === undefined ? "" : ` (${Number(wordRatio).toFixed(3)}x)`)
            + `, edit distance ${editDist}`
        );
        lines.push(
            `Run: ${chunksDone}/${chunksTotal} chunks ready`
            + ` (failed ${chunksFailed}, pending ${chunksPending})`
            + (recMs > 0 ? ` | recording ${(recMs / 1000).toFixed(1)}s` : "")
            + (stopToReadyMs !== null && Number.isFinite(stopToReadyMs) ? ` | stop->ready ${(stopToReadyMs / 1000).toFixed(2)}s` : "")
        );
        const reasonPairs = Object.entries(chunkReasons).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        if (reasonPairs.length) {
            lines.push(`Chunk reasons: ${reasonPairs.map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        if (gpuProxyTranscribeTimeS !== null && Number.isFinite(gpuProxyTranscribeTimeS)) {
            lines.push(
                `GPU proxy transcribe time: ${gpuProxyTranscribeTimeS.toFixed(2)}s`
                + (gpuProxyTranscribePct !== null && Number.isFinite(gpuProxyTranscribePct) ? ` (${gpuProxyTranscribePct.toFixed(1)}% of recording)` : "")
            );
        }
        if (gpuProxyPipelineTimeS !== null && Number.isFinite(gpuProxyPipelineTimeS)) {
            lines.push(
                `GPU proxy pipeline time: ${gpuProxyPipelineTimeS.toFixed(2)}s`
                + (gpuProxyPipelinePct !== null && Number.isFinite(gpuProxyPipelinePct) ? ` (${gpuProxyPipelinePct.toFixed(1)}% of recording)` : "")
            );
        }
        lines.push(
            `Health: poll_errors=${pollErrors} chunk_errors=${chunkErrors} finalization=${String(run.finalization_state || "")}`
        );
        const refMeta = fixture.reference_meta && typeof fixture.reference_meta === "object" ? fixture.reference_meta : {};
        if (Object.prototype.hasOwnProperty.call(refMeta, "boundary_partial_end")) {
            lines.push(`Ref boundary_partial_end=${String(refMeta.boundary_partial_end)}`);
        }
        return lines.join("\n");
    }

    formatRunMetricsSummaryFromResult(result) {
        const r = result && typeof result === "object" ? result : {};
        const recMs = Number(r.recording_duration_ms || 0);
        const chunksTotal = Number(r.chunks_total || 0);
        const chunksDone = Number(r.chunks_done || 0);
        const chunksFailed = Number(r.chunks_failed || 0);
        const chunksPending = Number(r.chunks_pending || Math.max(0, chunksTotal - chunksDone - chunksFailed));
        const chunkReasons = r.chunk_reason_counts && typeof r.chunk_reason_counts === "object"
            ? r.chunk_reason_counts
            : {};
        const finalizationState = String(r.finalization_state || "").trim();

        const gpuProxyTranscribeTimeS = Number(r.gpu_proxy_transcribe_s || 0);
        const gpuProxyPipelineTimeS = Number(r.gpu_proxy_pipeline_s || 0);

        const recordingS = recMs > 0 ? recMs / 1000 : 0;
        const gpuProxyTranscribePct = recordingS > 0 ? (gpuProxyTranscribeTimeS / recordingS) * 100 : null;
        const gpuProxyPipelinePct = recordingS > 0 ? (gpuProxyPipelineTimeS / recordingS) * 100 : null;

        const lines = [];
        lines.push(
            `Run: ${chunksDone}/${chunksTotal} chunks ready`
            + ` (failed ${chunksFailed}, pending ${chunksPending})`
            + (recMs > 0 ? ` | recording ${(recMs / 1000).toFixed(1)}s` : "")
        );
        const reasonPairs = Object.entries(chunkReasons).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        if (reasonPairs.length) {
            lines.push(`Chunk reasons: ${reasonPairs.map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        lines.push(
            `GPU proxy transcribe time: ${gpuProxyTranscribeTimeS.toFixed(2)}s`
            + (gpuProxyTranscribePct !== null && Number.isFinite(gpuProxyTranscribePct) ? ` (${gpuProxyTranscribePct.toFixed(1)}% of recording)` : "")
        );
        lines.push(
            `GPU proxy pipeline time: ${gpuProxyPipelineTimeS.toFixed(2)}s`
            + (gpuProxyPipelinePct !== null && Number.isFinite(gpuProxyPipelinePct) ? ` (${gpuProxyPipelinePct.toFixed(1)}% of recording)` : "")
        );
        lines.push(`Finalization: ${finalizationState || "unknown"}`);
        return lines.join("\n");
    }

    applyLiveQualityEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        this.qualityEnvelope = e;
        this.qualitySummaryText = this.formatQualitySummary(e);
        this._appendQualityTimelineEntry("final", this.qualitySummaryText);
        this.updateQualityPlaceholder();

        const sid = String(e.session_id || this.getCurrentSessionId() || "").trim();
        const revision = Number(
            e && e.quality && e.quality.run_metrics && e.quality.run_metrics.transcript_revision
                ? e.quality.run_metrics.transcript_revision
                : (this.resultEnvelope && this.resultEnvelope.result ? this.resultEnvelope.result.transcript_revision : 0)
        );
        this.qualityLoadedSessionId = sid;
        this.qualityLoadedRevision = Number.isFinite(revision) ? revision : -1;
    }

    async refreshLiveQuality(options = {}) {
        const quiet = options.quiet === true;
        const sid = this.getCurrentSessionId();
        if (!sid || !this.sessionService) return false;
        if (this.qualityInFlight) return false;
        this.qualityInFlight = true;
        try {
            const envelope = await this.sessionService.fetchQuality(sid);
            this.applyLiveQualityEnvelope(envelope);
            return true;
        } catch (err) {
            if (!quiet) {
                const msg = err && err.message ? err.message : String(err);
                this.appendLog(`Quality fetch failed: ${msg}`);
            }
            return false;
        } finally {
            this.qualityInFlight = false;
            this.updateControls();
        }
    }

    _appendQualityTimelineEntry(kind, summaryText) {
        const body = String(summaryText || "").trim();
        if (!body) return false;
        if (!Array.isArray(this.qualityTimelineEntries)) {
            this.qualityTimelineEntries = [];
        }
        const label = "Final quality";
        const stamp = new Date().toISOString().slice(11, 19);
        const entry = {
            kind: String(kind || "final"),
            label,
            stamp,
            body,
        };
        const last = this.qualityTimelineEntries[this.qualityTimelineEntries.length - 1];
        if (last && last.kind === entry.kind && last.body === entry.body) {
            return false;
        }
        this.qualityTimelineEntries.push(entry);
        return true;
    }

    _formatQualityTimelineText(options = {}) {
        const includeKinds = Array.isArray(options.includeKinds) ? new Set(options.includeKinds.map((v) => String(v || "").toLowerCase())) : null;
        const baseEntries = Array.isArray(this.qualityTimelineEntries) ? this.qualityTimelineEntries : [];
        const entries = includeKinds ? baseEntries.filter((entry) => includeKinds.has(String(entry && entry.kind || "").toLowerCase())) : baseEntries;
        if (!entries.length) return "";
        return entries.map((entry, idx) => {
            const n = idx + 1;
            const head = `#${n} ${String(entry.stamp || "")} · ${String(entry.label || "Update")}`;
            return `${head}\n${String(entry.body || "")}`;
        }).join("\n\n");
    }

    updateQualityPlaceholder() {
        if (!this.el.qualityText) return;

        const finalTimelineTxt = this._formatQualityTimelineText({ includeKinds: ["final"] });
        const combinedSections = [];
        const runTxt = String(this.runMetricsSummaryText || "").trim();
        if (runTxt) combinedSections.push(`Run Metrics\n${runTxt}`);
        if (finalTimelineTxt) combinedSections.push(`Final Fixture Benchmark\n${finalTimelineTxt}`);
        const timelineTxt = combinedSections.join("\n\n").trim();
        const finalTxt = String(this.qualitySummaryText || "").trim();
        const txt = timelineTxt || finalTxt;
        if (txt) {
            this.el.qualityText.textContent = txt;
            this.el.qualityText.setAttribute("data-empty", "0");
            this.el.qualityText.setAttribute("data-placeholder", "");
            return;
        }

        this.el.qualityText.textContent = "";
        this.el.qualityText.setAttribute("data-empty", "1");

        const result = this.resultEnvelope && this.resultEnvelope.result && typeof this.resultEnvelope.result === "object"
            ? this.resultEnvelope.result
            : {};
        const fixtureId = String((result && result.fixture_id) || (this.currentFixtureMeta && this.currentFixtureMeta.fixture_id) || "").trim();
        let placeholder = "Run metrics appear here after transcript finalization.";
        if (fixtureId && (this.awaitingLiveResult || this.audioStreaming || this.remoteState === "finalizing")) {
            placeholder = `Fixture ${fixtureId}: run metrics and final quality appear when the transcript is ready.`;
        } else if (fixtureId) {
            placeholder = `Fixture ${fixtureId}: no run metrics/quality available yet.`;
        }
        this.el.qualityText.setAttribute("data-placeholder", placeholder);
    }

    applyLiveResultEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        const result = e.result && typeof e.result === "object" ? e.result : {};
        const sid = this.getCurrentSessionId();

        this.resultEnvelope = e;
        this.resultCanExportWav = !!e.can_export_wav;
        this.resultCanExportSrt = !!e.can_export_srt;
        this.resultWavUrl = this.resultCanExportWav ? String(e.recording_wav_url || "") : "";
        this.resultSrtUrl = this.resultCanExportSrt ? String(e.transcript_srt_url || "") : "";

        const finalSegments = Array.isArray(result.final_segments) ? result.final_segments : [];
        const preview = result.preview && typeof result.preview === "object"
            ? result.preview
            : {};
        const previewText = String(preview.text || "");
        const previewSeq = Number(preview.preview_seq ?? -1);
        let transcriptChanged = false;
        const nextSegmentsSignature = this._segmentsSignature(finalSegments);
        const finalChanged = this.finalSegmentsSignature !== nextSegmentsSignature;
        if (finalChanged) {
            this.finalSegments = finalSegments.map((seg) => (
                seg && typeof seg === "object" ? seg : {}
            ));
            this.finalSegmentsSignature = nextSegmentsSignature;
            transcriptChanged = true;
        }
        const nextPreviewText = previewText;
        const previewChanged = this.previewText !== nextPreviewText;
        if (previewChanged) {
            this.previewText = nextPreviewText;
            transcriptChanged = true;
        }
        if (this.previewSeq !== previewSeq) {
            this.previewSeq = previewSeq;
        }
        if (transcriptChanged) {
            this.renderTranscriptText();
            this.recordCadenceVisibleUpdate({ finalChanged, previewChanged });
        }

        this.partialText = this.formatLiveSummary(result);
        this.runMetricsSummaryText = this.formatRunMetricsSummaryFromResult(result);
        this.applyVadStateFromResult(result);
        this.updatePartialPlaceholder();
        this.updateCadenceIndicator();
        this.currentFixtureMeta = String(result.fixture_id || "").trim()
            ? {
                fixture_id: String(result.fixture_id || "").trim(),
                fixture_version: String(result.fixture_version || "").trim(),
                fixture_test_mode: String(result.fixture_test_mode || "").trim(),
            }
            : this.currentFixtureMeta;
        this.updateQualityPlaceholder();

        const finalizationState = String(result.finalization_state || "").trim().toLowerCase();
        const ready = !!e.ready || finalizationState === "ready";
        const fixtureIdForBenchmark = String(result.fixture_id || (this.currentFixtureMeta && this.currentFixtureMeta.fixture_id) || "").trim();

        if (ready) {
            this.awaitingLiveResult = false;
            if (!this.audioStreaming) {
                this.remoteState = "ready";
                this.setStatus("ready", "Transcript ready. Download TXT, SRT, or WAV.");
            }
            const rev = Number(result.transcript_revision || 0);
            const qualityAlreadyLoaded = (
                this.qualityLoadedSessionId === String(sid || "")
                && Number(this.qualityLoadedRevision) === rev
            );
            if (String(result.fixture_id || "").trim() && !qualityAlreadyLoaded) {
                void this.refreshLiveQuality({ quiet: true });
            }
        } else if (!this.audioStreaming) {
            if (finalizationState === "error") {
                this.awaitingLiveResult = false;
                this.remoteState = "error";
                this.setStatus("error", "Transcript processing failed.");
            } else if (this.awaitingLiveResult || this.remoteState === "ended" || this.remoteState === "disconnected") {
                this.remoteState = "finalizing";
                this.setStatus("finalizing", "Transcript is being processed in chunks...");
            }
        }

        this.updateControls();
    }

    downloadLiveTranscript(kind) {
        const normalized = String(kind || "").trim().toLowerCase();
        if (normalized === "txt") {
            const text = this.el.finalText ? String(this.el.finalText.innerText || "").trim() : "";
            if (!text) {
                this.appendLog("No txt export available yet");
                return;
            }
            const blob = new Blob([text + "\n"], { type: "text/plain;charset=utf-8" });
            const sid = this.getCurrentSessionId() || "live-transcript";
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${sid}.txt`;
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(a.href), 0);
            return;
        }
        const url = normalized === "wav"
            ? this.resultWavUrl
            : normalized === "srt"
                ? this.resultSrtUrl
                : "";
        if (!url) {
            this.appendLog(`No ${normalized || "transcript"} export available yet`);
            return;
        }
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    formatStatsPayload(payload) {
        const p = payload && typeof payload === "object" ? payload : {};
        const num = (key, fallback = 0) => Number(p[key] ?? fallback);
        const boolish = (key) => {
            const v = p[key];
            if (v === undefined || v === null) return "?";
            return String(v);
        };

        const lines = [
            `bytes=${num("bytes_received")} frames=${num("frames_received")} uptime=${num("uptime_s").toFixed(2)}s`,
            `mode=${String(p.live_mode || "single_lane")} recording=${boolish("live_recording_state")} finalization=${boolish("live_finalization_state")}`,
            `rec_ms=${num("live_recording_duration_ms")} chunks=${num("live_commits_done")}/${num("live_commits_total")} failed=${num("live_commits_failed")}`,
            `jobs pending=${num("live_jobs_pending")} inflight=${boolish("live_inflight")}`,
        ];
        const g = p.rolling_guardrails && typeof p.rolling_guardrails === "object" ? p.rolling_guardrails : null;
        if (g) {
            const checks = Number(g.vad_checks);
            const speech = Number(g.vad_speech_allows);
            const hangover = Number(g.vad_hangover_allows);
            const silence = Number(g.vad_silence_skips);
            if (Number.isFinite(checks) || Number.isFinite(speech) || Number.isFinite(hangover) || Number.isFinite(silence)) {
                lines.push(
                    `vad checks=${Number.isFinite(checks) ? checks : "?"}`
                    + ` speech=${Number.isFinite(speech) ? speech : "?"}`
                    + ` hangover=${Number.isFinite(hangover) ? hangover : "?"}`
                    + ` silence=${Number.isFinite(silence) ? silence : "?"}`
                );
            }
        }

        const extra = Object.keys(p)
            .filter((k) => k !== "type" && k !== "session_id" && k !== "seq")
            .sort()
            .map((k) => `${k}: ${typeof p[k] === "object" ? JSON.stringify(p[k]) : String(p[k])}`);
        if (extra.length) {
            lines.push("");
            lines.push("raw:");
            lines.push(...extra);
        }
        return lines.join("\n");
    }

    updateControls() {
        const wsConnecting = !!(this.sessionService && this.sessionService.isConnecting());
        const wsOpen = !!(this.sessionService && this.sessionService.isOpen());

        // Determine UI phase
        let phase = "idle";
        if (wsConnecting && !this.audioStreaming) {
            phase = "connecting";
        } else if (this.audioStreaming && this.audioPaused) {
            phase = "paused";
        } else if (this.audioStreaming) {
            phase = "listening";
        } else if (this.awaitingLiveResult || this.remoteState === "finalizing") {
            phase = "finalizing";
        } else if (this.remoteState === "ready" || this.remoteState === "ended") {
            phase = "finished";
        } else if (this.remoteState === "error") {
            phase = "error";
        }

        this.setUiPhase(phase);

        if (this.el.languageSelect) {
            this.syncLanguageSelectUi();
        }

        // Dev fixture controls
        if (this.el.fixtureSelect) {
            this.el.fixtureSelect.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
            if (this.el.fixtureSelect.value !== this.selectedFixtureKey) {
                this.el.fixtureSelect.value = this.selectedFixtureKey;
            }
        }
        if (this.el.runFixturePlayBtn) {
            this.el.runFixturePlayBtn.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
            this.el.runFixturePlayBtn.textContent = this.fixtureRunActive
                ? (this.fixtureRunLabel ? `Running: ${this.fixtureRunLabel}` : "Fixture running...")
                : "Play fixture";
        }
        if (this.el.runFixtureInjectBtn) {
            this.el.runFixtureInjectBtn.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
            this.el.runFixtureInjectBtn.textContent = this.fixtureRunActive
                ? (this.fixtureRunLabel ? `Running: ${this.fixtureRunLabel}` : "Fixture running...")
                : "Inject fixture";
        }

        // Download buttons (enabled when export is ready)
        if (this.el.downloadWavBtn) this.el.downloadWavBtn.disabled = !this.resultCanExportWav;
        if (this.el.downloadTxtBtn) {
            const txt = this.el.finalText ? String(this.el.finalText.innerText || "").trim() : "";
            this.el.downloadTxtBtn.disabled = !txt;
        }
        if (this.el.downloadSrtBtn) this.el.downloadSrtBtn.disabled = !this.resultCanExportSrt;

        if (this.el.sessionId) {
            const sid = this.sessionService ? this.sessionService.getSessionId() : "";
            this.el.sessionId.textContent = sid || "(none)";
        }
        if (this.audioSettingsPanelOpen) {
            this.refreshAudioSettingsPanel({ readCurrent: true });
        }
        this.syncAppLiveNavState();
    }

    setUiPhase(phase) {
        const badgeLabels = {
            idle: "Ready",
            connecting: "Connecting...",
            listening: "Listening...",
            paused: "Paused...",
            finalizing: "Processing...",
            finished: "Recording Saved",
            error: "Error",
        };
        const badgeClasses = {
            idle: "status-idle",
            connecting: "status-connecting",
            listening: "status-listening",
            paused: "status-paused",
            finalizing: "status-finalizing",
            finished: "status-finished",
            error: "status-error",
        };
        if (this.el.statusBadge) {
            this.el.statusBadge.textContent = badgeLabels[phase] || phase;
            this.el.statusBadge.className = `live-status-badge ${badgeClasses[phase] || "status-idle"}`;
        }

        // Placeholder vs transcript text
        const showTranscript = phase !== "idle" && phase !== "connecting";
        if (this.el.placeholder) this.el.placeholder.classList.toggle("hidden", showTranscript);
        const hasTranscript = this.finalSegments.length > 0 || !!String(this.previewText || "").trim();
        if (this.el.finalText) this.el.finalText.classList.toggle("hidden", !showTranscript || !hasTranscript);

        // Timer: visible in listening + paused
        const showTimer = phase === "listening" || phase === "paused";
        const showLanguagePicker = phase === "idle" || phase === "connecting" || phase === "listening" || phase === "paused";
        const compactLanguagePicker = phase === "listening" || phase === "paused";
        if (this.el.languagePicker) this.el.languagePicker.classList.toggle("hidden", !showLanguagePicker);
        if (this.el.languagePicker) this.el.languagePicker.classList.toggle("is-compact", compactLanguagePicker);
        if (this.el.durationText) this.el.durationText.classList.toggle("hidden", !showTimer);
        if (this.el.durationTextTop) this.el.durationTextTop.classList.toggle("hidden", !showTimer);

        // Floating card panels
        if (this.el.floatIdle) this.el.floatIdle.classList.toggle("hidden", phase !== "idle");
        if (this.el.floatListening) this.el.floatListening.classList.toggle("hidden", phase !== "listening");
        if (this.el.floatPaused) this.el.floatPaused.classList.toggle("hidden", phase !== "paused");
        if (this.el.floatFinished) this.el.floatFinished.classList.toggle("hidden", phase !== "finished");
        if (this.el.floatProcessing) {
            const showProc = phase === "connecting" || phase === "finalizing";
            this.el.floatProcessing.classList.toggle("hidden", !showProc);
            if (showProc && this.el.processingText) {
                this.el.processingText.textContent = phase === "connecting" ? "Connecting..." : "Processing recording...";
            }
        }
        this.updateVadIndicator();
    }


    async connectSession() {
        if (!this.sessionService) this.initServices();
        if (!this.sessionService) return false;
        if (this.sessionService.isOpen() || this.sessionService.isConnecting()) {
            return true;
        }

        this.setStatus("connecting", "Creating live session...");
        this.updateControls();

        try {
            await this.sessionService.connect({
                language: this.getRequestedSessionLanguage(),
            });
            this.resetLiveResultState();
            this.currentFixtureMeta = null;
            this.awaitingLiveResult = false;
            this.updateQualityPlaceholder();
            this.updateControls();
            return true;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.appendLog(`Connect failed: ${msg}`);
            this.stopAudioCapture({ quiet: true });
            if (this.sessionService) {
                this.sessionService.destroy("connect_failed", { sendStop: false });
            }
            this.remoteState = "error";
            this.setStatus("error", `Connect failed: ${msg}`);
            if (this.app && typeof this.app.showAlert === "function") {
                this.app.showAlert("Live connection failed", msg);
            }
            this.updateControls();
            return false;
        }
    }

    waitForSocketOpen(timeoutMs = 4000) {
        const startAt = Date.now();
        return new Promise((resolve) => {
            const tick = () => {
                if (this.sessionService && this.sessionService.isOpen()) {
                    resolve(true);
                    return;
                }
                if (!this.sessionService || !this.sessionService.isConnecting()) {
                    resolve(false);
                    return;
                }
                if (Date.now() - startAt >= timeoutMs) {
                    resolve(false);
                    return;
                }
                window.setTimeout(tick, 50);
            };
            tick();
        });
    }

    buildMicPermissionGuidance(err) {
        const name = String(err && err.name ? err.name : "").trim();
        const isPermissionError = ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(name);
        if (!isPermissionError) return null;

        const shortMessage = this.isLikelyMobile
            ? "Microphone permission blocked. Check your phone app and site permissions, then reload."
            : "Microphone permission blocked. Allow microphone access in browser/site settings, then reload.";

        const lines = ["Microphone access was denied.", ""];
        if (this.isLikelyMobile) {
            lines.push("On mobile, check both:");
            lines.push("1. Phone Settings > Apps > [your browser] > Permissions > Microphone = Allow");
            lines.push("2. Browser site settings for this site > Microphone = Allow");
        } else {
            lines.push("Check this page's microphone permission in your browser/site settings and set it to Allow.");
        }
        lines.push("Then reload the page and try again.");
        lines.push("Tip: 'Inject fixture' does not require microphone access.");

        return {
            shortMessage,
            alertMessage: lines.join("\n"),
        };
    }

    async startMic() {
        if (!this.sessionService) this.initServices();
        if (!this.audioService) this.initServices();
        if (!this.sessionService || !this.audioService) return;

        if (!this.sessionService.isOpen()) {
            const connectStarted = await this.connectSession();
            if (!connectStarted) return;

            if (this.sessionService.isConnecting()) {
                const opened = await this.waitForSocketOpen(5000);
                if (!opened) {
                    this.appendLog("WebSocket did not open in time");
                    this.setStatus("error", "Could not open live connection");
                    this.updateControls();
                    return;
                }
            }
        }

        if (!this.sessionService.isOpen()) {
            this.appendLog("Cannot start microphone, websocket is not open.");
            this.setStatus("error", "Live connection is not open");
            this.updateControls();
            return;
        }

        try {
            if (!this.audioService.isCapturing()) {
                await this.audioService.start();
                this.stopRecordingTimer({ reset: true });
            } else {
                this.audioService.resume();
            }

            this.audioStreaming = true;
            this.audioPaused = false;
            this.awaitingLiveResult = false;
            this.remoteState = "listening";
            this.startRecordingTimer();
            this.sessionService.sendControl("start");
            this.setStatus("listening", "Recording in progress.");
            this.updatePartialPlaceholder();
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            const permissionHelp = this.buildMicPermissionGuidance(err);
            this.appendLog(`Microphone start failed: ${msg}`);
            this.setStatus("error", permissionHelp ? permissionHelp.shortMessage : `Microphone start failed: ${msg}`);
            if (this.app && typeof this.app.showAlert === "function") {
                this.app.showAlert("Microphone access failed", permissionHelp ? permissionHelp.alertMessage : msg);
            }
        }

        this.updateControls();
    }

    pauseMic() {
        if (!this.audioService || !this.audioStreaming) return;

        this.audioService.pause();
        this.audioPaused = true;
        this.remoteState = "paused";
        this.stopRecordingTimer({ reset: false });
        this.sessionService && this.sessionService.sendControl("pause");
        this.setStatus("paused", "Recording paused. Resume to continue.");
        this.updatePartialPlaceholder();
        this.updateControls();
    }

    resumeMic() {
        if (!this.audioService || !this.audioStreaming) return;

        this.audioService.resume();
        this.audioPaused = false;
        this.remoteState = "listening";
        this.startRecordingTimer();
        this.sessionService && this.sessionService.sendControl("resume");
        this.setStatus("listening", "Recording in progress.");
        this.updatePartialPlaceholder();
        this.updateControls();
    }

    cancelFixtureRun(reason = "cancelled") {
        if (this.fixtureStopTimerId !== null) {
            window.clearTimeout(this.fixtureStopTimerId);
            this.fixtureStopTimerId = null;
        }
        if (this.fixtureWatchdogTimerId !== null) {
            window.clearTimeout(this.fixtureWatchdogTimerId);
            this.fixtureWatchdogTimerId = null;
        }
        if (this.fixtureAudio) {
            try {
                this.fixtureAudio.pause();
            } catch {
                // ignore
            }
            try {
                this.fixtureAudio.src = "";
            } catch {
                // ignore
            }
            this.fixtureAudio = null;
        }

        const wasActive = this.fixtureRunActive;
        this.fixtureRunActive = false;
        this.fixtureRunLabel = "";
        this.fixtureRunToken += 1;
        if (wasActive) {
            this.appendLog(`Fixture run cancelled (${reason})`);
        }
        this.updateControls();
    }

    getSelectedFixtureConfig(mode = "playback") {
        const selected = String(
            (this.el.fixtureSelect && this.el.fixtureSelect.value)
            || this.selectedFixtureKey
            || (DEV_LIVE_FIXTURE_OPTIONS[0] ? DEV_LIVE_FIXTURE_OPTIONS[0].value : "panel120v1")
        ).trim();
        const normalizedMode = String(mode || "playback").trim().toLowerCase();
        const key = normalizedMode === "inject" ? `${selected}Inject` : selected;
        return DEV_LIVE_FIXTURES[key] || DEV_LIVE_FIXTURES.panel120v1;
    }

    async startSelectedFixtureRun(mode = "playback") {
        const cfg = this.getSelectedFixtureConfig(mode);
        return this.startFixtureRun(cfg);
    }

    async startFixtureRun(fixture) {
        const cfg = fixture && typeof fixture === "object" ? fixture : null;
        if (!cfg || !cfg.url) return;
        const mode = String(cfg.mode || "playback").trim().toLowerCase();
        if (mode === "playback" && this.isLikelyMobile) {
            this.appendLog("Play fixture is disabled on mobile. Use Inject fixture instead.");
            this.setStatus("ready", "Use Inject fixture on mobile for reliable tests.");
            this.updateControls();
            return;
        }
        if (mode === "inject") {
            return this.startFixtureInjectRun(cfg);
        }
        if (this.fixtureRunActive || this.audioStreaming) {
            this.appendLog("Fixture run ignored (already active or recording)");
            return;
        }

        this.cancelFixtureRun("replace");
        this.fixtureRunActive = true;
        this.fixtureRunLabel = String(cfg.id || "fixture");
        const token = this.fixtureRunToken + 1;
        this.fixtureRunToken = token;
        this.updateControls();

        const waitMs = (ms) => new Promise((resolve) => {
            window.setTimeout(resolve, Math.max(0, Number(ms || 0)));
        });

        const audio = new Audio(String(cfg.url));
        audio.preload = "auto";
        this.fixtureAudio = audio;
        let finishRequested = false;

        const finishIfStillCurrent = async (why) => {
            if (finishRequested) return;
            finishRequested = true;
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
            if (this.fixtureWatchdogTimerId !== null) {
                window.clearTimeout(this.fixtureWatchdogTimerId);
                this.fixtureWatchdogTimerId = null;
            }
            this.appendLog(`Fixture playback ended (${why}), stopping recording...`);
            this.fixtureStopTimerId = window.setTimeout(() => {
                this.fixtureStopTimerId = null;
                if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
                this.fixtureRunActive = false;
                this.fixtureRunLabel = "";
                try {
                    void this.stopMic();
                } finally {
                    if (this.fixtureAudio) {
                        try {
                            this.fixtureAudio.pause();
                        } catch {
                            // ignore
                        }
                        this.fixtureAudio = null;
                    }
                    this.updateControls();
                }
            }, Math.max(0, Number(cfg.tailDelayMs || 0)));
        };

        audio.addEventListener("ended", () => {
            void finishIfStillCurrent("ended");
        }, { once: true });

        audio.addEventListener("error", () => {
            const err = audio.error;
            const msg = err && err.message ? err.message : "Audio playback failed";
            if (this.fixtureRunActive && this.fixtureRunToken === token) {
                this.appendLog(`Fixture playback error: ${msg}`);
                this.fixtureRunActive = false;
                this.fixtureRunLabel = "";
                this.updateControls();
                if (this.audioStreaming) {
                    this.stopMic();
                }
            }
        }, { once: true });

        try {
            this.appendLog(`Fixture run start: ${cfg.id || "fixture"} -> ${cfg.url}`);
            await this.startMic();
            if (!this.audioStreaming) {
                throw new Error("Recording did not start");
            }
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;

            this.currentFixtureMeta = {
                fixture_id: String(cfg.id || "").trim(),
                fixture_version: String(cfg.version || "").trim(),
                fixture_test_mode: "playback",
            };
            if (this.sessionService && this.currentFixtureMeta.fixture_id) {
                try {
                    await this.sessionService.setFixtureMetadata(this.currentFixtureMeta);
                    this.appendLog(`Fixture metadata registered (${this.currentFixtureMeta.fixture_id})`);
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    this.appendLog(`Fixture metadata register failed: ${msg}`);
                }
            }
            this.updateQualityPlaceholder();

            await waitMs(Number(cfg.startDelayMs || 0));
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;

            const playPromise = audio.play();
            if (playPromise && typeof playPromise.then === "function") {
                await playPromise;
            }
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
            this.appendLog(`Fixture playback started: ${cfg.id || "fixture"}`);
            const durationMs = Math.max(0, Number(cfg.durationMs || 0));
            if (durationMs > 0) {
                const watchdogGraceMs = 2500;
                this.fixtureWatchdogTimerId = window.setTimeout(() => {
                    this.fixtureWatchdogTimerId = null;
                    void finishIfStillCurrent("watchdog_timeout");
                }, durationMs + watchdogGraceMs);
            }
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (this.fixtureRunActive && this.fixtureRunToken === token) {
                this.appendLog(`Fixture run failed: ${msg}`);
                this.fixtureRunActive = false;
                this.fixtureRunLabel = "";
                if (this.audioStreaming) {
                    this.stopMic();
                }
                this.updateControls();
            }
        }
    }

    async startFixtureInjectRun(fixture) {
        const cfg = fixture && typeof fixture === "object" ? fixture : null;
        if (!cfg || !cfg.url) return;
        if (this.fixtureRunActive || this.audioStreaming) {
            this.appendLog("Fixture inject run ignored (already active or recording)");
            return;
        }

        this.cancelFixtureRun("replace");
        this.fixtureRunActive = true;
        this.fixtureRunLabel = String(cfg.id || "fixture") + " (inject)";
        const token = this.fixtureRunToken + 1;
        this.fixtureRunToken = token;
        this.updateControls();

        const waitMs = (ms) => new Promise((resolve) => {
            window.setTimeout(resolve, Math.max(0, Number(ms || 0)));
        });

        const decodeFixtureToMono = async (url) => {
            const res = await fetch(String(url), { cache: "no-store" });
            if (!res.ok) {
                throw new Error(`Fixture fetch failed (${res.status})`);
            }
            const bytes = await res.arrayBuffer();
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error("Web Audio API not available in this browser.");
            const ctx = new Ctx({ latencyHint: "interactive" });
            try {
                const audioBuf = await ctx.decodeAudioData(bytes.slice(0));
                const channels = Math.max(1, Number(audioBuf.numberOfChannels || 1));
                const frameLength = Math.max(0, Number(audioBuf.length || 0));
                const mixed = new Float32Array(frameLength);
                for (let c = 0; c < channels; c += 1) {
                    const data = audioBuf.getChannelData(c);
                    if (!data || data.length !== frameLength) continue;
                    for (let i = 0; i < frameLength; i += 1) mixed[i] += data[i];
                }
                if (channels > 1) {
                    for (let i = 0; i < frameLength; i += 1) mixed[i] /= channels;
                }
                return {
                    sampleRate: Number(audioBuf.sampleRate || 0) || 0,
                    samples: mixed,
                };
            } finally {
                try {
                    await ctx.close();
                } catch {
                    // ignore
                }
            }
        };

        const streamPcmToSocketRealtime = async (pcmFrames, sampleRate) => {
            const targetRate = (this.audioService && Number(this.audioService.targetSampleRate)) || 16000;
            const chunkMs = (this.audioService && Number(this.audioService.chunkMs)) || 40;
            const chunkSamples = Math.max(80, Math.round((targetRate * chunkMs) / 1000));
            const mono16k = downsampleBuffer(pcmFrames, Number(sampleRate || targetRate), targetRate);
            const totalChunks = Math.ceil((mono16k.length || 0) / chunkSamples);
            this.appendLog(`Fixture inject decoded: ${mono16k.length} samples @${targetRate}Hz (~${(mono16k.length / targetRate).toFixed(2)}s), chunks=${totalChunks}`);
            let nextDue = performance.now();
            for (let off = 0, idx = 0; off < mono16k.length; off += chunkSamples, idx += 1) {
                if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
                if (!this.sessionService || !this.sessionService.isOpen()) {
                    throw new Error("Live socket closed during fixture inject");
                }
                const frame = mono16k.slice(off, Math.min(mono16k.length, off + chunkSamples));
                const pcm = float32ToPcm16LeBuffer(frame);
                const ok = this.sessionService.sendAudioChunk(pcm);
                if (!ok) {
                    throw new Error("Socket not writable during fixture inject");
                }
                nextDue += chunkMs;
                const wait = Math.max(0, nextDue - performance.now());
                if (wait > 0) {
                    await waitMs(wait);
                } else {
                    await Promise.resolve();
                }
            }
        };

        try {
            this.appendLog(`Fixture inject run start: ${cfg.id || "fixture"} -> ${cfg.url}`);
            const connectStarted = await this.connectSession();
            if (!connectStarted) throw new Error("Live session connect failed");
            if (this.sessionService && this.sessionService.isConnecting()) {
                const opened = await this.waitForSocketOpen(5000);
                if (!opened) throw new Error("WebSocket did not open in time");
            }
            if (!this.sessionService || !this.sessionService.isOpen()) {
                throw new Error("Live connection is not open");
            }

            this.stopRecordingTimer({ reset: true });
            this.audioStreaming = true;
            this.audioPaused = false;
            this.awaitingLiveResult = false;
            this.remoteState = "listening";
            this.sessionService.sendControl("start");
            this.setStatus("listening", "Fixture inject in progress.");
            this.updatePartialPlaceholder();

            this.currentFixtureMeta = {
                fixture_id: String(cfg.id || "").trim(),
                fixture_version: String(cfg.version || "").trim(),
                fixture_test_mode: "inject",
            };
            if (this.sessionService && this.currentFixtureMeta.fixture_id) {
                try {
                    await this.sessionService.setFixtureMetadata(this.currentFixtureMeta);
                    this.appendLog(`Fixture metadata registered (${this.currentFixtureMeta.fixture_id}, inject)`);
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    this.appendLog(`Fixture metadata register failed: ${msg}`);
                }
            }
            this.updateQualityPlaceholder();
            this.updateControls();

            await waitMs(Number(cfg.startDelayMs || 0));
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;

            const decoded = await decodeFixtureToMono(cfg.url);
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
            this.startRecordingTimer();
            await streamPcmToSocketRealtime(decoded.samples, decoded.sampleRate);
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;

            this.appendLog(`Fixture inject completed: ${cfg.id || "fixture"}; stopping recording...`);
            this.fixtureStopTimerId = window.setTimeout(() => {
                this.fixtureStopTimerId = null;
                if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
                this.fixtureRunActive = false;
                this.fixtureRunLabel = "";
                try {
                    void this.stopMic();
                } finally {
                    this.updateControls();
                }
            }, Math.max(0, Number(cfg.tailDelayMs || 0)));
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (this.fixtureRunActive && this.fixtureRunToken === token) {
                this.appendLog(`Fixture inject run failed: ${msg}`);
                this.fixtureRunActive = false;
                this.fixtureRunLabel = "";
                if (this.audioStreaming) {
                    this.stopMic();
                }
                this.updateControls();
            }
        }
    }

    stopMic() {
        this.cancelFixtureRun("user_stop");
        this.stopAudioCapture({ quiet: true });
        this.stopRecordingTimer({ reset: false });

        if (this.sessionService) {
            const ok = this.sessionService.sendControl("stop");
            if (!ok) {
                this.appendLog("Failed to send stop control (socket not open)");
            }
        }

        this.awaitingLiveResult = true;
        this.remoteState = "finalizing";
        this.setStatus("finalizing", "Recording stopped. Processing final chunks...");
        this.updatePartialPlaceholder();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    stopAudioCapture(options = {}) {
        const quiet = options.quiet === true;

        if (this.audioService && this.audioService.isCapturing()) {
            this.audioService.stop();
            if (!quiet) this.appendLog("Microphone capture stopped");
        }

        this.audioStreaming = false;
        this.audioPaused = false;
    }

    cleanupSession(reason = "manual_close", options = {}) {
        this.cancelFixtureRun(`cleanup:${reason}`);
        this.stopAudioCapture({ quiet: true });
        this.stopRecordingTimer({ reset: true });
        this.awaitingLiveResult = false;

        if (this.sessionService) {
            this.sessionService.destroy(reason, { sendStop: options.sendStop !== false });
        }

        this.remoteState = "idle";
        this.currentFixtureMeta = null;
        this.setStatus("idle", "Not connected");
        this.updatePartialPlaceholder();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    sendControl(type) {
        const msgType = String(type || "").trim().toLowerCase();
        if (!msgType) return;
        if (!this.sessionService || !this.sessionService.isOpen()) {
            this.appendLog(`Cannot send '${msgType}', websocket is not open.`);
            return;
        }

        const ok = this.sessionService.sendControl(msgType);
        if (!ok) {
            this.appendLog(`Failed to send '${msgType}'.`);
        }
    }

    startRecordingTimer() {
        if (this.recordingStartedAtMs <= 0) {
            this.recordingStartedAtMs = Date.now();
            this.ensureCadenceStarted(this.recordingStartedAtMs);
        }
        if (this.recordingTimerId !== null) return;

        this.updateDurationDisplay();
        this.recordingTimerId = window.setInterval(() => {
            this.updateDurationDisplay();
        }, 250);
    }

    stopRecordingTimer(options = {}) {
        const reset = options.reset === true;
        if (this.recordingStartedAtMs > 0) {
            this.recordingElapsedMs += Date.now() - this.recordingStartedAtMs;
            this.recordingStartedAtMs = 0;
        }
        if (this.recordingTimerId !== null) {
            window.clearInterval(this.recordingTimerId);
            this.recordingTimerId = null;
        }
        if (reset) {
            this.recordingElapsedMs = 0;
        }
        this.updateDurationDisplay();
        this.updateCadenceIndicator();
    }

    getRecordingElapsedMs() {
        let total = this.recordingElapsedMs;
        if (this.recordingStartedAtMs > 0) {
            total += Date.now() - this.recordingStartedAtMs;
        }
        return Math.max(0, total);
    }

    updateDurationDisplay() {
        if (!this.el.durationText && !this.el.durationTextTop) {
            this.updateCadenceIndicator();
            return;
        }
        const totalSeconds = Math.floor(this.getRecordingElapsedMs() / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const mm = String(minutes).padStart(2, "0");
        const ss = String(seconds).padStart(2, "0");
        const display = hours > 0
            ? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
            : `${mm}:${ss}`;
        if (this.el.durationText) this.el.durationText.textContent = display;
        if (this.el.durationTextTop) this.el.durationTextTop.textContent = display;
        this.updateCadenceIndicator();
    }

    updatePartialPlaceholder() {
        if (!this.el.partialText) return;

        const hasText = !!String(this.partialText || "").trim();
        if (hasText) {
            this.el.partialText.textContent = this.partialText;
            this.el.partialText.setAttribute("data-empty", "0");
            this.el.partialText.setAttribute("data-placeholder", "");
            return;
        }

        this.el.partialText.textContent = "";
        this.el.partialText.setAttribute("data-empty", "1");

        let placeholder = "Chunk status appears here.";
        if (this.audioStreaming && this.audioPaused) {
            placeholder = "Recording paused.";
        } else if (this.audioStreaming) {
            placeholder = "Recording in progress... transcript updates chunk by chunk.";
        } else if (this.remoteState === "ready" || this.remoteState === "connected") {
            placeholder = "Ready to record.";
        } else if (this.remoteState === "finalizing" || this.remoteState === "processing") {
            placeholder = "Transcript is being processed...";
        } else if (this.remoteState === "ended") {
            placeholder = "Recording finished. Waiting for final transcript batches.";
        }
        this.el.partialText.setAttribute("data-placeholder", placeholder);
    }

    handleServerMessage(raw) {
        let payload = null;
        try {
            payload = JSON.parse(String(raw || ""));
        } catch {
            this.appendLog(`Invalid JSON from server: ${String(raw || "")}`);
            return;
        }

        const t = String(payload.type || "").toLowerCase();
        this.appendLog(`Server -> ${t || "unknown"}`);

        if (t === "ready") {
            this.remoteState = "ready";
            this.setStatus("ready", "Ready. Start recording; transcript will appear in chunks.");
        } else if (t === "result") {
            this.applyLiveResultEnvelope(payload);
        } else if (t === "control_ack") {
            this.remoteState = String(payload.state || this.remoteState || "connected");
            const ctl = String(payload.control_type || "").toLowerCase();
            if (ctl === "pause") {
                this.setStatus("paused", "Recording paused. Resume to continue.");
            } else if (ctl === "resume" || ctl === "start") {
                this.setStatus("listening", "Recording in progress.");
            } else if (ctl === "stop") {
                this.awaitingLiveResult = true;
                this.remoteState = "finalizing";
                this.setStatus("finalizing", "Finalizing recording. Processing final chunks...");
            } else {
                this.setStatus(this.remoteState || "connected", `Control received: ${ctl || "ack"}`);
            }
        } else if (t === "pong") {
            // Keep the end-user status copy stable; pong remains visible in the event log.
        } else if (t === "stats") {
            const b = Number(payload.bytes_received || 0);
            const f = Number(payload.frames_received || 0);
            const s = Number(payload.uptime_s || 0);
            const decodeMs = Number(payload.decode_ms_last || 0);
            const rtf = Number(payload.rtf || 0);
            this.applyVadStateFromStats(payload);
            this.setDevStats(
                `Stats: ${b} bytes, ${f} frames, ${s.toFixed(2)}s, decode ${decodeMs.toFixed(2)}ms, rtf ${rtf.toFixed(3)}\n\n${this.formatStatsPayload(payload)}`
            );
        } else if (t === "ended") {
            this.stopAudioCapture({ quiet: true });
            this.stopRecordingTimer({ reset: false });
            this.awaitingLiveResult = false;
            this.remoteState = "ended";
            this.setStatus("ready", `Recording finished (${payload.reason || "unknown"}).`);
            this.updatePartialPlaceholder();
        } else if (t === "error") {
            const msg = String(payload.message || "Live error");
            this.setStatus("error", msg);
            if (payload.fatal) {
                this.stopAudioCapture({ quiet: true });
                this.stopRecordingTimer({ reset: false });
            }
            if (this.app && typeof this.app.showAlert === "function") {
                this.app.showAlert("Live session error", msg);
            }
            this.updatePartialPlaceholder();
        }

        this.updateControls();
    }
}
