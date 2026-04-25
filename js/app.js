import { UploadView } from "./components/UploadView.js";
import { EditorView } from "./components/EditorView.js";
import { SettingsView } from "./components/SettingsView.js";
import { LiveView } from "./components/LiveView.js";
import { LiveBenchmarkView } from "./components/LiveBenchmarkView.js";
import { ProjectService } from "./services/ProjectService.js";
import { FileHandleService } from "./services/FileHandleService.js";
import { fetchJobStatus } from "./api.js";
import { RouterCore, ShellState, DialogService, DialogAnchor, ModalController, bindMobileSidebarDismiss, createShellPersistence } from "@spa-foundation/core";

class App {
    constructor() {
        this.LAST_VIEW_KEY = 'omniscripta_last_view';
        this.LAST_EDITOR_PROJECT_KEY = 'omniscripta_last_editor_project_id';
        this.SHELL_STORAGE_KEY = 'omniscripta_shell_v1';
        const bootShell = createShellPersistence({ storageKey: this.SHELL_STORAGE_KEY }).resolve({
            preset: "",
            sidebarOpen: true,
            roundedSidebar: false
        });
        this.state = {
            currentView: null, // set in init()
            sidebarOpen: (typeof bootShell.sidebarOpen === 'boolean' ? bootShell.sidebarOpen : true),
            activeJob: null, // { id, filename, progress, status }
            activeUpload: null, // { filename, language, speakers, progress, ... } before job_id is returned
            activeProjectId: null // ID of currently open project
        };

        this.hasInitialRender = false;

        this.container = document.getElementById('main-view');
        this.sidebar = document.getElementById('app-sidebar');
        this.menuToggle = document.getElementById('menu-toggle');
        this.navLinks = document.querySelectorAll('.nav-links li[data-action]');
        this.liveNavLink = document.querySelector('.nav-links li[data-action="live"]');
        this.liveNavIcon = this.liveNavLink ? this.liveNavLink.querySelector('.material-symbols-outlined') : null;
        this.liveNavText = this.liveNavLink ? this.liveNavLink.querySelector('.link-text') : null;
        this.mobileLiveRecordingIndicator = document.getElementById('mobile-live-recording-indicator');
        this.mobileEditorActions = document.getElementById('mobile-editor-actions');
        this.mobileEditorMenuBtn = document.getElementById('mobile-editor-menu-btn');
        this.mobileEditorMenu = document.getElementById('mobile-editor-menu');
        this.mobileEditorExportBtn = document.getElementById('mobile-editor-export-btn');
        this.liveNavBaseText = this.liveNavText
            ? String(this.liveNavText.textContent || 'Live recording').trim()
            : 'Live recording';
        this.liveNavRecording = false;
        this.mobilePlayerInsetPx = 0;
        this.playerInsetTarget = null;
        this.playerInsetResizeObserver = null;
        this.playerInsetMutationObserver = null;

        this.views = {
            upload: new UploadView(this),
            editor: new EditorView(this),
            settings: new SettingsView(this),
            live: new LiveView(this),
            livebench: new LiveBenchmarkView(this),
        };

        this.projectActionMenu = null;
        this.projectActionSheetBackdrop = null;
        this.projectActionSheet = null;
        this.projectActionProject = null;
        this.projectActionTriggerRect = null;
        this.projectActionCloseTimer = null;
        this.deleteProjectModal = null;
        this.deleteProjectMessage = null;
        this.deleteProjectCancelBtn = null;
        this.deleteProjectConfirmBtn = null;
        this.pendingDeleteProject = null;
        this.renameProjectModal = null;
        this.renameProjectInput = null;
        this.renameProjectWarning = null;
        this.renameProjectCancelBtn = null;
        this.renameProjectConfirmBtn = null;
        this.pendingRenameProject = null;
        this.alertModalController = null;
        this.deleteProjectModalController = null;
        this.renameProjectModalController = null;

        this.projectService = new ProjectService();
        this.dialogService = new DialogService();
        this.deleteProjectPositioner = new DialogAnchor();
        this.shellState = this.initShellState();
        this.shellPersistence = createShellPersistence({
            storageKey: this.SHELL_STORAGE_KEY,
            shellState: this.shellState,
            getPreset: () => "",
            getRoundedSidebar: () => false
        });
        this.router = this.initRouter();
        this.initAlertModal();
        this.init();
    }

    initShellState() {
        const shellState = new ShellState({
            sidebarOpen: this.state.sidebarOpen,
            isMobile: !!this.state.isMobile
        });

        shellState.subscribe(({ next }) => {
            this.state.sidebarOpen = next.sidebarOpen;
            this.state.isMobile = next.isMobile;
            this.applySidebarState(next.sidebarOpen);
            if (this.shellPersistence && typeof this.shellPersistence.save === 'function') {
                this.shellPersistence.save();
            }
        });

        const initialState = shellState.getSnapshot();
        this.state.sidebarOpen = initialState.sidebarOpen;
        this.state.isMobile = initialState.isMobile;
        this.applySidebarState(initialState.sidebarOpen);
        return shellState;
    }

