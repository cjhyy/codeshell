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

  // Compute key column width for alignment
  const keyWidth = Math.min(
    Math.max(...entries.map((e) => e.key.length)),
    20,
  );

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color="ansi:cyan" bold>{"✦ 切换模型"}</Text>
        <Text dim>{"  (↑↓ 选择, Enter 确认, Esc 取消)"}</Text>
      </Box>
      {entries.map((e, i) => {
        const focused = i === cursor;
        const prefix = focused ? "❯ " : "  ";
        const activeMark = e.active ? " ← active" : "";
        return (
          <Box key={e.key} marginLeft={2}>
            <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
              {prefix}{e.key.padEnd(keyWidth)}
            </Text>
            <Text>{"  "}{e.model}</Text>
            <Text dim>{activeMark}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
