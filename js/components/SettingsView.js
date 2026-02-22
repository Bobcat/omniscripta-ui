import { fetchServiceSettings } from "../api.js";

function escHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function fmtUtcOrDash(raw) {
    const s = String(raw || "").trim();
    if (!s) return "—";
    return s;
}

export class SettingsView {
    constructor(app) {
        this.app = app;
        this.sources = [];
        this.activeSourceId = "";
    }

    getHtml() {
        return `
      <div class="svc-settings-wrap">
        <div class="svc-settings-header">
          <div>
            <h1 class="svc-settings-title">Service settings</h1>
            <p class="svc-settings-subtitle">Read-only runtime configuration from backend files.</p>
          </div>
          <button id="settingsRefreshBtn" class="btn-small" type="button">Refresh</button>
        </div>

        <div id="settingsStatusLine" class="svc-settings-status muted">Loading…</div>
        <div id="settingsTabs" class="svc-settings-tabs"></div>
        <div id="settingsPanel" class="svc-settings-panel"></div>
      </div>
    `;
    }

    mount(container) {
        container.innerHTML = this.getHtml();
        this.bindUi();
        this.load();
    }

    unmount() {
        return null;
    }

    bindUi() {
        const refreshBtn = document.getElementById("settingsRefreshBtn");
        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => this.load());
        }
    }

    setStatus(text) {
        const line = document.getElementById("settingsStatusLine");
        if (line) line.textContent = String(text || "");
    }

    async load() {
        const refreshBtn = document.getElementById("settingsRefreshBtn");
        if (refreshBtn) refreshBtn.disabled = true;
        this.setStatus("Loading…");

        try {
            const payload = await fetchServiceSettings();
            const items = Array.isArray(payload?.sources) ? payload.sources : [];
            this.sources = items;
            if (!this.sources.length) {
                this.activeSourceId = "";
                this.renderTabs();
                this.renderPanel();
                this.setStatus("No config sources returned by backend.");
                return;
            }
            const validCurrent = this.sources.some((s) => String(s?.id || "") === this.activeSourceId);
            if (!validCurrent) this.activeSourceId = String(this.sources[0]?.id || "");
            this.renderTabs();
            this.renderPanel();
            const gen = fmtUtcOrDash(payload?.generated_at_utc);
            this.setStatus(`Loaded at ${gen}`);
        } catch (err) {
            this.sources = [];
            this.activeSourceId = "";
            this.renderTabs();
            this.renderPanel();
            const msg = err && err.message ? err.message : String(err);
            this.setStatus(`Failed to load settings: ${msg}`);
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    renderTabs() {
        const tabs = document.getElementById("settingsTabs");
        if (!tabs) return;
        if (!this.sources.length) {
            tabs.innerHTML = "";
            return;
        }
        tabs.innerHTML = this.sources.map((src) => {
            const id = String(src?.id || "");
            const title = String(src?.title || id || "unknown");
            const active = id === this.activeSourceId ? " active" : "";
            return `<button type="button" class="svc-settings-tab${active}" data-source-id="${escHtml(id)}">${escHtml(title)}</button>`;
        }).join("");
        tabs.querySelectorAll(".svc-settings-tab").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = String(btn.getAttribute("data-source-id") || "");
                if (!id) return;
                this.activeSourceId = id;
                this.renderTabs();
                this.renderPanel();
            });
        });
    }

    renderPanel() {
        const panel = document.getElementById("settingsPanel");
        if (!panel) return;

        if (!this.sources.length || !this.activeSourceId) {
            panel.innerHTML = `<div class="svc-settings-empty">No settings to display.</div>`;
            return;
        }

        const src = this.sources.find((s) => String(s?.id || "") === this.activeSourceId);
        if (!src) {
            panel.innerHTML = `<div class="svc-settings-empty">Selected source not found.</div>`;
            return;
        }

        const exists = !!src.exists;
        const parseOk = !!src.parse_ok;
        const dataText = parseOk ? JSON.stringify(src.data ?? {}, null, 2) : "";
        const errorText = src.error ? String(src.error) : "";

        panel.innerHTML = `
      <div class="svc-settings-meta">
        <div><strong>Path:</strong> <code>${escHtml(src.path || "")}</code></div>
        <div><strong>Exists:</strong> ${exists ? "yes" : "no"}</div>
        <div><strong>Parse OK:</strong> ${parseOk ? "yes" : "no"}</div>
        <div><strong>Size:</strong> ${src.size_bytes != null ? `${Number(src.size_bytes)} bytes` : "—"}</div>
        <div><strong>Modified (UTC):</strong> ${escHtml(fmtUtcOrDash(src.mtime_utc))}</div>
      </div>
      ${errorText ? `<div class="svc-settings-error">${escHtml(errorText)}</div>` : ""}
      ${parseOk ? `<pre class="svc-settings-json">${escHtml(dataText)}</pre>` : ""}
    `;
    }
}
