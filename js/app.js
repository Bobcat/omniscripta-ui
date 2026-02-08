import { UploadView } from "./components/UploadView.js";
import { EditorView } from "./components/EditorView.js";
import { ProjectService } from "./services/ProjectService.js";

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
        this.init();
    }

    init() {
        this.bindEvents();
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
            link.addEventListener('click', (e) => {
                const action = link.dataset.action;
                if (!action || link.classList.contains('disabled')) return;

                // For history, etc.
                if (action === 'upload') {
                    this.navigateTo('upload');

                    // On mobile, close sidebar after selection
                    if (this.isMobile()) {
                        this.toggleSidebar(false);
                    }
                }
            });
        });

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
            this.checkDevice();
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
        return window.innerWidth <= 768;
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

            // Content wrapper
            const content = document.createElement('div');
            content.className = 'project-content';
            content.innerHTML = `
                <span class="material-symbols-outlined">description</span>
                <span class="link-text" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.name}</span>
            `;

            // Delete button (hidden by default via CSS)
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-project-btn';
            deleteBtn.title = 'Delete Project';
            deleteBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">delete</span>';

            li.appendChild(content);
            li.appendChild(deleteBtn);

            // Event: Click Project (Navigate)
            content.addEventListener('click', () => {
                if (this.state.activeJob && this.state.activeJob.id === p.id && this.state.activeJob.status !== 'done') {
                    return; // Prevent navigation if active
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
