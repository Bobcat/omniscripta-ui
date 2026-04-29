
export function safePreview(s, n = 70) {
    const t = String(s ?? '');
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + '…';
}

export function escHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
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
    const src = String(srtText)
        .replace(/\r/g, "")
        .replace(/<!-- OMNISCRIPTA_META:[\s\S]*?-->/g, "")
        .replace(/<!-- OMNISCRIPTA_META:[\s\S]*$/g, "")
        .trim();
    if (!src) return [];

    // Parse cues without blindly splitting on blank lines, so blank lines
    // inside a cue's text are preserved.
    const tc = "\\d{1,2}:\\d{2}:\\d{2}(?:[,.]\\d{1,3})?";
    const cueRe = new RegExp(
        `(?:^|\\n)(?:\\d+\\s*\\n)?(${tc}\\s*-->\\s*${tc})\\n([\\s\\S]*?)(?=\\n{2,}(?:(?:\\d+\\s*\\n)?${tc}\\s*-->\\s*${tc})\\n|$)`,
        "g"
    );
    const items = [];
    let match;
    while ((match = cueRe.exec(src))) {
        const timeLine = match[1] || "";
        const tm = timeLine.match(/(.+?)\s*-->\s*(.+)/);
        if (!tm) continue;

        const start = _srtTcToSeconds(tm[1]);
        const end = _srtTcToSeconds(tm[2]);

        const body = String(match[2] || "").replace(/\n+$/, "");
        const textLines = body.split("\n").map(x => x.trimEnd());
        while (textLines.length && !textLines[textLines.length - 1]) textLines.pop();
        if (!textLines.length) textLines.push("");

        // Try speaker extraction (common patterns)
        let speaker = "";
        const firstLine = textLines[0] || "";
        let sm = firstLine.match(/^(SPEAKER_\d+)\s*:\s*(.*)$/i);
        if (sm) { speaker = sm[1]; textLines[0] = sm[2]; }
        else {
            sm = firstLine.match(/^\[(SPEAKER_\d+)\]\s*(.*)$/i);
            if (sm) { speaker = sm[1]; textLines[0] = sm[2]; }
        }

        let text = textLines.join("\n").trim();

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
