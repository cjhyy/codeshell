# Personal sanitized eval dataset

This directory contains a local-only export of selected CodeShell sessions for
trajectory and reliability evaluation.

Generated data files are ignored by Git. Only this README and `SCHEMA.md` are
tracked.

## Privacy policy

The exporter intentionally keeps no free-form user or assistant text. It also
removes titles, summaries, prompts, paths, workspace/project names, commands,
tool arguments, tool outputs, error messages, stack traces, session IDs,
client-message IDs, tool-call IDs, and absolute timestamps.

It retains only:

- pseudonymous case IDs and a one-way source fingerprint;
- coarse origin, provider family, model family, and terminal status;
- turn, message, tool, failure, sub-agent, compaction, and token counts;
- a content-free event timeline with relative time offsets;
- recognized first-party tool names; other names become `external_tool_NN`.

This makes the export useful for detecting loops, tool-selection regressions,
failure recovery problems, excessive cost, and incorrect termination. It is
not sufficient for judging semantic answer quality because the original task
and answer text are deliberately absent.

## Selection policy

The exporter selects sessions that:

1. originated from an interactive Desktop or TUI run;
2. are top-level sessions rather than sub-agents;
3. have a generated title and at least one turn;
4. ended as `completed` or `model_error`;
5. contain at least one real user message and one assistant message.

Automation runs, sub-agent sessions, active sessions, user-aborted sessions,
and obvious test-only sessions are excluded.

## Refresh the local export

```bash
bun run scripts/export-personal-eval-dataset.ts
```

The command writes `manifest.json`, `cases.jsonl`, and one content-free JSONL
trace per selected case under `traces/`. Generated files use owner-only file
permissions where the platform supports them.

Before turning a case into a release gate, add a separately reviewed rubric or
synthetic task fixture. Do not restore raw personal prompts into this folder.
