/**
 * PermissionPrompt — interactive tool permission dialog (Claude Code-style).
 *
 * Layout:
 *   ╭─ Bash command ─────────────────────────────────────────╮
 *   │                                                        │
 *   │   git push --force                                     │
 *   │   Force-push current branch                            │
 *   │   cwd: ~/.../codeshell                                 │
 *   │                                                        │
 *   │  Do you want to proceed?                               │
 *   │  ❯ 1. Yes                                              │
 *   │    2. Yes, allow `git` for this session                │
 *   │    3. Yes, allow `git` for this project (saved)        │
 *   │    4. No (esc)                                         │
 *   ╰────────────────────────────────────────────────────────╯
 *
 * Keys:
 *   ↑/↓        navigate
 *   Enter      confirm
 *   1/2/3/4    jump to option
 *   y          shortcut for "Yes"
 *   a          shortcut for "Yes, session"
 *   p          shortcut for "Yes, project"
 *   n / Esc    "No"
 */
import { useState } from "react";
import { homedir } from "node:os";
import { Box, Text, useInput } from "../../render/index.js";
import type { ApprovalScope } from "../../types.js";
import { DiffLine } from "./DiffLine.js";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  riskLevel: string;
  args: Record<string, unknown>;
  cwd: string;
  onDecision: (approved: boolean, scope: ApprovalScope) => void;
}

const PREVIEW_MAX_LINES = 40;

