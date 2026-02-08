import { getApiUrl } from "../api.js";
import { ProjectService } from "../services/ProjectService.js";

export class UploadView {
  constructor(app) {
    this.app = app;
    this.projectService = new ProjectService();
  }

  getHtml() {
    return `
      <div class="upload-wrap">
        <div class="wrap">
        <div class="top">
          <div class="dot" aria-hidden="true"></div>
          <div class="brand">123transcribe</div>
        </div>

        <h1>1-2-3: Upload → Transcribe → Edit &amp; Export</h1>
        <p class="sub">
          Upload an audio file. When transcription is ready, the editor opens automatically.
        </p>

        <div class="steps">
          <div class="card">
            <span class="badgeNum">1</span><span class="cardTitle">Upload</span>
            <p class="cardText">Choose an audio file (MP3, WAV, M4A).</p>
          </div>
          <div class="card">
            <span class="badgeNum">2</span><span class="cardTitle">Transcribe</span>
            <p class="cardText">Automatic transcription with timestamps.</p>
          </div>
          <div class="card">
            <span class="badgeNum">3</span><span class="cardTitle">Edit &amp; Export</span>
            <p class="cardText">Fix text & speaker labels, then export.</p>
          </div>
        </div>

        <div class="panel">
          <h2>Get started</h2>

          <button class="btn" id="chooseBtn">Choose audio file</button>

          <div class="row">
            <div>
              <label for="lang">Language</label>
              <select id="lang">
                <option value="en" selected>English</option>
                <option value="nl">Dutch</option>
                <option value="de">German</option>
                <option value="fr">French</option>
              </select>
            </div>
            <div>
              <label for="spk">Speakers</label>
              <select id="spk">
                <option value="auto" selected>Auto</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
                <option value="7">7</option>
                <option value="8">8</option>
                <option value="9">9</option>
                <option value="10">10</option>
              </select>
            </div>
          </div>

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
    // We need to define restoreState and other functions before calling them, 
    // but they are defined inside this method in the current structure.
    // So we will call restoreState() at the END of this method.

    const fileEl = document.createElement('input');
    fileEl.type = 'file';
    fileEl.accept = 'audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus';
    fileEl.style.display = 'none';
    document.body.appendChild(fileEl); // Append to body or keep in memory is fine usually, but some browsers require it in DOM for some events. valid to just keep it in memory mostly, but let's append hidden to be safe.
    const chooseBtn = document.getElementById('chooseBtn');
    const langEl = document.getElementById('lang');
    const spkEl = document.getElementById('spk');

    const progressWrapEl = document.getElementById('progressWrap');
    const fillEl = document.getElementById('fill');
    const pctEl = document.getElementById('pct');
    const statelineEl = document.getElementById('stateline');
    const filelineEl = document.getElementById('fileline');

    // Clear any existing poller from previous mounts
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    let lastProgress = 0;

    // --- State Persistence Logic ---
    const restoreState = () => {
      const job = this.app.state.activeJob;
      if (job && job.status !== 'done' && job.status !== 'error') {
        // Restore UI
        showProgress();
        setFilename(job.filename);
        chooseBtn.disabled = true;
        chooseBtn.textContent = (job.status === 'queued' || job.status === 'upload') ? "Uploading..." : "Transcribing...";

        lastProgress = job.progress || 0;
        setProgress(lastProgress);

        // Resume polling if not already
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

    // NOTE: Instead of redirect, we signal the app to switch views
    const onJobReady = (jobId) => {
      stopPolling();
      chooseBtn.disabled = true;
      chooseBtn.textContent = "Opening editor…";

      // Use App's navigation
      setTimeout(() => {
        // Save project to history/sidebar
        // We use a generic name first, or the file name if we have it in scope. 
        // Ideally we pass the file name to onJobReady or store it in class
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
        this.app.refreshProjects(); // Trigger sidebar update to gray out item

        if (st.state === "done") {
          onJobReady(jobId);
          return;
        }

        if (st.state === "error") {
          stopPolling();
          chooseBtn.disabled = false;
          chooseBtn.textContent = "Choose audio file";
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
        // xhr.responseType = "json"; // Remove to allow reading responseText on errors

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

    chooseBtn.addEventListener('click', () => fileEl.click());

    fileEl.addEventListener('change', async () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) return;

      stopPolling();
      showProgress();
      setFilename(f.name);
      this.currentFilename = f.name; // Store for later usage

      chooseBtn.disabled = true;
      chooseBtn.textContent = "Uploading…";

      lastProgress = 0;
      setProgress(0);
      setLine("queued", "upload", "Uploading…");

      const fields = {};
      fields.language = (langEl && langEl.value) ? langEl.value : "en";
      fields.speakers = (spkEl && spkEl.value) ? spkEl.value : "auto";

      try {
        const res = await uploadWithProgress(f, fields);
        const jobId = res.job_id;
        chooseBtn.textContent = "Transcribing…";
        setLine("queued", "start", "Starting transcription…");

        // Save project immediately so it appears in sidebar
        this.projectService.addProject(jobId, this.currentFilename || "Audio Upload");
        this.app.refreshProjects(); // Notify app to update sidebar

        poll(jobId);
      } catch (e) {
        setProgress(0);
        setLine("error", "upload", e && e.message ? e.message : String(e));
        chooseBtn.disabled = false;
        chooseBtn.textContent = "Choose audio file";
      } finally {
        fileEl.value = "";
      }
    });

    restoreState(); // Restore state if returning to view
  }
}
