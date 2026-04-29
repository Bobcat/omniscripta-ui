import { formatDurationMs, formatPositiveCountSummary, formatTimingSeconds } from "./summaryFormatters.js";
import { vadLabelForPhase as defaultVadLabelForPhase } from "../transcript/vadState.js";

export function formatLiveSummaryPanel(result, options = {}) {
    const r = result && typeof result === "object" ? result : {};
    const engineState = options.engineState && typeof options.engineState === "object" ? options.engineState : {};
    const vadLabelForPhase = typeof options.vadLabelForPhase === "function"
        ? options.vadLabelForPhase
        : defaultVadLabelForPhase;
    const total = Number(r.chunks_total || 0);
    const done = Number(r.chunks_done || 0);
    const failed = Number(r.chunks_failed || 0);
    const pending = Number(r.chunks_pending || Math.max(0, total - done - failed));
    const fstate = String(r.finalization_state || "").trim() || "idle";
    const fstateLabel = ({
        idle: "Idle",
        recording: "Recording",
        processing_chunks: "Processing chunks",
        finalizing: "Finalizing",
        recording_finalized: "Recording finalized",
        finalized: "Ready",
        ready: "Ready",
        error: "Error",
    })[fstate] || fstate.replace(/_/g, " ");
    const rev = Number(r.transcript_revision || 0);
    const segs = Array.isArray(r.final_segments) ? r.final_segments : [];
    const chars = segs.reduce((acc, seg) => {
        const text = seg && typeof seg === "object" ? String(seg.text || "").trim() : "";
        return acc + (text ? text.length : 0);
    }, 0);
    const durMs = Number(r.recording_duration_ms || 0);

    const vadObj = engineState.vad && typeof engineState.vad === "object" ? engineState.vad : null;
    let vadLabel = "n/a";
    let vadCountersLine = "VAD counters: n/a";
    if (vadObj && vadObj.enabled === true) {
        const vadCfg = vadObj.config && typeof vadObj.config === "object" ? vadObj.config : {};
        const vadState = vadObj.state && typeof vadObj.state === "object" ? vadObj.state : {};
        const lastSpeechAgeMsRaw = Number(vadState.last_speech_age_ms);
        const hangoverMsRaw = Number(vadCfg.hangover_ms);
        const checksRaw = Number(vadState.checks);
        const speechRaw = Number(vadState.speech_checks);
        const hangoverRaw = Number(vadState.hangover_allows);
        const silenceRaw = Number(vadState.silence_checks);
        let vadPhase = "silence";
        if (Number.isFinite(lastSpeechAgeMsRaw) && lastSpeechAgeMsRaw >= 0) {
            if (lastSpeechAgeMsRaw <= 250) {
                vadPhase = "speech";
            } else if (Number.isFinite(hangoverMsRaw) && hangoverMsRaw > 0 && lastSpeechAgeMsRaw <= hangoverMsRaw) {
                vadPhase = "hangover";
            }
        }
        vadLabel = vadLabelForPhase(vadPhase) || "enabled";
        vadCountersLine =
            `VAD counters: checks=${Number.isFinite(checksRaw) ? Math.round(checksRaw) : "?"}`
            + ` | speech=${Number.isFinite(speechRaw) ? Math.round(speechRaw) : "?"}`
            + ` | hangover=${Number.isFinite(hangoverRaw) ? Math.round(hangoverRaw) : "?"}`
            + ` | silence=${Number.isFinite(silenceRaw) ? Math.round(silenceRaw) : "?"}`;
    } else if (vadObj && vadObj.enabled === false) {
        vadLabel = "Off";
        vadCountersLine = "VAD counters: disabled";
    }

    const reasonCounts = r.chunk_reason_counts && typeof r.chunk_reason_counts === "object"
        ? r.chunk_reason_counts
        : null;
    const rowsCount = Number(r.chunk_results_rows_count || 0);
    const uniqueCount = Number(r.chunk_results_unique_count || 0);
    const dupRows = Number(r.chunk_results_duplicate_index_rows || 0);
    const invalidRows = Number(r.chunk_results_invalid_index_rows || 0);
    return [
        `Processing state: ${fstateLabel}`,
        `Chunks: ${done}/${total} | pending ${pending} | failed ${failed}`,
        `Transcript: rev ${rev} | chars ${chars}`,
        `Recording: ${durMs > 0 ? `${(durMs / 1000).toFixed(1)}s` : "n/a"} | VAD ${vadLabel}`,
        vadCountersLine,
        `Chunk triggers: ${formatPositiveCountSummary(reasonCounts, { maxEntries: 4 })}`,
        `Chunk rows: rows ${Math.max(0, Math.round(rowsCount))}`
            + ` | unique ${Math.max(0, Math.round(uniqueCount || rowsCount))}`
            + ` | dup ${Math.max(0, Math.round(dupRows))}`
            + ` | invalid ${Math.max(0, Math.round(invalidRows))}`,
    ].join("\n");
}

