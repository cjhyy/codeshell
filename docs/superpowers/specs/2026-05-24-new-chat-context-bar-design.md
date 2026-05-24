# New Chat Context Bar Design

Date: 2026-05-24

## Goal

Fix the new-chat composer layout so project/folder selection is no longer visually mixed into the text input. Add branch selection to the same below-input context area.

## User-approved direction

Use an independent context bar below the text input. The text input remains focused on prompt text only. The context bar shows and controls the new chat context:

- Project/folder picker
- Git branch picker

The branch picker must support switching branches.

## Scope

### In scope

- Move the existing new-chat project picker into a dedicated below-input context bar style.
- Add a branch picker next to the project picker.
- Show the context bar only for fresh conversations with no messages, matching the existing project-picker behavior.
- Support local Git branch switching for the selected project.
- Keep permission, model, context usage, mic, and send controls in the existing composer control row.

### Out of scope

- Remote branch checkout or branch creation.
- Switching project or branch after a chat already has messages.
- Changing engine session semantics beyond using the selected project/branch before the first send.

## UX

The composer layout becomes:

1. Textarea row for prompt text.
2. Existing composer controls row for attachment, permission mode, context ring, model, mic, and send/stop.
3. New context bar row, visible only when `messages.length === 0`.

The context bar uses a quieter visual treatment than the textarea/card:

- Subtle background
- Thin border
- Small label or muted text
- Compact pill controls

Controls:

- Project pill: reuse current `ProjectPicker` behavior.
- Branch pill: new `BranchPicker` with current branch label and dropdown.

## Branch behavior

Branch selection is enabled only when an active project exists and the project path is a Git repository.

Branch picker states:

- Active Git repo: show current branch, list local branches, mark current branch with a check.
- No project selected: show disabled `No branch` or localized equivalent.
- Non-Git project: show disabled `非 Git 项目` or equivalent.
- Branch loading/checking: show a subtle loading state.
- Checkout failure: keep the previous branch selected and show a short error message in the picker/popover.

Selecting a branch runs a safe local branch switch for that repo path. It must not create branches or fetch remote state.

## Architecture

### Renderer

- Keep `ProjectPicker` as the project/folder control.
- Add `BranchPicker` under `packages/desktop/src/renderer/chat/`.
- Add context bar markup in `ChatView` where `composer-pills-row` currently renders for new chats.
- Replace the single project row with a semantic context bar container that holds project and branch controls.

### Desktop preload/main bridge

Add a small Git branch API if one does not already exist:

- list branches for a repo path
- get current branch for a repo path
- switch to a local branch for a repo path

The renderer should call this API through the existing Electron preload pattern, not by running shell commands directly from the renderer.

### Styling

Extend `packages/desktop/src/renderer/styles/composer.css` with context bar classes. Reuse existing pill/popover styling where possible, but make the context bar distinct from the input text area.

## Testing

- Component/unit test for context bar rendering only on empty chats.
- Component/unit test for branch picker states: no project, non-Git, active Git repo, checkout failure.
- Manual smoke test in desktop dev mode:
  - New chat shows context bar below input.
  - Project picker still works.
  - Branch picker lists local branches.
  - Switching branch updates the displayed branch.
  - Existing chats do not show project/branch switching controls.
