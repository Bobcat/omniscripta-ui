const DEFAULT_TARGET_SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_MS = 40;
const WORKLET_NAME = "live-capture-processor";

function concatFloat32(a, b) {
    if (!a || a.length === 0) return b;
    if (!b || b.length === 0) return a;
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export function downsampleBuffer(input, inputRate, outputRate) {
    if (!(input instanceof Float32Array) || input.length === 0) {
        return new Float32Array(0);
    }

    const inRate = Number(inputRate || 0);
    const outRate = Number(outputRate || 0);
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
        return new Float32Array(0);
    }

    if (Math.round(inRate) === Math.round(outRate)) {
        return input;
    }

    if (outRate > inRate) {
        // No upsampling in this path; keep source rate chunks.
        return input;
    }

    const ratio = inRate / outRate;
    const newLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < output.length) {
        const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
        let accum = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
            accum += input[i];
            count += 1;
        }
        output[offsetResult] = count > 0 ? accum / count : 0;
        offsetResult += 1;
        offsetBuffer = nextOffsetBuffer;
    }

    return output;
}

export function float32ToPcm16LeBuffer(samples) {
    const src = samples instanceof Float32Array ? samples : new Float32Array(0);
    const buffer = new ArrayBuffer(src.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < src.length; i += 1) {
        const s = Math.max(-1, Math.min(1, src[i]));
        const val = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        view.setInt16(i * 2, val, true);
    }
    return buffer;
}

function buildWorkletModuleUrl() {
    const code = `
class LiveCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frameLength = input[0] ? input[0].length : 0;
    if (!frameLength) return true;
    const mixed = new Float32Array(frameLength);
    let activeChannels = 0;
    for (let c = 0; c < input.length; c += 1) {
      const channel = input[c];
      if (!channel || channel.length !== frameLength) continue;
      activeChannels += 1;
      for (let i = 0; i < frameLength; i += 1) mixed[i] += channel[i];
    }
    if (activeChannels > 1) {
      for (let i = 0; i < frameLength; i += 1) mixed[i] /= activeChannels;
    }
    if (activeChannels > 0) {
      this.port.postMessage(mixed);
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', LiveCaptureProcessor);
`;
    const blob = new Blob([code], { type: "application/javascript" });
    return URL.createObjectURL(blob);
}

const DEFAULT_SETTINGS = {
    preGain: 1.0,
    noiseSuppression: false,
    autoGainControl: false,
    echoCancellation: false,
};

export class LiveAudioService {
    constructor(options = {}) {
        this.targetSampleRate = Number(options.targetSampleRate || DEFAULT_TARGET_SAMPLE_RATE);
        this.chunkMs = Number(options.chunkMs || DEFAULT_CHUNK_MS);
        this.onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
        this.onError = typeof options.onError === "function" ? options.onError : null;

        this.mediaStream = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.preGainNode = null;
        this.processorNode = null;
        this.fallbackGainNode = null;
        this.workletUrl = null;
        this.analyserNode = null;
        this.analyserDataArray = null;

        this.started = false;
        this.paused = true;

        this.inputSampleRate = 0;
        this.chunkSamples = Math.max(80, Math.round((this.targetSampleRate * this.chunkMs) / 1000));
        this.pendingSamples = new Float32Array(0);

        this.settings = { ...DEFAULT_SETTINGS };
    }

    fail(err) {
        if (this.onError) this.onError(err);
    }

    isCapturing() {
        return !!this.started;
    }

    isPaused() {
        return !!this.paused;
    }

