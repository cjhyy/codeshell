# New Chat Context Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move new-chat project selection into a separate below-input context bar and add a local Git branch picker that can switch branches.

**Architecture:** Reuse the existing desktop composer and ProjectPicker patterns. Add a small Electron main/preload Git branch API, a focused renderer BranchPicker component, and replace the current `composer-pills-row` with a distinct context bar visible only for draft/new chats.

**Tech Stack:** Electron main/preload IPC, React renderer, TypeScript, lucide-react icons, Bun test runner.

---

## File structure

- Modify: `packages/desktop/src/main/desktop-services.ts`
  - Add typed Git branch helpers: list local branches and switch to an existing local branch.
- Modify: `packages/desktop/src/main/index.ts`
  - Register IPC handlers for branch list and branch checkout.
- Modify: `packages/desktop/src/preload/index.ts`
  - Expose branch helpers on `window.codeshell`.
- Modify: `packages/desktop/src/preload/types.d.ts`
  - Add renderer-visible `GitBranches` type and API methods.
- Create: `packages/desktop/src/renderer/chat/BranchPicker.tsx`
  - Render branch chip/dropdown and own loading/error states.
- Modify: `packages/desktop/src/renderer/ChatView.tsx`
  - Pass active repo path to branch picker and render project + branch inside a context bar.
- Modify: `packages/desktop/src/renderer/App.tsx`
  - Pass `activeRepo?.path ?? null` to `ChatView`.
- Modify: `packages/desktop/src/renderer/styles/composer.css`
  - Add context bar and branch picker styles.
- Add/modify tests where practical:
  - `tests/desktop-services-git-branches.test.ts`
  - `tests/ui/new-chat-context-bar.test.tsx`

---

### Task 1: Add main-process Git branch services

**Files:**
- Modify: `packages/desktop/src/main/desktop-services.ts`
- Test: `tests/desktop-services-git-branches.test.ts`

- [ ] **Step 1: Write failing tests for branch service behavior**

Create `tests/desktop-services-git-branches.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getGitBranches, switchGitBranch } from "../packages/desktop/src/main/desktop-services";

const execFileAsync = promisify(execFile);
let dir = "";

async function git(args: string[]) {
  return execFileAsync("git", args, { cwd: dir });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeshell-branches-"));
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "init"]);
  await git(["branch", "feature/test"]);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("desktop git branch services", () => {
  test("lists local branches and current branch", async () => {
    const result = await getGitBranches(dir);
    expect(result.current).toBe("master");
    expect(result.branches).toContain("master");
    expect(result.branches).toContain("feature/test");
  });

  test("switches to an existing local branch", async () => {
    const result = await switchGitBranch(dir, "feature/test");
    expect(result.current).toBe("feature/test");
    expect(result.branches).toContain("master");
    expect(result.branches).toContain("feature/test");
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
bun test tests/desktop-services-git-branches.test.ts
```

Expected: FAIL because `getGitBranches` and `switchGitBranch` are not exported.

- [ ] **Step 3: Implement branch services**

Append to `packages/desktop/src/main/desktop-services.ts` after `getGitDiff`:

```ts
export interface GitBranches {
  current: string | null;
  branches: string[];
}

export async function getGitBranches(cwd: string): Promise<GitBranches> {
  const raw = await gitRun(cwd, ["branch", "--format=%(refname:short)"]);
  const branches = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let current: string | null = null;
  try {
    current = (await gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === "HEAD") current = null;
  } catch {
    current = null;
  }

  return { current, branches };
}

export async function switchGitBranch(cwd: string, branch: string): Promise<GitBranches> {
  const before = await getGitBranches(cwd);
  if (!before.branches.includes(branch)) {
    throw new Error(`Branch not found: ${branch}`);
  }
  await gitRun(cwd, ["switch", branch]);
  return getGitBranches(cwd);
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
bun test tests/desktop-services-git-branches.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/desktop-services.ts tests/desktop-services-git-branches.test.ts
git commit -m "feat: add desktop git branch services"
```

---

### Task 2: Expose branch services through Electron IPC

