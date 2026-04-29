import { downsampleBuffer, float32ToPcm16LeBuffer } from "../LiveAudioService.js";
import { DEV_LIVE_FIXTURES, DEV_LIVE_FIXTURE_OPTIONS, LIVE_DEMO_LANGUAGE_CODE } from "./liveFixtures.js";

function waitMs(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, Math.max(0, Number(ms || 0)));
    });
}

async function setFixtureMetadata(view, meta) {
    if (!view.sessionService || !meta.fixture_id) return;
    try {
        await view.sessionService.setFixtureMetadata(meta);
    } catch {
        // Fixture metadata is optional for ad-hoc live runs.
    }
}

function beginFixtureRun(view, label) {
    view.fixtureRunActive = true;
    view.fixtureRunLabel = label;
    const token = view.fixtureRunToken + 1;
    view.fixtureRunToken = token;
    view.updateControls();
    return token;
}

function clearActiveFixtureRun(view, token, { restoreDemoLanguage = false } = {}) {
    if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
    view.fixtureRunActive = false;
    view.fixtureRunLabel = "";
    if (restoreDemoLanguage) view.restoreDemoLanguage();
    view.updateControls();
}

export function cancelFixtureRun(view) {
    if (view.fixtureStopTimerId !== null) {
        window.clearTimeout(view.fixtureStopTimerId);
        view.fixtureStopTimerId = null;
    }
    if (view.fixtureWatchdogTimerId !== null) {
        window.clearTimeout(view.fixtureWatchdogTimerId);
        view.fixtureWatchdogTimerId = null;
    }
    if (view.fixtureAudio) {
        try {
            view.fixtureAudio.pause();
        } catch {
            // ignore
        }
        try {
            view.fixtureAudio.src = "";
        } catch {
            // ignore
        }
        view.fixtureAudio = null;
    }

    view.fixtureRunActive = false;
    view.fixtureRunLabel = "";
    view.fixtureRunToken += 1;
    view.restoreDemoLanguage();
    view.updateControls();
}

export function getSelectedFixtureConfig(view, mode = "playback") {
    const selected = String(
        (view.el.fixtureSelect && view.el.fixtureSelect.value)
        || view.selectedFixtureKey
        || (DEV_LIVE_FIXTURE_OPTIONS[0] ? DEV_LIVE_FIXTURE_OPTIONS[0].value : "panel120v1")
    ).trim();
    const normalizedMode = String(mode || "playback").trim().toLowerCase();
    const key = normalizedMode === "inject" ? `${selected}Inject` : selected;
    return DEV_LIVE_FIXTURES[key] || DEV_LIVE_FIXTURES.panel120v1;
}

export async function startSelectedFixtureRun(view, mode = "playback") {
    const cfg = getSelectedFixtureConfig(view, mode);
    return startFixtureRun(view, cfg);
}

