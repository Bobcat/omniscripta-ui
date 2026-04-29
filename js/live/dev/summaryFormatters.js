export function percentile(values, fraction) {
    const rows = Array.isArray(values)
        ? values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
        : [];
    if (!rows.length) return null;
    if (rows.length === 1) return rows[0];
    const clamped = Math.max(0, Math.min(1, Number(fraction)));
    const pos = (rows.length - 1) * clamped;
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    if (lower === upper) return rows[lower];
    const weight = pos - lower;
    return rows[lower] + ((rows[upper] - rows[lower]) * weight);
}

export function formatDurationMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return "n/a";
    if (value < 1000) return `${Math.round(value)}ms`;
    return `${(value / 1000).toFixed(2)}s`;
}

export function formatTimingSeconds(sec) {
    const value = Number(sec);
    if (!Number.isFinite(value) || value < 0) return "n/a";
    if (value < 1) return `${Math.round(value * 1000)}ms`;
    return `${value.toFixed(2)}s`;
}

export function formatPositiveCountSummary(source, options = {}) {
    const emptyLabel = String(options.emptyLabel || "none");
    const maxEntriesRaw = Number(options.maxEntries);
    const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw > 0
        ? Math.round(maxEntriesRaw)
        : 4;
    const entries = source && typeof source === "object"
        ? Object.entries(source)
            .map(([key, value]) => [String(key || "").trim(), Number(value)])
            .filter(([key, value]) => key && Number.isFinite(value) && value > 0)
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        : [];
    if (!entries.length) return emptyLabel;
    const visible = entries.slice(0, maxEntries)
        .map(([key, value]) => `${key}=${Math.round(value)}`);
    const hiddenCount = entries.length - visible.length;
    return hiddenCount > 0 ? `${visible.join(", ")} +${hiddenCount} more` : visible.join(", ");
}
