# Electron Codex UI Review Feedback

> Date: 2026-05-24
> Status: follow-up requirements after the first completed Electron Codex UI version.
> Goal: give CC a concrete UI revision brief.

## Reference Screenshots

Sidebar target:

![Sidebar session layout reference](images/electron-sidebar-session-reference-2026-05-24.png)

Composer target:

![Composer controls reference](images/electron-composer-controls-reference-2026-05-24.png)

## Summary

The current version is directionally complete, but two product layout decisions need to change before the UI feels right:

1. The left sidebar should be project-first. Under each project, show the session list directly.
2. Settings, model configuration, and related controls should move to the bottom-left settings area instead of occupying primary sidebar space.
3. Permission mode, context progress, and model switching should be placed near the input composer, matching the second screenshot's interaction pattern.

This is mainly an information architecture and layout revision. Do not treat it as a pure color/style pass.

## 1. Sidebar Revision

### Required Structure

The sidebar should follow this hierarchy:

```text
Top section
  New conversation
  Search
  Plugins
  Automations

Projects
  codeshell
    Session 1
    Session 2
    Session 3
    Session 4
    Session 5
    Expand / show more

  tanka-fast-app
    Session 1
    Session 2

  ai-test-platform
    Session 1

  Prismo
    Session 1

  mindMap
    Session 1

Bottom section
  Settings
```

### Concrete Requirements

- Keep `项目` as the main sidebar section label.
- Under each project row, render its sessions directly.
- Project rows should use a folder icon and project name.
- Session rows should be visually nested under the project.
- The active session should have a rounded selected background like the first screenshot.
- Session rows can show shortcut hints on the right for the first few sessions, for example `⌘1`, `⌘2`, `⌘3`.
- Older sessions can show relative time on the right, for example `2 天`, `3 周`, `1 个月`.
- Add an `展开显示` row when a project has more sessions than the compact limit.
- Keep the sidebar dense and calm. It should read like a productivity app, not a card dashboard.
- Put `设置` at the very bottom-left, pinned to the bottom of the sidebar.
- Move model/settings/MCP/provider/permission setup into Settings, not top-level nav.

### Remove Or Demote

Do not keep these as primary peer views if they can live under Settings:

- model manager
- provider/API key management
- permission configuration page
- MCP configuration
- logs/perf, unless needed for developer mode

Top-level sidebar should prioritize daily workflow:

- new chat
- search
- plugins
- automation
- projects and sessions
- settings at bottom

## 2. Composer Controls Revision

### Required Layout

The input composer area should include these controls:

```text
Left side
  + / attach-context button
  Permission mode selector

Right side
  Context progress indicator
  Model selector
  Voice/input utility icon if present
  Send button
```

### Permission Mode

Move permission mode control from settings/topbar into the composer row.

Expected behavior:

- Permission mode is visible before sending a message.
- It should be clickable and configurable inline.
- It should use a compact pill/chip style.
- For high-risk modes, use a warning color.
- Example label from screenshot: `完全访问权限`.
- Add a chevron to show it opens a dropdown or popover.

Suggested modes:

- `计划模式`
- `默认权限`
- `接受编辑`
- `完全访问权限`

The exact internal value can map to existing core permission modes, but the UI label should be user-facing Chinese.

### Context Progress

Add current session context usage/progress to the composer row.

Expected behavior:

- Show current session context progress, not global app usage.
- Use `usage_update` / session state as source.
- Compact display is enough:
  - circular progress ring, or
  - thin progress pill, or
  - `ctx 42%`
- It should update during the session.
- It should be near the model selector so users understand model/context together.

### Model Selector

Move the active model switcher to the composer row.

Expected behavior:

- Show the active model in compact form, for example `5.5 超高`.
- Use an icon if available.
- Add a chevron.
- Clicking opens a popover/dropdown to switch model.
- Model choice should apply to the current/new turn clearly.
- Detailed provider/API key configuration still belongs in Settings.

### Send Button

Use a compact circular send button on the far right.

Expected behavior:

- Idle state: upward arrow icon.
- Busy state: stop/cancel icon.
- Disabled state when no active project/session or empty draft.
- Keep the button visually stronger than secondary controls.

## 3. Settings Placement

Settings should be bottom-left and should contain:

- model/provider configuration
- API keys
- permission defaults
- MCP servers
- app theme
- logs/developer controls if kept
- update settings

The sidebar bottom row should look like:

```text
[gear icon] 设置
```

Do not put model/provider/permission as always-visible large sidebar sections. Daily controls go in the composer; advanced configuration goes in Settings.

## 4. Session UX Details

### New Conversation

The `新对话` action should:

- create a fresh UI session entry under the active project, or prepare one immediately
- clear the composer/message area
- keep active project selected
- start a real engine session on first send

### Session Selection

Selecting a session should:

- switch the transcript
- update active session title in the main area/top bar
- update composer context progress for that session
- preserve draft per session if feasible

### Session Titles

Session titles should be concise and readable:

- Use first user prompt initially.
- Allow rename later.
- Avoid raw ids in the sidebar.
- Truncate long titles with ellipsis.

## 5. Visual Style Notes

Match the reference screenshots:

- Light background.
- Soft selected row backgrounds.
- Dense list rows.
- Minimal borders.
- Rounded selected sidebar rows.
- Monochrome line icons.
- Bottom settings row pinned and stable.
- Composer controls should be compact and horizontally aligned.
- Avoid large cards around primary workflow controls.
- Avoid making settings/model controls compete with the chat text area.

## 6. Implementation Notes

Likely touched areas:

- `packages/desktop/src/renderer/Sidebar.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/styles.css`
- session state helpers under `packages/desktop/src/renderer/`

If the current implementation already has separate views for Settings/Models/Permissions:

- keep those pages, but route them from the bottom Settings entry
- remove model and permission from primary sidebar navigation
- expose quick controls in the composer row

If session data is currently grouped separately from projects:

- adapt the view model so sidebar receives `projects[]` with nested `sessions[]`
- avoid flattening all sessions into a global list for the default sidebar

## 7. Acceptance Checklist

- [ ] Screenshot 1 is linked in this document and available under `docs/images/`.
- [ ] Screenshot 2 is linked in this document and available under `docs/images/`.
- [ ] Sidebar has `项目` section with project rows.
- [ ] Sessions render nested below each project.
- [ ] Active session row has selected background.
- [ ] Settings is pinned to bottom-left.
- [ ] Model/provider/permission settings are not primary sidebar peers.
- [ ] Permission mode control appears in the composer row.
- [ ] Current session context progress appears in the composer row.
- [ ] Model selector appears in the composer row.
- [ ] Send/stop button is far right and visually prominent.
- [ ] Composer layout matches the second screenshot's control grouping.

