import { UploadView } from "./components/UploadView.js";
import { EditorView } from "./components/EditorView.js";
import { ProjectService } from "./services/ProjectService.js";
import { FileHandleService } from "./services/FileHandleService.js";
import { fetchJobStatus } from "./api.js";

class App {
    constructor() {
        this.state = {
            currentView: 'upload', // 'upload' | 'editor'
            sidebarOpen: true, // Desktop default
            activeJob: null, // { id, filename, progress, status }
            activeProjectId: null // ID of currently open project
        };

        this.container = document.getElementById('main-view');
        this.sidebar = document.getElementById('app-sidebar');
        this.menuToggle = document.getElementById('menu-toggle');
        this.navLinks = document.querySelectorAll('.nav-links li[data-action]');

        this.views = {
            upload: new UploadView(this),
            editor: new EditorView(this)
        };

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
            if (e.target.matches('.mobile-menu-btn, #mobileMenuBtn, #floatingMobileMenuBtn')) {
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
            li.style.position = 'relative'; // For absolute positioning of delete btn

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

            // Delete button (hidden by default via CSS)
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-project-btn';
            deleteBtn.title = 'Delete Project';
            deleteBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">delete</span>';

            li.appendChild(content);
            li.appendChild(deleteBtn);

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
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger navigation
                if (confirm(`Remove "${p.name}" from history?`)) {
                    this.projectService.deleteProject(p.id);
                    this.refreshProjects();
                }
            });
        });
    }
}

// Initialize
window.app = new App();
