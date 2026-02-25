import { LiveAudioService, downsampleBuffer, float32ToPcm16LeBuffer } from "../services/LiveAudioService.js";
import { LiveSessionService } from "../services/LiveSessionService.js";

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

const DEV_LIVE_FIXTURES = {
    panel120v1: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (120s)",
        url: "/dev-fixtures/panel_120s_v1_08m09s_10m09s.mp3",
        startDelayMs: 700,
        tailDelayMs: 1200,
        mode: "playback",
    },
    panel120v1Inject: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (inject, 120s)",
        url: "/dev-fixtures/panel_120s_v1_08m09s_10m09s.mp3",
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

export class LiveView {
    constructor(app) {
        this.app = app;

        this.remoteState = "idle";
        this.finalText = "";
        this.partialText = "";
        this.developerToolsOpen = false;

        this.audioStreaming = false;
        this.audioPaused = false;

        this.sessionService = null;
        this.audioService = null;

        this.recordingElapsedMs = 0;
        this.recordingStartedAtMs = 0;
        this.recordingTimerId = null;

        this.lastStatsSummary = "";

        this.awaitingSemiliveResult = false;
        this.resultPollTimerId = null;
        this.resultPollInFlight = false;
        this.resultEnvelope = null;
        this.resultCanExportTxt = false;
        this.resultCanExportSrt = false;
        this.resultCanExportWav = false;
        this.resultTxtUrl = "";
        this.resultSrtUrl = "";
        this.resultWavUrl = "";
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
        this.currentFixtureMeta = null;

        this.fixtureRunActive = false;
        this.fixtureRunToken = 0;
        this.fixtureAudio = null;
        this.fixtureStopTimerId = null;
        this.fixtureRunLabel = "";
        this.selectedFixtureKey = DEV_LIVE_FIXTURE_OPTIONS[0] ? DEV_LIVE_FIXTURE_OPTIONS[0].value : "panel120v1";

        this.el = {};
    }

    getHtml() {
        return `
      <div class="live-wrap">
        <div class="live-layout">
          <section class="live-card live-controls">
            <div class="live-section-kicker">Session</div>

            <div class="live-status-panel">
              <div class="live-status-panel-top">
                <span class="live-status-badge idle" id="liveStatusBadge">Idle</span>
                <span class="live-status-pill-note">Chunked</span>
              </div>
              <div class="live-status-timer" id="liveDurationText">00:00</div>
              <div class="live-status-copy" id="liveStatusText" title="Not connected">Not connected</div>
            </div>

            <div class="live-primary-controls">
              <button id="liveStartBtn" type="button">Start</button>
              <button id="livePauseBtn" type="button" disabled>Pause</button>
              <button id="liveResumeBtn" type="button" disabled>Resume</button>
              <button class="primary live-finish-btn" id="liveStopBtn" type="button" disabled>Finish</button>
            </div>

            <div class="live-secondary-row">
              <button id="liveClearBtn" type="button">Clear transcript</button>
              <button id="liveDownloadWavBtn" type="button" disabled>Download WAV</button>
              <button id="liveDownloadTxtBtn" type="button" disabled>Download TXT</button>
              <button id="liveDownloadSrtBtn" type="button" disabled>Download SRT</button>
            </div>

            <div class="live-controls-divider" role="separator" aria-label="Developer fixture tools">
              <span>Dev / fixture tools</span>
            </div>

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


          </section>

          <section class="live-card live-output">
            <div class="live-output-header">
              <div>
                <div class="live-section-kicker">Transcript (chunked)</div>
              </div>
            </div>

            <textarea id="liveFinalText" class="live-final-text" spellcheck="false" readonly></textarea>

            <div class="live-partial-row">
              <div class="live-label">Status / processing</div>
              <div class="live-partial-text" id="livePartialText" data-placeholder="Chunk status appears here."></div>
            </div>

            <div class="live-partial-row">
              <div class="live-label">Fixture quality</div>
              <div class="live-partial-text" id="liveQualityText" data-placeholder="Quality score appears here for fixture runs."></div>
            </div>
          </section>
        </div>
      </div>
    `;
    }