export function PermissionPrompt({
  toolName,
  description,
  riskLevel,
  args,
  cwd,
  onDecision,
}: PermissionPromptProps) {
  const [cursor, setCursor] = useState(0);
  const previewKind = previewKindFor(toolName);
  const detail = previewKind === "generic" ? describeArgs(toolName, args) : { body: [] };
  const scope = scopeLabel(toolName, args);
  const options: Array<{ label: string; scope: ApprovalScope; approved: boolean }> = [
    { label: "Yes", scope: "once", approved: true },
    { label: `Yes, allow ${scope} for this session`, scope: "session", approved: true },
    { label: `Yes, allow ${scope} for this project (saved)`, scope: "project", approved: true },
    { label: "No (esc)", scope: "once", approved: false },
  ];

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : options.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c < options.length - 1 ? c + 1 : 0));
      return;
    }
    if (key.return) {
      decide(cursor);
      return;
    }
    if (key.escape) {
      onDecision(false, "once");
      return;
    }
    const ch = input.toLowerCase();
    if (ch === "1" || ch === "y") decide(0);
    else if (ch === "2" || ch === "a") decide(1);
    else if (ch === "3" || ch === "p") decide(2);
    else if (ch === "4" || ch === "n") decide(3);
  });

  function decide(idx: number) {
    const opt = options[idx]!;
    onDecision(opt.approved, opt.scope);
  }

  const borderColor =
    riskLevel === "high" ? "ansi:red" : riskLevel === "medium" ? "ansi:yellow" : "ansi:cyan";
  const title = toolTitle(toolName);
  const cwdShort = shortenPath(cwd);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginLeft={1}
      marginY={0}
    >
      <Box>
        <Text color={borderColor} bold>
          {title}
        </Text>
        {riskLevel === "high" && <Text color="ansi:red">{"  ⚠ high risk"}</Text>}
      </Box>

      <Box marginTop={1} flexDirection="column" marginLeft={1}>
        {previewKind === "write" ? (
          <WritePreview
            filePath={String(args.file_path ?? "")}
            content={String(args.content ?? "")}
          />
        ) : previewKind === "edit" ? (
          <EditPreview
            filePath={String(args.file_path ?? "")}
            oldString={String(args.old_string ?? "")}
            newString={String(args.new_string ?? "")}
          />
        ) : (
          detail.body.map((line, i) => <Text key={i}>{line}</Text>)
        )}
        <Text dim>{description}</Text>
        <Text dim>
          {"cwd: "}
          {cwdShort}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {options.map((opt, i) => (
          <Box key={i}>
            <Text color={i === cursor ? "ansi:cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text dim>{i + 1}. </Text>
            <Text bold={i === cursor}>{opt.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── Preview components ────────────────────────────────────────────

type PreviewKind = "write" | "edit" | "generic";

function previewKindFor(toolName: string): PreviewKind {
  if (toolName === "Write") return "write";
  if (toolName === "Edit") return "edit";
  return "generic";
}

function WritePreview({ filePath, content }: { filePath: string; content: string }) {
  const lines = content.split("\n");
  const truncated = lines.length > PREVIEW_MAX_LINES;
  const shown = truncated ? lines.slice(0, PREVIEW_MAX_LINES) : lines;
  const home = homedir();
  const shortPath = filePath.startsWith(home) ? "~" + filePath.slice(home.length) : filePath;
  return (
    <Box flexDirection="column">
      <Text bold>{shortPath}</Text>
      <Box marginTop={1} flexDirection="column">
        {shown.map((line, i) => (
          <DiffLine key={i} kind="add" text={line} />
        ))}
        {truncated && (
          <Text dim>{`  … ${lines.length - PREVIEW_MAX_LINES} more lines`}</Text>
        )}
      </Box>
    </Box>
  );
}

function EditPreview({
  filePath,
  oldString,
  newString,
}: {
  filePath: string;
  oldString: string;
  newString: string;
}) {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const total = oldLines.length + newLines.length;
  const home = homedir();
  const shortPath = filePath.startsWith(home) ? "~" + filePath.slice(home.length) : filePath;

  let shownOld = oldLines;
  let shownNew = newLines;
  let omitted = 0;
  if (total > PREVIEW_MAX_LINES) {
    const halfBudget = Math.floor(PREVIEW_MAX_LINES / 2);
    shownOld = oldLines.slice(0, halfBudget);
    shownNew = newLines.slice(0, halfBudget);
    omitted = total - (shownOld.length + shownNew.length);
  }

  return (
    <Box flexDirection="column">
      <Text bold>{shortPath}</Text>
      <Box marginTop={1} flexDirection="column">
        {shownOld.map((line, i) => (
          <DiffLine key={`o${i}`} kind="remove" text={line} />
        ))}
        {shownNew.map((line, i) => (
          <DiffLine key={`n${i}`} kind="add" text={line} />
        ))}
        {omitted > 0 && <Text dim>{`  … ${omitted} more lines`}</Text>}
      </Box>
    </Box>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function toolTitle(toolName: string): string {
  switch (toolName) {
    case "Bash":
      return "Bash command";
    case "Edit":
      return "Edit file";
    case "Write":
      return "Write file";
    case "Read":
      return "Read file";
    case "WebFetch":
      return "Fetch URL";
    case "Agent":
      return "Launch sub-agent";
    default:
      return toolName;
  }
}

interface DescribedArgs {
  body: string[];
}

/**
 * Render the meaningful arg payload as one or more body lines. Bash gets the
 * full command. Edit/Write get the file path. Other tools get a compact JSON
 * dump so unknown tools at least show what's being requested.
 */
function describeArgs(toolName: string, args: Record<string, unknown>): DescribedArgs {
  switch (toolName) {
    case "Bash": {
      const cmd = String(args.command ?? "");
      return { body: cmd.split("\n") };
    }
    case "Edit":
    case "Write":
    case "Read":
      return { body: [String(args.file_path ?? args.path ?? "")] };
    case "WebFetch":
      return { body: [String(args.url ?? "")] };
    default: {
      const dump = JSON.stringify(args, null, 2);
      return { body: dump.split("\n").slice(0, 8) };
    }
  }
}

/**
 * Scope label for the "always allow" option — what the user is really
 * agreeing to whitelist. Bash narrows by command head (first token); for
 * file-tools we name the tool itself, since per-path whitelists aren't
 * persisted yet.
 */
function scopeLabel(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const cmd = String(args.command ?? "").trim();
    const head = cmd.split(/\s+/)[0] ?? "Bash";
    return `\`${head}\``;
  }
  return toolName;
}

function shortenPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}
