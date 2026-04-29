import { LiveAudioService } from "./LiveAudioService.js";
import { LiveSessionService } from "./LiveSessionService.js";
import { TRANSCRIPT_LANGUAGES } from "../constants/languages.js";
import { DEV_LIVE_FIXTURE_OPTIONS, LIVE_DEMO_LANGUAGE_CODE, LIVE_DEMO_QUERY_VALUE } from "./dev/liveFixtures.js";
import {
    cancelFixtureRun as cancelLiveFixtureRun,
    decodeAudioArrayBufferToMono as decodeFixtureAudioArrayBufferToMono,
    getSelectedFixtureConfig as getSelectedLiveFixtureConfig,
    startFixtureInjectRun as startLiveFixtureInjectRun,
    startFixtureRun as startLiveFixtureRun,
    startSelectedFixtureRun as startSelectedLiveFixtureRun,
    startUploadedAudioInjectRun as startUploadedLiveAudioInjectRun,
    streamDecodedAudioRealtime as streamDecodedFixtureAudioRealtime,
} from "./dev/liveFixtureRuns.js";
import { formatDurationMs, percentile } from "./dev/summaryFormatters.js";
import {
    formatEngineRuntimeSummaryPanel,
    formatLiveSummaryPanel,
    formatQualitySummaryPanel,
    formatRunMetricsSummaryPanel,
} from "./dev/summaryPanels.js";
import {
    DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES,
    buildVisibleTranscriptState,
    formatPreviewSuffixText,
    formatSegmentBlocksDiarizeHardPresentation,
    normalizeSegmentText,
    speakerLabelFromToken,
} from "./transcript/transcriptFormatting.js";
import {
    createLiveVadState,
    extractEngineState,
    nextLiveVadStateFromResult,
    nextLiveVadStateFromStats,
    shouldShowLiveVadSpeechBadge,
    vadLabelForPhase,
} from "./transcript/vadState.js";
import { renderLiveViewHtml } from "./liveViewTemplate.js";
import { createDialogDragController } from "@spa-foundation/core";

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
        this.vadState = createLiveVadState();

        this.audioStreaming = false;
        this.audioPaused = false;
        this.screenWakeLock = null;
        this.screenWakeLockRequestInFlight = false;

        this.sessionService = null;
        this.audioService = null;

        this.recordingElapsedMs = 0;
        this.recordingStartedAtMs = 0;
        this.recordingTimerId = null;

        this.awaitingLiveResult = false;
        this.resultEnvelope = null;
        this.resultCanExportPc = false;
        this.resultCanExportSrt = false;
        this.resultCanExportWav = false;
        this.resultPcUrl = "";
        this.resultSrtUrl = "";
        this.resultWavUrl = "";
        this.resultInFlight = false;
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
        this.runMetricsSummaryText = "";
        this.engineRuntimeSummaryText = "";
        this.lastEngineInflightSummaryText = "";
        this.engineRuntimeInflightStale = false;
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
        this.selectedInjectAudioFile = null;
        this.selectedLanguage = this.loadPreferredLanguage();
        this.demoLanguageRestore = null;
        this.languageSelectMeasureCanvas = null;
        this.audioSettingsPanelOpen = false;
        this.audioSettingsDrag = null;
        this.audioSettingsUi = {
            preGain: 1.0,
            autoGainControl: false,
        };
        this.liveDemoChoiceVisible = false;
        this.devSpeakerLabelsEnabled = true;
        this.liveTranscriptFormatRules = { ...DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES };
        this.handleVisibilityChange = () => {
            if (typeof document === "undefined" || document.visibilityState !== "visible") return;
            void this.syncScreenWakeLock();
        };
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
            document.addEventListener("visibilitychange", this.handleVisibilityChange);
        }

        this.el = {};
    }

    getHtml() {
        return renderLiveViewHtml();
    }


    mount(container) {
        container.innerHTML = this.getHtml();
        this.captureElements();
        this.initServices();
        this.bindUi();
        this.liveDemoChoiceVisible = this.readLiveDemoIntent();
        this.setSpeakerLabelsEnabled(this.devSpeakerLabelsEnabled);
        void this.loadUiSettings();
        this.renderTranscriptText();
        this.updateDurationDisplay();
        this.updatePartialPlaceholder();
        this.updateCadenceIndicator();
        this.updateQualityPlaceholder();
        this.updateControls();
        this.syncLiveDemoOverlay();
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

    isMobileLayout() {
        if (this.app && typeof this.app.isMobile === "function") {
            return !!this.app.isMobile();
        }
        if (typeof document !== "undefined" && document.body && document.body.classList.contains("mobile")) {
            return true;
        }
        return typeof window !== "undefined" && window.innerWidth <= 600;
    }

    getReadyDownloadStatusMessage() {
        return this.isMobileLayout()
            ? "Transcript ready. Download TXT, SRT, or WAV."
            : "Transcript ready. Download TXT, SRT, WAV, or P/C.";
    }

    shouldHoldScreenWakeLock() {
        return !!(this.audioStreaming || this.awaitingLiveResult || this.fixtureRunActive);
    }

    async releaseScreenWakeLock() {
        const wakeLock = this.screenWakeLock;
        this.screenWakeLock = null;
        if (!wakeLock || typeof wakeLock.release !== "function") return;
        try {
            await wakeLock.release();
        } catch {
            // Ignore release failures; the browser may have released it already.
        }
    }

    async syncScreenWakeLock() {
        const shouldHold = this.shouldHoldScreenWakeLock();
        const wakeLockApi = typeof navigator !== "undefined" ? navigator.wakeLock : null;
        const canRequest = !!(wakeLockApi && typeof wakeLockApi.request === "function");

        if (!shouldHold || !canRequest) {
            await this.releaseScreenWakeLock();
            return;
        }
        if (typeof document !== "undefined" && document.visibilityState !== "visible") {
            return;
        }
        if (this.screenWakeLock || this.screenWakeLockRequestInFlight) {
            return;
        }

        this.screenWakeLockRequestInFlight = true;
        try {
            const wakeLock = await wakeLockApi.request("screen");
            this.screenWakeLock = wakeLock;
            if (wakeLock && typeof wakeLock.addEventListener === "function") {
                wakeLock.addEventListener("release", () => {
                    if (this.screenWakeLock === wakeLock) {
                        this.screenWakeLock = null;
                    }
                    if (this.shouldHoldScreenWakeLock()
                        && typeof document !== "undefined"
                        && document.visibilityState === "visible") {
                        void this.syncScreenWakeLock();
                    }
                }, { once: true });
            }
        } catch {
            this.screenWakeLock = null;
        } finally {
            this.screenWakeLockRequestInFlight = false;
        }
    }

    initServices() {
        if (!this.sessionService) {
            this.sessionService = new LiveSessionService({
                onOpen: () => {
                    this.setStatus("connected", "Connected. Ready for recording.");
                    this.updateControls();
                },
                onClose: () => {
                    const remoteStateBeforeClose = String(this.remoteState || "").toLowerCase();
                    const awaitingResultBeforeClose = !!this.awaitingLiveResult;
                    this.cancelFixtureRun();
                    this.stopAudioCapture();
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
                        this.setStatus("ready", this.getReadyDownloadStatusMessage());
                        void this.refreshLiveResult();
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
                    this.setStatus("error", "WebSocket error");
                    this.updateControls();
                },
                onMessage: (raw) => {
                    this.handleServerMessage(raw);
                },
            });
        }

        if (!this.audioService) {
            this.audioService = new LiveAudioService({
                targetSampleRate: 16000,
                chunkMs: 40,
                onChunk: (chunk) => {
                    if (!this.sessionService || !this.sessionService.isOpen()) return;
                    this.sessionService.sendAudioChunk(chunk);
                },
                onError: (err) => {
                    const msg = err && err.message ? err.message : String(err);
                    this.setStatus("error", `Audio error: ${msg}`);
                    if (this.app && typeof this.app.showAlert === "function") {
                        this.app.showAlert("Microphone error", msg);
                    }
                    this.updateControls();
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
        this.el.audioSettingsBtn = document.getElementById("liveAudioSettingsBtn");
        this.el.audioPanel = document.getElementById("liveAudioPanel");
        this.el.audioPanelCard = document.getElementById("liveAudioPanelCard");
        this.el.audioPanelDragHandle = document.getElementById("liveAudioPanelDragHandle");
        this.el.audioPanelCloseBtn = document.getElementById("liveAudioPanelCloseBtn");
        this.el.audioPanelRecordBtn = document.getElementById("liveAudioPanelRecordBtn");
        this.el.audioPanelResetBtn = document.getElementById("liveAudioPanelResetBtn");
        this.el.audioPreGain = document.getElementById("liveAudioPreGain");
        this.el.audioPreGainUiValue = document.getElementById("liveAudioPreGainUiValue");
        this.el.audioAutoGainControl = document.getElementById("liveAudioAutoGainControl");
        this.el.audioCurrentDevice = document.getElementById("liveAudioCurrentDevice");
        this.el.audioCurrentSampleRate = document.getElementById("liveAudioCurrentSampleRate");
        this.el.audioCurrentChannelCount = document.getElementById("liveAudioCurrentChannelCount");
        this.el.audioCurrentChunkMs = document.getElementById("liveAudioCurrentChunkMs");
        this.el.audioVUMeter = document.getElementById("liveAudioVUMeter");
        this.el.durationTextTop = document.getElementById("liveDurationTextTop");
        this.el.durationTextBottom = document.getElementById("liveDurationTextBottom");
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
        this.el.openBenchmarkMatrixBtn = document.getElementById("liveOpenBenchmarkMatrixBtn");
        this.el.injectAudioFileInput = document.getElementById("liveInjectAudioFileInput");
        this.el.chooseAudioFileBtn = document.getElementById("liveChooseAudioFileBtn");
        this.el.injectAudioFileName = document.getElementById("liveInjectAudioFileName");
        this.el.runUploadedInjectBtn = document.getElementById("liveRunUploadedInjectBtn");
        this.el.downloadWavBtn = document.getElementById("liveDownloadWavBtn");
        this.el.downloadTxtBtn = document.getElementById("liveDownloadTxtBtn");
        this.el.downloadSrtBtn = document.getElementById("liveDownloadSrtBtn");
        this.el.downloadPcBtn = document.getElementById("liveDownloadPcBtn");
        this.el.qualityText = document.getElementById("liveQualityText");
        this.el.engineText = document.getElementById("liveEngineText");
        this.el.cadenceText = document.getElementById("liveCadenceText");
        this.el.devToggleBtn = document.getElementById("liveDevToggleBtn");
        this.el.devSection = document.getElementById("liveDevSection");
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
        this.el.demoOverlay = document.getElementById("liveDemoOverlay");
        this.el.demoInjectBtn = document.getElementById("liveDemoInjectBtn");
        this.el.demoPlaybackBtn = document.getElementById("liveDemoPlaybackBtn");
        this.el.demoSkipBtn = document.getElementById("liveDemoSkipBtn");
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

        if (this.el.audioPanelRecordBtn) {
            this.el.audioPanelRecordBtn.addEventListener("click", () => {
                if (this.audioStreaming) {
                    this.stopMic();
                } else {
                    this.startMic();
                }
            });
        }
        if (this.el.audioPanelResetBtn) {
            this.el.audioPanelResetBtn.addEventListener("click", () => this.resetAudioSettingsToDefaults());
        }
        if (this.el.audioPreGain) {
            this.el.audioPreGain.addEventListener("input", () => {
                const raw = Number(this.el.audioPreGain.value);
                this.audioSettingsUi.preGain = Number.isFinite(raw) ? Math.max(0.5, Math.min(3.0, raw)) : 1.0;
                // Apply gain immediately to audio service if recording
                if (this.audioService) {
                    this.audioService.setPreGain(this.audioSettingsUi.preGain);
                }
                this.refreshAudioSettingsPanel({ readCurrent: false });
            });
        }
        if (this.el.audioAutoGainControl) {
            this.el.audioAutoGainControl.addEventListener("change", () => {
                this.audioSettingsUi.autoGainControl = !!this.el.audioAutoGainControl.checked;
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
        if (this.el.openBenchmarkMatrixBtn) {
            this.el.openBenchmarkMatrixBtn.addEventListener("click", () => {
                this.app.navigateTo("livebench");
            });
        }
        if (this.el.injectAudioFileInput) {
            this.el.injectAudioFileInput.addEventListener("change", () => {
                const files = this.el.injectAudioFileInput && this.el.injectAudioFileInput.files;
                this.selectedInjectAudioFile = files && files[0] ? files[0] : null;
                this.updateControls();
            });
        }
        if (this.el.chooseAudioFileBtn) {
            this.el.chooseAudioFileBtn.addEventListener("click", () => {
                if (!this.el.injectAudioFileInput || this.el.chooseAudioFileBtn.disabled) return;
                this.el.injectAudioFileInput.click();
            });
        }
        if (this.el.runUploadedInjectBtn) {
            this.el.runUploadedInjectBtn.addEventListener("click", () => {
                void this.startUploadedAudioInjectRun();
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
        if (this.el.downloadPcBtn) {
            this.el.downloadPcBtn.addEventListener("click", () => this.downloadLiveTranscript("pc"));
        }
        if (this.el.devToggleBtn) {
            this.el.devToggleBtn.addEventListener("click", () => this.toggleDeveloperTools());
        }
        if (this.el.demoInjectBtn) {
            this.el.demoInjectBtn.addEventListener("click", () => {
                this.hideLiveDemoOverlay();
                void this.startSelectedFixtureRun("inject");
            });
        }
        if (this.el.demoPlaybackBtn) {
            this.el.demoPlaybackBtn.addEventListener("click", () => {
                this.hideLiveDemoOverlay();
                void this.startSelectedFixtureRun("playback");
            });
        }
        if (this.el.demoSkipBtn) {
            this.el.demoSkipBtn.addEventListener("click", () => {
                this.hideLiveDemoOverlay();
            });
        }
    }

    readLiveDemoIntent() {
        try {
            const params = new URLSearchParams(window.location.search);
            return String(params.get("demo") || "").trim() === LIVE_DEMO_QUERY_VALUE;
        } catch {
            return false;
        }
    }

    clearLiveDemoIntent() {
        try {
            const url = new URL(window.location.href);
            if (!url.searchParams.has("demo")) return;
            url.searchParams.delete("demo");
            const search = url.searchParams.toString();
            const nextUrl = url.pathname + (search ? `?${search}` : "") + url.hash;
            window.history.replaceState(window.history.state, "", nextUrl);
        } catch {
            // ignore URL cleanup issues
        }
    }

    syncLiveDemoOverlay() {
        if (!this.el.demoOverlay) return;
        this.el.demoOverlay.classList.toggle("hidden", !this.liveDemoChoiceVisible);
    }

    hideLiveDemoOverlay() {
        this.liveDemoChoiceVisible = false;
        this.clearLiveDemoIntent();
        this.syncLiveDemoOverlay();
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
        this.renderTranscriptText();
    }

    normalizeLanguageCode(value) {
        const code = String(value || "").trim().toLowerCase();
        if (!code) return "";
        if (code === "auto") return "";
        for (let i = 0; i < TRANSCRIPT_LANGUAGES.length; i += 1) {
            const known = String(TRANSCRIPT_LANGUAGES[i] && TRANSCRIPT_LANGUAGES[i].code || "").trim().toLowerCase();
            if (known === code) return known;
        }
        const primary = code.split(/[-_]/, 1)[0];
        if (primary && primary !== code) {
            for (let i = 0; i < TRANSCRIPT_LANGUAGES.length; i += 1) {
                const known = String(TRANSCRIPT_LANGUAGES[i] && TRANSCRIPT_LANGUAGES[i].code || "").trim().toLowerCase();
                if (known === primary) return known;
            }
        }
        return "";
    }

    detectBrowserPreferredLanguage() {
        if (typeof navigator === "undefined") return "";
        const candidates = [];
        if (Array.isArray(navigator.languages)) {
            for (let i = 0; i < navigator.languages.length; i += 1) {
                candidates.push(String(navigator.languages[i] || ""));
            }
        }
        candidates.push(String(navigator.language || ""));
        for (let i = 0; i < candidates.length; i += 1) {
            const normalized = this.normalizeLanguageCode(candidates[i]);
            if (normalized) return normalized;
        }
        return "";
    }

    loadPreferredLanguage() {
        try {
            const raw = window.localStorage.getItem(LIVE_LANGUAGE_STORAGE_KEY);
            if (raw !== null) {
                return this.normalizeLanguageCode(raw);
            }
            return this.detectBrowserPreferredLanguage();
        } catch {
            return this.detectBrowserPreferredLanguage();
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

    activateDemoLanguage(code = LIVE_DEMO_LANGUAGE_CODE) {
        const normalized = this.normalizeLanguageCode(code);
        if (!normalized) return;
        if (this.demoLanguageRestore === null) {
            this.demoLanguageRestore = this.selectedLanguage;
        }
        this.selectedLanguage = normalized;
        this.syncLanguageSelectUi();
    }

    restoreDemoLanguage() {
        if (this.demoLanguageRestore === null) return;
        this.selectedLanguage = this.normalizeLanguageCode(this.demoLanguageRestore);
        this.demoLanguageRestore = null;
        this.syncLanguageSelectUi();
    }

    syncLanguageSelectUi() {
        if (!this.el.languageSelect) return;
        const normalized = this.normalizeLanguageCode(this.selectedLanguage);
        this.selectedLanguage = normalized;
        this.el.languageSelect.value = normalized;
        this.fitLanguageSelectToSelectedOption();
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
            this.audioSettingsDrag = createDialogDragController((x, y) => {
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

    resetAudioSettingsToDefaults() {
        this.audioSettingsUi = {
            preGain: 1.0,
            autoGainControl: false,
        };
        // Reset gain in audio service
        if (this.audioService) {
            this.audioService.setPreGain(1.0);
        }
        this.refreshAudioSettingsPanel({ readCurrent: true });
    }

    readCurrentAudioTrackState() {
        const state = {
            hasActiveTrack: false,
            autoGainControl: null,
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
        state.autoGainControl = pickBool("autoGainControl", "autoGainControl");
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
        if (this.el.audioAutoGainControl) {
            this.el.audioAutoGainControl.checked = !!this.audioSettingsUi.autoGainControl;
            this.el.audioAutoGainControl.disabled = !!this.audioStreaming;
        }

        // Disable reset button during recording if AGC is enabled
        // (because checkbox can't be changed during recording, only pre-gain can)
        if (this.el.audioPanelResetBtn) {
            this.el.audioPanelResetBtn.disabled = !!this.audioStreaming && this.audioSettingsUi.autoGainControl;
        }

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

    startVUMeterAnimation() {
        if (this.vuMeterAnimationId) return;
        const draw = () => {
            if (!this.el.audioVUMeter || !this.audioService) {
                this.vuMeterAnimationId = null;
                return;
            }
            const ctx = this.el.audioVUMeter.getContext("2d");
            const width = this.el.audioVUMeter.width;
            const height = this.el.audioVUMeter.height;

            // Get current level
            const level = this.audioService.getLevel();

            // Clear canvas
            ctx.clearRect(0, 0, width, height);

            // Draw background
            ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
            ctx.fillRect(0, 0, width, height);

            // Draw level bar with 2 zones: blue (safe) and amber (clip risk)
            const barWidth = width * level;
            const clipRiskThreshold = 0.9; // 90% = start of amber zone

            if (barWidth > 0) {
                if (level <= clipRiskThreshold) {
                    // Safe zone - solid blue
                    ctx.fillStyle = "#0ea5e9"; // sky-500
                    ctx.fillRect(0, 0, barWidth, height);
                } else {
                    // Clip risk zone - amber
                    ctx.fillStyle = "#f59e0b"; // amber-500
                    ctx.fillRect(0, 0, barWidth, height);
                }
            }

            // Draw threshold line at 90%
            const thresholdX = width * clipRiskThreshold;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(thresholdX, 0);
            ctx.lineTo(thresholdX, height);
            ctx.stroke();



            this.vuMeterAnimationId = requestAnimationFrame(draw);
        };
        draw();
    }

    stopVUMeterAnimation() {
        if (this.vuMeterAnimationId) {
            cancelAnimationFrame(this.vuMeterAnimationId);
            this.vuMeterAnimationId = null;
        }
        // Clear canvas
        if (this.el.audioVUMeter) {
            const ctx = this.el.audioVUMeter.getContext("2d");
            ctx.clearRect(0, 0, this.el.audioVUMeter.width, this.el.audioVUMeter.height);
        }
    }

    clearOutput() {
        this.partialText = "";
        this.resetLiveResultState();
        this.currentFixtureMeta = null;
        this.previewText = "";
        this.remoteState = "idle";

        this.renderTranscriptText();
        if (this.el.partialText) this.el.partialText.textContent = "";
        if (this.el.engineText) this.el.engineText.textContent = "";
        if (this.el.cadenceText) this.el.cadenceText.textContent = "";
        if (this.el.qualityText) this.el.qualityText.textContent = "";

        this.updatePartialPlaceholder();
        this.updateCadenceIndicator();
        this.updateQualityPlaceholder();
        this.setUiPhase("idle");
        this.updateControls();
    }

    setStatus(kind, _text) {
        // Visible status is driven by setUiPhase() via updateControls();
        // keep setStatus for internal state transitions and call sites.
        const normalized = String(kind || "idle").toLowerCase();
        if (!this.audioStreaming) {
            this.remoteState = normalized;
        }
    }


    applyVadStateFromResult(result) {
        this.vadState = nextLiveVadStateFromResult(this.vadState, result);
        this.updateVadIndicator();
    }

    applyVadStateFromStats(payload) {
        const nextState = nextLiveVadStateFromStats(this.vadState, payload);
        if (!nextState) return;
        this.vadState = nextState;
        this.updateVadIndicator();
    }

    updateVadIndicator() {
        if (!this.el.vadBadge) return;
        const show = shouldShowLiveVadSpeechBadge(this.vadState, {
            audioStreaming: this.audioStreaming,
            remoteState: this.remoteState,
        });
        this.el.vadBadge.classList.toggle("hidden", !show);
        this.el.vadBadge.classList.remove("vad-speech", "vad-hangover", "vad-silence");
        if (!show) return;
        this.el.vadBadge.classList.add("vad-speech");
        this.el.vadBadge.textContent = vadLabelForPhase("speech");
    }

    resetLiveResultState() {
        this.awaitingLiveResult = false;
        this.resultEnvelope = null;
        this.resultCanExportPc = false;
        this.resultCanExportWav = false;
        this.resultCanExportSrt = false;
        this.resultPcUrl = "";
        this.resultWavUrl = "";
        this.resultSrtUrl = "";
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
        this.runMetricsSummaryText = "";
        this.engineRuntimeSummaryText = "";
        this.lastEngineInflightSummaryText = "";
        this.engineRuntimeInflightStale = false;
        this.qualityTimelineEntries = [];
        this.previewText = "";
        this.previewSeq = -1;
        this.finalSegments = [];
        this.finalSegmentsSignature = "";
        this.cadenceStats = this.createCadenceStats();
        this.vadState = createLiveVadState();
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

    _segmentsSignature(segments) {
        if (!Array.isArray(segments) || !segments.length) return "";
        const rows = [];
        for (let i = 0; i < segments.length; i += 1) {
            const seg = segments[i] && typeof segments[i] === "object" ? segments[i] : {};
            const text = normalizeSegmentText(seg.text);
            const t0Raw = Number(seg.t0_ms);
            const t1Raw = Number(seg.t1_ms);
            const t0 = Number.isFinite(t0Raw) ? Math.max(0, Math.round(t0Raw)) : 0;
            const t1 = Number.isFinite(t1Raw) ? Math.max(t0, Math.round(t1Raw)) : t0;
            rows.push(`${t0}:${t1}:${text}`);
        }
        return rows.join("|");
    }

    recordCadenceVisibleUpdate({ finalChanged = false, previewChanged = false } = {}) {
        const stats = this.ensureCadenceStarted(this.recordingStartedAtMs > 0 ? this.recordingStartedAtMs : Date.now());
        const visibleState = buildVisibleTranscriptState(this.finalSegments, this.previewText, {
            formatRules: this.liveTranscriptFormatRules,
            speakerLabelsEnabled: this.devSpeakerLabelsEnabled,
        });
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

        if (startMs <= 0 && stats.visibleUpdateCount <= 0) {
            return "";
        }

        const hasVisibleUpdate = stats.visibleUpdateCount > 0;
        const firstLatencyMs = (startMs > 0 && stats.firstVisibleUpdateAtMs > 0)
            ? Math.max(0, stats.firstVisibleUpdateAtMs - startMs)
            : null;
        const medianGapMs = percentile(stats.gapMs, 0.5);
        const p90GapMs = percentile(stats.gapMs, 0.9);
        const p95GapMs = percentile(stats.gapMs, 0.95);
        const sampleEndMs = stats.lastVisibleUpdateAtMs > 0 ? stats.lastVisibleUpdateAtMs : nowMs;
        const elapsedForRateMs = (startMs > 0 && sampleEndMs > startMs) ? (sampleEndMs - startMs) : 0;
        const updatesPerMin = elapsedForRateMs > 0
            ? (stats.visibleUpdateCount / (elapsedForRateMs / 60000))
            : null;
        const currentGapMs = stats.lastVisibleUpdateAtMs > 0
            ? Math.max(0, nowMs - stats.lastVisibleUpdateAtMs)
            : null;
        const showCurrentGap = this.audioStreaming || this.awaitingLiveResult || this.fixtureRunActive || this.remoteState === "finalizing";

        return [
            `State: ${hasVisibleUpdate ? "Active" : "Waiting for first visible transcript update"}`,
            `First visible update: ${firstLatencyMs !== null ? formatDurationMs(firstLatencyMs) : "n/a"}`
                + ` | current gap: ${showCurrentGap && currentGapMs !== null ? formatDurationMs(currentGapMs) : "n/a"}`,
            `Visible gap: median ${medianGapMs !== null ? formatDurationMs(medianGapMs) : "n/a"}`
                + ` | p90 ${p90GapMs !== null ? formatDurationMs(p90GapMs) : "n/a"}`
                + ` | p95 ${p95GapMs !== null ? formatDurationMs(p95GapMs) : "n/a"}`,
            `Visible updates: ${stats.visibleUpdateCount}`
                + (updatesPerMin !== null && Number.isFinite(updatesPerMin) ? ` (${updatesPerMin.toFixed(1)}/min)` : " (n/a/min)")
                + ` | preview ${stats.previewChangeCount} | final ${stats.finalChangeCount}`,
        ].join("\n");
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
            const text = normalizeSegmentText(row.text);
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
                const label = speakerLabelFromToken(row.speaker);
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
        const diarizePresentation = formatSegmentBlocksDiarizeHardPresentation(this.finalSegments, this.liveTranscriptFormatRules);
        const finalValue = (diarizePresentation && diarizePresentation.text)
            ? String(diarizePresentation.text)
            : "";
        const previewSuffix = formatPreviewSuffixText(finalValue, this.previewText, {
            speakerLabelsEnabled: this.devSpeakerLabelsEnabled,
        });

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
        return formatLiveSummaryPanel(result, {
            engineState: extractEngineState(result),
            vadLabelForPhase,
        });
    }

    formatEngineRuntimeSummary(result) {
        const summary = formatEngineRuntimeSummaryPanel(result, {
            lastInflightSummaryText: this.lastEngineInflightSummaryText,
        });
        this.lastEngineInflightSummaryText = String(summary.lastInflightSummaryText || "");
        this.engineRuntimeInflightStale = !!summary.inflightStale;
        return String(summary.text || "");
    }

    formatQualitySummary(envelope) {
        return formatQualitySummaryPanel(envelope);
    }

    formatRunMetricsSummaryFromResult(result) {
        return formatRunMetricsSummaryPanel(result);
    }

    applyLiveQualityEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        this.qualityEnvelope = e;
        this.qualitySummaryText = this.formatQualitySummary(e);
        this._appendQualityTimelineEntry("final", this.qualitySummaryText);
        this.updateQualityPlaceholder();

        const sid = String(e.session_id || this.getCurrentSessionId() || "").trim();
        const revision = Number(
            this.resultEnvelope && this.resultEnvelope.result ? this.resultEnvelope.result.transcript_revision : 0
        );
        this.qualityLoadedSessionId = sid;
        this.qualityLoadedRevision = Number.isFinite(revision) ? revision : -1;
    }

    async refreshLiveQuality() {
        const sid = this.getCurrentSessionId();
        if (!sid || !this.sessionService) return false;
        if (this.qualityInFlight) return false;
        this.qualityInFlight = true;
        try {
            const envelope = await this.sessionService.fetchQuality(sid);
            this.applyLiveQualityEnvelope(envelope);
            return true;
        } catch {
            return false;
        } finally {
            this.qualityInFlight = false;
            this.updateControls();
        }
    }

    async refreshLiveResult() {
        const sid = this.getCurrentSessionId();
        if (!sid || !this.sessionService || typeof this.sessionService.fetchResult !== "function") return false;
        if (this.resultInFlight) return false;
        this.resultInFlight = true;
        try {
            const envelope = await this.sessionService.fetchResult(sid);
            this.applyLiveResultEnvelope(envelope);
            return true;
        } catch {
            return false;
        } finally {
            this.resultInFlight = false;
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
        this.resultCanExportPc = !!e.can_export_pc;
        this.resultCanExportWav = !!e.can_export_wav;
        this.resultCanExportSrt = !!e.can_export_srt;
        this.resultPcUrl = this.resultCanExportPc ? String(e.transcript_pc_url || "") : "";
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
        this.engineRuntimeSummaryText = this.formatEngineRuntimeSummary(result);
        this.applyVadStateFromResult(result);
        this.updatePartialPlaceholder();
        this.updateEnginePlaceholder();
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

        if (ready) {
            this.awaitingLiveResult = false;
            if (!this.audioStreaming) {
                this.remoteState = "ready";
                this.setStatus("ready", this.getReadyDownloadStatusMessage());
            }
            const rev = Number(result.transcript_revision || 0);
            const qualityAlreadyLoaded = (
                this.qualityLoadedSessionId === String(sid || "")
                && Number(this.qualityLoadedRevision) === rev
            );
            if (String(result.fixture_id || "").trim() && !qualityAlreadyLoaded) {
                void this.refreshLiveQuality();
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
                : normalized === "pc"
                    ? this.resultPcUrl
                : "";
        if (!url) {
            return;
        }
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    updateControls() {
        void this.syncScreenWakeLock();
        const wsConnecting = !!(this.sessionService && this.sessionService.isConnecting());

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
            this.el.runFixturePlayBtn.textContent = "Play fixture";
        }
        if (this.el.runFixtureInjectBtn) {
            this.el.runFixtureInjectBtn.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
            this.el.runFixtureInjectBtn.textContent = "Inject fixture";
        }
        if (this.el.injectAudioFileInput) {
            this.el.injectAudioFileInput.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
        }
        if (this.el.chooseAudioFileBtn) {
            this.el.chooseAudioFileBtn.disabled = this.fixtureRunActive || this.audioStreaming || wsConnecting;
        }
        if (this.el.injectAudioFileName) {
            this.el.injectAudioFileName.textContent = this.selectedInjectAudioFile
                ? String(this.selectedInjectAudioFile.name || "")
                : "No file selected";
        }
        if (this.el.runUploadedInjectBtn) {
            this.el.runUploadedInjectBtn.disabled = !this.selectedInjectAudioFile || this.fixtureRunActive || this.audioStreaming || wsConnecting;
            this.el.runUploadedInjectBtn.textContent = "Inject audio file";
        }

        // Download buttons (enabled when export is ready)
        if (this.el.downloadWavBtn) this.el.downloadWavBtn.disabled = !this.resultCanExportWav;
        if (this.el.downloadTxtBtn) {
            const txt = this.el.finalText ? String(this.el.finalText.innerText || "").trim() : "";
            this.el.downloadTxtBtn.disabled = !txt;
        }
        if (this.el.downloadSrtBtn) this.el.downloadSrtBtn.disabled = !this.resultCanExportSrt;
        if (this.el.downloadPcBtn) this.el.downloadPcBtn.disabled = !this.resultCanExportPc;

        if (this.el.sessionId) {
            const sid = this.sessionService ? this.sessionService.getSessionId() : "";
            this.el.sessionId.textContent = sid || "(none)";
        }
        this.updateEnginePlaceholder();
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
        if (this.el.durationTextTop) this.el.durationTextTop.classList.toggle("hidden", !showTimer);
        if (this.el.durationTextBottom) this.el.durationTextBottom.classList.toggle("hidden", !showTimer);

        // Audio panel record button: update label based on state
        if (this.el.audioPanelRecordBtn) {
            const isRecording = phase === "listening" || phase === "paused";
            this.el.audioPanelRecordBtn.textContent = isRecording ? "Stop Recording" : "Start Recording";
        }

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
            this.stopAudioCapture();
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
                    this.setStatus("error", "Could not open live connection");
                    this.updateControls();
                    return;
                }
            }
        }

        if (!this.sessionService.isOpen()) {
            this.setStatus("error", "Live connection is not open");
            this.updateControls();
            return;
        }

        try {
            if (!this.audioService.isCapturing()) {
                await this.audioService.start({
                    preGain: this.audioSettingsUi.preGain,
                    autoGainControl: this.audioSettingsUi.autoGainControl,
                });
                this.stopRecordingTimer({ reset: true });
            } else {
                this.audioService.resume();
            }

            this.audioStreaming = true;
            this.audioPaused = false;
            this.awaitingLiveResult = false;
            this.remoteState = "listening";
            this.startRecordingTimer();
            this.startVUMeterAnimation();
            this.sessionService.sendControl("start");
            this.setStatus("listening", "Recording in progress.");
            this.updatePartialPlaceholder();
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            const permissionHelp = this.buildMicPermissionGuidance(err);
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

    cancelFixtureRun() {
        return cancelLiveFixtureRun(this);
    }

    getSelectedFixtureConfig(mode = "playback") {
        return getSelectedLiveFixtureConfig(this, mode);
    }

    async startSelectedFixtureRun(mode = "playback") {
        return startSelectedLiveFixtureRun(this, mode);
    }

    async startFixtureRun(fixture) {
        return startLiveFixtureRun(this, fixture);
    }

    async decodeAudioArrayBufferToMono(bytes) {
        return decodeFixtureAudioArrayBufferToMono(bytes);
    }

    async streamDecodedAudioRealtime(pcmFrames, sampleRate, token) {
        return streamDecodedFixtureAudioRealtime(this, pcmFrames, sampleRate, token);
    }

    async startFixtureInjectRun(fixture) {
        return startLiveFixtureInjectRun(this, fixture);
    }

    async startUploadedAudioInjectRun() {
        return startUploadedLiveAudioInjectRun(this);
    }

    stopMic() {
        this.cancelFixtureRun();
        this.stopAudioCapture();
        this.stopRecordingTimer({ reset: false });

        if (this.sessionService) {
            this.sessionService.sendControl("stop");
        }

        this.awaitingLiveResult = true;
        this.remoteState = "finalizing";
        this.setStatus("finalizing", "Recording stopped. Processing final chunks...");
        this.updatePartialPlaceholder();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    stopAudioCapture() {
        if (this.audioService && this.audioService.isCapturing()) {
            this.audioService.stop();
        }

        this.audioStreaming = false;
        this.audioPaused = false;
        this.stopVUMeterAnimation();
    }

    cleanupSession(reason = "manual_close", options = {}) {
        this.cancelFixtureRun();
        this.stopAudioCapture();
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
            return;
        }

        this.sessionService.sendControl(msgType);
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
        if (!this.el.durationTextTop) {
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
        if (this.el.durationTextTop) this.el.durationTextTop.textContent = display;
        if (this.el.durationTextBottom) this.el.durationTextBottom.textContent = display;
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

        let placeholder = "Processing summary appears here.";
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

    updateEnginePlaceholder() {
        if (!this.el.engineText) return;

        const text = !!String(this.engineRuntimeSummaryText || "").trim()
            ? String(this.engineRuntimeSummaryText)
            : "";
        if (text) {
            const lines = text.split("\n");
            this.el.engineText.textContent = "";
            const frag = document.createDocumentFragment();
            for (let i = 0; i < lines.length; i += 1) {
                const line = document.createElement("span");
                line.textContent = lines[i];
                if (i === 2 && this.engineRuntimeInflightStale) {
                    line.className = "live-engine-stale-line";
                }
                frag.appendChild(line);
                if (i < lines.length - 1) {
                    frag.appendChild(document.createElement("br"));
                }
            }
            this.el.engineText.appendChild(frag);
            this.el.engineText.setAttribute("data-empty", "0");
            this.el.engineText.setAttribute("data-placeholder", "");
            return;
        }

        this.el.engineText.textContent = "";
        this.el.engineText.setAttribute("data-empty", "1");

        let placeholder = "Engine runtime details appear here once live results start arriving.";
        if (this.audioStreaming || this.fixtureRunActive || this.awaitingLiveResult || this.remoteState === "finalizing") {
            placeholder = "Engine runtime details appear after the live engine has emitted result state.";
        } else if (this.resultEnvelope && this.resultEnvelope.result) {
            placeholder = "No engine runtime details were captured for this run.";
        }
        this.el.engineText.setAttribute("data-placeholder", placeholder);
    }

    handleServerMessage(raw) {
        let payload = null;
        try {
            payload = JSON.parse(String(raw || ""));
        } catch {
            return;
        }

        const t = String(payload.type || "").toLowerCase();

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
            // Keep the visible status stable; pong is ignored in the Dev Tools cards.
        } else if (t === "stats") {
            this.applyVadStateFromStats(payload);
        } else if (t === "ended") {
            this.stopAudioCapture();
            this.stopRecordingTimer({ reset: false });
            this.awaitingLiveResult = false;
            this.remoteState = "ended";
            this.setStatus("ready", `Recording finished (${payload.reason || "unknown"}).`);
            this.updatePartialPlaceholder();
            void this.refreshLiveResult();
        } else if (t === "error") {
            const msg = String(payload.message || "Live error");
            this.setStatus("error", msg);
            if (payload.fatal) {
                this.stopAudioCapture();
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
