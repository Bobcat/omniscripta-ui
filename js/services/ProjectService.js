export class ProjectService {
    constructor() {
        this.STORAGE_KEY = 'omniscripta_projects_v1';
    }

    getProjects() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            console.error("Failed to load projects", e);
            return [];
        }
    }

    addProject(jobId, filename) {
        const projects = this.getProjects();

        // Remove if already exists (move to top)
        const existingIndex = projects.findIndex(p => p.id === jobId);
        if (existingIndex >= 0) {
            projects.splice(existingIndex, 1);
        }

        const newProject = {
            id: jobId,
            name: filename,
            createdAt: new Date().toISOString()
        };

        // Add to top
        projects.unshift(newProject);

        // Limit to 50 recent projects
        if (projects.length > 50) {
            projects.length = 50;
        }

        this.saveProjects(projects);
        return projects;
    }

    deleteProject(jobId) {
        let projects = this.getProjects();
        projects = projects.filter(p => p.id !== jobId);
        this.saveProjects(projects);
        return projects;
    }

    updateProject(jobId, data) {
        const projects = this.getProjects();
        const project = projects.find(p => p.id === jobId);
        if (project) {
            Object.assign(project, data);
            this.saveProjects(projects);
        }
    }

    saveProjects(projects) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
        } catch (e) {
            console.error("Failed to save projects", e);
        }
    }
}