    mount(container) {
        container.innerHTML = this.getHtml();
        this.captureElements();
        this.initServices();
        this.bindUi();
        this.updateDurationDisplay();
        this.updatePartialPlaceholder();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    unmount() {
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
        this.stopResultPolling();
        this.sessionService = null;
        return {};
    }

    initServices() {
        if (!this.sessionService) {
            this.sessionService = new LiveSessionService({
                onOpen: () => {
                    this.setStatus("connected", "Connected. Ready for chunked recording.");
                    this.updateControls();
                },
                onClose: (ev) => {
                    this.cancelFixtureRun("session_socket_closed");
                    this.appendLog(`Socket closed (code=${ev && ev.code !== undefined ? ev.code : "?"}, reason=${ev && ev.reason ? ev.reason : "none"})`);
                    this.stopAudioCapture({ quiet: true });
                    this.stopRecordingTimer({ reset: false });
                    this.remoteState = "disconnected";
                    if (this.awaitingSemiliveResult) {
                        this.setStatus("finalizing", "Connection closed. Transcript is still being processed...");
                        this.startResultPolling({ immediate: true, intervalMs: 1000 });
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

    captureElements() {
        this.el.statusBadge = document.getElementById("liveStatusBadge");
        this.el.statusText = document.getElementById("liveStatusText");
        this.el.durationText = document.getElementById("liveDurationText");
        this.el.sessionId = document.getElementById("liveSessionId");
        this.el.connectBtn = document.getElementById("liveConnectBtn");
        this.el.disconnectBtn = document.getElementById("liveDisconnectBtn");
        this.el.startBtn = document.getElementById("liveStartBtn");
        this.el.pauseBtn = document.getElementById("livePauseBtn");
        this.el.resumeBtn = document.getElementById("liveResumeBtn");
        this.el.pingBtn = document.getElementById("livePingBtn");
        this.el.stopBtn = document.getElementById("liveStopBtn");
        this.el.clearBtn = document.getElementById("liveClearBtn");
        this.el.fixtureSelect = document.getElementById("liveFixtureSelect");
        this.el.runFixturePlayBtn = document.getElementById("liveRunFixturePlayBtn");
        this.el.runFixtureInjectBtn = document.getElementById("liveRunFixtureInjectBtn");
        this.el.downloadWavBtn = document.getElementById("liveDownloadWavBtn");
        this.el.downloadTxtBtn = document.getElementById("liveDownloadTxtBtn");
        this.el.downloadSrtBtn = document.getElementById("liveDownloadSrtBtn");
        this.el.qualityText = document.getElementById("liveQualityText");
        this.el.devToggleBtn = document.getElementById("liveDevToggleBtn");
        this.el.devPanel = document.getElementById("liveDevPanel");
        this.el.devStats = document.getElementById("liveDevStats");
        this.el.log = document.getElementById("liveEventLog");
        this.el.finalText = document.getElementById("liveFinalText");
        this.el.partialText = document.getElementById("livePartialText");
    }

    bindUi() {
        if (this.el.connectBtn) {
            this.el.connectBtn.addEventListener("click", () => this.connectSession());
        }
        if (this.el.disconnectBtn) {
            this.el.disconnectBtn.addEventListener("click", () => this.cleanupSession("client_disconnect", { sendStop: true }));
        }
        if (this.el.startBtn) {
            this.el.startBtn.addEventListener("click", () => this.startMic());
        }
        if (this.el.pauseBtn) {
            this.el.pauseBtn.addEventListener("click", () => this.pauseMic());
        }
        if (this.el.resumeBtn) {
            this.el.resumeBtn.addEventListener("click", () => this.resumeMic());
        }
        if (this.el.pingBtn) {
            this.el.pingBtn.addEventListener("click", () => this.sendControl("ping"));
        }
        if (this.el.stopBtn) {
            this.el.stopBtn.addEventListener("click", () => this.stopMic());
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
            this.el.downloadWavBtn.addEventListener("click", () => this.downloadSemiliveTranscript("wav"));
        }
        if (this.el.downloadTxtBtn) {
            this.el.downloadTxtBtn.addEventListener("click", () => this.downloadSemiliveTranscript("txt"));
        }
        if (this.el.downloadSrtBtn) {
            this.el.downloadSrtBtn.addEventListener("click", () => this.downloadSemiliveTranscript("srt"));
        }
        if (this.el.devToggleBtn) {
            this.el.devToggleBtn.addEventListener("click", () => this.toggleDeveloperTools());
        }
    }

    toggleDeveloperTools(forceOpen) {
        const next = typeof forceOpen === "boolean" ? forceOpen : !this.developerToolsOpen;
        this.developerToolsOpen = next;

        if (this.el.devPanel) {
            this.el.devPanel.classList.toggle("hidden", !next);
        }
        if (this.el.devToggleBtn) {
            this.el.devToggleBtn.textContent = next ? "Hide" : "Show";
            this.el.devToggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
        }
    }

    clearOutput() {
        this.finalText = "";
        this.partialText = "";
        this.lastStatsSummary = "";
        this.resetSemiliveResultState();
        this.currentFixtureMeta = null;

        if (this.el.finalText) this.el.finalText.value = "";
        if (this.el.partialText) this.el.partialText.textContent = "";
        if (this.el.qualityText) this.el.qualityText.textContent = "";
        if (this.el.log) this.el.log.textContent = "";
        if (this.el.devStats) this.el.devStats.textContent = "No stats yet";

        this.updatePartialPlaceholder();
        this.updateQualityPlaceholder();
        this.updateControls();
    }

    setStatus(kind, text) {
        const normalized = String(kind || "idle").toLowerCase();
        const label = STATUS_LABELS[normalized] || normalized;
        const copy = String(text || "");

        if (this.el.statusBadge) {
            this.el.statusBadge.textContent = label;
            this.el.statusBadge.className = `live-status-badge ${normalized}`;
            this.el.statusBadge.title = label;
        }
        if (this.el.statusText) {
            this.el.statusText.textContent = copy;
            this.el.statusText.title = copy;
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

    resetSemiliveResultState() {
        this.awaitingSemiliveResult = false;
        this.resultEnvelope = null;
        this.resultCanExportWav = false;
        this.resultCanExportTxt = false;
        this.resultCanExportSrt = false;
        this.resultWavUrl = "";
        this.resultTxtUrl = "";
        this.resultSrtUrl = "";
        this.qualityEnvelope = null;
        this.qualityInFlight = false;
        this.qualityLoadedSessionId = "";
        this.qualityLoadedRevision = -1;
        this.qualitySummaryText = "";
    }

    getCurrentSessionId() {
        return this.sessionService ? String(this.sessionService.getSessionId() || "").trim() : "";
    }

    formatSemiliveSummary(result) {
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
            recording_finalized: "Ready (recording finalized)",
            finalized: "Ready",
            ready: "Ready",
            error: "Error",
        })[fstate] || fstate.replace(/_/g, " ");
        const rev = Number(r.transcript_revision || 0);
        const chars = String(r.final_text || "").trim().length;
        const durMs = Number(r.recording_duration_ms || 0);

        const parts = [
            `Processing state: ${fstateLabel}`,
            `Chunks ${done}/${total} (pending ${pending}, failed ${failed})`,
            `Transcript rev ${rev}`,
        ];
        if (durMs > 0) {
            parts.push(`Recording ${(durMs / 1000).toFixed(1)}s`);
        }
        if (chars > 0) {
            parts.push(`${chars} chars`);
        }

        const rows = Array.isArray(r.chunk_results) ? r.chunk_results : [];
        if (rows.length) {
            const latest = rows[rows.length - 1];
            if (latest && typeof latest === "object") {
                const idx = Number(latest.chunk_index || 0);
                const st = String(latest.state || "").trim() || "unknown";
                const txt = String(latest.text || "").trim().replace(/\s+/g, " ");
                let line = `Latest chunk #${idx}: ${st}`;
                if (txt) {
                    line += ` - ${txt.slice(0, 120)}${txt.length > 120 ? "..." : ""}`;
                }
                parts.push(line);
            }
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
        const dedupChunksApplied = Number(run.dedup_chunks_applied || 0);
        const dedupWordsTrimmedTotal = Number(run.dedup_words_trimmed_total || 0);

        const lines = [];
        if (Number.isFinite(uploadScore)) {
            lines.push(`Upload Similarity Score: ${Math.round(uploadScore)}/100${fixtureId ? ` (${fixtureId})` : ""}`);
        } else {
            lines.push(`Fixture quality available${fixtureId ? ` (${fixtureId})` : ""}`);
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
        lines.push(`Dedup: chunks_applied=${dedupChunksApplied} words_trimmed_total=${dedupWordsTrimmedTotal}`);
        lines.push(
            `Health: poll_errors=${pollErrors} chunk_errors=${chunkErrors} finalization=${String(run.finalization_state || "")}`
        );
        const refMeta = fixture.reference_meta && typeof fixture.reference_meta === "object" ? fixture.reference_meta : {};
        if (Object.prototype.hasOwnProperty.call(refMeta, "boundary_partial_end")) {
            lines.push(`Ref boundary_partial_end=${String(refMeta.boundary_partial_end)}`);
        }
        return lines.join("\n");
    }

    applySemiliveQualityEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        this.qualityEnvelope = e;
        this.qualitySummaryText = this.formatQualitySummary(e);
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

    async refreshSemiliveQuality(options = {}) {
        const quiet = options.quiet === true;
        const sid = this.getCurrentSessionId();
        if (!sid || !this.sessionService) return false;
        if (this.qualityInFlight) return false;
        this.qualityInFlight = true;
        try {
            const envelope = await this.sessionService.fetchQuality(sid);
            this.applySemiliveQualityEnvelope(envelope);
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

    updateQualityPlaceholder() {
        if (!this.el.qualityText) return;

        const txt = String(this.qualitySummaryText || "").trim();
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
        let placeholder = "Quality score appears here for fixture runs.";
        if (fixtureId && (this.awaitingSemiliveResult || this.audioStreaming || this.remoteState === "finalizing")) {
            placeholder = `Fixture ${fixtureId}: quality score will be computed when the transcript is ready.`;
        } else if (fixtureId) {
            placeholder = `Fixture ${fixtureId}: no quality score available yet.`;
        }
        this.el.qualityText.setAttribute("data-placeholder", placeholder);
    }

    applySemiliveResultEnvelope(envelope) {
        const e = envelope && typeof envelope === "object" ? envelope : {};
        const result = e.result && typeof e.result === "object" ? e.result : {};
        const sid = this.getCurrentSessionId();

        this.resultEnvelope = e;
        this.resultCanExportWav = !!e.can_export_wav;
        this.resultCanExportTxt = !!e.can_export_txt;
        this.resultCanExportSrt = !!e.can_export_srt;
        this.resultWavUrl = this.resultCanExportWav ? String(e.recording_wav_url || "") : "";
        this.resultTxtUrl = this.resultCanExportTxt ? String(e.transcript_txt_url || "") : "";
        this.resultSrtUrl = this.resultCanExportSrt ? String(e.transcript_srt_url || "") : "";

        const finalText = String(result.final_text || "");
        if (this.finalText !== finalText) {
            this.finalText = finalText;
            if (this.el.finalText) {
                this.el.finalText.value = finalText;
                this.el.finalText.scrollTop = this.el.finalText.scrollHeight;
            }
        }

        this.partialText = this.formatSemiliveSummary(result);
        this.updatePartialPlaceholder();
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
            this.awaitingSemiliveResult = false;
            if (!this.audioStreaming) {
                this.remoteState = "ready";
                this.setStatus("ready", "Transcript ready. Download TXT, SRT, or WAV.");
            }
            this.stopResultPolling();
            const rev = Number(result.transcript_revision || 0);
            const qualityAlreadyLoaded = (
                this.qualityLoadedSessionId === String(sid || "")
                && Number(this.qualityLoadedRevision) === rev
            );
            if (String(result.fixture_id || "").trim() && !qualityAlreadyLoaded) {
                void this.refreshSemiliveQuality({ quiet: true });
            }
        } else if (!this.audioStreaming) {
            if (finalizationState === "error") {
                this.awaitingSemiliveResult = false;
                this.remoteState = "error";
                this.setStatus("error", "Transcript processing failed.");
                this.stopResultPolling();
            } else if (this.awaitingSemiliveResult || this.remoteState === "ended" || this.remoteState === "disconnected") {
                this.remoteState = "finalizing";
                this.setStatus("finalizing", "Transcript is being processed in chunks...");
            }
        }

        this.updateControls();
    }

    async refreshSemiliveResult(options = {}) {
        const quiet = options.quiet === true;
        const sid = this.getCurrentSessionId();
        if (!sid || !this.sessionService) return false;
        if (this.resultPollInFlight) return false;

        this.resultPollInFlight = true;
        this.updateControls();
        try {
            const envelope = await this.sessionService.fetchResult(sid);
            this.applySemiliveResultEnvelope(envelope);
            return true;
        } catch (err) {
            if (!quiet) {
                const msg = err && err.message ? err.message : String(err);
                this.appendLog(`Result poll failed: ${msg}`);
            }
            return false;
        } finally {
            this.resultPollInFlight = false;
            this.updateControls();
        }
    }

    startResultPolling(options = {}) {
        const intervalMs = Math.max(500, Number(options.intervalMs || 1500));
        const immediate = options.immediate !== false;

        this.stopResultPolling();
        if (immediate) {
            void this.refreshSemiliveResult({ quiet: true });
        }
        this.resultPollTimerId = window.setInterval(() => {
            void this.refreshSemiliveResult({ quiet: true });
        }, intervalMs);
        this.updateControls();
    }

    stopResultPolling() {
        if (this.resultPollTimerId !== null) {
            window.clearInterval(this.resultPollTimerId);
            this.resultPollTimerId = null;
        }
    }

    downloadSemiliveTranscript(kind) {
        const normalized = String(kind || "").trim().toLowerCase();
        const url = normalized === "wav"
            ? this.resultWavUrl
            : normalized === "txt"
                ? this.resultTxtUrl
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
            `mode=${String(p.live_mode || "semilive_chunked")} recording=${boolish("semilive_recording_state")} finalization=${boolish("semilive_finalization_state")}`,
            `rec_ms=${num("semilive_recording_duration_ms")} chunks=${num("semilive_chunks_done")}/${num("semilive_chunks_total")} failed=${num("semilive_chunks_failed")}`,
            `jobs pending=${num("semilive_chunk_jobs_pending")} queue=${num("semilive_chunk_jobs_to_enqueue")} chunk_open=${boolish("semilive_chunker_chunk_open")}`,
        ];

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
        const wsOpen = !!(this.sessionService && this.sessionService.isOpen());
        const wsConnecting = !!(this.sessionService && this.sessionService.isConnecting());
        const hasSessionId = !!this.getCurrentSessionId();

        if (this.el.connectBtn) this.el.connectBtn.disabled = wsOpen || wsConnecting;
        if (this.el.disconnectBtn) this.el.disconnectBtn.disabled = !wsOpen && !wsConnecting;

        if (this.el.startBtn) this.el.startBtn.disabled = this.audioStreaming || wsConnecting;
        if (this.el.pauseBtn) this.el.pauseBtn.disabled = !this.audioStreaming || this.audioPaused || this.fixtureRunActive;
        if (this.el.resumeBtn) this.el.resumeBtn.disabled = !this.audioStreaming || !this.audioPaused || this.fixtureRunActive;
        if (this.el.pingBtn) this.el.pingBtn.disabled = !wsOpen;
        if (this.el.stopBtn) this.el.stopBtn.disabled = !this.audioStreaming;
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
        if (this.el.downloadWavBtn) this.el.downloadWavBtn.disabled = !this.resultCanExportWav || this.audioStreaming;
        if (this.el.downloadTxtBtn) this.el.downloadTxtBtn.disabled = !this.resultCanExportTxt;
        if (this.el.downloadSrtBtn) this.el.downloadSrtBtn.disabled = !this.resultCanExportSrt;

        if (this.el.sessionId) {
            const sid = this.sessionService ? this.sessionService.getSessionId() : "";
            this.el.sessionId.textContent = sid || "(none)";
        }
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
            await this.sessionService.connect();
            this.stopResultPolling();
            this.resetSemiliveResultState();
            this.currentFixtureMeta = null;
            this.awaitingSemiliveResult = false;
            void this.refreshSemiliveResult({ quiet: true });
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
            this.awaitingSemiliveResult = false;
            this.remoteState = "listening";
            this.startRecordingTimer();
            this.sessionService.sendControl("start");
            this.startResultPolling({ immediate: true, intervalMs: 1500 });
            this.setStatus("listening", "Recording in progress. Transcript updates chunk by chunk.");
            this.updatePartialPlaceholder();
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.appendLog(`Microphone start failed: ${msg}`);
            this.setStatus("error", `Microphone start failed: ${msg}`);
            if (this.app && typeof this.app.showAlert === "function") {
                this.app.showAlert("Microphone access failed", msg);
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
        this.startResultPolling({ immediate: false, intervalMs: 1500 });
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
        this.startResultPolling({ immediate: false, intervalMs: 1500 });
        this.setStatus("listening", "Recording in progress. Transcript updates chunk by chunk.");
        this.updatePartialPlaceholder();
        this.updateControls();
    }

    cancelFixtureRun(reason = "cancelled") {
        if (this.fixtureStopTimerId !== null) {
            window.clearTimeout(this.fixtureStopTimerId);
            this.fixtureStopTimerId = null;
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

        const finishIfStillCurrent = async (why) => {
            if (!this.fixtureRunActive || this.fixtureRunToken !== token) return;
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
            this.awaitingSemiliveResult = false;
            this.remoteState = "listening";
            this.sessionService.sendControl("start");
            this.startResultPolling({ immediate: true, intervalMs: 1500 });
            this.setStatus("listening", "Fixture inject in progress. Transcript updates chunk by chunk.");
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

        this.awaitingSemiliveResult = true;
        this.remoteState = "finalizing";
        this.startResultPolling({ immediate: true, intervalMs: 1000 });
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
        this.stopResultPolling();
        this.awaitingSemiliveResult = false;

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
    }

    getRecordingElapsedMs() {
        let total = this.recordingElapsedMs;
        if (this.recordingStartedAtMs > 0) {
            total += Date.now() - this.recordingStartedAtMs;
        }
        return Math.max(0, total);
    }

    updateDurationDisplay() {
        if (!this.el.durationText) return;
        const totalSeconds = Math.floor(this.getRecordingElapsedMs() / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const mm = String(minutes).padStart(2, "0");
        const ss = String(seconds).padStart(2, "0");
        this.el.durationText.textContent = hours > 0
            ? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
            : `${mm}:${ss}`;
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
            void this.refreshSemiliveResult({ quiet: true });
        } else if (t === "control_ack") {
            this.remoteState = String(payload.state || this.remoteState || "connected");
            const ctl = String(payload.control_type || "").toLowerCase();
            if (ctl === "pause") {
                this.setStatus("paused", "Recording paused. Resume to continue.");
            } else if (ctl === "resume" || ctl === "start") {
                this.setStatus("listening", "Recording in progress. Transcript updates chunk by chunk.");
            } else if (ctl === "stop") {
                this.awaitingSemiliveResult = true;
                this.remoteState = "finalizing";
                this.startResultPolling({ immediate: true, intervalMs: 1000 });
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
            this.setDevStats(
                `Stats: ${b} bytes, ${f} frames, ${s.toFixed(2)}s, decode ${decodeMs.toFixed(2)}ms, rtf ${rtf.toFixed(3)}\n\n${this.formatStatsPayload(payload)}`
            );
        } else if (t === "partial") {
            // WhisperLive preview is intentionally de-emphasized in semilive UX.
        } else if (t === "final") {
            // Final transcript for the user comes from semilive result polling (/result).
        } else if (t === "ended") {
            this.stopAudioCapture({ quiet: true });
            this.stopRecordingTimer({ reset: false });
            this.awaitingSemiliveResult = true;
            this.remoteState = "finalizing";
            this.startResultPolling({ immediate: true, intervalMs: 1000 });
            this.setStatus("finalizing", `Recording finished (${payload.reason || "unknown"}). Transcript is being processed...`);
            this.updatePartialPlaceholder();
        } else if (t === "error") {
            const msg = String(payload.message || "Live error");
            this.setStatus("error", msg);
            if (payload.fatal) {
                this.stopAudioCapture({ quiet: true });
                this.stopRecordingTimer({ reset: false });
                if (this.awaitingSemiliveResult) {
                    this.startResultPolling({ immediate: true, intervalMs: 1000 });
                }
            }
            if (this.app && typeof this.app.showAlert === "function") {
                this.app.showAlert("Live session error", msg);
            }
            this.updatePartialPlaceholder();
        }

        this.updateControls();
    }
}