export function formatEngineRuntimeSummaryPanel(result, options = {}) {
    const r = result && typeof result === "object" ? result : {};
    const runtime = r.engine_runtime && typeof r.engine_runtime === "object" ? r.engine_runtime : {};
    const engineState = runtime.engine_state && typeof runtime.engine_state === "object"
        ? runtime.engine_state
        : {};
    const speechGate = engineState.speech_gate && typeof engineState.speech_gate === "object"
        ? engineState.speech_gate
        : {};
    const guardrails = engineState.guardrails && typeof engineState.guardrails === "object"
        ? engineState.guardrails
        : {};
    const debug = engineState.debug && typeof engineState.debug === "object" ? engineState.debug : {};
    const debugState = debug.state && typeof debug.state === "object" ? debug.state : {};
    const inflight = debugState.inflight && typeof debugState.inflight === "object"
        ? debugState.inflight
        : null;

    const recMs = Number(r.recording_duration_ms || 0);
    const coveredMs = Number(r.final_covered_ms || 0);
    const uncommittedMs = Number(runtime.uncommitted_audio_ms || 0);
    const processedMs = Number(debugState.processed_offset_ms);
    const decodeMs = Number(debugState.decode_offset_ms);
    const submittedMs = Number(debugState.last_submitted_t1_ms);
    const previewChars = Number(debugState.preview_chars);
    let inflightSummary = "none";
    let inflightStale = false;
    let lastInflightSummaryText = String(options.lastInflightSummaryText || "");
    if (inflight) {
        const seq = Number(inflight.sequence_id);
        const t0Ms = Number(inflight.t0_ms);
        const t1Ms = Number(inflight.t1_ms);
        const inflightParts = [];
        if (Number.isFinite(seq) && seq >= 0) inflightParts.push(`seq ${Math.round(seq)}`);
        if (Number.isFinite(t0Ms) && t0Ms >= 0 && Number.isFinite(t1Ms) && t1Ms >= t0Ms) {
            inflightParts.push(`${formatDurationMs(t0Ms)} -> ${formatDurationMs(t1Ms)}`);
            inflightParts.push(`len ${formatDurationMs(Math.max(0, t1Ms - t0Ms))}`);
        }
        const language = String(inflight.language || "").trim();
        if (language) inflightParts.push(`lang ${language}`);
        if (inflightParts.length) {
            inflightSummary = inflightParts.join(" | ");
            lastInflightSummaryText = inflightSummary;
            inflightStale = false;
        }
    } else if (String(lastInflightSummaryText || "").trim()) {
        inflightSummary = String(lastInflightSummaryText);
        inflightStale = true;
    }

    const gateState = String(speechGate.state || "").trim();
    const recentHits = Number(speechGate.recent_hits_count);
    const silenceElapsedMs = Number(speechGate.silence_elapsed_ms);
    const rearmFromMs = Number(speechGate.rearm_from_ms);
    const hardClipCount = Number(guardrails.hard_clip_count);
    const hardClipDroppedMs = Number(guardrails.hard_clip_dropped_audio_ms);
    const bufferTrimCount = Number(guardrails.buffer_trim_count);
    const bufferTrimDroppedMs = Number(guardrails.buffer_trim_dropped_audio_ms);
    const emitSkips = Number(guardrails.emit_interval_skips);
    const pacingSkips = Number(guardrails.pacing_slot_skips);
    const vadErrors = Number(guardrails.vad_errors);
    const forcedCommits = Number(guardrails.speech_gate_forced_commit_count);

    const reasonCounts = debug.reason_counts && typeof debug.reason_counts === "object" ? debug.reason_counts : {};
    const workDecision = reasonCounts.work_decision && typeof reasonCounts.work_decision === "object"
        ? reasonCounts.work_decision
        : {};
    const applyDecision = reasonCounts.apply_decision && typeof reasonCounts.apply_decision === "object"
        ? reasonCounts.apply_decision
        : {};
    const hardClipText = Number.isFinite(hardClipCount) && hardClipCount > 0
        ? `${Math.round(hardClipCount)}/${Number.isFinite(hardClipDroppedMs) && hardClipDroppedMs > 0 ? formatDurationMs(hardClipDroppedMs) : "0ms"}`
        : "0";
    const bufferTrimText = Number.isFinite(bufferTrimCount) && bufferTrimCount > 0
        ? `${Math.round(bufferTrimCount)}/${Number.isFinite(bufferTrimDroppedMs) && bufferTrimDroppedMs > 0 ? formatDurationMs(bufferTrimDroppedMs) : "0ms"}`
        : "0";

    const text = [
        `Coverage: recording ${recMs > 0 ? formatDurationMs(recMs) : "n/a"}`
            + ` | covered ${coveredMs > 0 ? formatDurationMs(coveredMs) : "n/a"}`
            + ` | uncommitted ${uncommittedMs > 0 ? formatDurationMs(uncommittedMs) : "0ms"}`,
        `Offsets: processed ${Number.isFinite(processedMs) && processedMs >= 0 ? formatDurationMs(processedMs) : "n/a"}`
            + ` | decode ${Number.isFinite(decodeMs) && decodeMs >= 0 ? formatDurationMs(decodeMs) : "n/a"}`
            + ` | submitted ${Number.isFinite(submittedMs) && submittedMs >= 0 ? formatDurationMs(submittedMs) : "n/a"}`
            + ` | preview ${Number.isFinite(previewChars) && previewChars >= 0 ? Math.round(previewChars) : "n/a"} chars`,
        `Inflight: ${inflightSummary}`,
        `Speech gate: state ${gateState || "n/a"}`
            + ` | hits ${Number.isFinite(recentHits) && recentHits >= 0 ? Math.round(recentHits) : 0}`
            + ` | silence ${Number.isFinite(silenceElapsedMs) && silenceElapsedMs >= 0 ? formatDurationMs(silenceElapsedMs) : "n/a"}`
            + ` | rearm_from ${Number.isFinite(rearmFromMs) && rearmFromMs > 0 ? formatDurationMs(rearmFromMs) : "n/a"}`,
        `Guardrails: clip ${hardClipText}`
            + ` | trim ${bufferTrimText}`
            + ` | emit ${Number.isFinite(emitSkips) && emitSkips >= 0 ? Math.round(emitSkips) : 0}`
            + ` | pacing ${Number.isFinite(pacingSkips) && pacingSkips >= 0 ? Math.round(pacingSkips) : 0}`
            + ` | vad ${Number.isFinite(vadErrors) && vadErrors >= 0 ? Math.round(vadErrors) : 0}`
            + ` | forced ${Number.isFinite(forcedCommits) && forcedCommits >= 0 ? Math.round(forcedCommits) : 0}`,
        `Decisions: work ${formatPositiveCountSummary(workDecision, { maxEntries: 3 })}`
            + ` | apply ${formatPositiveCountSummary(applyDecision, { maxEntries: 3 })}`,
    ].join("\n");

    return {
        text,
        lastInflightSummaryText,
        inflightStale,
    };
}

