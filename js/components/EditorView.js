
import { mountEditor, unmountEditor } from "../editor.js";

export class EditorView {
  constructor(app) {
    this.app = app;
  }

  getHtml() {
    return `
  <header>
    <div class="header-line header-line1">
      <div class="header-left">
        <div aria-label="Editor mode" class="mode-toggle desktop-only" role="group">
          <button class="mode-btn active" id="modeSegmentsBtn" title="Segment editor view"
            type="button">Segments</button>
          <button class="mode-btn" id="modeTextBtn" title="Readable text view" type="button">Document</button>
        </div><button class="desktop-only" id="helpBtn" title="Show keyboard shortcuts" type="button">Help</button>
      </div>
      <div class="header-right header-actions">
        <!-- Desktop Tools (Hidden on Mobile) -->
        <button class="desktop-only" id="findBtn" title="Find and replace (Ctrl+F)" type="button">Find/Replace</button>
        <button class="desktop-only" id="filterBtn" title="Filter segments" type="button">Filter</button>
        <button class="primary desktop-only" disabled="" id="saveBtn" title="Ctrl+S" type="button">Save</button>
        <button class="desktop-only" id="saveAsBtn" title="Save as…" type="button">Save as</button>

        <!-- Mobile Menu Toggle -->
        <button id="mobileMenuBtn" class="mobile-only" type="button" title="Menu">☰</button>

        <!-- File Actions (Collapsible on Mobile) -->
        <div id="headerFileActions" class="header-file-actions">
          <button id="exportDocBtn" title="Export document" type="button">Export document</button>
          <button class="file-btn" id="transcriptBtnLabel" title="Choose transcript" type="button">Choose
            transcript</button>
          <input accept=".srt" hidden="" id="transcriptInput" type="file" />
          <label class="file-btn" for="audioInput" id="audioBtnLabel" title="Choose audio">Choose audio</label>
          <input accept="audio/*" hidden="" id="audioInput" type="file" />
        </div>
      </div>
    </div>
    <div class="header-line header-line2">
      <div class="header-left"></div>
      <div class="header-right">
        <div class="file-summary" id="fileSummaryLabel" title="No transcript selected / No audio selected">No transcript
          selected / No audio selected</div>
      </div>
    </div>
  </header>



  <main>
    <div aria-label="Active filters" class="filter-bar hidden" id="filterBar">
      <div class="filter-bar-left">
        <span class="muted" style="margin-right:6px;">Filter:</span>
        <div class="filter-chips" id="filterChips"></div>
      </div>
      <div class="filter-bar-right">
        <span class="muted" id="filterCount"></span>
        <button class="btn-small" id="filterClearBtn" title="Clear filters" type="button">Clear</button>
      </div>
    </div>
    <div aria-live="polite" class="filter-notice hidden" id="filterNotice" role="status">
      <div class="filter-notice-text" id="filterNoticeText"></div>
      <div class="filter-notice-actions">
        <button id="filterStrictBtn" type="button">Apply strict filter</button>
      </div>
    </div>
    <div id="segments" tabindex="-1"></div>
    <div id="docViewContainer" class="hidden">
      <div aria-label="Text view" id="textView" tabindex="-1"></div>
      <div id="docViewSplitter" class="doc-view-splitter mobile-only hidden" aria-label="Resize panels" role="separator">
        <div class="doc-view-splitter-grip"></div>
      </div>
      <div aria-label="Topics view" class="hidden" id="topicsView"></div>
    </div>

    <!-- Floating Mobile Menu Button -->
    <button id="floatingMobileMenuBtn" class="mobile-only" type="button" title="Menu">☰</button>
    <div id="player-container">
      <audio id="player" class="hidden"></audio>
      <div id="customPlayer"></div>
      <div class="footer-right">
        <span class="pill muted hidden desktop-only" id="loopPill" title="Repeat loop (F6). Click to clear.">Loop:
          —</span>
        <span class="pill muted desktop-only" id="segmentsChangedPill"
          title="Segments changed since last load/save">Segments
          changed: 0</span>
        <span class="pill muted desktop-only" id="donePill" title="Segments marked Done (workflow)">Done: 0/0</span>
        <button class="desktop-only" id="settingsBtn" title="Settings" type="button">Settings</button>
        <button class="desktop-only" id="historyBtn" title="Show app-level undo/redo stack"
          type="button">History</button>

      </div>
    </div>
  </main>
  <!-- Save modal -->
  <div aria-labelledby="saveTitle" aria-modal="true" class="modal hidden" id="saveModal" role="dialog">
    <div class="modal-card">
      <h3 id="saveTitle">Save as</h3>
      <p>Edit the filename (Enter = save with the suggested name).</p>
      <div class="modal-row">
        <label for="saveName">Filename (.srt)</label>
        <input autocomplete="off" id="saveName" spellcheck="false">
        </input>
      </div>
      <div class="modal-actions">
        <button id="cancelSaveBtn">Cancel</button>
        <button class="primary" id="confirmSaveBtn">Download</button>
      </div>
    </div>
  </div>
  <div aria-label="History" aria-modal="true" class="modal hidden" id="historyModal" role="dialog">
    <div class="modal-card history-card">
      <div class="history-topbar">
        <button class="mini history-close" id="closeHistoryBtn" type="button">Close</button>
      </div>
      <div class="history-body">
        <div class="history-grid">
          <div>
            <div class="history-head">Undo <span class="muted" id="undoCount"></span></div>
            <div aria-label="Undo stack" class="history-list" id="undoList" tabindex="0"></div>
          </div>
          <div>
            <div class="history-head">Redo <span class="muted" id="redoCount"></span></div>
            <div aria-label="Redo stack" class="history-list" id="redoList" tabindex="0"></div>
          </div>
        </div>
        <div class="history-details">
          <div class="history-head">Details</div>
          <pre class="history-pre" id="historyDetails">(click an item)</pre>
        </div>
      </div>
    </div>
  </div>
  <div aria-label="Settings" aria-modal="true" class="modal hidden" id="settingsModal" role="dialog">
    <div class="modal-card settings-card">
      <div class="settings-topbar" id="settingsDragHandle" title="Drag to move">
        <div class="settings-title">Settings</div>
        <div aria-hidden="true" class="settings-grip">⋮⋮</div>
      </div>
      <div class="settings-body">
        <label class="chk">
          <input id="optKeepCentered" type="checkbox" />
          Keep active segment centered during playback
        </label>
        <div class="muted settings-hint">
          When enabled, the transcript scrolls so the highlighted segment stays near the center while playing.
        </div>
        <div class="settings-option-sep"></div>
        <label class="chk">
          <input id="optAutoSplitTs" type="checkbox" />
          Auto-assign split timestamp for fast splitting
        </label>
        <div class="muted settings-hint">
          When enabled, Split inserts a new segment immediately after the current one without prompting for a timestamp.
          You can edit the assigned timestamps afterwards.
        </div>
        <div class="settings-actions">
          <button class="mini settings-close" id="closeSettingsBtn" type="button">Close</button>
        </div>
      </div>
    </div>
  </div>
  <!-- Find/Replace modal -->
  <div aria-label="Find and replace" aria-modal="true" class="modal hidden" id="findModal" role="dialog">
    <div class="modal-card find-card">
      <div class="find-topbar" id="findDragHandle" title="Drag to move">
        <div class="find-title">Find/Replace</div>
        <div aria-hidden="true" class="find-grip">⋮⋮</div>
      </div>
      <div class="find-body">
        <div class="find-row">
          <label for="findInput">Find</label>
          <input autocomplete="off" id="findInput" spellcheck="false">
          </input>
        </div>
        <div class="find-row">
          <label for="replaceInput">Replace</label>
          <input autocomplete="off" id="replaceInput" spellcheck="false">
          </input>
        </div>
        <div class="find-options">
          <label class="chk"><input id="optRegex" type="checkbox" />Regex</label>
          <label class="chk"><input id="optCase" type="checkbox" />Case sensitive</label>
          <label class="chk"><input id="optWords" type="checkbox" />Whole words</label>
          <label class="chk"><input checked="" id="optWrap" type="checkbox" />Wrap</label>
        </div>
        <div class="find-scope">
          <span class="muted">Scope</span>
          <label class="rad"><input checked="" name="findScope" type="radio" value="text" />Text</label>
          <label class="rad"><input name="findScope" type="radio" value="speaker" />Speakers</label>
          <label class="rad"><input name="findScope" type="radio" value="both" />Text + speakers</label>
        </div>
        <div class="find-actions">
          <button id="findNextBtn">Find next</button>
          <button class="primary" id="replaceBtn">Replace</button>
          <button id="replaceAllBtn">Replace all…</button>
          <button class="mini find-close" id="closeFindBtn" type="button">Close</button>
          <span class="muted" id="findStatus"></span>
        </div>
      </div>
    </div>
  </div>
  <!-- Replace all confirm modal -->
  <div aria-labelledby="raTitle" aria-modal="true" class="modal hidden" id="replaceAllModal" role="dialog">
    <div class="modal-card" style="max-width: 560px;">
      <h3 id="raTitle">Replace all</h3>
      <p id="raSummary" style="margin-top: 6px;"></p>
      <div class="modal-actions">
        <button id="raCancelBtn">Cancel</button>
        <button class="primary" id="raConfirmBtn">Replace all</button>
      </div>
    </div>
  </div>
  <!-- Help modal -->
  <div aria-label="Help" aria-modal="true" class="modal hidden" id="helpModal" role="dialog">
    <div class="modal-card help-card">
      <div class="help-topbar" id="helpDragHandle" title="Drag to move">
        <div class="help-title">Help</div>
        <div aria-hidden="true" class="help-grip">⋮⋮</div>
      </div>
      <div class="help-body">
        <div aria-label="Keyboard shortcuts" class="help-grid">
          <div class="help-key"><span class="kbd">F1</span></div>
          <div>Play/pause</div>
          <div class="help-key"><span class="kbd">F2</span></div>
          <div>Repeat segment (toggle)</div>
          <div class="help-key"><span class="kbd">F3</span></div>
          <div>Append segment to previous segment <span class="kbd" aria-hidden="true">🔗</span></div>
          <div class="help-key"><span class="kbd">F4</span></div>
          <div>Split segment (at cursor location while editing) <span class="kbd" aria-hidden="true">✂</span></div>
          <div class="help-key"><span class="kbd">F6</span></div>
          <div>Repeat loop: set start, set end, clear</div>
          <div class="help-key"><span class="kbd">F9</span></div>
          <div>Toggle segment status Done (workflow)</div>
          <div class="help-key"><span class="kbd">↑</span> / <span class="kbd">↓</span></div>
          <div>Move active segment (when not editing)</div>
          <div class="help-key"><span class="kbd">Home</span> / <span class="kbd">End</span></div>
          <div>Jump to first/last segment (when not editing)</div>
          <div class="help-key"><span class="kbd">Ctrl</span>+<span class="kbd">F</span></div>
          <div>Find/Replace</div>
          <div class="help-key"><span class="kbd">Space</span></div>
          <div>Play/pause (not while editing)</div>
          <div class="help-key"><span class="kbd">←</span> / <span class="kbd">→</span></div>
          <div>Seek −3s/+3s (not while editing)</div>
          <div class="help-key"><span class="kbd">Ctrl</span>+<span class="kbd">S</span></div>
          <div>Save (.srt)</div>
          <div class="help-key"><span class="kbd">Ctrl</span>+<span class="kbd">Z</span></div>
          <div>Undo</div>
          <div class="help-key"><span class="kbd">Ctrl</span>+<span class="kbd">Y</span></div>
          <div>Redo</div>
        </div>
      </div>
      <div class="help-actions">
        <button class="btn-small" id="closeHelpBtn" type="button">Close</button>
      </div>
    </div>
  </div>

  <!-- Filter modal -->
  <div aria-label="Filter" aria-modal="true" class="modal hidden" id="filterModal" role="dialog">
    <div class="modal-card filter-card">
      <div class="filter-topbar" id="filterDragHandle" title="Drag to move">
        <div class="filter-title">Filter</div>
        <div aria-hidden="true" class="filter-grip">⋮⋮</div>
      </div>
      <div class="filter-body">
        <div class="filter-section">
          <div class="filter-head">Speakers</div>
          <div class="muted" style="margin-top:4px;">Select one or more speakers (leave empty = all).</div>
          <div aria-label="Speaker filters" class="filter-speakers" id="filterSpeakersList"></div>
        </div>
        <div class="filter-section">
          <div class="filter-head">Changed</div>
          <div class="filter-inline">
            <label class="rad"><input checked="" name="changedMode" type="radio" value="all" />All</label>
            <label class="rad"><input name="changedMode" type="radio" value="changed" />Changed only</label>
            <label class="rad"><input name="changedMode" type="radio" value="unchanged" />Unchanged only</label>
          </div>
        </div>
        <div class="filter-section">
          <div class="filter-head">Done</div>
          <div class="filter-inline">
            <label class="rad"><input checked="" name="doneMode" type="radio" value="all" />All</label>
            <label class="rad"><input name="doneMode" type="radio" value="undone" />Undone only</label>
            <label class="rad"><input name="doneMode" type="radio" value="done" />Done only</label>
          </div>
        </div>
        <div class="filter-section">
          <label class="chk">
            <input checked="" id="playFilteredToggle" type="checkbox" />
            Play only visible segments (skip hidden)
          </label>
        </div>
        <div class="filter-actions">
          <button class="btn-small" id="filterClearBtn3" type="button">Clear</button>
          <button class="btn-small" id="closeFilterBtn" type="button">Close</button>
        </div>
      </div>
    </div>
  </div>
    `;
  }

  mount(container, data) {
    container.innerHTML = this.getHtml();
    mountEditor({
      ...data,
      app: this.app,
      canUseFileSystem: this.app.canUseFileSystem(),
      updateProject: (id, payload) => this.app.projectService.updateProject(id, payload)
    });
  }

  unmount() {
    return unmountEditor();
  }
}
