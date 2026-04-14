/**
 * CommandInput — text input with slash command autocomplete.
 *
 * When the user types "/" at the start, a filterable command list appears.
 * Arrow keys navigate, Tab/Enter selects, Esc dismisses.
 */
import { useState, useMemo, useEffect, useRef } from "react";
import { Box, Text, useInput } from "../../ink/index.js";
import TextInput from "./TextInput.js";
import { createHistoryNavigator, addToHistory } from "../input-history.js";

interface CommandDef {
  name: string;
  description: string;
}

interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  commands: CommandDef[];
  placeholder?: string;
}

const MAX_VISIBLE = 8;

export function CommandInput({
  value,
  onChange,
  onSubmit,
  commands,
  placeholder,
}: CommandInputProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const historyRef = useRef(createHistoryNavigator());
  // Track whether the current value came from history navigation —
  // if so, suppress the autocomplete menu so ↑↓ keep browsing history.
  const [fromHistory, setFromHistory] = useState(false);

  // Show autocomplete when input starts with "/" and no space yet (still typing cmd name),
  // but NOT when the value was filled by history navigation.
  const showAutocomplete = !fromHistory && value.startsWith("/") && !value.includes(" ");
  const filter = value.slice(1).toLowerCase();

  const filtered = useMemo(() => {
    if (!showAutocomplete) return [];
    if (filter === "") return commands;
    return commands.filter(
      (c) =>
        c.name.slice(1).toLowerCase().includes(filter) ||
        c.description.toLowerCase().includes(filter),
    );
  }, [showAutocomplete, filter, commands]);

  // Sync selectedIndex when filtered list shrinks
  useEffect(() => {
    if (filtered.length > 0 && selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length - 1);
    } else if (filtered.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }, [filtered.length, selectedIndex]);

  useInput((ch, key) => {
    // Autocomplete navigation takes priority
    if (showAutocomplete && filtered.length > 0) {
      if (key.upArrow) {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
        return;
      } else if (key.downArrow) {
        setSelectedIndex(Math.min(filtered.length - 1, selectedIndex + 1));
        return;
      } else if (key.tab) {
        const cmd = filtered[selectedIndex];
        if (cmd) {
          onChange(cmd.name + " ");
          setSelectedIndex(0);
        }
        return;
      } else if (key.escape) {
        onChange("");
        setSelectedIndex(0);
        return;
      }
    }

    // P1.7: Input history navigation (when autocomplete is not active)
    if (key.upArrow) {
      const prev = historyRef.current.up(value);
      if (prev !== null) {
        setFromHistory(true);
        onChange(prev);
      }
    } else if (key.downArrow) {
      const next = historyRef.current.down();
      if (next !== null) {
        setFromHistory(true);
        onChange(next);
      }
    }
  });

  const handleChange = (v: string) => {
    // User typed/deleted — reset history navigation position so next
    // ↑ starts from the most recent entry instead of continuing from
    // the old cursor position.
    historyRef.current.reset();
    setFromHistory(false);
    onChange(v);
    setSelectedIndex(0);
  };

  const handleSubmit = (v: string) => {
    // If autocomplete is showing and user presses Enter, complete first
    if (showAutocomplete && filtered.length > 0 && filter.length > 0) {
      const cmd = filtered[selectedIndex];
      if (cmd && v.trim() === value.trim()) {
        // If the typed value exactly matches a command, submit it
        const exactMatch = filtered.find((c) => c.name === v.trim());
        if (exactMatch) {
          onSubmit(v);
          setSelectedIndex(0);
          historyRef.current.reset();
          return;
        }
        // Otherwise autocomplete
        onChange(cmd.name + " ");
        setSelectedIndex(0);
        return;
      }
    }
    // P1.7: Record input history and reset navigator
    addToHistory(v);
    historyRef.current.refresh();
    setFromHistory(false);
    onSubmit(v);
    setSelectedIndex(0);
  };

  // Compute visible window for scrolling
  const start = Math.max(0, selectedIndex - MAX_VISIBLE + 1);
  const visible = filtered.slice(start, start + MAX_VISIBLE);
  const visibleStartIndex = start;

  return (
    <Box flexDirection="column">
      {/* Autocomplete dropdown (above input) */}
      {showAutocomplete && filtered.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={0}>
          {start > 0 && (
            <Text dim>  ↑ {start} more</Text>
          )}
          {visible.map((cmd, i) => {
            const globalIdx = visibleStartIndex + i;
            const isSelected = globalIdx === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={isSelected ? "cyanBright" : undefined} bold={isSelected}>
                  {isSelected ? "▸ " : "  "}
                </Text>
                <Text color={isSelected ? "cyanBright" : "white"} bold={isSelected}>
                  {cmd.name}
                </Text>
                <Text dim>  {cmd.description}</Text>
              </Box>
            );
          })}
          {start + MAX_VISIBLE < filtered.length && (
            <Text dim>  ↓ {filtered.length - start - MAX_VISIBLE} more</Text>
          )}
        </Box>
      )}

      {/* Input line */}
      <Box flexDirection="column">
        <Box>
          <Text>{"❯ "}</Text>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={placeholder ?? "Ask anything… (/ for commands, ↑ for history)"}
          />
        </Box>
      </Box>
    </Box>
  );
}
