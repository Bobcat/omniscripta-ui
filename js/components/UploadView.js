import { getApiUrl } from "../api.js";
import { ProjectService } from "../services/ProjectService.js";

const LANGUAGES = [
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'nl', flag: '🇳🇱', name: 'Dutch' },
  { code: 'de', flag: '🇩🇪', name: 'German' },
  { code: 'fr', flag: '🇫🇷', name: 'French' },
  { code: 'es', flag: '🇪🇸', name: 'Spanish' },
  { code: 'it', flag: '🇮🇹', name: 'Italian' },
  { code: 'pt', flag: '🇵🇹', name: 'Portuguese' },
  { code: 'ru', flag: '🇷🇺', name: 'Russian' },
  { code: 'zh', flag: '🇨🇳', name: 'Chinese' },
  { code: 'ja', flag: '🇯🇵', name: 'Japanese' },
  { code: 'ko', flag: '🇰🇷', name: 'Korean' },
  { code: 'pl', flag: '🇵🇱', name: 'Polish' },
  { code: 'uk', flag: '🇺🇦', name: 'Ukrainian' },
  { code: 'tr', flag: '🇹🇷', name: 'Turkish' },
  { code: 'ar', flag: '🇸🇦', name: 'Arabic' },
  { code: 'hi', flag: '🇮🇳', name: 'Hindi' },
  { code: 'el', flag: '🇬🇷', name: 'Greek' },
  { code: 'cs', flag: '🇨🇿', name: 'Czech' },
  { code: 'da', flag: '🇩🇰', name: 'Danish' },
  { code: 'fi', flag: '🇫🇮', name: 'Finnish' },
  { code: 'hu', flag: '🇭🇺', name: 'Hungarian' },
  { code: 'no', flag: '🇳🇴', name: 'Norwegian' },
  { code: 'ro', flag: '🇷🇴', name: 'Romanian' },
  { code: 'sk', flag: '🇸🇰', name: 'Slovak' },
  { code: 'sv', flag: '🇸🇪', name: 'Swedish' },
  { code: 'th', flag: '🇹🇭', name: 'Thai' },
  { code: 'vi', flag: '🇻🇳', name: 'Vietnamese' },
  { code: 'id', flag: '🇮🇩', name: 'Indonesian' },
  { code: 'ms', flag: '🇲🇾', name: 'Malay' },
  { code: 'he', flag: '🇮🇱', name: 'Hebrew' },
  { code: 'fa', flag: '🇮🇷', name: 'Persian' },
  { code: 'bg', flag: '🇧🇬', name: 'Bulgarian' },
  { code: 'ca', flag: '🇪🇸', name: 'Catalan' },
  { code: 'hr', flag: '🇭🇷', name: 'Croatian' },
  { code: 'lt', flag: '🇱🇹', name: 'Lithuanian' },
  { code: 'lv', flag: '🇱🇻', name: 'Latvian' },
  { code: 'sl', flag: '🇸🇮', name: 'Slovenian' },
  { code: 'sr', flag: '🇷🇸', name: 'Serbian' },
  { code: 'et', flag: '🇪🇪', name: 'Estonian' }
];

export class UploadView {
  constructor(app) {
    this.app = app;
    this.projectService = new ProjectService();
    // Temporary state for the selected file before upload
    this.selectedFile = null;
  }

