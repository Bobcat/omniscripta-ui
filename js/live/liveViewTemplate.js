import { TRANSCRIPT_LANGUAGES } from "../constants/languages.js";
import { DEV_LIVE_FIXTURE_OPTIONS } from "./dev/liveFixtures.js";

export function renderLiveViewHtml() {
    const langOptions = [
        "<option value=\"\">Auto detect</option>",
        ...TRANSCRIPT_LANGUAGES.map((l) => (`<option value=\"${String(l.code || "")}\">${String(l.flag || "")} ${String(l.name || l.code || "")}</option>`)),
    ].join("");
    return `
      <div class="live-wrap">
        <h1 class="sr-only">Live Recording Session</h1>

        <!-- Main content area (always 100vh) -->
        <div class="live-main">

        <!-- Top bar: badge + timer -->
        <header class="live-header">
          <div class="header-left">
            <span class="live-status-badge status-idle" id="liveStatusBadge">Ready</span>
          </div>
          <div class="header-right">
            <span class="live-vad-badge hidden" id="liveVadBadge" aria-live="polite">Listening...</span>
            <div class="timer timer-top hidden" id="liveDurationTextTop">00:00</div>
          </div>
        </header>

        <!-- Content area (no card, full height) -->
        <div class="live-content-area" id="liveTranscriptArea">
          <div class="live-demo-overlay hidden" id="liveDemoOverlay" aria-live="polite">
            <div class="live-demo-dialog">
              <div class="live-demo-eyebrow">Demo mode</div>
              <h2>Choose a live demo</h2>
              <p class="live-demo-copy">
                Try the real live transcription view with a prerecorded sample. Pick the path that fits what you want to experience.
              </p>
              <div class="live-demo-option">
                <button class="btn-primary-start live-demo-primary" id="liveDemoInjectBtn" type="button">Instant demo</button>
                <p>
                  Demo mode: A prerecorded sample is fed directly into live transcription. Transcript text appears immediately, but you will not hear the audio through your speakers.
                </p>
              </div>
              <div class="live-demo-option">
                <button class="btn-outline live-demo-secondary" id="liveDemoPlaybackBtn" type="button">Speaker + mic demo</button>
                <p>
                  Plays the sample through your speakers and records it through your microphone. More realistic, but it depends on your browser, speaker volume, and mic setup.
                </p>
              </div>
              <div class="live-demo-actions">
                <button class="btn-outline live-demo-skip" id="liveDemoSkipBtn" type="button">Use live view normally</button>
              </div>
            </div>
          </div>

          <!-- Idle placeholder -->
          <div class="live-placeholder" id="livePlaceholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
            <span>Click start to begin recording...</span>

            <!-- Idle: round start button moved inside placeholder -->
            <div class="live-float-idle" id="liveFloatIdle" style="margin-top: 16px;">
              <button class="btn-primary-start" id="liveStartBtn" type="button" title="Start Recording" aria-label="Start Recording"></button>
            </div>
          </div>

          <!-- Transcript text (hidden when idle) -->
          <div id="liveFinalText" class="live-final-text hidden" aria-live="polite" tabindex="0">
            <span id="liveFinalTextMain" class="live-final-text-main"></span><span id="liveFinalTextPreview" class="live-final-text-preview hidden"></span>
          </div>

        </div>

        <!-- Fixed Bottom Controls -->
        <div class="live-bottom-bar" id="liveControlsFloat">

          <!-- Left: Desktop Timer + Language -->
          <div class="controls-left">
            <div class="timer timer-bottom-desktop" id="liveDurationTextBottom">00:00</div>
            <div class="live-language-picker" id="liveLanguagePicker">
              <button
                id="liveAudioSettingsBtn"
                class="live-audio-settings-btn"
                type="button"
                title="Advanced audio options"
                aria-label="Advanced audio options"
                aria-expanded="false"
              >
                <span class="material-symbols-outlined" aria-hidden="true">settings</span>
              </button>
              <select id="liveLanguageSelect" class="live-select live-language-select" title="Auto is recommended unless you are sure about the spoken language.">
                ${langOptions}
              </select>
            </div>
          </div>

          <!-- Center: Actions -->
          <div class="controls-center">
            <!-- Listening: Pause + Finish -->
            <div class="live-float-listening hidden" id="liveFloatListening">
              <button class="btn-secondary" id="livePauseBtn" type="button">Pause</button>
              <button class="btn-danger" id="liveStopBtn" type="button">Finish</button>
            </div>

            <!-- Paused: Resume + Finish -->
            <div class="live-float-paused hidden" id="liveFloatPaused">
              <button class="btn-secondary" id="liveResumeBtn" type="button">Resume</button>
              <button class="btn-danger" id="liveStopPausedBtn" type="button">Finish</button>
            </div>

            <!-- Connecting / Finalizing: status message -->
            <div class="live-float-processing hidden" id="liveFloatProcessing">
              <span class="live-float-processing-text" id="liveProcessingText">Connecting...</span>
            </div>
          </div>

          <!-- Right: Exports + Dev Toggle -->
          <div class="controls-right" style="flex-wrap: nowrap; justify-content: flex-end;">
            <!-- Finished: downloads + clear -->
            <div class="live-float-finished hidden" id="liveFloatFinished" style="display: flex; gap: 6px; flex-wrap: nowrap; justify-content: flex-end;">
              <button class="btn-outline btn-compact" id="liveDownloadWavBtn" type="button" disabled>WAV</button>
              <button class="btn-outline btn-compact" id="liveDownloadTxtBtn" type="button" disabled>TXT</button>
              <button class="btn-outline btn-compact" id="liveDownloadSrtBtn" type="button" disabled>SRT</button>
              <button class="btn-outline btn-compact" id="liveDownloadPcBtn" type="button" disabled>P/C</button>
              <button class="btn-outline btn-compact" id="liveClearBtn" type="button" style="color: var(--accent-red); border-color: transparent;">Clear</button>
            </div>

            <!-- Dev Tools toggle (always visible) -->
            <button class="btn-outline btn-dev-toggle" id="liveDevToggleBtn" type="button" aria-expanded="false" title="Dev Tools">
              <span class="dev-toggle-icon">⚙</span>
              <span class="dev-toggle-text">Dev Tools</span>
            </button>
          </div>

        </div>

        </div>
        <!-- /live-main -->

        <!-- Advanced audio panel -->
        <div class="live-audio-panel hidden" id="liveAudioPanel" role="dialog" aria-modal="false" aria-label="Advanced audio options">
          <div class="live-audio-panel-card dialog-card" id="liveAudioPanelCard">
            <div class="dialog-topbar dialog-drag-handle" id="liveAudioPanelDragHandle" title="Drag to move">
              <div class="dialog-title">Advanced audio</div>
              <div class="dialog-grip" aria-hidden="true">⋮⋮</div>
            </div>
            <div class="dialog-body live-audio-panel-body">
              <div class="live-audio-pregain">
                <div class="live-audio-pregain-head">
                  <label for="liveAudioPreGain">Mic pre-gain</label>
                  <span class="live-audio-ui-value" id="liveAudioPreGainUiValue">1.0x</span>
                </div>
                <input id="liveAudioPreGain" type="range" min="0.5" max="3.0" step="0.1" value="1.0" />
              </div>

              <div class="live-vu-meter-wrap">
                <div class="live-vu-meter-label">Input level</div>
                <div class="live-vu-meter-bar">
                  <canvas id="liveAudioVUMeter" width="200" height="20"></canvas>
                </div>
              </div>

              <div class="live-audio-toggles">
                <label class="live-audio-toggle">
                  <input id="liveAudioAutoGainControl" type="checkbox" />
                  <span>Auto gain control</span>
                </label>
              </div>

              <div class="live-audio-sep"></div>

              <div class="live-audio-kv"><span class="muted">Device</span><span id="liveAudioCurrentDevice">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Input sample rate</span><span id="liveAudioCurrentSampleRate">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Channel count</span><span id="liveAudioCurrentChannelCount">Start recording to read</span></div>
              <div class="live-audio-kv"><span class="muted">Chunk cadence</span><span id="liveAudioCurrentChunkMs">40 ms</span></div>

              <div class="live-audio-panel-actions">
                <button class="mini live-audio-panel-reset" id="liveAudioPanelResetBtn" type="button">Reset to defaults</button>
                <div class="live-audio-panel-actions-right">
                  <button class="mini live-audio-panel-record" id="liveAudioPanelRecordBtn" type="button">Start Recording</button>
                  <button class="mini live-audio-panel-close" id="liveAudioPanelCloseBtn" type="button">Close</button>
                </div>
              </div>
            </div>
          </div>
        </div>


        <!-- Dev section (hidden by default) -->
        <div class="live-dev-section hidden" id="liveDevSection">

          <!-- Session card -->
          <div class="live-card live-controls">

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

            <div class="live-secondary-row">
              <button id="liveOpenBenchmarkMatrixBtn" type="button">Benchmark matrix</button>
            </div>

            <div class="live-session-row">
              <div class="muted">Audio file (dev)</div>
              <div class="live-file-picker">
                <input id="liveInjectAudioFileInput" class="live-file-input" type="file" accept="audio/*" />
                <button id="liveChooseAudioFileBtn" type="button">Choose file</button>
                <div id="liveInjectAudioFileName" class="live-file-name">No file selected</div>
              </div>
            </div>

            <div class="live-secondary-row">
              <button id="liveRunUploadedInjectBtn" type="button">Inject audio file</button>
            </div>
          </div>

          <!-- Run/Benchmark card -->
          <div class="live-card live-run-panels">

            <div class="live-run-panel-card">
              <div class="live-label">Status / processing</div>
              <div class="live-partial-text" id="livePartialText" data-placeholder="Processing summary appears here."></div>
            </div>

            <div class="live-run-panel-card">
              <div class="live-label">Cadence / snappiness</div>
              <div class="live-partial-text live-quality-report" id="liveCadenceText" data-placeholder="Cadence indicator appears once the visible transcript starts updating."></div>
            </div>

            <div class="live-run-panel-card live-run-panel-card-wide">
              <div class="live-label">Run metrics / benchmark</div>
              <div class="live-partial-text live-quality-report" id="liveQualityText" data-placeholder="Quality score appears here for fixture runs."></div>
            </div>

            <div class="live-run-panel-card">
              <div class="live-label">Engine runtime</div>
              <div class="live-partial-text live-quality-report" id="liveEngineText" data-placeholder="Engine runtime details appear here once live results start arriving."></div>
            </div>
          </div>

        </div>

      </div>
    `;
}
