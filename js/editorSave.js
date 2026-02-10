/**
 * editorSave.js — Save / Export functions extracted from editor.js
 *
 * All functions that need shared editor state receive a `ctx` object.
 * Pure utility functions take explicit parameters.
 */
import { embedMetadata } from "./utils.js";

// ========================
// Pure utilities (no ctx)
// ========================

export function secondsToSrtTimecode(sec) {
    const msTotal = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const hh = Math.floor(msTotal / 3600000);
    const mm = Math.floor((msTotal % 3600000) / 60000);
    const ss = Math.floor((msTotal % 60000) / 1000);
    const ms = msTotal % 1000;
    return String(hh).padStart(2, '0') + ":" + String(mm).padStart(2, '0') + ":" + String(ss).padStart(2, '0') + "," + String(ms).padStart(3, '0');
}

export function downloadTextBlob(text, filename, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "transcript.srt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ========================
// Functions using ctx
// ========================

export function buildSrtFromSegments(ctx) {
    const segs = [...ctx.segments].sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    const out = [];
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const start = secondsToSrtTimecode(s.start);
        let endSec = Number(s.end);
        if (!Number.isFinite(endSec) || endSec <= Number(s.start)) endSec = Number(s.start) + 0.5;
        const end = secondsToSrtTimecode(endSec);

        const speaker = (s.speaker || "").trim();
        const text = String(s.text || "").trim();
        const line = speaker ? (speaker + ": " + text) : text;

        out.push(String(i + 1));
        out.push(start + " --> " + end);
        out.push(line);
        out.push(""); // blank line
    }
    return out.join("\n");
}

export function suggestSrtName(ctx) {
    const norm = (name) => {
        if (!name) return null;
        let n = String(name).trim();
        if (!n) return null;
        n = n.replace(/\.srt\.json$/i, ".srt");
        if (n.toLowerCase().endsWith(".json")) n = n.replace(/\.json$/i, ".srt");
        if (!n.toLowerCase().endsWith(".srt")) n = n + ".srt";
        return n;
    };

    const fromExport = norm(ctx.exportFileName);
    if (fromExport) return fromExport;

    const fromLoaded = norm(ctx.loadedJsonFileName);
    if (fromLoaded) return fromLoaded;

    return "transcript.srt";
}

export function sanitizeSrtFileName(name, ctx) {
    name = String(name || '').trim();
    if (!name) name = suggestSrtName(ctx);
    name = name.replace(/\.srt\.json$/i, ".srt");
    if (name.toLowerCase().endsWith(".json")) name = name.replace(/\.json$/i, ".srt");
    if (!name.toLowerCase().endsWith(".srt")) name += ".srt";
    name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
    return name;
}

export function downloadSrt(filename, text, ctx) {
    let content = text;
    if (ctx.topicsView.topics && ctx.topicsView.topics.length > 0) {
        content = embedMetadata(text, { topics: ctx.topicsView.topics });
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.lastSavedAt = ctx.nowHHMMSS();
    ctx.setCleanNow();
}

export async function saveSrtLocally(forceSaveAs, ctx) {
    if (!ctx.segments.length) return;

    const sourceKind = ctx.transcriptLoadKind;
    const finalName = sanitizeSrtFileName(suggestSrtName(ctx), ctx);
    const srtText = buildSrtFromSegments(ctx);

    const canPicker = (typeof window.showSaveFilePicker === "function" && window.isSecureContext);

    try {
        if (canPicker) {
            let handle = ctx.srtSaveHandle;
            if (forceSaveAs) {
                handle = await window.showSaveFilePicker({ suggestedName: finalName, types: [{ description: "SubRip (.srt)", accept: { "text/plain": [".srt"] } }] });
                ctx.srtSaveHandle = handle;
            } else if (!handle) {
                handle = await window.showSaveFilePicker({ suggestedName: finalName, types: [{ description: "SubRip (.srt)", accept: { "text/plain": [".srt"] } }] });
                ctx.srtSaveHandle = handle;
            }

            try {
                if (!forceSaveAs && typeof handle.queryPermission === "function" && typeof handle.requestPermission === "function") {
                    const qp = await handle.queryPermission({ mode: "readwrite" });
                    if (qp !== "granted") {
                        const rp = await handle.requestPermission({ mode: "readwrite" });
                        if (rp !== "granted") {
                            ctx.showToast("No write permission for this file.");
                            return;
                        }
                    }
                }
            } catch { }

            const writable = await handle.createWritable();

            let contentToWrite = srtText;
            if (ctx.topicsView.topics && ctx.topicsView.topics.length > 0) {
                contentToWrite = embedMetadata(srtText, { topics: ctx.topicsView.topics });
            }

            await writable.write(contentToWrite);
            await writable.close();

            ctx.lastSavedAt = ctx.nowHHMMSS();
            ctx.setCleanNow();
            ctx.showToast(`Saved: ${handle.name}`);

        } else {
            downloadSrt(finalName, srtText, ctx);
        }
    } catch (e) {
        console.error(e);
        if (e.name !== 'AbortError') {
            ctx.showToast(`Save failed: ${e.message}`);
        }
    }
}

export function doExport(finalName, ctx) {
    const outObj = ctx.buildJsonFromSegments();
    const blob = new Blob([JSON.stringify(outObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    ctx.exportFileName = finalName;
    ctx.lastSavedAt = ctx.nowHHMMSS();
    ctx.setCleanNow();
}
