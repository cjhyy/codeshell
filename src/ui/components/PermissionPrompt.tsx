/**
 * PermissionPrompt — interactive tool permission dialog (Claude Code-style).
 *
 * Layout:
 *   ╭─ Bash command ─────────────────────────────╮
 *   │                                            │
 *   │   git push --force                         │
 *   │   Force-push current branch                │
 *   │   cwd: ~/.../codeshell                     │
 *   │                                            │
 *   │  Do you want to proceed?                   │
 *   │  ❯ 1. Yes                                  │
 *   │    2. Yes, and don't ask again for `git`   │
 *   │    3. No (esc)                             │
 *   ╰────────────────────────────────────────────╯
 *
 * Keys:
 *   ↑/↓        navigate
 *   Enter      confirm
 *   1/2/3      jump to option
 *   y          shortcut for "Yes"
 *   a          shortcut for "Always allow"
 *   n / Esc    "No"
 */
import { useState } from "react";
import { homedir } from "node:os";
import { Box, Text, useInput } from "../../ink/index.js";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  riskLevel: string;
  args: Record<string, unknown>;
  cwd: string;
  onDecision: (approved: boolean, always: boolean) => void;
}

export function PermissionPrompt({
  toolName,
  description,
  riskLevel,
  args,
  cwd,
  onDecision,
}: PermissionPromptProps) {
  const [cursor, setCursor] = useState(0);
  const detail = describeArgs(toolName, args);
  const alwaysScope = scopeLabel(toolName, args);
  const options = [
    { label: "Yes" },
    { label: `Yes, and don't ask again for ${alwaysScope} this session` },
    { label: "No (esc)" },
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
      onDecision(false, false);
      return;
    }
    const ch = input.toLowerCase();
    if (ch === "1" || ch === "y") decide(0);
    else if (ch === "2" || ch === "a") decide(1);
    else if (ch === "3" || ch === "n") decide(2);
  });

  function decide(idx: number) {
    if (idx === 0) onDecision(true, false);
    else if (idx === 1) onDecision(true, true);
    else onDecision(false, false);
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
        <Text color={borderColor} bold>{title}</Text>
        {riskLevel === "high" && <Text color="ansi:red">{"  ⚠ high risk"}</Text>}
      </Box>

      <Box marginTop={1} flexDirection="column" marginLeft={1}>
        {detail.body.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text dim>{description}</Text>
        <Text dim>{"cwd: "}{cwdShort}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {options.map((opt, i) => (
          <Box key={i}>
            <Text color={i === cursor ? "ansi:cyan" : undefined}>
              {i === cursor ? "❯ " : "  "}
            </Text>
            <Text dim>{i + 1}. </Text>
            <Text bold={i === cursor}>{opt.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function toolTitle(toolName: string): string {
  switch (toolName) {
    case "Bash": return "Bash command";
    case "Edit": return "Edit file";
    case "Write": return "Write file";
    case "Read": return "Read file";
    case "WebFetch": return "Fetch URL";
    case "Agent": return "Launch sub-agent";
    default: return toolName;
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
