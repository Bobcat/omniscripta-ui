export function seekRelative(player, delta) {
    if (!player || !player.duration) return;
    let time = player.currentTime + delta;
    if (time < 0) time = 0;
    if (time > player.duration) time = player.duration;
    player.currentTime = time;
}

export function upperBound(arr, value) {
    let low = 0;
    let high = arr.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (arr[mid] <= value) low = mid + 1;
        else high = mid;
    }
    return low;
}

export function findSegmentIndexAtTime({
    time,
    segments,
    segmentStarts,
    rebuildSegmentStarts,
}) {
    if (!Array.isArray(segments) || segments.length === 0) return -1;
    if (!Array.isArray(segmentStarts) || segmentStarts.length !== segments.length) {
        rebuildSegmentStarts();
    }

    const index = upperBound(segmentStarts, time) - 1;
    if (index < 0) return 0;
    if (index >= segments.length) return segments.length - 1;
    if (time >= segments[index].end && index + 1 < segments.length) return index + 1;
    return index;
}

export function nextVisibleStartAfter({
    time,
    visibleStarts,
}) {
    if (!Array.isArray(visibleStarts) || visibleStarts.length === 0) return null;
    const index = upperBound(visibleStarts, time);
    return (index < visibleStarts.length) ? visibleStarts[index] : null;
}

function buildVisibleStarts(segments, isVisibleNow) {
    const starts = [];
    const ids = [];
    for (const segment of segments) {
        if (isVisibleNow(segment)) {
            starts.push(segment.start);
            ids.push(segment.id);
        }
    }
    return { starts, ids };
}

export function snapToVisibleIfNeeded({
    filterActive,
    playbackFiltered,
    visibleStarts,
    visibleSegIds,
    segments,
    isVisibleNow,
    player,
    findSegmentIndexAtTime,
}) {
    let nextVisibleStarts = visibleStarts;
    let nextVisibleSegIds = visibleSegIds;

    if (!filterActive || !playbackFiltered) {
        return { visibleStarts: nextVisibleStarts, visibleSegIds: nextVisibleSegIds, moved: false };
    }

    if (!nextVisibleStarts.length) {
        const computed = buildVisibleStarts(segments, isVisibleNow);
        nextVisibleStarts = computed.starts;
        nextVisibleSegIds = computed.ids;
    }
    if (!nextVisibleStarts.length) {
        return { visibleStarts: nextVisibleStarts, visibleSegIds: nextVisibleSegIds, moved: false };
    }

    const time = player.currentTime;
    const index = findSegmentIndexAtTime(time);
    const segment = segments[index];
    if (segment && isVisibleNow(segment)) {
        return { visibleStarts: nextVisibleStarts, visibleSegIds: nextVisibleSegIds, moved: false };
    }

    const nextStart = nextVisibleStartAfter({ time: time - 0.001, visibleStarts: nextVisibleStarts }) ?? nextVisibleStarts[0];
    if (nextStart == null) {
        return { visibleStarts: nextVisibleStarts, visibleSegIds: nextVisibleSegIds, moved: false };
    }
    player.currentTime = nextStart;
    return { visibleStarts: nextVisibleStarts, visibleSegIds: nextVisibleSegIds, moved: true };
}

export function enforceFilteredPlayback({
    filterActive,
    playbackFiltered,
    visibleStarts,
    segments,
    isVisibleNow,
    player,
    findSegmentIndexAtTime,
}) {
    if (!filterActive || !playbackFiltered) return false;
    if (!visibleStarts.length) {
        player.pause();
        return true;
    }

    const time = player.currentTime;
    const index = findSegmentIndexAtTime(time);
    const segment = segments[index];
    if (segment && isVisibleNow(segment)) return false;

    const nextStart = nextVisibleStartAfter({ time: time - 0.001, visibleStarts }) ?? visibleStarts[0];
    if (nextStart == null) {
        player.pause();
        return true;
    }
    if (Math.abs((player.currentTime || 0) - nextStart) < 1e-4) {
        player.pause();
        return true;
    }

    player.currentTime = nextStart;
    return true;
}

export function wirePlaybackLoopEvents({
    player,
    clampToLoopStartIfNeeded,
    snapToVisibleIfNeeded,
    getEffectiveLoopBounds,
    getSuppressTimeSyncUntil,
    enforceFilteredPlayback,
    findSegmentIndexAtTime,
    getCurrentSegmentIndex,
    getKeepCenteredDuringPlayback,
    setActiveSegment,
}) {
    let playRaf = 0;

    function playbackLoop() {
        playRaf = 0;
        if (player.paused) return;

        const bounds = getEffectiveLoopBounds();
        if (bounds) {
            const time = player.currentTime;
            if (time >= bounds.end - 0.01 || time < bounds.start - 0.01) {
                player.currentTime = bounds.start;
            }
        }

        if (Date.now() >= getSuppressTimeSyncUntil()) {
            const jumped = enforceFilteredPlayback();
            if (!jumped) {
                const time = player.currentTime;
                const index = findSegmentIndexAtTime(time);
                const currentSegmentIndex = getCurrentSegmentIndex();
                if (index !== -1 && index !== currentSegmentIndex) {
                    if (getKeepCenteredDuringPlayback()) setActiveSegment(index, 'auto', 'center', true);
                    else setActiveSegment(index, 'smooth', 'nearest');
                }
            }
        }

        playRaf = requestAnimationFrame(playbackLoop);
    }

    const onPlay = () => {
        clampToLoopStartIfNeeded();
        snapToVisibleIfNeeded();

        const currentSegmentIndex = getCurrentSegmentIndex();
        if (currentSegmentIndex >= 0) {
            setActiveSegment(currentSegmentIndex, 'auto', 'center');
        }

        if (!playRaf) playRaf = requestAnimationFrame(playbackLoop);
    };

    const onPause = () => {
        if (playRaf) {
            cancelAnimationFrame(playRaf);
            playRaf = 0;
        }
    };

    const onSeeked = () => {
        clampToLoopStartIfNeeded();
        snapToVisibleIfNeeded();
    };

    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('seeked', onSeeked);

    return () => {
        player.removeEventListener('play', onPlay);
        player.removeEventListener('pause', onPause);
        player.removeEventListener('seeked', onSeeked);
        if (playRaf) cancelAnimationFrame(playRaf);
        playRaf = 0;
    };
}
