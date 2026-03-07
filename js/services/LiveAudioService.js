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

export class LiveAudioService {
    constructor(options = {}) {
        this.targetSampleRate = Number(options.targetSampleRate || DEFAULT_TARGET_SAMPLE_RATE);
        this.chunkMs = Number(options.chunkMs || DEFAULT_CHUNK_MS);
        this.onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
        this.onError = typeof options.onError === "function" ? options.onError : null;
        this.onLog = typeof options.onLog === "function" ? options.onLog : null;

        this.mediaStream = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.fallbackGainNode = null;
        this.workletUrl = null;

        this.mode = "idle";
        this.started = false;
        this.paused = true;

        this.inputSampleRate = 0;
        this.chunkSamples = Math.max(80, Math.round((this.targetSampleRate * this.chunkMs) / 1000));
        this.pendingSamples = new Float32Array(0);
        this.sentChunks = 0;
    }

    log(msg) {
        if (this.onLog) this.onLog(String(msg || ""));
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
        } catch (e) {
            return [];
        }
    }

    async _tryGetUserMedia(constraints, label) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.log(`Mic acquired${label ? ` (${label})` : ''}`);
            return stream;
        } catch (err) {
            const name = String(err && err.name ? err.name : "").trim();
            const isPermissionError = ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(name);
            return { error: err, isPermissionError };
        }
    }

    async start() {
        if (this.started) {
            this.paused = false;
            return;
        }

        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            throw new Error("Microphone API not available in this browser.");
        }        
        // Strategy 1: Try standard constraints first
        const standardConstraints = {
            audio: {
                channelCount: 1,
                sampleRate: this.targetSampleRate,
                noiseSuppression: false,
                echoCancellation: false,
                autoGainControl: false,
            },
            video: false,
        };
        
        let result = await this._tryGetUserMedia(standardConstraints, "standard constraints");
        if (result instanceof MediaStream) {
            this.mediaStream = result;
        } else if (result.isPermissionError) {
            throw result.error;
        } else {
            // Strategy 2: Get list of available devices and try each one
            this.log(`Standard constraints failed (${result.error && result.error.message ? result.error.message : String(result.error)}); scanning for available mics...`);
            
            const devices = await this._enumerateAudioInputs();
            const deviceIds = devices
                .filter(d => d.deviceId)
                .map(d => ({ id: d.deviceId, label: d.label || d.deviceId.slice(0, 8) }));
            
            this.log(`Found ${deviceIds.length} audio input(s)`);
            
            let acquiredStream = null;
            
            // Try each device with relaxed constraints
            for (const device of deviceIds) {
                this.log(`Trying device: ${device.label}...`);
                const deviceConstraints = {
                    audio: {
                        deviceId: { exact: device.id },
                        noiseSuppression: false,
                        echoCancellation: false,
                        autoGainControl: false,
                    },
                    video: false,
                };
                
                result = await this._tryGetUserMedia(deviceConstraints, `device ${device.label}`);
                if (result instanceof MediaStream) {
                    acquiredStream = result;
                    this.log(`Successfully acquired mic: ${device.label}`);
                    break;
                }
                if (result.isPermissionError) {
                    throw result.error;
                }
            }
            
            // Strategy 3: If no specific device worked, try default
            if (!acquiredStream) {
                this.log("No specific device worked; trying default mic...");
                const defaultConstraints = {
                    audio: {
                        noiseSuppression: false,
                        echoCancellation: false,
                        autoGainControl: false,
                    },
                    video: false,
                };
                
                result = await this._tryGetUserMedia(defaultConstraints, "default");
                if (result instanceof MediaStream) {
                    acquiredStream = result;
                } else if (result.isPermissionError) {
                    throw result.error;
                }
            }
            
            // Strategy 4: Last resort - any audio
            if (!acquiredStream) {
                this.log("Default failed; trying any available audio...");
                result = await this._tryGetUserMedia({ audio: true, video: false }, "any audio");
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

                this.sourceNode.connect(node);
                this.processorNode = node;
                this.mode = "worklet";
                workletReady = true;
            } catch (err) {
                this.log(`AudioWorklet unavailable, fallback to ScriptProcessor (${err && err.message ? err.message : err})`);
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

            const gain = this.audioContext.createGain();
            gain.gain.value = 0;

            this.sourceNode.connect(node);
            node.connect(gain);
            gain.connect(this.audioContext.destination);

            this.processorNode = node;
            this.fallbackGainNode = gain;
            this.mode = "script_processor";
        }

        try {
            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume();
            }
        } catch {
            // keep running best-effort
        }

        this.pendingSamples = new Float32Array(0);
        this.sentChunks = 0;
        this.started = true;
        this.paused = false;

        this.log(`Mic capture started (${this.mode}, input ${Math.round(this.inputSampleRate)}Hz -> ${Math.round(this.targetSampleRate)}Hz)`);
    }

    pause() {
        if (!this.started) return;
        this.paused = true;
        this.log("Mic capture paused");
    }

    resume() {
        if (!this.started) return;
        this.paused = false;
        this.log("Mic capture resumed");
    }

    handleFloatChunk(rawChunk) {
        if (this.paused || !this.started) return;
        if (!(rawChunk instanceof Float32Array) || rawChunk.length === 0) return;

        try {
            const down = downsampleBuffer(rawChunk, this.inputSampleRate, this.targetSampleRate);
            if (!down || down.length === 0) return;

            this.pendingSamples = concatFloat32(this.pendingSamples, down);
            while (this.pendingSamples.length >= this.chunkSamples) {
                const frame = this.pendingSamples.slice(0, this.chunkSamples);
                this.pendingSamples = this.pendingSamples.slice(this.chunkSamples);
                const pcm = float32ToPcm16LeBuffer(frame);
                if (this.onChunk) this.onChunk(pcm);
                this.sentChunks += 1;
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

        this.mode = "idle";
        this.inputSampleRate = 0;
        this.pendingSamples = new Float32Array(0);
        this.log(`Mic capture stopped (${this.sentChunks} chunks sent)`);
    }
}
