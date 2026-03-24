export function actionToDebugJson(action) {
    const meta = action.meta || {};
    const out = {
        id: action.hid,
        label: action.label,
        meta,
    };
    return JSON.stringify(out, null, 2);
}

export function timecodeToSeconds(timecode) {
    const parts = String(timecode).trim().split(':');
    if (parts.length === 3) {
        const hours = Number(parts[0]) || 0;
        const minutes = Number(parts[1]) || 0;
        const seconds = parseFloat(parts[2]) || 0;
        return hours * 3600 + minutes * 60 + seconds;
    }
    if (parts.length === 2) {
        const minutes = Number(parts[0]) || 0;
        const seconds = parseFloat(parts[1]) || 0;
        return minutes * 60 + seconds;
    }
    return parseFloat(timecode) || 0;
}

export function nowHHMMSS() {
    const date = new Date();
    return String(date.getHours()).padStart(2, '0') + ":" + String(date.getMinutes()).padStart(2, '0') + ":" + String(date.getSeconds()).padStart(2, '0');
}
