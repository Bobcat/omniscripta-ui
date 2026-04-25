const SETTINGS_KEY = 'transcript_editor_settings_v1';
const UI_SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;
let uiSettingsCacheValue = null;
let uiSettingsCacheAtMs = 0;
let uiSettingsInFlight = null;

export function getApiUrl(path) {
    return path.startsWith('/') ? path : `/${path}`;
}

export function loadSettings() {
    const defaults = {
        keepCenteredDuringPlayback: false,
        autoAssignSplitTs: false,
    };
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return defaults;
        const s = JSON.parse(raw);

        // Validate/merge
        if (s.keepCenteredDuringPlayback !== undefined) {
            if (typeof s.keepCenteredDuringPlayback === 'string') defaults.keepCenteredDuringPlayback = (s.keepCenteredDuringPlayback.toLowerCase() === 'true');
            else if (typeof s.keepCenteredDuringPlayback === 'number') defaults.keepCenteredDuringPlayback = (s.keepCenteredDuringPlayback !== 0);
            else defaults.keepCenteredDuringPlayback = !!s.keepCenteredDuringPlayback;
        }

        if (s.autoAssignSplitTs !== undefined) {
            if (typeof s.autoAssignSplitTs === 'string') defaults.autoAssignSplitTs = (s.autoAssignSplitTs.toLowerCase() === 'true');
            else if (typeof s.autoAssignSplitTs === 'number') defaults.autoAssignSplitTs = (s.autoAssignSplitTs !== 0);
            else defaults.autoAssignSplitTs = !!s.autoAssignSplitTs;
        }
    } catch { }
    return defaults;
}

export function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { }
}

export async function fetchJobStatus(jobId) {
    const r = await fetch(getApiUrl(`/api/demo/jobs/${encodeURIComponent(jobId)}`), { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch job failed: ${r.status}`);
    return await r.json();
}

export async function fetchSrt(url) {
    const r = await fetch(getApiUrl(url), { cache: "no-store" });
    if (!r.ok) throw new Error(`fetch srt failed: ${r.status}`);
    return await r.text();
}

export async function fetchServiceSettings() {
    const r = await fetch(getApiUrl("/api/demo/settings"), { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch settings failed: ${r.status}`);
    return await r.json();
}

export async function fetchUiSettings(options = {}) {
    const forceRefresh = !!(options && options.forceRefresh === true);
    const rawMaxAge = options && options.maxAgeMs;
    const maxAgeMs = Number.isFinite(rawMaxAge)
        ? Math.max(0, Number(rawMaxAge))
        : UI_SETTINGS_CACHE_TTL_MS;

    const now = Date.now();
    const hasFreshCache = (
        uiSettingsCacheValue !== null
        && maxAgeMs > 0
        && (now - uiSettingsCacheAtMs) <= maxAgeMs
    );

    if (!forceRefresh && hasFreshCache) {
        return uiSettingsCacheValue;
    }
    if (!forceRefresh && uiSettingsInFlight) {
        return uiSettingsInFlight;
    }

    uiSettingsInFlight = (async () => {
        const r = await fetch(getApiUrl("/api/ui/settings"), { cache: "no-store" });
        if (!r.ok) throw new Error(`Fetch ui settings failed: ${r.status}`);
        const payload = await r.json();
        uiSettingsCacheValue = payload;
        uiSettingsCacheAtMs = Date.now();
        return payload;
    })();
    try {
        return await uiSettingsInFlight;
    } finally {
        uiSettingsInFlight = null;
    }
}


export async function createLiveSession(options = {}) {
    const qs = new URLSearchParams();
    if (options && options.ttlSeconds !== undefined && options.ttlSeconds !== null && String(options.ttlSeconds).trim() !== "") {
        qs.set("ttl_s", String(options.ttlSeconds).trim());
    }
    if (options && options.language !== undefined && options.language !== null) {
        const lang = String(options.language).trim();
        if (lang) qs.set("language", lang);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const r = await fetch(getApiUrl(`/api/demo/live/sessions${suffix}`), {
        method: "POST",
        cache: "no-store",
    });
    if (!r.ok) throw new Error(`Create live session failed: ${r.status}`);
    return await r.json();
}

export async function fetchLiveSession(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) throw new Error("Missing session id");
    const r = await fetch(getApiUrl(`/api/demo/live/sessions/${encodeURIComponent(sid)}`), { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch live session failed: ${r.status}`);
    return await r.json();
}

export async function fetchLiveBenchmarks(options = {}) {
    const qs = new URLSearchParams();
    const limit = Number(options && options.limit);
    const mode = String(options && options.mode || "").trim().toLowerCase();
    if (Number.isFinite(limit) && limit > 0) {
        qs.set("limit", String(Math.max(1, Math.min(200, Math.round(limit)))));
    }
    if (mode === "inject" || mode === "playback") {
        qs.set("mode", mode);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const r = await fetch(getApiUrl(`/api/demo/live/benchmarks${suffix}`), { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch live benchmarks failed: ${r.status}`);
    return await r.json();
}
