const LIVE_VAD_PHASE_LABELS = {
    speech: "Speech detected",
    hangover: "Recent speech",
    silence: "No speech",
    disabled: "Disabled",
    unknown: "Unknown",
};

const LIVE_VAD_SPEECH_BADGE_MAX_AGE_MS = 220;
const LIVE_VAD_SPEECH_BADGE_HOLD_MS = 900;

export function createLiveVadState() {
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

export function normalizeVadPhase(value) {
    const v = String(value || "").trim().toLowerCase();
    if (v === "speech" || v === "hangover" || v === "silence") return v;
    if (v === "disabled") return "disabled";
    return "unknown";
}

export function vadLabelForPhase(phase) {
    const p = normalizeVadPhase(phase);
    return LIVE_VAD_PHASE_LABELS[p] || LIVE_VAD_PHASE_LABELS.unknown;
}

export function extractEngineState(result) {
    const r = result && typeof result === "object" ? result : {};
    const runtime = r.engine_runtime && typeof r.engine_runtime === "object" ? r.engine_runtime : {};
    const engineState = runtime.engine_state && typeof runtime.engine_state === "object"
        ? runtime.engine_state
        : runtime;
    return engineState && typeof engineState === "object" ? engineState : {};
}

export function nextLiveVadStateFromResult(currentState, result, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const state = currentState && typeof currentState === "object" ? currentState : createLiveVadState();
    const engineState = extractEngineState(result);
    const vad = engineState.vad && typeof engineState.vad === "object" ? engineState.vad : null;
    if (!vad || vad.enabled !== true) {
        return {
            ...state,
            enabled: false,
            phase: "disabled",
            label: "",
            speechHintUntilMs: 0,
        };
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

    return {
        ...state,
        enabled: true,
        phase,
        label: vadLabelForPhase(phase),
        speechHintUntilMs,
        lastSpeechAgeMs: ageMs,
        hangoverMs,
        checks: Number.isFinite(Number(st.checks)) ? Number(st.checks) : state.checks,
        speechAllows: Number.isFinite(Number(st.speech_checks)) ? Number(st.speech_checks) : state.speechAllows,
        hangoverAllows: Number.isFinite(Number(st.hangover_allows)) ? Number(st.hangover_allows) : state.hangoverAllows,
        silenceSkips: Number.isFinite(Number(st.silence_checks)) ? Number(st.silence_checks) : state.silenceSkips,
    };
}

export function nextLiveVadStateFromStats(currentState, payload, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const p = payload && typeof payload === "object" ? payload : {};
    const g = p.rolling_guardrails && typeof p.rolling_guardrails === "object" ? p.rolling_guardrails : null;
    if (!g) return null;

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
        return null;
    }

    const state = currentState && typeof currentState === "object" ? currentState : createLiveVadState();
    const seemsEnabled = !!state.enabled || nextChecks > 0 || nextSpeech > 0 || nextHangover > 0 || nextSilence > 0;
    if (!seemsEnabled) return null;
    const prevChecks = Number(state.checks || 0);
    const prevSpeech = Number(state.speechAllows || 0);
    const prevHangover = Number(state.hangoverAllows || 0);
    const prevSilence = Number(state.silenceSkips || 0);
    let phase = normalizeVadPhase(state.phase);
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

    return {
        ...state,
        enabled: true,
        phase,
        label: vadLabelForPhase(phase),
        speechHintUntilMs,
        checks: nextChecks,
        speechAllows: nextSpeech,
        hangoverAllows: nextHangover,
        silenceSkips: nextSilence,
    };
}

export function shouldShowLiveVadSpeechBadge(state, options = {}) {
    const phase = normalizeVadPhase(state && state.phase);
    const enabled = !!(state && state.enabled);
    const speechHintUntilMs = Number(state && state.speechHintUntilMs || 0);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const speechActive = phase === "speech" && speechHintUntilMs > nowMs;
    const remoteState = String(options.remoteState || "").toLowerCase();
    const sessionActive = !!options.audioStreaming || remoteState === "listening";
    return enabled && sessionActive && speechActive;
}
