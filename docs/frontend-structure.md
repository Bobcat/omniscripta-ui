# Frontend Structure Convention

This note describes the target structure for new frontend projects. Existing
projects may temporarily keep their current root names when a full move would
create unnecessary churn.

## Target Layout

Use `src/workflows/` for user-facing workflows and `src/shared/` for code that
is genuinely shared by multiple workflows.

```text
src/
  app.js
  api-client.js

  shared/
    ui-helpers.js
    formatting.js
    languages.js

  workflows/
    upload/
      index.js

    live/
      index.js

    settings/
      index.js
```

## Rules

- `src/app.js` owns shell composition, routing, and workflow mounting.
- `src/api-client.js` is the backend boundary.
- `src/workflows/<name>/index.js` is the entrypoint for a workflow.
- Workflow-owned code starts inside that workflow directory.
- Move code to `src/shared/` only after it is used by multiple workflows.
- Add subdirectories inside a workflow only when they represent a real concept,
  not just because a single file exists.

## Existing Repos

- `llm-workbench-ui` already follows the preferred `src/workflows/` shape.
- `omniscripta-ui` currently uses `js/` as its root. Its workflow directories
  (`js/upload`, `js/live`, `js/settings`) should be treated as conceptually
  equivalent to `src/workflows/upload`, `src/workflows/live`, and
  `src/workflows/settings`.
- If `omniscripta-ui` is migrated later, prefer one explicit root-composition
  phase instead of mixing `js/` and `src/` paths over time.