    initRouter() {
        const router = new RouterCore(this.container, {
            onSameRouteNavigate: ({ to, isPopState }) => {
                const viewName = to.view;
                const data = to.data;
                if (this.hasInitialRender && this.state.currentView === viewName && isPopState && data && data.section) {
                    const view = this.views[viewName];
                    if (view && typeof view.scrollToSection === 'function') {
                        view.scrollToSection(data.section);
                        return true;
                    }
                }
                return false;
            },
            onRouteWillMount: ({ from, to, data, unmountState }) => {
                const previousViewName = from ? from.view : this.state.currentView;
                const viewName = to.view;

                // If leaving the editor, persist audio position.
                if (previousViewName === 'editor' && this.state.activeProjectId && unmountState && unmountState.currentTime) {
                    this.projectService.updateProject(this.state.activeProjectId, { lastPosition: unmountState.currentTime });
                }

                this.state.currentView = viewName;
                localStorage.setItem(this.LAST_VIEW_KEY, viewName);

                let viewData = data;
                if (viewName === 'editor') {
                    if (data && data.jobId) {
                        this.state.activeProjectId = data.jobId;
                        localStorage.setItem(this.LAST_EDITOR_PROJECT_KEY, data.jobId);

                        const projects = this.projectService.getProjects();
                        const p = projects.find(proj => proj.id === data.jobId);
                        if (p && p.lastPosition) {
                            viewData = { ...data, startTime: p.lastPosition, lastViewMode: p.lastViewMode || null };
                        }
                    }
                } else {
                    this.state.activeProjectId = null;
                }

                this.updateNavHighlight(viewName);
                this.updateMobileEditorActionsVisibility(viewName);
                this.renderProjects(); // Re-render sidebar to update project highlights
                return viewData;
            },
            onRouteDidMount: () => {
                this.hasInitialRender = true;
                this.syncLiveNavState();
            }
        });

        Object.entries(this.views).forEach(([viewName, view]) => {
            router.register(viewName, view);
        });
        return router;
    }

    initAlertModal() {
        this.alertModal = document.getElementById('alertModal');
        this.alertTitle = document.getElementById('alertTitle');
        this.alertMessage = document.getElementById('alertMessage');
        const okBtn = document.getElementById('alertOkBtn');

        if (okBtn) {
            okBtn.addEventListener('click', () => this.hideAlert());
        }

        this.alertModalController = new ModalController(this.alertModal, {
            onEnter: () => this.hideAlert()
        });

        this.dialogService.register('alert', {
            onOpen: ({ title, message }) => {
                if (!this.alertModal) return false;
                this.alertTitle.textContent = title;
                this.alertMessage.innerText = message;
                this.alertModalController.open();
                // Focus the OK button
                const okButton = document.getElementById('alertOkBtn');
                if (okButton) okButton.focus();
                return true;
            },
            onClose: () => {
                if (this.alertModalController) {
                    this.alertModalController.close();
                }
            }
        });
    }

    showAlert(title, message) {
        this.dialogService.open('alert', { title, message });
    }

    hideAlert() {
        this.dialogService.close('alert');
    }

    async init() {
        // Figure out startup view
        let initialView = localStorage.getItem(this.LAST_VIEW_KEY);
        if (!initialView) {
            initialView = 'upload';
        } else if (!this.views[initialView]) {
            initialView = 'upload';
        }
        this.state.currentView = initialView;

        this.bindEvents();
        this.initDeleteProjectModal();
        this.initRenameProjectModal();
        this.initProjectActionsUi();
        this.detectDeviceType(); // Set global mobile/desktop class
        this.checkDevice();
        this.initMobilePlayerInsetSync();
        bindMobileSidebarDismiss(this.shellState, this.sidebar, 600);
        this.renderProjects(); // Initial render
        this.render();
        this.syncLiveNavState();
        this.router.bindPopState({
            parseHash: ({ hash }) => this.parseHashRoute(hash)
        });
    }

    bindEvents() {
        // Toggle Sidebar
        if (this.menuToggle) {
            this.menuToggle.addEventListener('click', () => {
                this.toggleSidebar();
            });
        }

        if (this.mobileEditorMenuBtn && this.mobileEditorMenu && this.mobileEditorExportBtn) {
            this.mobileEditorMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const willOpen = !this.mobileEditorMenu.classList.contains('show-menu');
                this.setMobileEditorMenuOpen(willOpen);
            });

            this.mobileEditorExportBtn.addEventListener('click', () => {
                this.setMobileEditorMenuOpen(false);
                this.triggerMobileEditorExport();
            });