export function formatQualitySummaryPanel(envelope) {
    const qenv = envelope && typeof envelope === "object" ? envelope : {};
    const q = qenv.quality && typeof qenv.quality === "object" ? qenv.quality : {};
    const fixture = q.fixture && typeof q.fixture === "object" ? q.fixture : {};
    const score = q.score && typeof q.score === "object" ? q.score : {};

    const fixtureId = String(qenv.fixture_id || fixture.fixture_id || "").trim();
    const uploadScore = Number(score.upload_similarity_score);
    const wordLive = Number(score.word_count_live || 0);
    const wordRef = Number(score.word_count_reference || 0);
    const wordRatio = score.word_count_ratio_live_to_ref;
    const editDist = Number(score.word_edit_distance || 0);

    return [
        Number.isFinite(uploadScore)
            ? `Fixture benchmark: ${Math.round(uploadScore)}/100${fixtureId ? ` (${fixtureId})` : ""}`
            : `Fixture benchmark: pending${fixtureId ? ` (${fixtureId})` : ""}`,
        `Words: live ${wordLive} | ref ${wordRef}`
            + ` | ratio ${wordRatio === null || wordRatio === undefined ? "n/a" : `${Number(wordRatio).toFixed(3)}x`}`
            + ` | edit ${editDist}`,
    ].join("\n");
}

