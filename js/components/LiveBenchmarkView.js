import { fetchLiveBenchmarks } from "../api.js";

function escHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function fmtMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "inject") return "Inject";
    if (mode === "playback") return "Play";
    return "—";
}

function fmtReasons(value) {
    const obj = value && typeof value === "object" ? value : {};
    const pairs = Object.entries(obj).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join(", ") : "—";
}

function getTuning(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const asr = snap.asr && typeof snap.asr === "object" ? snap.asr : {};
    const timing = snap.timing && typeof snap.timing === "object" ? snap.timing : {};
    const rolling = snap.rolling && typeof snap.rolling === "object" ? snap.rolling : {};
    const vad = rolling.vad && typeof rolling.vad === "object" ? rolling.vad : {};
    return {
        cs: asr.chunk_size ?? "",
        minNewMs: rolling.min_new_audio_ms ?? "",
        maxDecodeMs: rolling.max_decode_window_ms ?? "",
        singleCommitMs: rolling.single_segment_commit_min_ms ?? "",
        emitMinMs: timing.emit_min_ms ?? "",
        vadEnabled: vad.enabled === true ? "on" : (vad.enabled === false ? "off" : ""),
    };
}

export class LiveBenchmarkView {
    constructor(app) {
        this.app = app;
        this.rows = [];
        this.mode = "all";
        this.generatedAtUtc = "";
        this.currentTuning = {};
        this.el = {};
    }