**Files:**
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`

- [ ] **Step 1: Import branch services in main**

In `packages/desktop/src/main/index.ts`, extend the import from `./desktop-services.js`:

```ts
import {
  getGitStatus,
  getGitDiff,
  getGitBranches,
  switchGitBranch,
  openExternal,
  revealInFinder,
} from "./desktop-services.js";
```

- [ ] **Step 2: Register IPC handlers**

After the existing `git:diff` handler, add:

```ts
ipcMain.handle("git:branches", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:branches requires cwd");
  return getGitBranches(cwd);
});

ipcMain.handle("git:switchBranch", async (_e, cwd: string, branch: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:switchBranch requires cwd");
  if (typeof branch !== "string" || !branch) throw new Error("git:switchBranch requires branch");
  return switchGitBranch(cwd, branch);
});
```

- [ ] **Step 3: Expose preload methods**

In `packages/desktop/src/preload/index.ts`, after `getGitDiff`, add:

```ts
  getGitBranches: (cwd: string) => ipcRenderer.invoke("git:branches", cwd),
  switchGitBranch: (cwd: string, branch: string) =>
    ipcRenderer.invoke("git:switchBranch", cwd, branch),
```

- [ ] **Step 4: Add preload types**

In `packages/desktop/src/preload/types.d.ts`, after `GitStatus`, add:

```ts
export interface GitBranches {
  current: string | null;
  branches: string[];
}
```

Then in `CodeshellApi`, after `getGitDiff`, add:

```ts
  getGitBranches(cwd: string): Promise<GitBranches>;
  switchGitBranch(cwd: string, branch: string): Promise<GitBranches>;
```

- [ ] **Step 5: Typecheck the desktop package**

Run:

```bash
bun run --cwd packages/desktop typecheck
```

Expected: No new type errors from these files. If the package script is unavailable, run root typecheck and inspect only errors related to modified files:

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat: expose git branch IPC"
```

---

### Task 3: Add BranchPicker renderer component

**Files:**
- Create: `packages/desktop/src/renderer/chat/BranchPicker.tsx`

- [ ] **Step 1: Create the component**

Create `packages/desktop/src/renderer/chat/BranchPicker.tsx`:

```tsx
import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import type { GitBranches } from "../../preload/types";

interface Props {
  cwd: string | null;
  disabled?: boolean;
}

type LoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

export function BranchPicker({ cwd, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cwd) {
      setState("unavailable");
      setBranches({ current: null, branches: [] });
      setError(null);
      return;
    }

    let cancelled = false;
    setState("loading");
    setError(null);
    window.codeshell
      .getGitBranches(cwd)
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
        setState(result.branches.length > 0 ? "ready" : "unavailable");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBranches({ current: null, branches: [] });
        setError(err instanceof Error ? err.message : "无法读取分支");
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const unavailable = disabled || !cwd || state !== "ready";
  const label = (() => {
    if (!cwd) return "No branch";
    if (state === "loading") return "Loading branch…";
    if (state === "error") return "非 Git 项目";
    if (state === "unavailable") return "非 Git 项目";
    return branches.current ?? "detached HEAD";
  })();

  const choose = async (branch: string): Promise<void> => {
    if (!cwd || branch === branches.current) {
      setOpen(false);
      return;
    }
    setState("loading");
    setError(null);
    try {
      const next = await window.codeshell.switchGitBranch(cwd, branch);
      setBranches(next);
      setState("ready");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换分支失败");
      setState("ready");
    }
  };

  return (
    <div className="branch-picker" ref={wrapRef}>
      <button
        type="button"
        className="composer-pill branch-picker-trigger"
        disabled={unavailable}
        onClick={() => setOpen((o) => !o)}
        title={error ?? "切换 Git 分支"}
      >
        <GitBranch size={12} />
        <span className="branch-picker-name">{label}</span>
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="branch-picker-popover">
          {error && <div className="branch-picker-error">{error}</div>}
          <ul className="project-picker-list">
            {branches.branches.map((branch) => {
              const active = branch === branches.current;
              return (
                <li
                  key={branch}
                  className={`project-picker-item${active ? " active" : ""}`}
                  onClick={() => { void choose(branch); }}
                >
                  <GitBranch size={12} className="project-picker-item-icon" />
                  <span className="project-picker-item-label">{branch}</span>
                  {active && <Check size={12} className="project-picker-item-check" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
bun run --cwd packages/desktop typecheck
```

