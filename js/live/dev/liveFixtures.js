export const DEV_LIVE_FIXTURES = {
    panel120v1: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (120s)",
        url: "/dev-fixtures/panel_discussion_120s.mp3",
        durationMs: 120000,
        startDelayMs: 700,
        tailDelayMs: 1200,
        mode: "playback",
    },
    panel120v1Inject: {
        id: "panel_120s_v1",
        version: "v1",
        label: "Run panel fixture (inject, 120s)",
        url: "/dev-fixtures/panel_discussion_120s.mp3",
        durationMs: 120000,
        startDelayMs: 700,
        tailDelayMs: 1200,
        mode: "inject",
    },
};

export const DEV_LIVE_FIXTURE_OPTIONS = [
    {
        value: "panel120v1",
        label: "Panel discussion (120s) · v1",
    },
];

export const LIVE_DEMO_QUERY_VALUE = "live-demo";
export const LIVE_DEMO_LANGUAGE_CODE = "en";
