import { createLiveSession, getApiUrl, fetchUiSettings as fetchUiSettingsEnvelope } from "../api.js";

export class LiveSessionService {
    constructor(options = {}) {
        this.socket = null;
        this.sessionPayload = null;
        this.lastSessionId = "";

        this.onOpen = typeof options.onOpen === "function" ? options.onOpen : null;
        this.onClose = typeof options.onClose === "function" ? options.onClose : null;
        this.onError = typeof options.onError === "function" ? options.onError : null;
        this.onMessage = typeof options.onMessage === "function" ? options.onMessage : null;

        this._onSocketOpen = null;
        this._onSocketClose = null;
        this._onSocketError = null;
        this._onSocketMessage = null;
    }

    isOpen() {
        return !!(this.socket && this.socket.readyState === WebSocket.OPEN);
    }

    isConnecting() {
        return !!(this.socket && this.socket.readyState === WebSocket.CONNECTING);
    }

    getSessionId() {
        const current = this.sessionPayload && this.sessionPayload.session
            ? String(this.sessionPayload.session.session_id || "")
            : "";
        return current || String(this.lastSessionId || "");
    }

    resolveWsUrl(payload) {
        const direct = String(payload && payload.ws_url ? payload.ws_url : "").trim();
        if (direct) {
            try {
                const u = new URL(direct, window.location.href);
                // If the page is HTTPS, never use an insecure ws:// URL.
                if (window.location.protocol === "https:" && u.protocol === "ws:") {
                    const path = String(payload && payload.ws_path ? payload.ws_path : "").trim();
                    if (path) {
                        const prefixed = path.startsWith("/") ? path : `/${path}`;
                        return `wss://${window.location.host}${prefixed}`;
                    }
                    u.protocol = "wss:";
                    return u.toString();
                }
                return u.toString();
            } catch {
                if (window.location.protocol !== "https:" || !direct.startsWith("ws://")) {
                    return direct;
                }
                // Fall through to ws_path synthesis on malformed/insecure direct URL.
            }
        }

        const path = String(payload && payload.ws_path ? payload.ws_path : "").trim();
        if (!path) throw new Error("Missing ws_url/ws_path in live session payload");

        const prefixed = path.startsWith("/") ? path : `/${path}`;
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${scheme}//${window.location.host}${prefixed}`;
    }

    async connect(options = {}) {
        if (this.isOpen() || this.isConnecting()) {
            return this.sessionPayload;
        }

        this.sessionPayload = await createLiveSession(options);
        this.lastSessionId = this.getSessionId();
        const wsUrl = this.resolveWsUrl(this.sessionPayload);

        this.socket = new WebSocket(wsUrl);
        this.socket.binaryType = "arraybuffer";

        this._onSocketOpen = () => {
            if (this.onOpen) this.onOpen();
        };

        this._onSocketClose = (ev) => {
            if (this.onClose) this.onClose(ev);
            this.detachSocketHandlers();
            this.socket = null;
            this.sessionPayload = null;
        };

        this._onSocketError = (ev) => {
            if (this.onError) this.onError(ev);
        };

        this._onSocketMessage = (ev) => {
            if (this.onMessage) this.onMessage(ev.data);
        };

        this.socket.addEventListener("open", this._onSocketOpen);
        this.socket.addEventListener("close", this._onSocketClose);
        this.socket.addEventListener("error", this._onSocketError);
        this.socket.addEventListener("message", this._onSocketMessage);

        return this.sessionPayload;
    }

    detachSocketHandlers() {
        if (!this.socket) return;
        if (this._onSocketOpen) this.socket.removeEventListener("open", this._onSocketOpen);
        if (this._onSocketClose) this.socket.removeEventListener("close", this._onSocketClose);
        if (this._onSocketError) this.socket.removeEventListener("error", this._onSocketError);
        if (this._onSocketMessage) this.socket.removeEventListener("message", this._onSocketMessage);
        this._onSocketOpen = null;
        this._onSocketClose = null;
        this._onSocketError = null;
        this._onSocketMessage = null;
    }

    sendControl(type, options = {}) {
        const msgType = String(type || "").trim().toLowerCase();
        if (!msgType) return false;
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;

        const payload = options && typeof options.payload === "object"
            ? { ...options.payload }
            : {};
        payload.type = msgType;
        try {
            this.socket.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    sendAudioChunk(chunk) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;

        let payload = null;
        if (chunk instanceof ArrayBuffer) {
            payload = chunk;
        } else if (ArrayBuffer.isView(chunk)) {
            payload = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        }
        if (!payload) return false;

        try {
            this.socket.send(payload);
            return true;
        } catch {
            return false;
        }
    }

    destroy(reason = "manual_close", options = {}) {
        const socket = this.socket;
        const sendStop = options.sendStop !== false;
        if (!socket) {
            this.sessionPayload = null;
            return;
        }

        try {
            if (sendStop && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "stop" }));
            }
        } catch {
            // ignore shutdown send failures
        }

        this.detachSocketHandlers();

        try {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close(1000, String(reason || "manual_close"));
            }
        } catch {
            // ignore shutdown close failures
        }

        this.socket = null;
        this.sessionPayload = null;
    }

    async setFixtureMetadata(payload, sessionId) {
        const sid = String(sessionId || this.getSessionId() || "").trim();
        if (!sid) throw new Error("Missing session id");
        const r = await fetch(getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}/fixture`), {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify(payload && typeof payload === "object" ? payload : {}),
        });
        if (!r.ok) throw new Error(`Set live fixture metadata failed: ${r.status}`);
        return await r.json();
    }

    async fetchQuality(sessionId) {
        const sid = String(sessionId || this.getSessionId() || "").trim();
        if (!sid) throw new Error("Missing session id");
        const r = await fetch(getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}/quality`), {
            cache: "no-store",
        });
        if (!r.ok) throw new Error(`Fetch live quality failed: ${r.status}`);
        return await r.json();
    }

    async fetchResult(sessionId) {
        const sid = String(sessionId || this.getSessionId() || "").trim();
        if (!sid) throw new Error("Missing session id");
        const r = await fetch(getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}/result`), {
            cache: "no-store",
        });
        if (!r.ok) throw new Error(`Fetch live result failed: ${r.status}`);
        return await r.json();
    }

    async fetchUiSettings(options = {}) {
        return await fetchUiSettingsEnvelope(options);
    }

    getTranscriptDownloadUrl(kind, sessionId) {
        const sid = String(sessionId || this.getSessionId() || "").trim();
        if (!sid) return "";
        const normalized = String(kind || "").trim().toLowerCase();
        if (normalized === "srt") {
            return getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}/transcript.srt`);
        }
        if (normalized === "wav") {
            return getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}/recording.wav`);
        }
        return "";
    }
}
