/**
 * editorSave.js — Save / Export functions extracted from editor.js
 *
 * All functions that need shared editor state receive a `ctx` object.
 * Pure utility functions take explicit parameters.
 */
import { getApiUrl } from "../../../api.js";
import { embedMetadata } from "../../../utils.js";

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
        const rawText = String(s.text || "").replace(/\r\n?/g, "\n").trim();
        let line = rawText;
        if (speaker) {
            const textLines = rawText.split("\n");
            const first = textLines[0] || "";
            line = `${speaker}: ${first}`;
            if (textLines.length > 1) {
                line += `\n${textLines.slice(1).join("\n")}`;
            }
        }

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

function suggestExportBaseName(ctx) {
    const suggested = String(suggestSrtName(ctx) || "transcript").trim();
    const stripped = suggested.replace(/\.srt$/i, "");
    const base = stripped || "transcript";
    return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

function sanitizeExportFileName(baseName, extension) {
    const safeBase = String(baseName || "transcript")
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || "transcript";
    const ext = String(extension || "").trim().replace(/^\.+/, "").toLowerCase();
    return ext ? `${safeBase}.${ext}` : safeBase;
}

function sortedSegments(ctx) {
    return [...ctx.segments].sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
}

export function buildTxtFromSegments(ctx) {
    const segs = sortedSegments(ctx);
    const lines = [];
    for (const s of segs) {
        const rawText = String(s.text || "").replace(/\r\n?/g, "\n").trim();
        if (!rawText) continue;
        const speaker = String(s.speaker || "").trim();
        if (!speaker) {
            lines.push(rawText);
            continue;
        }
        const textLines = rawText.split("\n");
        let out = `${speaker}: ${textLines[0] || ""}`;
        if (textLines.length > 1) out += `\n${textLines.slice(1).join("\n")}`;
        lines.push(out);
    }
    return lines.join("\n\n");
}

function buildSrtExportContent(ctx) {
    const srtText = buildSrtFromSegments(ctx);
    if (ctx.topicsView.topics && ctx.topicsView.topics.length > 0) {
        return embedMetadata(srtText, { topics: ctx.topicsView.topics });
    }
    return srtText;
}

const ACTIVE_DOWNLOAD_LEASES = new Set();

function releaseDownloadLease(lease) {
    if (!lease) return;
    ACTIVE_DOWNLOAD_LEASES.delete(lease);
    try { URL.revokeObjectURL(lease.url); } catch { }
    try {
        if (lease.anchor && lease.anchor.parentNode) {
            lease.anchor.parentNode.removeChild(lease.anchor);
        }
    } catch { }
}

function scheduleDownloadLeaseRelease(lease) {
    if (!lease) return;
    // Keep object URL + blob + anchor alive long enough for Android "Open".
    window.setTimeout(() => {
        releaseDownloadLease(lease);
    }, 30 * 60 * 1000);
}

function triggerBrowserDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);

    const lease = { url, blob, anchor: a };
    ACTIVE_DOWNLOAD_LEASES.add(lease);
    a.click();
    scheduleDownloadLeaseRelease(lease);
}

function triggerHttpDownload(downloadUrl) {
    const href = getApiUrl(downloadUrl);
    const a = document.createElement('a');
    a.href = href;
    a.style.display = 'none';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function createServerExport(baseName, artifacts) {
    const r = await fetch(getApiUrl("/api/demo/exports"), {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            base_name: String(baseName || "transcript"),
            artifacts,
        }),
    });
    if (!r.ok) {
        let detail = `Export request failed: ${r.status}`;
        try {
            const body = await r.json();
            if (body && body.detail) {
                detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
            }
        } catch { }
        throw new Error(detail);
    }
    const payload = await r.json();
    const downloadUrl = String(payload.download_url || "").trim();
    if (!downloadUrl) {
        throw new Error("Export download URL missing");
    }
    return payload;
}

export async function exportDocumentsLocally(formats, ctx) {
    if (!ctx.segments.length) {
        throw new Error("No transcript loaded");
    }

    const selected = Array.from(new Set((formats || [])
        .map(f => String(f || "").trim().toLowerCase())
        .filter(f => f === "txt" || f === "srt")));

    if (selected.length === 0) {
        throw new Error("Select at least one export format");
    }

    const base = suggestExportBaseName(ctx);
    const artifacts = [];

    if (selected.includes("txt")) {
        artifacts.push({
            format: "txt",
            text: buildTxtFromSegments(ctx),
        });
    }

    if (selected.includes("srt")) {
        artifacts.push({
            format: "srt",
            text: buildSrtExportContent(ctx),
        });
    }

    const payload = await createServerExport(base, artifacts);
    const archive = artifacts.length > 1;
    const defaultFileName = archive
        ? sanitizeExportFileName(base, "zip")
        : sanitizeExportFileName(base, artifacts[0].format);
    const resolvedFileName = String(payload.filename || defaultFileName);
    const downloadUrl = String(payload.download_url || "").trim();
    triggerHttpDownload(downloadUrl);

    if (!archive) {
        return {
            archive: false,
            downloaded: [resolvedFileName],
        };
    }
    return {
        archive: true,
        downloaded: artifacts.map(a => sanitizeExportFileName(base, a.format)),
        archiveName: resolvedFileName,
    };
}

export function downloadSrt(filename, text, ctx) {
    let content = text;
    if (ctx.topicsView.topics && ctx.topicsView.topics.length > 0) {
        content = embedMetadata(text, { topics: ctx.topicsView.topics });
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    triggerBrowserDownload(filename, blob);
    ctx.lastSavedAt = ctx.nowHHMMSS();
    ctx.setCleanNow();
}

export async function saveSrtLocally(forceSaveAs, ctx) {
    if (!ctx.segments.length) return;

    const finalName = sanitizeSrtFileName(suggestSrtName(ctx), ctx);
    const srtText = buildSrtFromSegments(ctx);

    const canPicker = ctx.canUseFileSystem;

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
        if (e && e.name === 'AbortError') return;
        console.error(e);
        ctx.showToast(`Save failed: ${e.message}`);
    }
}