export function formatRunMetricsSummaryPanel(result) {
    const r = result && typeof result === "object" ? result : {};
    const recMs = Number(r.recording_duration_ms || 0);
    const chunksTotal = Number(r.chunks_total || 0);
    const chunksDone = Number(r.chunks_done || 0);
    const chunksFailed = Number(r.chunks_failed || 0);
    const chunksPending = Number(r.chunks_pending || Math.max(0, chunksTotal - chunksDone - chunksFailed));
    const chunkReasons = r.chunk_reason_counts && typeof r.chunk_reason_counts === "object"
        ? r.chunk_reason_counts
        : {};

    const asrTranscribeTimeS = Number(r.asr_transcribe_s || 0);
    const asrLoadAudioTimeS = Number(r.asr_load_audio_s || 0);
    const asrRunnerWallTimeS = Number(r.asr_runner_wall_s || 0);
    const asrPoolWallTimeS = Number(r.asr_pool_wall_s || 0);
    const asrPoolIngestTimeS = Number(r.asr_pool_ingest_s || 0);
    const asrPoolQueueTimeS = Number(r.asr_pool_queue_wait_s || 0);
    const asrPoolOutsideRunnerTimeS = Number(r.asr_pool_outside_runner_s || 0);
    const asrBackendWallTimeS = Number(r.asr_backend_wall_s || 0);
    const asrBackendWavWriteTimeS = Number(r.asr_backend_wav_write_s || 0);
    const asrBackendSubmitTimeS = Number(r.asr_backend_submit_s || 0);
    const asrBackendCollectTimeS = Number(r.asr_backend_result_collect_s || 0);
    const asrBackendOutsidePoolTimeS = Number(r.asr_backend_outside_pool_s || 0);

    const transcribeBaselineS = Number.isFinite(asrTranscribeTimeS) && asrTranscribeTimeS > 0
        ? asrTranscribeTimeS
        : null;
    const formatTranscribeRelativePct = (value) => (
        transcribeBaselineS !== null && Number.isFinite(value)
            ? `${((Number(value) / transcribeBaselineS) * 100).toFixed(1)}%`
            : "n/a"
    );
    const formatRunnerCumulativePct = (extraValue) => (
        transcribeBaselineS !== null && Number.isFinite(extraValue)
            ? `${(100 + ((Number(extraValue) / transcribeBaselineS) * 100)).toFixed(1)}%`
            : "n/a"
    );
    const timingNotes = [
        "Timing notes:",
        "- percentages use ASR runner transcribe = 100%",
        "- submit overlaps with pool wall; non-pool is exclusive",
    ];

    return [
        `Run: ${chunksDone}/${chunksTotal} ready | failed ${chunksFailed} | pending ${chunksPending}`
            + ` | recording ${recMs > 0 ? `${(recMs / 1000).toFixed(1)}s` : "n/a"}`,
        `Chunk reasons: ${formatPositiveCountSummary(chunkReasons, { maxEntries: 4 })}`,
        ...timingNotes,
        `ASR runner: transcribe ${formatTimingSeconds(asrTranscribeTimeS)}`
            + ` (${transcribeBaselineS !== null ? "100%" : "n/a"})`
            + ` | load_audio ${formatTimingSeconds(asrLoadAudioTimeS)}`
            + ` (${formatRunnerCumulativePct(asrLoadAudioTimeS)})`
            + ` | wall ${formatTimingSeconds(asrRunnerWallTimeS)}`
            + ` (${formatTranscribeRelativePct(asrRunnerWallTimeS)})`,
        `Pool: wall ${formatTimingSeconds(asrPoolWallTimeS)}`
            + ` (${formatTranscribeRelativePct(asrPoolWallTimeS)})`
            + ` | ingest ${formatTimingSeconds(asrPoolIngestTimeS)}`
            + ` | queue ${formatTimingSeconds(asrPoolQueueTimeS)}`
            + ` | non-runner ${formatTimingSeconds(asrPoolOutsideRunnerTimeS)}`,
        `Backend: wall ${formatTimingSeconds(asrBackendWallTimeS)}`
            + ` (${formatTranscribeRelativePct(asrBackendWallTimeS)})`
            + ` | wav ${formatTimingSeconds(asrBackendWavWriteTimeS)}`
            + ` | submit ${formatTimingSeconds(asrBackendSubmitTimeS)}`
            + ` | collect ${formatTimingSeconds(asrBackendCollectTimeS)}`
            + ` | non-pool ${formatTimingSeconds(asrBackendOutsidePoolTimeS)}`,
    ].join("\n");
}
