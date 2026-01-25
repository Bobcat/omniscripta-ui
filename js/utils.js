
export function safePreview(s, n = 70) {
    const t = String(s ?? '');
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + '…';
}

export function normSpeaker(v) {
    return String(v || '').trim();
}

export function secondsToTimecodeWhole(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, '0') + ":" + String(m).padStart(2, '0') + ":" + String(s).padStart(2, '0');
}

export function hashString(str) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

export function _srtTcToSeconds(tc) {
    // accepts "HH:MM:SS,mmm" or "HH:MM:SS.mmm"
    const t = String(tc).trim().replace(",", ".");
    const m = t.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
    if (!m) return 0;
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = parseInt(m[3], 10);
    const ms = m[4] ? parseInt((m[4] + "000").slice(0, 3), 10) : 0;
    return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function _parseSrt(srtText) {
    const blocks = String(srtText).replace(/\r/g, "").trim().split(/\n\n+/);
    const items = [];
    for (const b of blocks) {
        const lines = b.split("\n").map(x => x.trimEnd());
        if (lines.length < 2) continue;

        // Usually: [index] then time line
        let timeLineIdx = 0;
        if (/^\d+$/.test(lines[0].trim())) timeLineIdx = 1;

        const timeLine = lines[timeLineIdx] || "";
        const tm = timeLine.match(/(.+?)\s*-->\s*(.+)/);
        if (!tm) continue;

        const start = _srtTcToSeconds(tm[1]);
        const end = _srtTcToSeconds(tm[2]);

        const textLines = lines.slice(timeLineIdx + 1).filter(Boolean);
        let text = textLines.join(" ").trim();

        // Try speaker extraction (common patterns)
        let speaker = "";
        let sm = text.match(/^(SPEAKER_\d+)\s*:\s*(.*)$/i);
        if (sm) { speaker = sm[1]; text = sm[2].trim(); }
        else {
            sm = text.match(/^\[(SPEAKER_\d+)\]\s*(.*)$/i);
            if (sm) { speaker = sm[1]; text = sm[2].trim(); }
        }

        // WhisperX variants sometimes leave leading punctuation (":", "-", "—")
        if (speaker) {
            text = String(text || "").replace(/^[:\-\u2013\u2014]+\s*/, "");
        }
        // Also strip a bare leading ":" (seen in some diarized SRT variants)
        text = String(text || "").replace(/^:\s*/, "");

        items.push({ start, end, speaker, text });
    }
    return items;
}

// --- Embedded Metadata (Topics in SRT) ---
// We append a hidden block at the end: <!-- OMNISCRIPTA_META: { ... } -->
// This persists topics when the user saves to disk.

export function extractMetadata(srtText) {
    // Look for the last occurrence of the marker to be safe
    const marker = "<!-- OMNISCRIPTA_META:";
    const closure = "-->";
    const idx = srtText.lastIndexOf(marker);
    if (idx === -1) return null;

    const endIdx = srtText.indexOf(closure, idx);
    if (endIdx === -1) return null;

    try {
        const jsonStr = srtText.slice(idx + marker.length, endIdx).trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("Failed to parse embedded metadata", e);
        return null;
    }
}

export function embedMetadata(srtText, metadata) {
    // First, strip any existing metadata block to avoid duplicates
    const marker = "<!-- OMNISCRIPTA_META:";
    const regex = /<!-- OMNISCRIPTA_META:[\s\S]*?-->/g;
    let cleanSrt = srtText.replace(regex, '').trim();

    if (!metadata) return cleanSrt;

    // Append new block
    const block = `\n\n${marker} ${JSON.stringify(metadata)} -->`;
    return cleanSrt + block;
}