  getHtml() {
    const langOptions = LANGUAGES.map(l =>
      `<option value="${l.code}">${l.flag} ${l.name}</option>`
    ).join('');

    return `
      <div class="upload-wrap">
        <div class="wrap">
        <div class="top">
          <div class="dot" aria-hidden="true"></div>
          <div class="brand">Omniscripta</div>
        </div>

        <h1 class="subtle-header">Upload → Transcribe → Edit &amp; Export</h1>
        <p class="sub">
          Upload an audio file. When transcription is ready, the editor opens automatically.
        </p>


        <div class="panel">
          
          <!-- Step 1: Choose File -->
          <div id="step1" class="upload-zone" onclick="document.getElementById('fileInput').click()">
            <div class="upload-zone-content">
              <svg class="upload-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
              <button class="btn primary" id="chooseBtn">Choose audio file</button>
              <p class="upload-hint">Click to browse <span class="desktop-only">(or drag and drop)</span></p>
            </div>
          </div>

          <!-- Step 2: Configure & Upload (Initially Hidden) -->
          <div id="step2" class="hidden" style="margin-top: 24px;">
            <div class="file-confirm-box">
              <div class="file-icon-styled">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
              </div>
              <div class="file-info">
                 <div class="file-name-label" id="selectedFileName">filename.mp3</div>
                 <button class="change-file-link" id="changeFileBtn">Change file</button>
              </div>
            </div>

            <div class="row">
              <div>
                <label for="lang">Language</label>
                <select id="lang">
                  ${langOptions}
                </select>
              </div>
              <div>
                <label for="spk">Speakers</label>
                <select id="spk">
                  <option value="auto" selected>Auto (Detect)</option>
                  <option value="1">1 Speaker</option>
                  <option value="2">2 Speakers</option>
                  <option value="3">3 Speakers</option>
                  <option value="4">4 Speakers</option>
                  <option value="5">5 Speakers</option>
                  <option value="6">6 Speakers</option>
                  <option value="7">7 Speakers</option>
                  <option value="8">8 Speakers</option>
                  <option value="9">9 Speakers</option>
                  <option value="10">10 Speakers</option>
                </select>
              </div>
            </div>

            <button class="btn primary" id="startUploadBtn" style="margin-top: 24px; width: 100%;">
              Start Transcription
            </button>
          </div>

          <!-- Progress Section (Initially Hidden) -->
          <div class="progressWrap" id="progressWrap">
            <div class="bar">
              <div class="fill" id="fill"></div>
            </div>
            <div class="pct" id="pct">0%</div>

            <div class="fileline" id="fileline"></div>
            <div class="line" id="stateline"></div>
          </div>
        </div>
        </div>
      </div>
      </div>
    `;
  }

  mount(container) {
    container.innerHTML = this.getHtml();
    this.initLogic();
  }