Expected: No type errors in `BranchPicker.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/chat/BranchPicker.tsx
git commit -m "feat: add branch picker component"
```

---

### Task 4: Render project and branch in a separate context bar

**Files:**
- Modify: `packages/desktop/src/renderer/ChatView.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/styles/composer.css`

- [ ] **Step 1: Update ChatView props and imports**

In `ChatView.tsx`, add import:

```ts
import { BranchPicker } from "./chat/BranchPicker";
```

Add prop:

```ts
  activeRepoPath: string | null;
```

Destructure it in `ChatView({ ... })`.

- [ ] **Step 2: Replace the old pills row**

Replace the existing `messages.length === 0` block in `ChatView.tsx` with:

```tsx
        {messages.length === 0 && (
          <div className="composer-context-bar" aria-label="新聊天上下文">
            <span className="composer-context-label">Context</span>
            <ProjectPicker
              repos={repos}
              activeRepoId={activeRepoId}
              onSelect={onSelectRepo}
              onAddRepo={onAddRepo}
              disabled={busy}
            />
            <BranchPicker cwd={activeRepoPath} disabled={busy} />
          </div>
        )}
```

- [ ] **Step 3: Pass active repo path from App**

In `App.tsx`, where `ChatView` is rendered, pass:

```tsx
activeRepoPath={activeRepo?.path ?? null}
```

- [ ] **Step 4: Add context bar styles**

In `composer.css`, replace the `.composer-pills-row` block with:

```css
.composer-context-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: 4px;
  padding: 6px var(--sp-2);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--bg-muted, var(--bg-app));
  flex-wrap: wrap;
}
.composer-context-label {
  font-size: var(--fz-xs);
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.composer-context-bar .composer-pill {
  height: 26px;
  font-weight: 400;
  background: var(--bg-elevated);
}
```

Append branch picker styles near project picker styles:

```css
.branch-picker { position: relative; }
.branch-picker-trigger { max-width: 200px; }
.branch-picker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-picker-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 220px;
  max-width: 320px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-2);
  z-index: var(--z-popover);
  padding: 4px;
}
.branch-picker-error {
  padding: 6px var(--sp-2);
  color: var(--status-err);
  font-size: var(--fz-sm);
  border-bottom: 1px solid var(--border-subtle);
}
```

- [ ] **Step 5: Typecheck**

Run:

```bash
bun run --cwd packages/desktop typecheck
```

Expected: No type errors in modified desktop files.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/ChatView.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/styles/composer.css
git commit -m "feat: add new chat context bar"
```

---

### Task 5: Verify manually and with targeted tests

**Files:**
- Modify or create tests only if existing test utilities make renderer mounting straightforward.

- [ ] **Step 1: Run branch service test**

```bash
bun test tests/desktop-services-git-branches.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run desktop typecheck**

```bash
bun run --cwd packages/desktop typecheck
```

Expected: no errors related to modified files.

- [ ] **Step 3: Run desktop dev app**

```bash
bun run --cwd packages/desktop dev
```

Expected: Electron app opens.

- [ ] **Step 4: Manual smoke checklist**

In the Electron UI:

- New chat with no messages shows the context bar below the input.
- The input box no longer contains folder/project controls.
- Project picker still opens, filters, selects project, adds project, and supports no-project mode.
- For a Git project, branch picker shows the current branch.
- Branch picker dropdown lists local branches and marks current branch.
- Selecting another local branch updates the displayed branch.
- For no project, branch picker is disabled and shows `No branch`.
- For non-Git project, branch picker is disabled and shows `非 Git 项目`.
- After sending the first message, the context bar disappears.

- [ ] **Step 5: Commit verification fixes if needed**

If manual smoke finds small fixes, commit only those files:

```bash
git add <fixed-files>
git commit -m "fix: polish new chat context bar"
```

---

## Self-review

- Spec coverage: context bar, project picker reuse, branch picker, local branch switch, disabled states, and draft-only visibility are all covered.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: `GitBranches`, `getGitBranches`, and `switchGitBranch` names are consistent across main, preload, and renderer.
