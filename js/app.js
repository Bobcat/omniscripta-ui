import { UploadView } from "./components/UploadView.js";
import { EditorView } from "./components/EditorView.js";
import { SettingsView } from "./components/SettingsView.js";
import { LiveView } from "./components/LiveView.js";
import { ProjectService } from "./services/ProjectService.js";
import { FileHandleService } from "./services/FileHandleService.js";
import { fetchJobStatus } from "./api.js";

class App {
    constructor() {
        this.state = {
            currentView: 'upload', // 'upload' | 'editor' | 'settings' | 'live'
            sidebarOpen: true, // Desktop default
            activeJob: null, // { id, filename, progress, status }
            activeUpload: null, // { filename, language, speakers, progress, ... } before job_id is returned
            activeProjectId: null // ID of currently open project
        };

        this.container = document.getElementById('main-view');
        this.sidebar = document.getElementById('app-sidebar');
        this.menuToggle = document.getElementById('menu-toggle');
        this.navLinks = document.querySelectorAll('.nav-links li[data-action]');

        this.views = {
            upload: new UploadView(this),
            editor: new EditorView(this),
            settings: new SettingsView(this),
            live: new LiveView(this)
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

        this.projectService = new ProjectService();
        this.initAlertModal();
        this.init();
    }

    initAlertModal() {
        this.alertModal = document.getElementById('alertModal');
        this.alertTitle = document.getElementById('alertTitle');
        this.alertMessage = document.getElementById('alertMessage');
        const okBtn = document.getElementById('alertOkBtn');

        if (okBtn) {
            okBtn.addEventListener('click', () => this.hideAlert());
        }

        // Close on Enter
        this.alertModal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.hideAlert();
            }
        });
    }

    showAlert(title, message) {
        if (!this.alertModal) return;
        this.alertTitle.textContent = title;
        this.alertMessage.innerText = message;
        this.alertModal.classList.remove('hidden');
        // Focus the OK button
        const okBtn = document.getElementById('alertOkBtn');
        if (okBtn) okBtn.focus();
    }

    hideAlert() {
        if (this.alertModal) {
            this.alertModal.classList.add('hidden');
        }
    }

    init() {
        this.bindEvents();
        this.createMobileToggle(); // Floating hamburger for mobile
        this.initDeleteProjectModal();
        this.initProjectActionsUi();
        this.detectDeviceType(); // Set global mobile/desktop class
        this.checkDevice();
        this.renderProjects(); // Initial render
        this.render();

        // Handle browser back/forward if we decide to use history API later
        // window.onpopstate = ...
    }

    bindEvents() {
        // Toggle Sidebar
        if (this.menuToggle) {
            this.menuToggle.addEventListener('click', () => {
                this.toggleSidebar();
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

        // Listen for mobile menu buttons from views being clicked
        // We use event delegation or a custom event since views are dynamic
        document.addEventListener('click', (e) => {
            // Check if clicked element is a mobile-menu toggle (e.g. from editor)
            if (e.target.matches('.mobile-menu-btn, #mobileMenuBtn')) {
                this.toggleSidebar(true);
            }
        });

        // Window resize
        window.addEventListener('resize', () => {
            this.detectDeviceType();
            this.checkDevice();
        });

        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', (e) => {
            if (this.state.isMobile && this.state.sidebarOpen) {
                const inSidebar = this.sidebar.contains(e.target);
                const isToggle = e.target.closest('#mobile-menu-toggle') ||
                    e.target.closest('#mobileMenuBtn'); // Also check the internal toggle

                if (!inSidebar && !isToggle) {
                    this.toggleSidebar(false);
                }
            }
        });
    }

    checkDevice() {
        const wasMobile = this.state.isMobile;
        this.state.isMobile = this.isMobile();

        if (this.state.isMobile !== wasMobile) {
            // Reset sidebar state based on device
            if (this.state.isMobile) {
                this.sidebar.classList.remove('expanded');
                this.state.sidebarOpen = false;
            } else {
                this.sidebar.classList.add('expanded');
                this.state.sidebarOpen = true;
            }
        }
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

    createMobileToggle() {
        const btn = document.createElement('button');
        btn.id = 'mobile-menu-toggle';
        btn.className = 'icon-btn';
        btn.title = 'Menu';
        btn.innerHTML = '<span class="material-symbols-outlined">menu</span>';
        btn.addEventListener('click', () => this.toggleSidebar());

        document.body.appendChild(btn);
    }

    toggleSidebar(forceState) {
        const newState = forceState !== undefined ? forceState : !this.state.sidebarOpen;
        this.state.sidebarOpen = newState;

        if (this.state.sidebarOpen) {
            this.sidebar.classList.add('expanded');
            document.body.classList.add('sidebar-open');
        } else {
            this.sidebar.classList.remove('expanded');
            document.body.classList.remove('sidebar-open');
        }
    }

    render() {
        this.navigateTo(this.state.currentView);
    }

    navigateTo(viewName, data = null) {
        if (!this.views[viewName]) return;

        // Unmount current view and save state if applicable
        if (this.state.currentView && this.views[this.state.currentView]) {
            const currentV = this.views[this.state.currentView];
            if (typeof currentV.unmount === 'function') {
                const state = currentV.unmount();

                // If it was the editor, save the audio position
                if (this.state.currentView === 'editor' && this.state.activeProjectId && state && state.currentTime) {
                    this.projectService.updateProject(this.state.activeProjectId, { lastPosition: state.currentTime });
                }
            }
        }

        this.state.currentView = viewName;

        let viewData = data;

        // Track active project & Restore state
        if (viewName === 'editor') {
            if (data && data.jobId) {
                this.state.activeProjectId = data.jobId;

                // Load saved position
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
        this.refreshProjects(); // Re-render sidebar to update project highlights

        // Mount new
        this.container.innerHTML = ''; // Clear
        this.views[viewName].mount(this.container, viewData);

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

    refreshProjects() {
        this.renderProjects();
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

        this.deleteProjectModal.addEventListener('mousedown', (e) => {
            if (e.target === this.deleteProjectModal) {
                this.hideDeleteProjectDialog();
            }
        });
        this.deleteProjectModal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideDeleteProjectDialog();
            } else if (e.key === 'Enter') {
                this.confirmDeleteProject();
            }
        });
    }

    showDeleteProjectDialog(project, anchorRect = null) {
        if (!project || !this.deleteProjectModal || !this.deleteProjectMessage) return;
        this.pendingDeleteProject = project;
        this.deleteProjectMessage.innerText = `This will delete "${project.name}" from recent projects.`;
        this.positionDeleteProjectDialog(anchorRect);
        this.deleteProjectModal.classList.remove('hidden');
        // Reposition after render using the actual dialog dimensions.
        requestAnimationFrame(() => this.positionDeleteProjectDialog(anchorRect));
        if (this.deleteProjectConfirmBtn) {
            this.deleteProjectConfirmBtn.focus();
        }
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

        const viewportPadding = 8;
        const card = this.deleteProjectModal.querySelector('.delete-project-card');
        const cardRect = card ? card.getBoundingClientRect() : null;
        const dialogWidth = cardRect && cardRect.width > 0 ? cardRect.width : Math.min(420, window.innerWidth - 20);
        const dialogHeight = cardRect && cardRect.height > 0 ? cardRect.height : 188;

        let left = rect.right + 8;
        let top = rect.top - dialogHeight - 10;

        if (left + dialogWidth > window.innerWidth - viewportPadding) {
            left = rect.left - dialogWidth - 8;
        }
        left = Math.max(viewportPadding, Math.min(left, window.innerWidth - dialogWidth - viewportPadding));
        top = Math.max(viewportPadding, Math.min(top, window.innerHeight - dialogHeight - viewportPadding));

        this.deleteProjectModal.style.setProperty('--dp-left', `${left}px`);
        this.deleteProjectModal.style.setProperty('--dp-top', `${top}px`);
    }

    hideDeleteProjectDialog() {
        if (this.deleteProjectModal) {
            this.deleteProjectModal.classList.add('hidden');
        }
        this.pendingDeleteProject = null;
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
        this.refreshProjects();
        this.hideDeleteProjectDialog();
    }

    initProjectActionsUi() {
        let menu = document.getElementById('projectActionMenu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'projectActionMenu';
            menu.className = 'project-action-menu hidden';
            menu.innerHTML = `
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

        const desktopDeleteBtn = menu.querySelector('#projectActionDeleteDesktop');
        const mobileDeleteBtn = sheetBackdrop.querySelector('#projectActionDeleteMobile');

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

    renderProjects() {
        // Find or create the projects container in sidebar
        let container = document.getElementById('sidebar-projects');
        if (!container) {
            const sidebarContent = this.sidebar.querySelector('.sidebar-content');
            if (!sidebarContent) return;

            // Create separator and container
            const separator = document.createElement('div');
            separator.className = 'separator';
            separator.textContent = 'Recent projects'; // Changed case
            // Reduced to 0.75rem
            separator.style.cssText = 'padding: 10px 16px; font-size: 0.75rem; color: var(--text-secondary); letter-spacing: 0.05em; margin-top: 10px; font-weight: 500;';

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
            container.innerHTML = '<li style="padding: 8px 14px; opacity: 0.6; font-size: 0.85rem;">No recent projects</li>';
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
