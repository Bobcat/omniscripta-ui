
import { UploadView } from "./components/UploadView.js";
import { EditorView } from "./components/EditorView.js";

class App {
    constructor() {
        this.state = {
            currentView: 'upload', // 'upload' | 'editor'
            sidebarOpen: true // Desktop default
        };

        this.container = document.getElementById('main-view');
        this.sidebar = document.getElementById('app-sidebar');
        this.menuToggle = document.getElementById('menu-toggle');
        this.navLinks = document.querySelectorAll('.nav-links li[data-action]');

        this.views = {
            upload: new UploadView(this),
            editor: new EditorView(this)
        };

        this.init();
    }

    init() {
        this.bindEvents();
        this.checkDevice();
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
        this.state.isMobile = window.innerWidth <= 768;

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

        this.state.currentView = viewName;
        this.updateNavHighlight(viewName);

        // Unmount current? (if we had specific cleanup)
        // Mount new
        this.container.innerHTML = ''; // Clear
        this.views[viewName].mount(this.container, data);

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
}

// Initialize
window.app = new App();
