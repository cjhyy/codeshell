/**
 * ModelSelector — Ink-rendered model picker.
 *
 * Pinned to the bottom slot when active. ↑↓ moves cursor, Enter selects,
 * Esc cancels. Receives the model pool from the parent (App.tsx fetches it
 * via client.query("models")) so this component stays purely presentational.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import type { ProtocolModelEntry } from "../../protocol/types.js";

/** Re-export under the UI name for convenience. */
export type ModelEntry = ProtocolModelEntry;

interface ModelSelectorProps {
  entries: ModelEntry[];
  onSelect: (key: string) => void;
  onCancel: () => void;
}

/** Format a token count into a human-readable string. */
function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

/** Derive capability tags from model key/name. */
function modelTags(key: string, model: string): string[] {
  const tags: string[] = [];
  const lower = `${key} ${model}`.toLowerCase();
  if (/coder|code|devstral/i.test(lower)) tags.push("coding");
  if (/reason|think|r1|o3|o4|pro/i.test(lower)) tags.push("reasoning");
  if (/flash|mini|haiku|fast|small|nano/i.test(lower)) tags.push("fast");
  if (/cheap|free/i.test(lower)) tags.push("cheap");
  if (/large|max|ultra|opus|big/i.test(lower)) tags.push("powerful");
  return tags;
}

export function ModelSelector({ entries, onSelect, onCancel }: ModelSelectorProps) {
  // Start cursor on the active model so Enter is a no-op confirm.
  const initialIdx = Math.max(0, entries.findIndex((e) => e.active));
  const [cursor, setCursor] = useState(initialIdx);

  useInput((_ch, key) => {
    if (entries.length === 0) {
      if (key.escape || key.return) onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : entries.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < entries.length - 1 ? c + 1 : 0));
    } else if (key.return) {
      onSelect(entries[cursor]!.key);
    } else if (key.escape) {
      onCancel();
    }
  });

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Box>
          <Text color="ansi:cyan" bold>{"✦ 切换模型"}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dim>未配置模型池。请用 /login 重新配置或编辑 settings.json 的 "models" 字段。</Text>
        </Box>
        <Box marginLeft={2}><Text dim>按任意键关闭</Text></Box>
      </Box>
    );
  }

  // Compute column widths for alignment
  const keyWidth = Math.min(
    Math.max(...entries.map((e) => e.key.length)),
    20,
  );
  const ctxWidth = Math.min(
    Math.max(...entries.map((e) => fmtTokens(e.maxContextTokens).length)),
    8,
  );

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color="ansi:cyan" bold>{"✦ 切换模型"}</Text>
        <Text dim>{"  (↑↓ 选择, Enter 确认, Esc 取消)"}</Text>
      </Box>
      <Box marginLeft={2} marginBottom={0}>
        <Text dim>
          {"  ".padEnd(keyWidth + 2)}模型路径{" ".repeat(28)}上下文{"  "}标签
        </Text>
      </Box>
      {entries.map((e, i) => {
        const focused = i === cursor;
        const prefix = focused ? "❯ " : "  ";
        const activeMark = e.active ? " ← active" : "";
        const tags = modelTags(e.key, e.model);
        const tagStr = tags.length > 0 ? tags.join(", ") : "";
        return (
          <Box key={e.key} marginLeft={2}>
            <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
              {prefix}{e.key.padEnd(keyWidth)}
            </Text>
            <Text>{"  "}{e.model.padEnd(32)}</Text>
            <Text dim>{fmtTokens(e.maxContextTokens).padStart(ctxWidth)}</Text>
            <Text>{"  "}</Text>
            <Text color="ansi:green">{tagStr}</Text>
            <Text dim>{activeMark}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