            document.addEventListener('click', (e) => {
                const target = e.target;
                if (!(target instanceof Element)) return;
                const insideMenu = this.mobileEditorActions && this.mobileEditorActions.contains(target);
                if (!insideMenu) {
                    this.setMobileEditorMenuOpen(false);
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.setMobileEditorMenuOpen(false);
                }
            });
        }

        // Nav Links
        this.navLinks.forEach(link => {
            link.addEventListener('click', async (e) => {
                const action = link.dataset.action;
                if (!action || link.classList.contains('disabled')) return;

                if (action === 'open-local') {
                    // Try File System Access API first
                    if (this.canUseFileSystem()) {
                        try {
                            const [fileHandle] = await window.showOpenFilePicker({
                                types: [{
                                    description: 'Subtitle Files',
                                    accept: { 'text/plain': ['.srt'] }
                                }],
                                multiple: false
                            });

                            const file = await fileHandle.getFile();
                            const text = await file.text();
                            const id = 'local-' + Date.now();

                            // Save handle for later
                            await FileHandleService.saveHandle(id, fileHandle);

                            this.projectService.addProject(id, file.name, 'local', { hasHandle: true });
                            this.navigateTo('editor', {
                                jobId: id,
                                srtContent: text,
                                transcriptName: file.name
                            });

                            if (this.isMobile()) {
                                this.toggleSidebar(false);
                            }
                        } catch (err) {
                            if (err.name !== 'AbortError') {
                                console.error("Error opening file:", err);
                                this.showAlert("Error", "Failed to open file. Please try again.");
                            }
                        }
                    } else {
                        // Fallback to hidden input
                        const input = document.getElementById('localProjectInput');
                        if (input) {
                            input.value = '';
                            input.click();
                        }
                        if (this.isMobile()) {
                            this.toggleSidebar(false);
                        }
                    }
                } else if (action === 'upload') {
                    this.navigateTo('upload');

                    // On mobile, close sidebar after selection
                    if (this.isMobile()) {
                        this.toggleSidebar(false);
                    }
                } else if (action === 'live') {
                    this.navigateTo('live');

                    // On mobile, close sidebar after selection
                    if (this.isMobile()) {
                        this.toggleSidebar(false);
                    }
                } else if (action === 'settings') {
                    this.navigateTo('settings');

                    // On mobile, close sidebar after selection
                    if (this.isMobile()) {
                        this.toggleSidebar(false);
                    }
                } else if (action === 'home') {
                    window.location.href = '/';
                }
            });
        });

        // Local Project Input Change
        const localInput = document.getElementById('localProjectInput');
        if (localInput) {
            localInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (ev) => {
                    const text = ev.target.result;
                    // Use a pseudo-ID for local files, e.g. "local-<timestamp>"
                    const id = 'local-' + Date.now();
                    this.projectService.addProject(id, file.name, 'local');
                    this.navigateTo('editor', {
                        jobId: id,
                        srtContent: text,
                        transcriptName: file.name
                    });
                };
                reader.readAsText(file);
            });
        }

        // Window resize
        window.addEventListener('resize', () => {
            this.detectDeviceType();
            this.checkDevice();
            this.bindPlayerInsetTarget();
            this.updateMobilePlayerInset();
        });
    }

    initMobilePlayerInsetSync() {
        this.bindPlayerInsetTarget();

        if (typeof ResizeObserver !== 'undefined') {
            this.playerInsetResizeObserver = new ResizeObserver(() => {
                this.updateMobilePlayerInset();
            });
            if (this.playerInsetTarget) {
                this.playerInsetResizeObserver.observe(this.playerInsetTarget);
            }
        }

        if (typeof MutationObserver !== 'undefined') {
            this.playerInsetMutationObserver = new MutationObserver(() => {
                this.bindPlayerInsetTarget();
                this.updateMobilePlayerInset();
            });
            this.playerInsetMutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }

        this.updateMobilePlayerInset();
    }

    bindPlayerInsetTarget() {
        const nextTarget = document.getElementById('player-container');
        if (nextTarget === this.playerInsetTarget) return;

        if (this.playerInsetResizeObserver && this.playerInsetTarget) {
            this.playerInsetResizeObserver.unobserve(this.playerInsetTarget);
        }

        this.playerInsetTarget = nextTarget || null;

        if (this.playerInsetResizeObserver && this.playerInsetTarget) {
            this.playerInsetResizeObserver.observe(this.playerInsetTarget);
        }
    }

    updateMobilePlayerInset() {
        const root = document.documentElement;
        if (!root) return;

        let insetPx = 0;
        const el = this.playerInsetTarget;
        if (el) {
            const style = window.getComputedStyle(el);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
            if (isVisible) {
                const rect = el.getBoundingClientRect();
                if (Number.isFinite(rect.height) && rect.height > 0) {
                    insetPx = Math.ceil(rect.height);
                }
            }
        }

        if (insetPx === this.mobilePlayerInsetPx) return;
        this.mobilePlayerInsetPx = insetPx;
        root.style.setProperty('--mobile-player-height', `${insetPx}px`);
    }

    checkDevice() {
        const snapshot = this.shellState.getSnapshot();
        const wasMobile = snapshot.isMobile;
        const isMobileNow = this.isMobile();
        this.shellState.setIsMobile(isMobileNow, "checkDevice.setIsMobile");

        if (isMobileNow !== wasMobile) {
            // Reset sidebar state based on device
            this.shellState.syncSidebarForDevice("checkDevice.syncSidebarForDevice");
        }
        this.updateMobileEditorActionsVisibility(this.state.currentView);
    }

    isMobile() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('mobile')) return true;
        // Check if we are in "mobile mode" via class (UA/Touch) OR if screen is small
        return document.body.classList.contains('mobile') || window.innerWidth <= 600;
    }

    /**
     * Checks if the File System Access API is supported and allowed.
     * ALWAYS use this method instead of checking window.showOpenFilePicker directly
     * to support Safari emulation testing via ?emulate_safari=1.
     */
    canUseFileSystem() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('emulate_safari') === '1') {
            return false;
        }
        return 'showOpenFilePicker' in window;
    }

    detectDeviceType() {
        const isTouch = (navigator.maxTouchPoints > 0) || ("ontouchstart" in window);
        const ua = navigator.userAgent;
        const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(ua);
        const isIPad = /Macintosh/i.test(ua) && isTouch;

        if (isMobileUA || isIPad) {
            document.body.classList.add('mobile');
            document.body.classList.remove('desktop');
        } else {
            document.body.classList.add('desktop');
            document.body.classList.remove('mobile');
        }
    }

    toggleSidebar(forceState) {
        if (forceState !== undefined) {
            this.shellState.setSidebarOpen(!!forceState, "toggleSidebar.force");
            return;
        }
        this.shellState.toggleSidebar("toggleSidebar.toggle");
    }

    applySidebarState(sidebarOpen) {
        this.sidebar.classList.toggle('expanded', !!sidebarOpen);
        this.updateMobileEditorActionsVisibility(this.state.currentView);
    }

    setMobileEditorMenuOpen(open) {
        if (!this.mobileEditorMenu || !this.mobileEditorMenuBtn) return;
        const isOpen = !!open;
        this.mobileEditorMenu.classList.toggle('show-menu', isOpen);
        this.mobileEditorMenuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    updateMobileEditorActionsVisibility(viewName = this.state.currentView) {
        if (!this.mobileEditorActions) return;
        const isCollapsed = this.sidebar ? !this.sidebar.classList.contains('expanded') : false;
        const shouldShow = this.isMobile() && isCollapsed && viewName === 'editor';
        this.mobileEditorActions.classList.toggle('hidden', !shouldShow);
        this.mobileEditorActions.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
        if (this.mobileEditorMenuBtn) this.mobileEditorMenuBtn.disabled = !shouldShow;
        if (!shouldShow) this.setMobileEditorMenuOpen(false);
    }

    triggerMobileEditorExport() {
        if (this.state.currentView !== 'editor') return;
        const exportBtn = document.getElementById('exportDocBtn');
        if (!exportBtn) return;
        exportBtn.click();
    }

    parseHashRoute(hash) {
        const raw = String(hash || '').trim();
        if (!raw) return null;
        const parts = raw.split('-');
        const viewName = parts[0];
        if (!this.views[viewName]) return null;

        if (parts.length > 1) {
            return { view: viewName, data: { section: parts.slice(1).join('-') } };
        }

        return { view: viewName, data: null };
    }

    clearTransientEditorQuery(viewName, data = null) {
        const keepFixtureQuery = (
            viewName === 'editor'
            && (!data || (
                !data.jobId
                && !data.srtContent
                && !data.audioUrl
                && !data.srtUrlPreview
            ))
        );
        if (keepFixtureQuery) return;

        try {
            const url = new URL(window.location.href);
            let changed = false;
            for (const key of ['audioUrl', 'srtUrl', 'jobId', 'mode', 'viewMode']) {
                if (!url.searchParams.has(key)) continue;
                url.searchParams.delete(key);
                changed = true;
            }
            if (!changed) return;

            const search = url.searchParams.toString();
            const nextUrl = url.pathname + (search ? `?${search}` : '') + url.hash;
            window.history.replaceState(window.history.state, '', nextUrl);
        } catch (_) { }
    }

    resolveInitialRoute(viewName, data = null) {
        let nextData = data;
        if (viewName === 'editor' && (!nextData || !nextData.jobId)) {
            let hasExplicitEditorSource = false;
            try {
                const params = new URLSearchParams(window.location.search);
                hasExplicitEditorSource = !!(params.get('audioUrl') || params.get('srtUrl'));
            } catch (_) { }

            if (!hasExplicitEditorSource) {
                const lastEditorProjectId = localStorage.getItem(this.LAST_EDITOR_PROJECT_KEY);
                if (lastEditorProjectId) {
                    nextData = { ...(nextData || {}), jobId: lastEditorProjectId };
                }
            }
        }
        return { view: viewName, data: nextData };
    }

    render() {
        const defaultRoute = this.resolveInitialRoute(this.state.currentView, null);
        this.router.startFromHash(defaultRoute.view, defaultRoute.data, {
            parseHash: ({ hash }) => this.parseHashRoute(hash),
            resolveInitialRoute: ({ view, data }) => this.resolveInitialRoute(view, data)
        });
    }

    navigateTo(viewName, data = null, isPopState = false) {
        if (!this.views[viewName]) return;
        if (!isPopState) {
            this.clearTransientEditorQuery(viewName, data);
        }
        const options = { isPopState };
        this.router.navigate(viewName, data, options);
    }

    updateNavHighlight(viewName) {
        this.navLinks.forEach(link => {
            if (link.dataset.action === viewName) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

    syncLiveNavState() {
        if (!this.liveNavLink || !this.liveNavText) return;
        const liveView = this.views && this.views.live;
        const recordingActive = !!(
            liveView
            && typeof liveView.isRecordingActive === 'function'
            && liveView.isRecordingActive()
        );
        if (recordingActive === this.liveNavRecording) return;
        this.liveNavRecording = recordingActive;
        const nextLabel = recordingActive
            ? `${this.liveNavBaseText} (recording)`
            : this.liveNavBaseText;
        this.liveNavText.textContent = nextLabel;
        this.liveNavLink.title = nextLabel;
        if (this.liveNavIcon) {
            this.liveNavIcon.style.color = recordingActive ? '#dc2626' : '';
        }
        if (this.mobileLiveRecordingIndicator) {
            this.mobileLiveRecordingIndicator.classList.toggle('recording', recordingActive);
        }
    }

    initDeleteProjectModal() {
        let modal = document.getElementById('deleteProjectModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'deleteProjectModal';
            modal.className = 'modal hidden delete-project-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'deleteProjectTitle');
            modal.innerHTML = `
                <div class="modal-card delete-project-card">
                    <h3 id="deleteProjectTitle">Delete project?</h3>
                    <p id="deleteProjectMessage"></p>
                    <div class="modal-actions">
                        <button id="deleteProjectCancelBtn" type="button">Cancel</button>
                        <button id="deleteProjectConfirmBtn" class="danger-soft" type="button">Delete</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        this.deleteProjectModal = modal;
        this.deleteProjectMessage = modal.querySelector('#deleteProjectMessage');
        this.deleteProjectCancelBtn = modal.querySelector('#deleteProjectCancelBtn');
        this.deleteProjectConfirmBtn = modal.querySelector('#deleteProjectConfirmBtn');

        if (this.deleteProjectCancelBtn) {
            this.deleteProjectCancelBtn.addEventListener('click', () => this.hideDeleteProjectDialog());
        }
        if (this.deleteProjectConfirmBtn) {
            this.deleteProjectConfirmBtn.addEventListener('click', () => this.confirmDeleteProject());
        }

        this.deleteProjectModalController = new ModalController(this.deleteProjectModal, {
            backdropEvent: 'mousedown',
            onBackdrop: () => this.hideDeleteProjectDialog(),
            onEscape: () => this.hideDeleteProjectDialog(),
            onEnter: () => this.confirmDeleteProject()
        });

        this.dialogService.register('delete-project', {
            onOpen: ({ project, anchorRect = null }) => {
                if (!project || !this.deleteProjectModal || !this.deleteProjectMessage) return false;
                this.pendingDeleteProject = project;
                this.deleteProjectMessage.innerText = `This will delete "${project.name}" from recent projects.`;
                this.positionDeleteProjectDialog(anchorRect);
                this.deleteProjectModalController.open();
                // Reposition after render using the actual dialog dimensions.
                requestAnimationFrame(() => this.positionDeleteProjectDialog(anchorRect));
                if (this.deleteProjectConfirmBtn) {
                    this.deleteProjectConfirmBtn.focus();
                }
                return true;
            },
            onClose: () => {
                if (this.deleteProjectModalController) {
                    this.deleteProjectModalController.close();
                }
                this.pendingDeleteProject = null;
            }
        });
    }

    initRenameProjectModal() {
        let modal = document.getElementById('renameProjectModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'renameProjectModal';
            modal.className = 'modal hidden rename-project-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'renameProjectTitle');
            modal.innerHTML = `
                <div class="modal-card rename-project-card">
                    <h3 id="renameProjectTitle">Rename project</h3>
                    <label class="rename-project-label" for="renameProjectInput">New name</label>
                    <input id="renameProjectInput" type="text" maxlength="180" autocomplete="off" />
                    <p id="renameProjectWarning"></p>
                    <div class="modal-actions">
                        <button id="renameProjectCancelBtn" type="button">Cancel</button>
                        <button id="renameProjectConfirmBtn" class="primary" type="button">Save</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        this.renameProjectModal = modal;
        this.renameProjectInput = modal.querySelector('#renameProjectInput');
        this.renameProjectWarning = modal.querySelector('#renameProjectWarning');
        this.renameProjectCancelBtn = modal.querySelector('#renameProjectCancelBtn');
        this.renameProjectConfirmBtn = modal.querySelector('#renameProjectConfirmBtn');

        if (this.renameProjectCancelBtn) {
            this.renameProjectCancelBtn.addEventListener('click', () => this.hideRenameProjectDialog());
        }
        if (this.renameProjectConfirmBtn) {
            this.renameProjectConfirmBtn.addEventListener('click', () => this.confirmRenameProject());
        }
        if (this.renameProjectInput) {
            this.renameProjectInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmRenameProject();
                }
            });
        }

        this.renameProjectModalController = new ModalController(this.renameProjectModal, {
            backdropEvent: 'mousedown',
            onBackdrop: () => this.hideRenameProjectDialog(),
            onEscape: () => this.hideRenameProjectDialog(),
            onEnter: () => this.confirmRenameProject()
        });

        this.dialogService.register('rename-project', {
            onOpen: ({ project, anchorRect = null }) => {
                if (!project || !this.renameProjectModal || !this.renameProjectInput || !this.renameProjectWarning) return false;
                this.pendingRenameProject = project;
                this.renameProjectInput.value = String(project.name || '');
                this.renameProjectWarning.innerText = `Renaming only changes the local project entry. The transcription may still be available on the server for a while, but that is not guaranteed. If you want to keep working on it, save it locally.`;
                this.positionRenameProjectDialog(anchorRect);
                this.renameProjectModalController.open();
                requestAnimationFrame(() => {
                    this.positionRenameProjectDialog(anchorRect);
                    if (this.renameProjectInput) {
                        this.renameProjectInput.focus();
                        this.renameProjectInput.select();
                    }
                });
                return true;
            },
            onClose: () => {
                if (this.renameProjectModalController) {
                    this.renameProjectModalController.close();
                }
                this.pendingRenameProject = null;
            }
        });
    }

    showDeleteProjectDialog(project, anchorRect = null) {
        this.dialogService.open('delete-project', { project, anchorRect });
    }

    positionDeleteProjectDialog(anchorRect = null) {
        if (!this.deleteProjectModal) return;

        if (this.isMobile()) {
            this.deleteProjectModal.style.removeProperty('--dp-left');
            this.deleteProjectModal.style.removeProperty('--dp-top');
            return;
        }

        let rect = anchorRect;
        if (!rect) {
            const sidebarRect = this.sidebar ? this.sidebar.getBoundingClientRect() : null;
            if (sidebarRect) {
                rect = {
                    left: sidebarRect.right + 8,
                    right: sidebarRect.right + 8,
                    top: Math.max(72, sidebarRect.top + 110),
                    bottom: Math.max(72, sidebarRect.top + 140)
                };
            }
        }
        if (!rect) return;

        const card = this.deleteProjectModal.querySelector('.delete-project-card');
        const cardRect = card ? card.getBoundingClientRect() : null;
        const dialogWidth = cardRect && cardRect.width > 0 ? cardRect.width : Math.min(420, window.innerWidth - 20);
        const dialogHeight = cardRect && cardRect.height > 0 ? cardRect.height : 188;

        const position = this.deleteProjectPositioner.compute(rect, {
            width: dialogWidth,
            height: dialogHeight
        });
        this.deleteProjectPositioner.applyCssVars(this.deleteProjectModal, position, '--dp-left', '--dp-top');
    }

    hideDeleteProjectDialog() {
        this.dialogService.close('delete-project');
    }

    showRenameProjectDialog(project, anchorRect = null) {
        this.dialogService.open('rename-project', { project, anchorRect });
    }

    positionRenameProjectDialog(anchorRect = null) {
        if (!this.renameProjectModal) return;

        if (this.isMobile()) {
            this.renameProjectModal.style.removeProperty('--rp-left');
            this.renameProjectModal.style.removeProperty('--rp-top');
            return;
        }

        let rect = anchorRect;
        if (!rect) {
            const sidebarRect = this.sidebar ? this.sidebar.getBoundingClientRect() : null;
            if (sidebarRect) {
                rect = {
                    left: sidebarRect.right + 8,
                    right: sidebarRect.right + 8,
                    top: Math.max(72, sidebarRect.top + 110),
                    bottom: Math.max(72, sidebarRect.top + 140)
                };
            }
        }
        if (!rect) return;

        const card = this.renameProjectModal.querySelector('.rename-project-card');
        const cardRect = card ? card.getBoundingClientRect() : null;
        const dialogWidth = cardRect && cardRect.width > 0 ? cardRect.width : Math.min(460, window.innerWidth - 20);
        const dialogHeight = cardRect && cardRect.height > 0 ? cardRect.height : 232;

        const position = this.deleteProjectPositioner.compute(rect, {
            width: dialogWidth,
            height: dialogHeight
        });
        this.deleteProjectPositioner.applyCssVars(this.renameProjectModal, position, '--rp-left', '--rp-top');
    }

    hideRenameProjectDialog() {
        this.dialogService.close('rename-project');
    }

    confirmRenameProject() {
        const project = this.pendingRenameProject;
        if (!project || !this.renameProjectInput) {
            this.hideRenameProjectDialog();
            return;
        }
        const nextName = String(this.renameProjectInput.value || '').trim();
        if (!nextName) {
            this.showAlert('Rename project', 'Name cannot be empty.');
            return;
        }
        this.projectService.updateProject(project.id, { name: nextName });
        this.renderProjects();
        this.hideRenameProjectDialog();
    }

    confirmDeleteProject() {
        const project = this.pendingDeleteProject;
        if (!project) {
            this.hideDeleteProjectDialog();
            return;
        }

        this.projectService.deleteProject(project.id);
        if (this.state.activeProjectId === project.id) {
            this.state.activeProjectId = null;
        }
        this.renderProjects();
        this.hideDeleteProjectDialog();
    }

    initProjectActionsUi() {
        let menu = document.getElementById('projectActionMenu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'projectActionMenu';
            menu.className = 'project-action-menu hidden';
            menu.innerHTML = `
                <button type="button" class="project-action-item" id="projectActionRenameDesktop">
                    <span class="material-symbols-outlined">edit</span>
                    <span>Rename</span>
                </button>
                <button type="button" class="project-action-item delete" id="projectActionDeleteDesktop">
                    <span class="material-symbols-outlined">delete</span>
                    <span>Delete</span>
                </button>
            `;
            document.body.appendChild(menu);
        }
        this.projectActionMenu = menu;

        let sheetBackdrop = document.getElementById('projectActionSheetBackdrop');
        if (!sheetBackdrop) {
            sheetBackdrop = document.createElement('div');
            sheetBackdrop.id = 'projectActionSheetBackdrop';
            sheetBackdrop.className = 'project-action-sheet-backdrop hidden';
            sheetBackdrop.innerHTML = `
                <div class="project-action-sheet" id="projectActionSheet" role="dialog" aria-modal="true" aria-label="Project actions">
                    <div class="project-action-sheet-handle" aria-hidden="true"></div>
                    <button type="button" class="project-action-item" id="projectActionRenameMobile">
                        <span class="material-symbols-outlined">edit</span>
                        <span>Rename</span>
                    </button>
                    <button type="button" class="project-action-item delete" id="projectActionDeleteMobile">
                        <span class="material-symbols-outlined">delete</span>
                        <span>Delete</span>
                    </button>
                </div>
            `;
            document.body.appendChild(sheetBackdrop);
        }
        this.projectActionSheetBackdrop = sheetBackdrop;
        this.projectActionSheet = sheetBackdrop.querySelector('#projectActionSheet');
        const sheetHandle = sheetBackdrop.querySelector('.project-action-sheet-handle');

        const desktopRenameBtn = menu.querySelector('#projectActionRenameDesktop');
        const mobileRenameBtn = sheetBackdrop.querySelector('#projectActionRenameMobile');
        const desktopDeleteBtn = menu.querySelector('#projectActionDeleteDesktop');
        const mobileDeleteBtn = sheetBackdrop.querySelector('#projectActionDeleteMobile');

        if (desktopRenameBtn) {
            desktopRenameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.renameProjectFromActions();
            });
        }
        if (mobileRenameBtn) {
            mobileRenameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.renameProjectFromActions();
            });
        }

        if (desktopDeleteBtn) {
            desktopDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteProjectFromActions();
            });
        }
        if (mobileDeleteBtn) {
            mobileDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteProjectFromActions();
            });
        }

        sheetBackdrop.addEventListener('click', (e) => {
            if (e.target === sheetBackdrop) {
                this.closeProjectActions();
            }
        });
        if (this.projectActionSheet) {
            this.projectActionSheet.addEventListener('click', (e) => e.stopPropagation());
        }

        if (sheetHandle && this.projectActionSheet) {
            let dragging = false;
            let startY = 0;
            let deltaY = 0;

            const onMove = (e) => {
                if (!dragging || !this.projectActionSheet) return;
                const pointY = e.touches ? e.touches[0].clientY : e.clientY;
                deltaY = Math.max(0, pointY - startY);
                this.projectActionSheet.style.transition = 'none';
                this.projectActionSheet.style.transform = `translateY(${deltaY}px)`;
                if (e.cancelable) e.preventDefault();
            };

            const onEnd = () => {
                if (!dragging || !this.projectActionSheet) return;
                dragging = false;
                this.projectActionSheet.style.transition = '';

                if (deltaY > 80) {
                    this.closeProjectActions();
                } else {
                    this.projectActionSheet.style.transform = '';
                    this.projectActionSheet.classList.add('open');
                }

                window.removeEventListener('touchmove', onMove);
                window.removeEventListener('touchend', onEnd);
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onEnd);
            };

            const onStart = (e) => {
                dragging = true;
                startY = e.touches ? e.touches[0].clientY : e.clientY;
                deltaY = 0;
                window.addEventListener('touchmove', onMove, { passive: false });
                window.addEventListener('touchend', onEnd);
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onEnd);
            };

            sheetHandle.addEventListener('touchstart', onStart, { passive: true });
            sheetHandle.addEventListener('mousedown', onStart);
        }

        document.addEventListener('click', (e) => {
            const inMenu = e.target.closest('#projectActionMenu');
            const inSheet = e.target.closest('#projectActionSheet');
            const onTrigger = e.target.closest('.project-menu-btn');
            if (!inMenu && !inSheet && !onTrigger) {
                this.closeProjectActions();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeProjectActions();
            }
        });
        window.addEventListener('resize', () => this.closeProjectActions());
    }

    openProjectActions(project, triggerButton) {
        this.closeProjectActions();
        this.projectActionProject = project;
        this.projectActionTriggerRect = triggerButton ? triggerButton.getBoundingClientRect() : null;
        if (this.isMobile()) {
            this.openProjectActionsSheet();
            return;
        }
        this.openProjectActionsMenu(triggerButton);
    }

    openProjectActionsMenu(triggerButton) {
        if (!this.projectActionMenu || !triggerButton) return;
        this.projectActionMenu.classList.remove('hidden');

        const triggerRect = triggerButton.getBoundingClientRect();
        this.projectActionTriggerRect = triggerRect;
        const menuRect = this.projectActionMenu.getBoundingClientRect();
        let left = triggerRect.right - menuRect.width;
        let top = triggerRect.bottom + 6;

        if (left < 8) left = 8;
        if (top + menuRect.height > window.innerHeight - 8) {
            top = Math.max(8, triggerRect.top - menuRect.height - 6);
        }

        this.projectActionMenu.style.left = `${left}px`;
        this.projectActionMenu.style.top = `${top}px`;
    }

    openProjectActionsSheet() {
        if (!this.projectActionSheetBackdrop || !this.projectActionSheet) return;
        this.projectActionSheetBackdrop.classList.remove('hidden');
        this.projectActionSheet.style.transform = '';
        this.projectActionSheet.style.transition = '';
        // Trigger transition on next frame.
        requestAnimationFrame(() => {
            this.projectActionSheetBackdrop.classList.add('open');
            this.projectActionSheet.classList.add('open');
        });
    }

    closeProjectActions(opts = {}) {
        const immediate = !!opts.immediate;
        if (this.projectActionCloseTimer) {
            clearTimeout(this.projectActionCloseTimer);
            this.projectActionCloseTimer = null;
        }
        if (this.projectActionMenu) {
            this.projectActionMenu.classList.add('hidden');
        }
        if (this.projectActionSheetBackdrop && this.projectActionSheet) {
            if (!this.projectActionSheetBackdrop.classList.contains('hidden')) {
                this.projectActionSheetBackdrop.classList.remove('open');
                this.projectActionSheet.classList.remove('open');
                this.projectActionSheet.style.transform = '';
                this.projectActionSheet.style.transition = '';
                if (immediate) {
                    this.projectActionSheetBackdrop.classList.add('hidden');
                } else {
                    this.projectActionCloseTimer = setTimeout(() => {
                        if (this.projectActionSheetBackdrop) {
                            this.projectActionSheetBackdrop.classList.add('hidden');
                        }
                    }, 180);
                }
            }
        }
        this.projectActionProject = null;
    }

    deleteProjectFromActions(anchorRect = null) {
        const project = this.projectActionProject;
        const effectiveAnchor = anchorRect || this.projectActionTriggerRect || null;
        this.closeProjectActions({ immediate: this.isMobile() });
        this.projectActionProject = null;
        this.projectActionTriggerRect = null;
        if (!project) return;
        this.showDeleteProjectDialog(project, effectiveAnchor);
    }

    renameProjectFromActions(anchorRect = null) {
        const project = this.projectActionProject;
        const effectiveAnchor = anchorRect || this.projectActionTriggerRect || null;
        this.closeProjectActions({ immediate: this.isMobile() });
        this.projectActionProject = null;
        this.projectActionTriggerRect = null;
        if (!project) return;
        this.showRenameProjectDialog(project, effectiveAnchor);
    }

    renderProjects() {
        // Find or create the projects container in sidebar
        let container = document.getElementById('sidebar-projects');
        if (!container) {
            const sidebarContent = this.sidebar.querySelector('.sidebar-content');
            if (!sidebarContent) return;

            // Create separator and container
            const separator = document.createElement('div');
            separator.className = 'separator projects-separator';
            separator.textContent = 'Recent projects'; // Changed case

            container = document.createElement('ul');
            container.id = 'sidebar-projects';
            container.className = 'nav-links projects-list';

            // Insert before the last .nav-links (which is the settings footer)
            const allNavs = sidebarContent.querySelectorAll('.nav-links');
            const footerNav = allNavs[allNavs.length - 1]; // The settings UL

            if (footerNav && allNavs.length > 1) {
                sidebarContent.insertBefore(separator, footerNav);
                sidebarContent.insertBefore(container, footerNav);
            } else {
                sidebarContent.appendChild(separator);
                sidebarContent.appendChild(container);
            }
        }

        container.innerHTML = '';
        const projects = this.projectService.getProjects();

        if (projects.length === 0) {
            container.innerHTML = '<li class="projects-empty">No recent projects</li>';
            return;
        }

        projects.forEach(p => {
            const li = document.createElement('li');
            li.title = p.name;
            li.style.position = 'relative';

            // Active Highlight
            if (this.state.activeProjectId === p.id) {
                li.classList.add('active');
                li.style.backgroundColor = 'var(--active-bg)'; // Explicitly set for visibility
                li.style.color = 'var(--active-text)';
            }

            if (p.type === 'local') {
                li.classList.add('local');
            }

            // Content wrapper
            const content = document.createElement('div');
            content.className = 'project-content';

            const iconSpan = document.createElement('span');
            iconSpan.className = 'material-symbols-outlined';
            iconSpan.textContent = 'description';

            const textSpan = document.createElement('span');
            textSpan.className = 'link-text';
            textSpan.style.whiteSpace = 'nowrap';
            textSpan.style.overflow = 'hidden';
            textSpan.style.textOverflow = 'ellipsis';
            textSpan.textContent = String(p.name || '');

            content.appendChild(iconSpan);
            content.appendChild(textSpan);

            const menuBtn = document.createElement('button');
            menuBtn.className = 'project-menu-btn';
            menuBtn.type = 'button';
            menuBtn.title = 'Project actions';
            menuBtn.innerHTML = '<span class="material-symbols-outlined">more_vert</span>';

            li.appendChild(content);
            li.appendChild(menuBtn);

            // Event: Click Project (Navigate)
            content.addEventListener('click', async () => {
                if (this.state.activeJob && this.state.activeJob.id === p.id && this.state.activeJob.status !== 'done') {
                    return; // Prevent navigation if active
                }

                if (p.type === 'local') {
                    // Start with capabilities check to support emulation/safari
                    if (this.canUseFileSystem() && p.hasHandle) {
                        try {
                            const handle = await FileHandleService.getHandle(p.id);
                            if (!handle) throw new Error("Handle missing");

                            // Check permission
                            const opts = { mode: 'read' };
                            if ((await handle.queryPermission(opts)) !== 'granted') {
                                if ((await handle.requestPermission(opts)) !== 'granted') {
                                    this.showAlert("Permission Denied", "Permission denied. Cannot open file.");
                                    return;
                                }
                            }

                            const file = await handle.getFile();
                            const text = await file.text();

                            this.navigateTo('editor', {
                                jobId: p.id,
                                srtContent: text,
                                transcriptName: file.name
                            });
                        } catch (err) {
                            console.warn("Failed to re-open local file:", err);
                            this.showAlert("File Missing", "Cannot re-open file (moved or deleted). Please open it again.");
                            // Optional: remove handle from DB?
                        }
                    } else {
                        if (!this.canUseFileSystem()) {
                            this.showAlert("Browser limitation", "Cannot re-open this file automatically in your current browser. Please open it again via 'Open local project'.\n\nTip: Use a Chromium-based browser (such as Chrome or Edge) to enable automatic re-opening from this list.");
                        } else {
                            this.showAlert("Local project history", "Cannot re-open local project from history. The file handle is missing or expired. Please open it again via the menu.");
                        }
                    }
                    return;
                }

                // Check server if job still exists
                try {
                    await fetchJobStatus(p.id);
                } catch (err) {
                    console.warn("Job not found on server:", err);
                    this.showAlert("Not Available", 'Project no longer available on server');
                    return;
                }

                this.navigateTo('editor', { jobId: p.id });
                if (this.isMobile()) {
                    this.toggleSidebar(false);
                }
            });

            // Styling for active job
            if (this.state.activeJob && this.state.activeJob.id === p.id && this.state.activeJob.status !== 'done') {
                li.style.opacity = '0.5';
                li.style.pointerEvents = 'none'; // Optional: disable clicks entirely

                // Safely update text
                const textSpan = content.querySelector('.link-text');
                if (textSpan) {
                    textSpan.textContent += ' (Processing...)';
                }
            }

            container.appendChild(li);
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger navigation
                this.openProjectActions(p, menuBtn);
            });
        });
    }
}

// Initialize
window.app = new App();
