# Design Studio Panel App

Design Studio is an independent CodeShell Desktop Panel App. It is not an
agent plugin and deliberately contains no Skill, MCP server, Agent, Command, or
Hook.

## What it does

- Vector canvas with selection, collapsible layer hierarchy, frames, alignment,
  distribution, snapping, rotation, zoom, pan, undo, and redo.
- Figma-style horizontal and vertical auto layout with gap, padding, alignment,
  space distribution, stretch, and grow controls.
- Reusable master components and linked instances.
- Deterministic v2 `.codesign.json` repository documents with strict v1 compatibility.
- Automatic binding to the current repository: recovery first, then the
  repository's last-opened or newest design, otherwise a blank repo document.
- Live reload when an Agent or editor changes the active source file and the
  canvas has no conflicting local edits.
- Reviewable SVG previews and built-in accessibility/layout audits.
- Optimistic-concurrency checks before overwriting repository files.
- Explicit Host permissions for workspace access, app storage, current-session
  context, and optional prompt submission.

## Install

Open **Extensions → Panel Apps → From folder**, then select this directory.
CodeShell validates `.codeshell-panel/panel.json`, shows a permission review,
and installs it into the independent Panel App registry.

Continue editing this directory in the repository. To load those changes, use
**Extensions → Panel Apps → Update from source** on the Design Studio card,
review the new package digest and permissions, then confirm the update.

Design files belong to the repository that is currently open in CodeShell and
live below `designs/`. They are not shared globally between projects. The panel
header shows the connected repository, and the file picker lets you switch
among that repository's `.codesign.json` files.

The optional repository checker is bundled at
`app/tools/check-design.mjs`; it is a document utility, not an agent command.

## Package boundary

Everything executable or renderable lives under `app/`, beside the declared
HTML entry. The package cannot be installed through the normal Plugin
installer, and the Panel App installer rejects agent-plugin content.