    getHtml() {
        return `
      <div class="bench-matrix-wrap">
        <div class="bench-matrix-header">
          <div>
            <h1 class="bench-matrix-title">Live Benchmark Matrix</h1>
            <p class="bench-matrix-subtitle">Recent fixture runs with score, revisions, chunk counts, and captured live tuning.</p>
          </div>
          <div class="bench-matrix-actions">
            <button id="benchBackBtn" class="btn-small" type="button">Back to Live</button>
            <button id="benchRefreshBtn" class="btn-small" type="button">Refresh</button>
          </div>
        </div>

        <div id="benchStatusLine" class="bench-matrix-status muted">Loading…</div>

        <div class="bench-matrix-toolbar">
          <div class="bench-matrix-filters" role="group" aria-label="Benchmark mode filter">
            <button id="benchModeAllBtn" class="btn-small" type="button">All</button>
            <button id="benchModePlaybackBtn" class="btn-small" type="button">Play</button>
            <button id="benchModeInjectBtn" class="btn-small" type="button">Inject</button>
          </div>
          <div id="benchCurrentTuning" class="bench-matrix-current muted"></div>
        </div>

        <div class="bench-matrix-table-wrap">
          <table class="bench-matrix-table">
            <thead>
              <tr>
                <th>Saved</th>
                <th>Mode</th>
                <th>Score</th>
                <th>Rev</th>
                <th>Chunks</th>
                <th>Rec s</th>
                <th>CS</th>
                <th>min new</th>
                <th>max decode</th>
                <th>single commit</th>
                <th>emit min</th>
                <th>VAD</th>
                <th>Reasons</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody id="benchTableBody">
              <tr><td colspan="14" class="bench-matrix-empty">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    }

    mount(container) {
        container.innerHTML = this.getHtml();
        this.captureElements();
        this.bindUi();
        this.renderFilters();
        void this.load();
    }

    unmount() {
        return null;
    }

    captureElements() {
        this.el.statusLine = document.getElementById("benchStatusLine");
        this.el.refreshBtn = document.getElementById("benchRefreshBtn");
        this.el.backBtn = document.getElementById("benchBackBtn");
        this.el.modeAllBtn = document.getElementById("benchModeAllBtn");
        this.el.modePlaybackBtn = document.getElementById("benchModePlaybackBtn");
        this.el.modeInjectBtn = document.getElementById("benchModeInjectBtn");
        this.el.currentTuning = document.getElementById("benchCurrentTuning");
        this.el.tableBody = document.getElementById("benchTableBody");
    }

    bindUi() {
        if (this.el.refreshBtn) {
            this.el.refreshBtn.addEventListener("click", () => void this.load());
        }
        if (this.el.backBtn) {
            this.el.backBtn.addEventListener("click", () => this.app.navigateTo("live"));
        }
        if (this.el.modeAllBtn) {
            this.el.modeAllBtn.addEventListener("click", () => this.setMode("all"));
        }
        if (this.el.modePlaybackBtn) {
            this.el.modePlaybackBtn.addEventListener("click", () => this.setMode("playback"));
        }
        if (this.el.modeInjectBtn) {
            this.el.modeInjectBtn.addEventListener("click", () => this.setMode("inject"));
        }
    }

    setStatus(text) {
        if (this.el.statusLine) this.el.statusLine.textContent = String(text || "");
    }

    setMode(mode) {
        const next = String(mode || "all").trim().toLowerCase();
        this.mode = next === "inject" || next === "playback" ? next : "all";
        this.renderFilters();
        void this.load();
    }

    renderFilters() {
        const activeClass = "is-active";
        if (this.el.modeAllBtn) this.el.modeAllBtn.classList.toggle(activeClass, this.mode === "all");
        if (this.el.modePlaybackBtn) this.el.modePlaybackBtn.classList.toggle(activeClass, this.mode === "playback");
        if (this.el.modeInjectBtn) this.el.modeInjectBtn.classList.toggle(activeClass, this.mode === "inject");
    }

    renderCurrentTuning() {
        if (!this.el.currentTuning) return;
        const tuning = getTuning(this.currentTuning);
        const parts = [];
        if (tuning.cs !== "") parts.push(`active cs=${tuning.cs}`);
        if (tuning.minNewMs !== "") parts.push(`min_new=${tuning.minNewMs}`);
        if (tuning.maxDecodeMs !== "") parts.push(`max_decode=${tuning.maxDecodeMs}`);
        if (tuning.singleCommitMs !== "") parts.push(`single_commit=${tuning.singleCommitMs}`);
        if (tuning.emitMinMs !== "") parts.push(`emit_min=${tuning.emitMinMs}`);
        if (tuning.vadEnabled !== "") parts.push(`vad=${tuning.vadEnabled}`);
        this.el.currentTuning.textContent = parts.length ? parts.join(" | ") : "No current tuning snapshot";
    }

    renderTable() {
        if (!this.el.tableBody) return;
        if (!Array.isArray(this.rows) || !this.rows.length) {
            this.el.tableBody.innerHTML = `<tr><td colspan="14" class="bench-matrix-empty">No benchmark rows found.</td></tr>`;
            return;
        }

        this.el.tableBody.innerHTML = this.rows.map((row) => {
            const tuning = getTuning(row.live_tuning_snapshot);
            const recMs = Number(row.recording_duration_ms || 0);
            const recS = recMs > 0 ? (recMs / 1000).toFixed(2) : "—";
            return `
          <tr>
            <td>${escHtml(row.saved_at_utc || "—")}</td>
            <td>${escHtml(fmtMode(row.fixture_test_mode))}</td>
            <td>${escHtml(row.score ?? "—")}</td>
            <td>${escHtml(row.transcript_revision ?? "—")}</td>
            <td>${escHtml(row.chunks_total ?? "—")}</td>
            <td>${escHtml(recS)}</td>
            <td>${escHtml(tuning.cs || "—")}</td>
            <td>${escHtml(tuning.minNewMs || "—")}</td>
            <td>${escHtml(tuning.maxDecodeMs || "—")}</td>
            <td>${escHtml(tuning.singleCommitMs || "—")}</td>
            <td>${escHtml(tuning.emitMinMs || "—")}</td>
            <td>${escHtml(tuning.vadEnabled || "—")}</td>
            <td class="bench-matrix-reasons">${escHtml(fmtReasons(row.chunk_reason_counts))}</td>
            <td class="bench-matrix-session">${escHtml(row.session_id || "—")}</td>
          </tr>
        `;
        }).join("");
    }

    async load() {
        if (this.el.refreshBtn) this.el.refreshBtn.disabled = true;
        this.setStatus("Loading…");
        try {
            const payload = await fetchLiveBenchmarks({
                limit: 60,
                mode: this.mode === "all" ? "" : this.mode,
            });
            this.rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
            this.generatedAtUtc = String(payload && payload.generated_at_utc || "").trim();
            this.currentTuning = payload && typeof payload.current_tuning_snapshot === "object"
                ? payload.current_tuning_snapshot
                : {};
            this.renderCurrentTuning();
            this.renderTable();
            this.setStatus(this.generatedAtUtc ? `Loaded at ${this.generatedAtUtc}` : "Loaded");
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.rows = [];
            this.currentTuning = {};
            this.renderCurrentTuning();
            this.renderTable();
            this.setStatus(`Failed to load benchmarks: ${msg}`);
        } finally {
            if (this.el.refreshBtn) this.el.refreshBtn.disabled = false;
        }
    }
}