    async _enumerateAudioInputs() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === 'audioinput');
        } catch {
            return [];
        }
    }

    async _tryGetUserMedia(constraints) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            return stream;
        } catch (err) {
            const name = String(err && err.name ? err.name : "").trim();
            const isPermissionError = ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(name);
            return { error: err, isPermissionError };
        }
    }

    async start(settings = {}) {
        if (this.started) {
            this.paused = false;
            return;
        }

        this.settings = {
            preGain: Number.isFinite(settings.preGain) ? settings.preGain : DEFAULT_SETTINGS.preGain,
            noiseSuppression: !!settings.noiseSuppression,
            autoGainControl: !!settings.autoGainControl,
            echoCancellation: !!settings.echoCancellation,
        };

        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            throw new Error("Microphone API not available in this browser.");
        }
        // Strategy 1: Try standard constraints first
        const standardConstraints = {
            audio: {
                channelCount: 1,
                sampleRate: this.targetSampleRate,
                noiseSuppression: this.settings.noiseSuppression,
                echoCancellation: this.settings.echoCancellation,
                autoGainControl: this.settings.autoGainControl,
            },
            video: false,
        };

        let result = await this._tryGetUserMedia(standardConstraints);
        if (result instanceof MediaStream) {
            this.mediaStream = result;
        } else if (result.isPermissionError) {
            throw result.error;
        } else {
            // Strategy 2: Get list of available devices and try each one
            const devices = await this._enumerateAudioInputs();
            const deviceIds = devices
                .filter(d => d.deviceId)
                .map(d => d.deviceId);

            let acquiredStream = null;

            // Try each device with relaxed constraints
            for (const deviceId of deviceIds) {
                const deviceConstraints = {
                    audio: {
                        deviceId: { exact: deviceId },
                        noiseSuppression: this.settings.noiseSuppression,
                        echoCancellation: this.settings.echoCancellation,
                        autoGainControl: this.settings.autoGainControl,
                    },
                    video: false,
                };

                result = await this._tryGetUserMedia(deviceConstraints);
                if (result instanceof MediaStream) {
                    acquiredStream = result;
                    break;
                }
                if (result.isPermissionError) {
                    throw result.error;
                }
            }

            // Strategy 3: If no specific device worked, try default
            if (!acquiredStream) {
                const defaultConstraints = {
                    audio: {
                        noiseSuppression: this.settings.noiseSuppression,
                        echoCancellation: this.settings.echoCancellation,
                        autoGainControl: this.settings.autoGainControl,
                    },
                    video: false,
                };

                result = await this._tryGetUserMedia(defaultConstraints);
                if (result instanceof MediaStream) {
                    acquiredStream = result;
                } else if (result.isPermissionError) {
                    throw result.error;
                }
            }

            // Strategy 4: Last resort - any audio
            if (!acquiredStream) {
                result = await this._tryGetUserMedia({ audio: true, video: false });
                if (result instanceof MediaStream) {
                    acquiredStream = result;
                } else if (result.isPermissionError) {
                    throw result.error;
                } else {
                    throw result.error;
                }
            }

            this.mediaStream = acquiredStream;
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            this.stop();
            throw new Error("Web Audio API not available in this browser.");
        }

        this.audioContext = new Ctx({ latencyHint: "interactive" });
        this.inputSampleRate = Number(this.audioContext.sampleRate || this.targetSampleRate);
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

        // Create pre-gain node (for VU meter to reflect actual gain)
        this.preGainNode = this.audioContext.createGain();
        this.preGainNode.gain.value = this.settings.preGain || 1.0;
        this.sourceNode.connect(this.preGainNode);

        let workletReady = false;
        if (this.audioContext.audioWorklet && typeof window.AudioWorkletNode !== "undefined") {
            try {
                this.workletUrl = buildWorkletModuleUrl();
                await this.audioContext.audioWorklet.addModule(this.workletUrl);

                const node = new AudioWorkletNode(this.audioContext, WORKLET_NAME, {
                    numberOfInputs: 1,
                    numberOfOutputs: 0,
                    channelCount: 1,
                });
                node.port.onmessage = (ev) => this.handleFloatChunk(ev.data);

                // Chain: source -> preGain -> processor
                this.preGainNode.connect(node);
                this.processorNode = node;
                workletReady = true;

                // Add analyser for VU meter (after preGain so it reflects the gain)
                this.setupAnalyser();
            } catch {
                // Fall back to ScriptProcessor below.
            }
        }

        if (!workletReady) {
            const bufferSize = 4096;
            const node = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            node.onaudioprocess = (ev) => {
                if (!ev || !ev.inputBuffer) return;
                const inputBuffer = ev.inputBuffer;
                const channels = Number(inputBuffer.numberOfChannels || 0);
                if (!channels) return;
                const frameLength = Number(inputBuffer.length || 0);
                if (!frameLength) return;

                const mixed = new Float32Array(frameLength);
                let activeChannels = 0;
                for (let c = 0; c < channels; c += 1) {
                    const data = inputBuffer.getChannelData(c);
                    if (!data || data.length !== frameLength) continue;
                    activeChannels += 1;
                    for (let i = 0; i < frameLength; i += 1) mixed[i] += data[i];
                }
                if (!activeChannels) return;
                if (activeChannels > 1) {
                    for (let i = 0; i < frameLength; i += 1) mixed[i] /= activeChannels;
                }

                this.handleFloatChunk(mixed);
            };

            const muteGain = this.audioContext.createGain();
            muteGain.gain.value = 0;

            // Chain: source -> preGain -> processor -> muteGain (to prevent feedback)
            this.preGainNode.connect(node);
            node.connect(muteGain);
            muteGain.connect(this.audioContext.destination);

            this.processorNode = node;
            this.fallbackGainNode = muteGain;

            // Add analyser for VU meter (after preGain)
            this.setupAnalyser();
        }

        try {
            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume();
            }
        } catch {
            // keep running best-effort
        }

        this.pendingSamples = new Float32Array(0);
        this.started = true;
        this.paused = false;
    }

    pause() {
        if (!this.started) return;
        this.paused = true;
    }

    resume() {
        if (!this.started) return;
        this.paused = false;
    }

    handleFloatChunk(rawChunk) {
        if (this.paused || !this.started) return;
        if (!(rawChunk instanceof Float32Array) || rawChunk.length === 0) return;

        try {
            // Pre-gain is now applied in the audio graph via preGainNode
            // No need to apply it again here
            const down = downsampleBuffer(rawChunk, this.inputSampleRate, this.targetSampleRate);
            if (!down || down.length === 0) return;

            this.pendingSamples = concatFloat32(this.pendingSamples, down);
            while (this.pendingSamples.length >= this.chunkSamples) {
                const frame = this.pendingSamples.slice(0, this.chunkSamples);
                this.pendingSamples = this.pendingSamples.slice(this.chunkSamples);
                const pcm = float32ToPcm16LeBuffer(frame);
                if (this.onChunk) this.onChunk(pcm);
            }
        } catch (err) {
            this.fail(err);
        }
    }

    stop() {
        this.paused = true;
        this.started = false;

        if (this.processorNode) {
            try {
                this.processorNode.disconnect();
            } catch {
                // ignore disconnect failure
            }
            if (this.processorNode.port && typeof this.processorNode.port.onmessage !== "undefined") {
                this.processorNode.port.onmessage = null;
            }
        }
        this.processorNode = null;

        if (this.fallbackGainNode) {
            try {
                this.fallbackGainNode.disconnect();
            } catch {
                // ignore disconnect failure
            }
            this.fallbackGainNode = null;
        }

        if (this.preGainNode) {
            try {
                this.preGainNode.disconnect();
            } catch {
                // ignore disconnect failure
            }
            this.preGainNode = null;
        }

        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch {
                // ignore disconnect failure
            }
            this.sourceNode = null;
        }

        if (this.mediaStream) {
            try {
                this.mediaStream.getTracks().forEach((t) => t.stop());
            } catch {
                // ignore stream stop failure
            }
            this.mediaStream = null;
        }

        if (this.audioContext) {
            try {
                this.audioContext.close();
            } catch {
                // ignore context close failure
            }
            this.audioContext = null;
        }

        if (this.workletUrl) {
            try {
                URL.revokeObjectURL(this.workletUrl);
            } catch {
                // ignore revoke failure
            }
            this.workletUrl = null;
        }

        if (this.analyserNode) {
            try {
                this.analyserNode.disconnect();
            } catch {
                // ignore disconnect failure
            }
            this.analyserNode = null;
        }
        this.analyserDataArray = null;

        this.inputSampleRate = 0;
        this.pendingSamples = new Float32Array(0);
    }

    setupAnalyser() {
        if (!this.audioContext || !this.preGainNode) return;
        try {
            this.analyserNode = this.audioContext.createAnalyser();
            this.analyserNode.fftSize = 256;
            this.analyserDataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

            // Connect preGainNode to analyser so VU meter reflects the gain
            // (analyser is not connected to destination - it's just for monitoring)
            this.preGainNode.connect(this.analyserNode);
        } catch {
            // VU meter is optional; capture can continue without it.
        }
    }

    /**
     * Get current audio input level (0.0 to 1.0)
     * Uses time domain data for accurate amplitude measurement
     * @returns {number} Level between 0.0 (silence) and 1.0 (max)
     */
    getLevel() {
        if (!this.analyserNode || !this.analyserDataArray) return 0;
        this.analyserNode.getByteTimeDomainData(this.analyserDataArray);

        // Calculate peak amplitude (values are 0-255, 128 is silence)
        let peak = 0;
        for (let i = 0; i < this.analyserDataArray.length; i++) {
            // Distance from center (128)
            const amplitude = Math.abs(this.analyserDataArray[i] - 128);
            if (amplitude > peak) peak = amplitude;
        }

        // Convert to 0-1 range (max amplitude is 128)
        return Math.min(1, peak / 128);
    }

    /**
     * Update pre-gain value (can be called while recording)
     * @param {number} value - Gain value (0.5 to 3.0)
     */
    setPreGain(value) {
        const newGain = Number.isFinite(value) ? Math.max(0.1, Math.min(5.0, value)) : 1.0;
        this.settings.preGain = newGain;
        if (this.preGainNode && this.audioContext) {
            try {
                this.preGainNode.gain.setTargetAtTime(newGain, this.audioContext.currentTime, 0.1);
            } catch (err) {
                // Fallback for older browsers
                try {
                    this.preGainNode.gain.value = newGain;
                } catch {
                    // ignore
                }
            }
        }
    }
}
