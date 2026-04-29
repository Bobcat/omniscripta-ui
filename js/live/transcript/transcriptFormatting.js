import { buildSpeakerParagraphs, DEFAULT_TRANSCRIPT_PARAGRAPH_RULES } from "../../text/paragraphs.js";

const LIVE_SPEAKER_TAG_PREFIX_RE = /^\s*\[?\s*(speaker[_ ]?\d+|spk[_ ]?\d+)\s*\]?\s*[:\-]/i;
const LIVE_SPEAKER_TAG_GLOBAL_RE = /\[?\s*(speaker[_ ]?\d+|spk[_ ]?\d+)\s*\]?\s*[:\-]\s*/gi;

export const DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES = { ...DEFAULT_TRANSCRIPT_PARAGRAPH_RULES };

export function normalizeSegmentText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

export function stripSpeakerTagsFromText(text) {
    return normalizeSegmentText(String(text || "").replace(LIVE_SPEAKER_TAG_GLOBAL_RE, " "));
}

export function speakerLabelFromToken(token) {
    const raw = String(token || "").trim();
    if (!raw) return "";
    const m = raw.match(/(?:speaker|spk)[_ ]?(\d+)/i);
    if (!m) return "";
    const idx = Number(m[1]);
    if (!Number.isFinite(idx) || idx < 0) return "";
    return `Speaker ${idx + 1}`;
}

export function resolveTranscriptFormatRules(formatRules) {
    const src = formatRules && typeof formatRules === "object"
        ? formatRules
        : DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES;
    const out = { ...DEFAULT_LIVE_TRANSCRIPT_FORMAT_RULES };
    Object.keys(out).forEach((key) => {
        const value = Number(src[key]);
        if (Number.isFinite(value)) out[key] = value;
    });
    return out;
}

export function formatSegmentBlocksDiarizeHardPresentation(finalSegments, formatRules) {
    if (!Array.isArray(finalSegments) || !finalSegments.length) return { text: "", paragraphs: [] };
    const rules = resolveTranscriptFormatRules(formatRules);

    const rows = [];
    for (let i = 0; i < finalSegments.length; i += 1) {
        const seg = finalSegments[i] && typeof finalSegments[i] === "object" ? finalSegments[i] : {};
        const rawText = String(seg.text || "");
        const text = stripSpeakerTagsFromText(rawText);
        if (!text) continue;
        const tagged = rawText.match(LIVE_SPEAKER_TAG_PREFIX_RE);
        const inferredSpeaker = tagged ? String(tagged[1] || "").trim().toUpperCase().replace(" ", "_") : "";
        const speaker = String(seg.speaker || "").trim() || inferredSpeaker;
        rows.push({ text, speaker });
    }
    return buildSpeakerParagraphs(rows, {
        rules,
        normalizeParagraphText: normalizeSegmentText,
        carrySentenceCapitalization: true,
    });
}

export function formatPreviewSuffixText(finalText, previewText, options = {}) {
    const finalValue = String(finalText || "");
    const rawPreview = String(previewText || "").trim();
    if (!rawPreview) return "";
    const speakerLabelsEnabled = !!(options && options.speakerLabelsEnabled);
    const previewValue = speakerLabelsEnabled
        ? rawPreview
        : stripSpeakerTagsFromText(rawPreview);
    if (!previewValue) return "";
    return /\s$/.test(finalValue) ? previewValue : (" " + previewValue);
}

export function buildVisibleTranscriptState(finalSegments, previewText, options = {}) {
    const diarizePresentation = formatSegmentBlocksDiarizeHardPresentation(finalSegments, options.formatRules);
    const finalValue = (diarizePresentation && diarizePresentation.text)
        ? String(diarizePresentation.text)
        : "";
    const previewSuffix = formatPreviewSuffixText(finalValue, previewText, {
        speakerLabelsEnabled: !!options.speakerLabelsEnabled,
    });
    return {
        finalText: finalValue,
        previewSuffix,
        signature: `${finalValue}\n@@preview@@${previewSuffix}`,
    };
}
