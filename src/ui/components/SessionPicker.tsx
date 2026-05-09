/**
 * SessionPicker — Ink-rendered session resume picker.
 *
 * Each row shows: relative time · turn count · first-user-message preview.
 * ↑↓ moves cursor, Enter selects, Esc cancels. Empty (no-message) sessions
 * are filtered upstream so the list is always meaningful.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";

export interface SessionPickerEntry {
  sessionId: string;
  startedAt: number;
  turnCount: number;
  preview?: string;
  cwd?: string;
}

interface SessionPickerProps {
  entries: SessionPickerEntry[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

export function SessionPicker({ entries, onSelect, onCancel }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0);

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
      onSelect(entries[cursor]!.sessionId);
    } else if (key.escape) {
      onCancel();
    }
  });

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Box>
          <Text color="ansi:cyan" bold>{"✦ Resume session"}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dim>没有可恢复的会话。</Text>
        </Box>
        <Box marginLeft={2}><Text dim>按任意键关闭</Text></Box>
      </Box>
    );
  }

  // Column widths — time fixed-ish, turns fixed, preview fills the rest.
  const timeWidth = Math.max(...entries.map((e) => relativeTime(e.startedAt).length));
  const turnsWidth = Math.max(...entries.map((e) => `${e.turnCount} turns`.length));

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color="ansi:cyan" bold>{"✦ Resume session"}</Text>
        <Text dim>{"  (↑↓ 选择, Enter 加载, Esc 取消)"}</Text>
      </Box>
      {entries.map((e, i) => {
        const focused = i === cursor;
        const prefix = focused ? "❯ " : "  ";
        const time = relativeTime(e.startedAt).padEnd(timeWidth);
        const turns = `${e.turnCount} turns`.padEnd(turnsWidth);
        const preview = e.preview
          ? truncate(e.preview, 60)
          : "(no messages)";
        return (
          <Box key={e.sessionId} marginLeft={2}>
            <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
              {prefix}
            </Text>
            <Text dim>{time}{"  "}</Text>
            <Text dim>{turns}{"  "}</Text>
            <Text>{preview}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Format a timestamp as "Nm ago" / "Nh ago" / "Nd ago" / absolute date. */
function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
