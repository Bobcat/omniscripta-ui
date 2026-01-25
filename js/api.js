
const SETTINGS_KEY = 'transcript_editor_settings_v1';

export function loadSettings() {
    const defaults = {
        keepCenteredDuringPlayback: false,
        autoAssignSplitTs: false,
    };
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return defaults;
        const s = JSON.parse(raw);

        // Validate/merge
        if (s.keepCenteredDuringPlayback !== undefined) {
            if (typeof s.keepCenteredDuringPlayback === 'string') defaults.keepCenteredDuringPlayback = (s.keepCenteredDuringPlayback.toLowerCase() === 'true');
            else if (typeof s.keepCenteredDuringPlayback === 'number') defaults.keepCenteredDuringPlayback = (s.keepCenteredDuringPlayback !== 0);
            else defaults.keepCenteredDuringPlayback = !!s.keepCenteredDuringPlayback;
        }

        if (s.autoAssignSplitTs !== undefined) {
            if (typeof s.autoAssignSplitTs === 'string') defaults.autoAssignSplitTs = (s.autoAssignSplitTs.toLowerCase() === 'true');
            else if (typeof s.autoAssignSplitTs === 'number') defaults.autoAssignSplitTs = (s.autoAssignSplitTs !== 0);
            else defaults.autoAssignSplitTs = !!s.autoAssignSplitTs;
        }
    } catch { }
    return defaults;
}

export function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { }
}

export async function fetchJobStatus(jobId) {
    const r = await fetch(`/api/demo/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch job failed: ${r.status}`);
    return await r.json();
}

export async function fetchSrt(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`fetch srt failed: ${r.status}`);
    return await r.text();
}