export async function startFixtureRun(view, fixture) {
    const cfg = fixture && typeof fixture === "object" ? fixture : null;
    if (!cfg || !cfg.url) return;
    const mode = String(cfg.mode || "playback").trim().toLowerCase();
    if (mode === "inject") {
        return startFixtureInjectRun(view, cfg);
    }
    if (view.fixtureRunActive || view.audioStreaming) {
        return;
    }

    cancelFixtureRun(view);
    view.activateDemoLanguage(LIVE_DEMO_LANGUAGE_CODE);
    const token = beginFixtureRun(view, String(cfg.id || "fixture"));

    const audio = new Audio(String(cfg.url));
    audio.preload = "auto";
    view.fixtureAudio = audio;
    let finishRequested = false;

    const finishIfStillCurrent = async () => {
        if (finishRequested) return;
        finishRequested = true;
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
        if (view.fixtureWatchdogTimerId !== null) {
            window.clearTimeout(view.fixtureWatchdogTimerId);
            view.fixtureWatchdogTimerId = null;
        }
        view.fixtureStopTimerId = window.setTimeout(() => {
            view.fixtureStopTimerId = null;
            if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            try {
                void view.stopMic();
            } finally {
                if (view.fixtureAudio) {
                    try {
                        view.fixtureAudio.pause();
                    } catch {
                        // ignore
                    }
                    view.fixtureAudio = null;
                }
                view.updateControls();
            }
        }, Math.max(0, Number(cfg.tailDelayMs || 0)));
    };

    audio.addEventListener("ended", () => {
        void finishIfStillCurrent();
    }, { once: true });

    audio.addEventListener("error", () => {
        if (view.fixtureRunActive && view.fixtureRunToken === token) {
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            view.restoreDemoLanguage();
            view.updateControls();
            if (view.audioStreaming) {
                view.stopMic();
            }
        }
    }, { once: true });

    try {
        await view.startMic();
        if (!view.audioStreaming) {
            throw new Error("Recording did not start");
        }
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        view.currentFixtureMeta = {
            fixture_id: String(cfg.id || "").trim(),
            fixture_version: String(cfg.version || "").trim(),
            fixture_test_mode: "playback",
        };
        await setFixtureMetadata(view, view.currentFixtureMeta);
        view.updateQualityPlaceholder();

        await waitMs(Number(cfg.startDelayMs || 0));
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === "function") {
            await playPromise;
        }
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
        const durationMs = Math.max(0, Number(cfg.durationMs || 0));
        if (durationMs > 0) {
            const watchdogGraceMs = 2500;
            view.fixtureWatchdogTimerId = window.setTimeout(() => {
                view.fixtureWatchdogTimerId = null;
                void finishIfStillCurrent();
            }, durationMs + watchdogGraceMs);
        }
    } catch {
        if (view.fixtureRunActive && view.fixtureRunToken === token) {
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            view.restoreDemoLanguage();
            if (view.audioStreaming) {
                view.stopMic();
            }
            view.updateControls();
        }
    }
}

export async function decodeAudioArrayBufferToMono(bytes) {
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
}

export async function streamDecodedAudioRealtime(view, pcmFrames, sampleRate, token) {
    const targetRate = (view.audioService && Number(view.audioService.targetSampleRate)) || 16000;
    const chunkMs = (view.audioService && Number(view.audioService.chunkMs)) || 40;
    const chunkSamples = Math.max(80, Math.round((targetRate * chunkMs) / 1000));
    const mono16k = downsampleBuffer(pcmFrames, Number(sampleRate || targetRate), targetRate);
    let nextDue = performance.now();
    for (let off = 0; off < mono16k.length; off += chunkSamples) {
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
        if (!view.sessionService || !view.sessionService.isOpen()) {
            throw new Error("Live socket closed during audio inject");
        }
        const frame = mono16k.slice(off, Math.min(mono16k.length, off + chunkSamples));
        const pcm = float32ToPcm16LeBuffer(frame);
        const ok = view.sessionService.sendAudioChunk(pcm);
        if (!ok) {
            throw new Error("Socket not writable during audio inject");
        }
        nextDue += chunkMs;
        const wait = Math.max(0, nextDue - performance.now());
        if (wait > 0) {
            await waitMs(wait);
        } else {
            await Promise.resolve();
        }
    }
}

