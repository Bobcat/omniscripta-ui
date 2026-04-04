export const DEFAULT_TRANSCRIPT_PARAGRAPH_RULES = {
    blockEverySegments: 3,
    blockMinChars: 220,
    blockMinWords: 35,
    allowLooseBreak: false,
};

function countWords(text) {
    const tokens = String(text || "").trim().match(/\S+/g);
    return tokens ? tokens.length : 0;
}

function startsWithUppercaseWord(text) {
    return /^[\s"'(\[]*[A-Z][\w'-]*/.test(String(text || ""));
}

function endsWithClosedSentence(text) {
    return /[.!?]["')\]]*\s*$/.test(String(text || ""));
}

function endsWithSinglePeriodOrTerminalPunctuation(text) {
    const value = String(text || "");
    if (/[!?]["')\]]*\s*$/.test(value)) return true;
    if (!/\.["')\]]*\s*$/.test(value)) return false;
    return !/(?:\.\.\.|…)["')\]]*\s*$/.test(value);
}

function capitalizeFirstLetterIfLowercase(text) {
    return String(text || "").replace(/^([\s"'([{<]*)([a-z])/, (_match, lead, letter) => `${lead}${letter.toUpperCase()}`);
}

function canBreakAfterSegment(currentText, nextText) {
    const cur = String(currentText || "");
    const next = String(nextText || "");
    if (!endsWithClosedSentence(cur)) return false;
    if (/[,;:]\s*$/.test(cur)) return false;
    if (/(\.\.\.|…)\s*$/.test(cur)) return false;
    if (next && !startsWithUppercaseWord(next)) return false;
    return true;
}

function defaultNormalizeRowText(text) {
    return String(text || "").trim();
}

function defaultNormalizeParagraphText(text) {
    return String(text || "").trim();
}

export function buildSpeakerParagraphs(rawRows, options = {}) {
    const rules = {
        ...DEFAULT_TRANSCRIPT_PARAGRAPH_RULES,
        ...(options.rules && typeof options.rules === "object" ? options.rules : {}),
    };
    const normalizeRowText = typeof options.normalizeRowText === "function"
        ? options.normalizeRowText
        : defaultNormalizeRowText;
    const normalizeParagraphText = typeof options.normalizeParagraphText === "function"
        ? options.normalizeParagraphText
        : defaultNormalizeParagraphText;
    const carrySentenceCapitalization = !!options.carrySentenceCapitalization;

    const rows = [];
    for (let i = 0; i < (Array.isArray(rawRows) ? rawRows.length : 0); i += 1) {
        const raw = rawRows[i] && typeof rawRows[i] === "object" ? rawRows[i] : {};
        const text = normalizeRowText(raw.text);
        if (!text) continue;
        rows.push({
            ...raw,
            text,
            speaker: String(raw.speaker || "").trim(),
            forceBreakBefore: !!raw.forceBreakBefore,
        });
    }

    if (!rows.length) return { text: "", paragraphs: [] };

    const paragraphs = [{
        text: rows[0].text,
        speaker: rows[0].speaker,
        breakBefore: "start",
        items: [rows[0]],
    }];
    let blockSegCount = 1;
    let blockChars = rows[0].text.length;
    let blockWords = countWords(rows[0].text);

    for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const curText = carrySentenceCapitalization && endsWithSinglePeriodOrTerminalPunctuation(prev.text)
            ? capitalizeFirstLetterIfLowercase(cur.text)
            : cur.text;
        const curItem = { ...cur, text: curText };
        const speakerChanged = !!(prev.speaker && cur.speaker && prev.speaker !== cur.speaker);
        if (cur.forceBreakBefore || speakerChanged) {
            paragraphs.push({
                text: curText,
                speaker: cur.speaker,
                breakBefore: cur.forceBreakBefore ? "gap" : "speaker_change",
                items: [curItem],
            });
            blockSegCount = 1;
            blockChars = curText.length;
            blockWords = countWords(curText);
            continue;
        }

        const targetReached = blockSegCount >= Number(rules.blockEverySegments || 0);
        const minReached = (
            blockChars >= Number(rules.blockMinChars || 0)
            || blockWords >= Number(rules.blockMinWords || 0)
        );
        const allowLooseBreak = !!rules.allowLooseBreak;
        if (targetReached && minReached && (allowLooseBreak || canBreakAfterSegment(prev.text, curText))) {
            paragraphs.push({
                text: curText,
                speaker: cur.speaker,
                breakBefore: "heuristic",
                items: [curItem],
            });
            blockSegCount = 1;
            blockChars = curText.length;
            blockWords = countWords(curText);
            continue;
        }

        const tail = paragraphs[paragraphs.length - 1];
        tail.text = tail.text ? `${tail.text} ${curText}` : curText;
        tail.items.push(curItem);
        blockSegCount += 1;
        blockChars += curText.length;
        blockWords += countWords(curText);
    }

    const normalizedParagraphs = paragraphs
        .map((paragraph) => ({
            text: normalizeParagraphText(paragraph.text),
            speaker: String(paragraph.speaker || "").trim(),
            breakBefore: String(paragraph.breakBefore || "heuristic"),
            items: Array.isArray(paragraph.items) ? paragraph.items : [],
        }))
        .filter((paragraph) => !!paragraph.text);

    return {
        text: normalizedParagraphs.map((paragraph) => paragraph.text).join("\n"),
        paragraphs: normalizedParagraphs,
    };
}