  initLogic() {
    const fileEl = document.createElement('input');
    fileEl.type = 'file';
    fileEl.accept = 'audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus';
    fileEl.style.display = 'none';
    document.body.appendChild(fileEl);

    // UI Elements
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const chooseBtn = document.getElementById('chooseBtn');
    const changeFileBtn = document.getElementById('changeFileBtn');
    const startUploadBtn = document.getElementById('startUploadBtn');
    const selectedFileNameEl = document.getElementById('selectedFileName');
    const langEl = document.getElementById('lang');
    const spkEl = document.getElementById('spk');

    const progressWrapEl = document.getElementById('progressWrap');
    const fillEl = document.getElementById('fill');
    const pctEl = document.getElementById('pct');
    const statelineEl = document.getElementById('stateline');
    const filelineEl = document.getElementById('fileline');

    // Polling state
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    let lastProgress = 0;


    // --- Logic ---

    // 1. File Selection
    const triggerFileSelect = () => fileEl.click();

    if (chooseBtn) chooseBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent bubbling to zone
      triggerFileSelect();
    });
    if (changeFileBtn) changeFileBtn.addEventListener('click', triggerFileSelect);

    // 1b. Drag and Drop
    if (step1) { // The upload zone
      step1.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        step1.classList.add('drag-over');
      });

      step1.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        step1.classList.remove('drag-over');
      });

      step1.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        step1.classList.remove('drag-over');

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          handleFile(files[0]);
        }
      });
    }

    const handleFile = (f) => {
      if (!f) return;

      this.selectedFile = f;
      this.currentFilename = f.name;

      // Update UI to Step 2
      step1.classList.add('hidden');
      step2.classList.remove('hidden');
      selectedFileNameEl.textContent = f.name;


      // Reset any previous progress/errors
      progressWrapEl.style.display = 'none';
      if (pctEl) pctEl.textContent = '0%';
      if (fillEl) fillEl.style.width = '0%';
    };

    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      handleFile(f);
    });

    // 2. Start Upload
    if (startUploadBtn) {
      startUploadBtn.addEventListener('click', async () => {
        if (!this.selectedFile) return;

        // Lock UI
        startUploadBtn.disabled = true;
        startUploadBtn.textContent = "Starting...";
        changeFileBtn.style.display = 'none'; // Prevent changing file during upload
        if (langEl) langEl.disabled = true;
        if (spkEl) spkEl.disabled = true;


        // Show progress
        showProgress();
        setFilename(this.selectedFile.name);
        lastProgress = 0;
        setProgress(0);
        setLine("queued", "upload", "Uploading…");

        const fields = {};
        fields.language = (langEl && langEl.value) ? langEl.value : "en";
        fields.speakers = (spkEl && spkEl.value) ? spkEl.value : "auto";

        try {
          const res = await uploadWithProgress(this.selectedFile, fields);
          const jobId = res.job_id;

          startUploadBtn.textContent = "Transcribing…";
          setLine("queued", "start", "Starting transcription…");

          // Save project
          this.projectService.addProject(jobId, this.currentFilename || "Audio Upload");
          this.app.refreshProjects();

          poll(jobId);
        } catch (e) {
          setProgress(0);
          setLine("error", "upload", e && e.message ? e.message : String(e));

          // Reset UI to allow retry
          startUploadBtn.disabled = false;
          startUploadBtn.textContent = "Start Transcription";
          changeFileBtn.style.display = 'inline-block';
          if (langEl) langEl.disabled = false;
          if (spkEl) spkEl.disabled = false;
        }
      });
    }

    // --- Helpers (Same as before, simplified) ---

    // State Persistence
    const restoreState = () => {
      const job = this.app.state.activeJob;
      if (job && job.status !== 'done' && job.status !== 'error') {
        // If a job is running, we skip step 1 & 2 and go straight to progress
        step1.classList.add('hidden');
        step2.classList.add('hidden'); // Or keep it visible but disabled? Better to hide config once started.

        showProgress();
        setFilename(job.filename);

        lastProgress = job.progress || 0;
        setProgress(lastProgress);

        if (!this.pollTimer) {
          poll(job.id);
        }
      }
    };

    const clamp01 = (x) => {
      if (typeof x !== 'number' || !isFinite(x)) return 0;
      return Math.max(0, Math.min(1, x));
    };

    const showProgress = () => {
      progressWrapEl.style.display = "block";
      statelineEl.style.display = "block";
      filelineEl.style.display = "block";
    };

    const setProgress = (p01) => {
      const p = clamp01(p01);
      fillEl.style.width = (p * 100).toFixed(1) + "%";
      pctEl.textContent = Math.round(p * 100) + "%";
    };

    const setLine = (state, phase, message) => {
      const left = [state, phase].filter(Boolean).join(" / ");
      const right = message ? (" — " + message) : "";
      statelineEl.textContent = (left || "") + right;
    };

    const setFilename = (name) => {
      filelineEl.textContent = name ? name : "";
    };

    const stopPolling = () => {
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    };

    const onJobReady = (jobId) => {
      stopPolling();
      // startUploadBtn.textContent = "Opening editor…"; // Button might be hidden if we restored state?
      // Just rely on the redirect
      setLine("done", "ready", "Opening editor...");

      setTimeout(() => {
        this.app.navigateTo('editor', { jobId });
      }, 250);
    };

    const poll = async (jobId) => {
      try {
        const r = await fetch(getApiUrl(`/api/demo/jobs/${jobId}`), { cache: "no-store" });
        if (!r.ok) throw new Error(`status ${r.status}`);
        const st = await r.json();

        let p = st.progress;
        if (typeof p === "number" && p > 1.0001) p = p / 100.0;
        if (typeof p !== "number") p = 0;

        p = Math.max(lastProgress, clamp01(p));
        lastProgress = p;
        setProgress(p);
        setLine(st.state, st.phase, st.message);

        // Update Global State
        this.app.state.activeJob = {
          id: jobId,
          filename: this.currentFilename || (this.app.state.activeJob ? this.app.state.activeJob.filename : "Audio"),
          progress: p,
          status: st.state
        };
        this.app.refreshProjects();

        if (st.state === "done") {
          onJobReady(jobId);
          return;
        }

        if (st.state === "error") {
          stopPolling();
          startUploadBtn.disabled = false;
          startUploadBtn.textContent = "Start Transcription";
          changeFileBtn.style.display = 'inline-block';
          return;
        }
      } catch (e) {
        setLine("error", "poll", e && e.message ? e.message : String(e));
      }

      this.pollTimer = setTimeout(() => poll(jobId), 900);
    };

    const uploadWithProgress = (file, fields) => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", getApiUrl("/api/demo/jobs"), true);

        xhr.upload.onprogress = (evt) => {
          if (!evt.lengthComputable) return;
          const p = clamp01(evt.loaded / evt.total);
          setProgress(p);
          setLine("queued", "upload", "Uploading…");
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const res = JSON.parse(xhr.responseText);
              resolve(res);
            } catch (e) {
              reject(new Error("Invalid JSON response from server"));
            }
          } else {
            reject(new Error(`upload failed: ${xhr.status} ${(xhr.responseText || "").slice(0, 200)}`));
          }
        };
        xhr.onerror = () => reject(new Error("upload network error"));

        const fd = new FormData();
        fd.append("file", file);
        Object.entries(fields || {}).forEach(([k, v]) => {
          if (v === undefined || v === null) return;
          fd.append(k, String(v));
        });

        xhr.send(fd);
      });
    };

    restoreState();
  }
}
