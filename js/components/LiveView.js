import { LiveAudioService } from "../services/LiveAudioService.js";
import { LiveSessionService } from "../services/LiveSessionService.js";

const STATUS_LABELS = {
    idle: "Idle",
    connecting: "Connecting",
    connected: "Connected",
    ready: "Ready",
    listening: "Listening",
    paused: "Paused",
    ended: "Finished",
    disconnected: "Disconnected",
    error: "Error",
};

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
                <span class="live-status-pill-note">Live</span>
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
            </div>

            <div class="live-dev-toggle-row">
              <div>
                <div class="live-dev-toggle-label">Developer tools</div>
              </div>
              <button id="liveDevToggleBtn" type="button" class="live-dev-toggle-btn" aria-expanded="false">Show</button>
            </div>

            <div class="live-dev-panel hidden" id="liveDevPanel">
              <div class="live-session-row">
                <div class="muted">Session ID</div>
                <code id="liveSessionId">(none)</code>
              </div>

              <div class="live-dev-stats muted" id="liveDevStats">No stats yet</div>

              <div class="live-controls-grid live-controls-grid-dev">
                <button class="primary" id="liveConnectBtn" type="button">Connect</button>
                <button id="liveDisconnectBtn" type="button" disabled>Disconnect</button>
                <button id="livePingBtn" type="button" disabled>Ping</button>
              </div>

              <div class="live-log-block">
                <div class="live-log-title">Event log</div>
                <div class="live-event-log" id="liveEventLog"></div>
              </div>
            </div>
          </section>

          <section class="live-card live-output">
            <div class="live-output-header">
              <div>
                <div class="live-section-kicker">Transcript</div>
              </div>
            </div>

            <textarea id="liveFinalText" class="live-final-text" spellcheck="false" readonly></textarea>

            <div class="live-partial-row">
              <div class="live-label">Current phrase (partial)</div>
              <div class="live-partial-text" id="livePartialText" data-placeholder="Live partial text verschijnt hier."></div>
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
        this.toggleDeveloperTools(false);
        this.updateDurationDisplay();
        this.updatePartialPlaceholder();
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
        this.sessionService = null;
        return {};
    }

    initServices() {
        if (!this.sessionService) {
            this.sessionService = new LiveSessionService({
                onOpen: () => {
                    this.setStatus("connected", "Connected. Waiting for live engine...");
                    this.updateControls();
                },
                onClose: (ev) => {
                    this.appendLog(`Socket closed (code=${ev && ev.code !== undefined ? ev.code : "?"}, reason=${ev && ev.reason ? ev.reason : "none"})`);
                    this.stopAudioCapture({ quiet: true });
                    this.stopRecordingTimer({ reset: false });
                    this.remoteState = "disconnected";
                    this.setStatus("disconnected", "Disconnected");
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

        if (this.el.finalText) this.el.finalText.value = "";
        if (this.el.partialText) this.el.partialText.textContent = "";
        if (this.el.log) this.el.log.textContent = "";
        if (this.el.devStats) this.el.devStats.textContent = "No stats yet";

        this.updatePartialPlaceholder();
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
            `decode_last=${num("decode_ms_last").toFixed(2)}ms rtf=${num("rtf").toFixed(3)} calls=${num("decode_calls")}`,
            `p/f=${num("partials_emitted")}/${num("finals_emitted")} rev=${num("revision")} committed_segs=${num("committed_segments")} chars=${num("committed_chars")}`,
            `ready=${boolish("engine_ready")} rx=${num("engine_rx_messages")} parse=${num("engine_rx_parse_errors")} unknown=${num("engine_rx_unknown_messages")}`,
            `tx_audio=${num("engine_tx_sidecar_audio_bytes")} committed_until_ms=${num("committed_until_ms")} tail=${boolish("has_partial_tail")}`,
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

        if (this.el.connectBtn) this.el.connectBtn.disabled = wsOpen || wsConnecting;
        if (this.el.disconnectBtn) this.el.disconnectBtn.disabled = !wsOpen && !wsConnecting;

        if (this.el.startBtn) this.el.startBtn.disabled = this.audioStreaming || wsConnecting;
        if (this.el.pauseBtn) this.el.pauseBtn.disabled = !this.audioStreaming || this.audioPaused;
        if (this.el.resumeBtn) this.el.resumeBtn.disabled = !this.audioStreaming || !this.audioPaused;
        if (this.el.pingBtn) this.el.pingBtn.disabled = !wsOpen;
        if (this.el.stopBtn) this.el.stopBtn.disabled = !this.audioStreaming;

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
            this.remoteState = "listening";
            this.startRecordingTimer();
            this.sessionService.sendControl("start");
            this.setStatus("listening", "Opname loopt. Transcript wordt live opgebouwd.");
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
        this.setStatus("paused", "Opname gepauzeerd. Hervat om verder te gaan.");
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
        this.setStatus("listening", "Opname loopt. Transcript wordt live opgebouwd.");
        this.updatePartialPlaceholder();
        this.updateControls();
    }

    stopMic() {
        this.stopAudioCapture({ quiet: true });
        this.stopRecordingTimer({ reset: false });

        if (this.sessionService) {
            const ok = this.sessionService.sendControl("stop");
            if (!ok) {
                this.appendLog("Failed to send stop control (socket not open)");
            }
        }

        this.setStatus(this.remoteState || "connected", "Opname wordt afgerond...");
        this.updatePartialPlaceholder();
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
        this.stopAudioCapture({ quiet: true });
        this.stopRecordingTimer({ reset: true });

        if (this.sessionService) {
            this.sessionService.destroy(reason, { sendStop: options.sendStop !== false });
        }

        this.remoteState = "idle";
        this.setStatus("idle", "Not connected");
        this.updatePartialPlaceholder();
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

        let placeholder = "Live partial text verschijnt hier.";
        if (this.audioStreaming && this.audioPaused) {
            placeholder = "Opname gepauzeerd.";
        } else if (this.audioStreaming) {
            placeholder = "Luistert... partial tekst verschijnt zodra er spraak is.";
        } else if (this.remoteState === "ready" || this.remoteState === "connected") {
            placeholder = "Klaar om op te nemen.";
        } else if (this.remoteState === "ended") {
            placeholder = "Opname klaar. Partial buffer is leeg.";
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
            this.setStatus("ready", "Klaar. Start opname wanneer je wilt.");
        } else if (t === "control_ack") {
            this.remoteState = String(payload.state || this.remoteState || "connected");
            const ctl = String(payload.control_type || "").toLowerCase();
            if (ctl === "pause") {
                this.setStatus("paused", "Opname gepauzeerd. Hervat om verder te gaan.");
            } else if (ctl === "resume" || ctl === "start") {
                this.setStatus("listening", "Opname loopt. Transcript wordt live opgebouwd.");
            } else if (ctl === "stop") {
                this.setStatus(this.remoteState || "connected", "Opname wordt afgerond...");
            } else {
                this.setStatus(this.remoteState || "connected", `Control ontvangen: ${ctl || "ack"}`);
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
            this.partialText = String(payload.text || "");
            this.updatePartialPlaceholder();
        } else if (t === "final") {
            const txt = String(payload.text || "").trim();
            if (txt) {
                this.finalText = this.finalText ? `${this.finalText}\n${txt}` : txt;
                if (this.el.finalText) {
                    this.el.finalText.value = this.finalText;
                    this.el.finalText.scrollTop = this.el.finalText.scrollHeight;
                }
            }
            this.partialText = "";
            this.updatePartialPlaceholder();
        } else if (t === "ended") {
            this.stopAudioCapture({ quiet: true });
            this.stopRecordingTimer({ reset: false });
            this.remoteState = "ended";
            this.setStatus("ended", `Opname klaar: ${payload.reason || "unknown"}`);
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