export async function startFixtureInjectRun(view, fixture) {
    const cfg = fixture && typeof fixture === "object" ? fixture : null;
    if (!cfg || !cfg.url) return;
    if (view.fixtureRunActive || view.audioStreaming) {
        return;
    }

    cancelFixtureRun(view);
    view.activateDemoLanguage(LIVE_DEMO_LANGUAGE_CODE);
    const token = beginFixtureRun(view, String(cfg.id || "fixture") + " (inject)");

    try {
        const connectStarted = await view.connectSession();
        if (!connectStarted) throw new Error("Live session connect failed");
        if (view.sessionService && view.sessionService.isConnecting()) {
            const opened = await view.waitForSocketOpen(5000);
            if (!opened) throw new Error("WebSocket did not open in time");
        }
        if (!view.sessionService || !view.sessionService.isOpen()) {
            throw new Error("Live connection is not open");
        }

        view.stopRecordingTimer({ reset: true });
        view.audioStreaming = true;
        view.audioPaused = false;
        view.awaitingLiveResult = false;
        view.remoteState = "listening";
        view.sessionService.sendControl("start");
        view.setStatus("listening", "Fixture inject in progress.");
        view.updatePartialPlaceholder();

        view.currentFixtureMeta = {
            fixture_id: String(cfg.id || "").trim(),
            fixture_version: String(cfg.version || "").trim(),
            fixture_test_mode: "inject",
        };
        await setFixtureMetadata(view, view.currentFixtureMeta);
        view.updateQualityPlaceholder();
        view.updateControls();

        await waitMs(Number(cfg.startDelayMs || 0));
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        const fixtureRes = await fetch(String(cfg.url), { cache: "no-store" });
        if (!fixtureRes.ok) {
            throw new Error(`Fixture fetch failed (${fixtureRes.status})`);
        }
        const decoded = await decodeAudioArrayBufferToMono(await fixtureRes.arrayBuffer());
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
        view.startRecordingTimer();
        await streamDecodedAudioRealtime(view, decoded.samples, decoded.sampleRate, token);
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        view.fixtureStopTimerId = window.setTimeout(() => {
            view.fixtureStopTimerId = null;
            if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            try {
                void view.stopMic();
            } finally {
                view.updateControls();
            }
        }, Math.max(0, Number(cfg.tailDelayMs || 0)));
    } catch {
        if (view.fixtureRunActive && view.fixtureRunToken === token) {
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            view.restoreDemoLanguage();
            if (view.audioStreaming) {
                view.stopMic();
            }
            view.updateControls();
        }
    }
}

export async function startUploadedAudioInjectRun(view) {
    const file = view.selectedInjectAudioFile instanceof File ? view.selectedInjectAudioFile : null;
    if (!file) {
        return;
    }
    if (view.fixtureRunActive || view.audioStreaming) {
        return;
    }

    cancelFixtureRun(view);
    const token = beginFixtureRun(view, `${String(file.name || "audio file")} (inject)`);

    try {
        const connectStarted = await view.connectSession();
        if (!connectStarted) throw new Error("Live session connect failed");
        if (view.sessionService && view.sessionService.isConnecting()) {
            const opened = await view.waitForSocketOpen(5000);
            if (!opened) throw new Error("WebSocket did not open in time");
        }
        if (!view.sessionService || !view.sessionService.isOpen()) {
            throw new Error("Live connection is not open");
        }

        view.stopRecordingTimer({ reset: true });
        view.audioStreaming = true;
        view.audioPaused = false;
        view.awaitingLiveResult = false;
        view.remoteState = "listening";
        view.sessionService.sendControl("start");
        view.setStatus("listening", "Audio file inject in progress.");
        view.currentFixtureMeta = null;
        view.updatePartialPlaceholder();
        view.updateQualityPlaceholder();
        view.updateControls();

        await waitMs(700);
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        const decoded = await decodeAudioArrayBufferToMono(await file.arrayBuffer());
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
        view.startRecordingTimer();
        await streamDecodedAudioRealtime(view, decoded.samples, decoded.sampleRate, token);
        if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;

        view.fixtureStopTimerId = window.setTimeout(() => {
            view.fixtureStopTimerId = null;
            if (!view.fixtureRunActive || view.fixtureRunToken !== token) return;
            view.fixtureRunActive = false;
            view.fixtureRunLabel = "";
            try {
                void view.stopMic();
            } finally {
                view.updateControls();
            }
        }, 1200);
    } catch {
        clearActiveFixtureRun(view, token);
        if (view.audioStreaming) {
            view.stopMic();
        }
    }
}
