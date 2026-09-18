/**
 * AskUserPrompt — dialog for the AskUserQuestion tool, Claude-Code-style.
 *
 * Two phases:
 *   1. Pick phase — numbered list of options (1. 2. 3. …), one option block
 *      per row: label on first line, dim description indented on the next.
 *      Cursor moves with ↑↓ or by pressing the number key. Multi-select
 *      uses Space to toggle ◉/◯. Last row is always an "Other…" free-text
 *      input. Enter advances to the review phase.
 *   2. Review phase — shows the answer(s) the user picked and asks
 *      "Submit answers" or "Cancel" as the next list. Enter on Submit
 *      finalizes; Enter on Cancel or Esc returns to the pick phase so the
 *      user can change their mind without losing what they typed.
 */
import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import TextInput from "./TextInput.js";
import type { QuestionDraft } from "../pending-questions.js";

interface Choice {
  label: string;
  description: string;
}

interface AskUserPromptProps {
  question: string;
  header?: string;
  options?: Choice[];
  multiSelect?: boolean;
  onAnswer: (answer: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  /** Optional questions can be set aside without sending a response. */
  onDefer?: () => void;
  draft?: QuestionDraft;
  onDraftChange?: (draft: QuestionDraft) => void;
  submitting?: boolean;
  onSubmittingChange?: (submitting: boolean) => void;
}

const OTHER_LABEL = "Other...";
const DEFAULT_HEADER = "Agent question";
const BORDER_COLOR = "ansi:yellow";

export function AskUserPrompt({
  question,
  header,
  options,
  multiSelect,
  onAnswer,
  onCancel,
  onDefer,
  draft: savedDraft,
  onDraftChange,
  submitting: pendingSubmission = false,
  onSubmittingChange,
}: AskUserPromptProps) {
  const hasOptions = !!options && options.length > 0;
  const choices: Choice[] = hasOptions
    ? [...options!, { label: OTHER_LABEL, description: "Type a custom answer" }]
    : [{ label: OTHER_LABEL, description: "Type your answer" }];
  const inputIdx = choices.length - 1;

  const [draft, setDraft] = useState<QuestionDraft>(
    () =>
      savedDraft ?? {
        phase: "pick",
        cursor: hasOptions ? 0 : inputIdx,
        selected: [],
        inputValue: "",
        reviewCursor: 0,
      },
  );
  const draftRef = useRef(draft);
  const submissionRef = useRef<"idle" | "pending" | "resolved">("idle");
  const [locallySubmitting, setSubmitting] = useState(false);
  const submitting = pendingSubmission || locallySubmitting;
  const { phase, cursor, inputValue, reviewCursor } = draft;
  const selected = new Set(draft.selected);

  function updateDraft(update: (current: QuestionDraft) => QuestionDraft): void {
    if (pendingSubmission || submissionRef.current !== "idle") return;
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    onDraftChange?.(next);
  }

  async function submitDecision(action: () => void | Promise<void>): Promise<void> {
    // Lock synchronously: consecutive keypresses can arrive before React renders.
    if (pendingSubmission || submissionRef.current !== "idle") return;
    submissionRef.current = "pending";
    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      await action();
      // Keep a successful question locked until its owner removes it.
      submissionRef.current = "resolved";
    } catch {
      submissionRef.current = "idle";
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  const onInputRow = cursor === inputIdx;

  // ─── Build the answer string the same way submit() used to ─────────
  function buildAnswer(): string {
    if (multiSelect && hasOptions) {
      const labels = [...selected]
        .sort((a, b) => a - b)
        .filter((i) => i !== inputIdx)
        .map((i) => choices[i]!.label);
      const extra = inputValue.trim();
      const all = extra ? [...labels, `Other: ${extra}`] : labels;
      return all.join(", ");
    }
    if (onInputRow) {
      const v = inputValue.trim();
      return v ? (hasOptions ? `Other: ${v}` : v) : hasOptions ? "Other" : "";
    }
    return choices[cursor]!.label;
  }

  // What we'll show in the review block — same data as buildAnswer() but
  // kept as an array so we can render one bullet per pick.
  function reviewLines(): string[] {
    if (multiSelect && hasOptions) {
      const labels = [...selected]
        .sort((a, b) => a - b)
        .filter((i) => i !== inputIdx)
        .map((i) => choices[i]!.label);
      const extra = inputValue.trim();
      if (extra) labels.push(`Other: ${extra}`);
      return labels.length > 0 ? labels : ["(nothing selected)"];
    }
    if (onInputRow) {
      const v = inputValue.trim();
      if (v) return [hasOptions ? `Other: ${v}` : v];
      return [hasOptions ? "Other" : "(empty)"];
    }
    return [choices[cursor]!.label];
  }

  function advanceToReview(): void {
    // Skip review if the answer is meaningless (empty free-text, no picks
    // in multi-select). In those cases we just stay on the pick phase.
    if (multiSelect && hasOptions) {
      const hasAnyPick = [...selected].some((i) => i !== inputIdx);
      const hasTypedText = inputValue.trim().length > 0;
      if (!hasAnyPick && !hasTypedText) return;
    } else if (onInputRow && !inputValue.trim() && !hasOptions) {
      // Free-text mode with empty input — don't advance.
      return;
    }
    updateDraft((current) => ({ ...current, reviewCursor: 0, phase: "review" }));
  }

  // ─── Input handler ─────────────────────────────────────────────────
  useInput((input, key) => {
    if (pendingSubmission || submissionRef.current !== "idle") return;
    if (phase === "review") {
      if (key.escape) {
        updateDraft((current) => ({ ...current, phase: "pick" }));
        return;
      }
      if (key.upArrow) {
        updateDraft((current) => ({
          ...current,
          reviewCursor: current.reviewCursor > 0 ? current.reviewCursor - 1 : 1,
        }));
        return;
      }
      if (key.downArrow) {
        updateDraft((current) => ({
          ...current,
          reviewCursor: current.reviewCursor < 1 ? current.reviewCursor + 1 : 0,
        }));
        return;
      }
      if (input === "1") {
        updateDraft((current) => ({ ...current, reviewCursor: 0 }));
        return;
      }
      if (input === "2") {
        updateDraft((current) => ({ ...current, reviewCursor: 1 }));
        return;
      }
      if (key.return) {
        if (reviewCursor === 0) void submitDecision(() => onAnswer(buildAnswer()));
        else updateDraft((current) => ({ ...current, phase: "pick" }));
      }
      return;
    }

    // ── pick phase ──
    if (key.escape) {
      if (onDefer) onDefer();
      else void submitDecision(onCancel);
      return;
    }
    if (key.upArrow) {
      updateDraft((current) => ({
        ...current,
        cursor: current.cursor > 0 ? current.cursor - 1 : choices.length - 1,
      }));
      return;
    }
    if (key.downArrow) {
      updateDraft((current) => ({
        ...current,
        cursor: current.cursor < choices.length - 1 ? current.cursor + 1 : 0,
      }));
      return;
    }
    if (key.return) {
      // The inline TextInput also receives Enter and calls onSubmit, which
      // routes here. Both rows go through advanceToReview() now.
      if (!onInputRow) advanceToReview();
      return;
    }
    if (multiSelect && hasOptions && input === " " && !onInputRow) {
      updateDraft((current) => {
        const next = new Set(current.selected);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return { ...current, selected: [...next] };
      });
      return;
    }
    // Number-key jump (1-9). Only applies on non-input rows so the digit
    // keys still work normally when typing into the Other… field.
    if (!onInputRow && /^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx >= 0 && idx < choices.length) updateDraft((current) => ({ ...current, cursor: idx }));
      return;
    }
  });

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <Frame header={header}>
      {phase === "pick" ? (
        <PickPhase
          question={question}
          choices={choices}
          cursor={cursor}
          selected={selected}
          inputValue={inputValue}
          setInputValue={(inputValue) => updateDraft((current) => ({ ...current, inputValue }))}
          onInputSubmit={() => advanceToReview()}
          multiSelect={!!multiSelect}
          hasOptions={hasOptions}
          inputIdx={inputIdx}
          canDefer={!!onDefer}
          disabled={submitting || submissionRef.current === "resolved"}
        />
      ) : (
        <ReviewPhase lines={reviewLines()} reviewCursor={reviewCursor} />
      )}
      {submitting && (
        <Box marginLeft={1}>
          <Text dim>Submitting answer…</Text>
        </Box>
      )}
    </Frame>
  );
}

// ─── Pick phase ─────────────────────────────────────────────────────

interface PickPhaseProps {
  question: string;
  choices: Choice[];
  cursor: number;
  selected: Set<number>;
  inputValue: string;
  setInputValue: (v: string) => void;
  onInputSubmit: () => void;
  multiSelect: boolean;
  hasOptions: boolean;
  inputIdx: number;
  canDefer: boolean;
  disabled: boolean;
}

function PickPhase({
  question,
  choices,
  cursor,
  selected,
  inputValue,
  setInputValue,
  onInputSubmit,
  multiSelect,
  hasOptions,
  inputIdx,
  canDefer,
  disabled,
}: PickPhaseProps) {
  return (
    <>
      <Box marginTop={1} marginLeft={1}>
        <Text>{question}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {choices.map((c, i) => {
          const isCursor = i === cursor;
          const isPicked = selected.has(i);
          const isInput = i === inputIdx;
          const number = `${i + 1}.`;
          const numberCol = isCursor ? "ansi:cyan" : undefined;
          const labelCol = isCursor ? "ansi:cyan" : undefined;
          // Multi-select adds a ◉/◯ glyph BEFORE the number. Non-input rows
          // only — the input row never shows a checkbox.
          const checkbox = multiSelect && hasOptions && !isInput ? (isPicked ? "◉" : "◯") : null;
          const cursorMark = isCursor ? "❯" : " ";

          return (
            <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Box>
                <Text color={numberCol}>{`${cursorMark} `}</Text>
                {checkbox && <Text color={numberCol}>{`${checkbox} `}</Text>}
                <Text color={numberCol} bold={isCursor}>{`${number} `}</Text>
                {isInput ? (
                  isCursor ? (
                    <TextInput
                      focus={!disabled}
                      value={inputValue}
                      onChange={setInputValue}
                      onSubmit={onInputSubmit}
                      placeholder={hasOptions ? "Type a custom answer here" : "Type your answer"}
                    />
                  ) : (
                    <Text dim>{c.label}</Text>
                  )
                ) : (
                  <Text color={labelCol} bold={isCursor}>
                    {c.label}
                  </Text>
                )}
              </Box>
              {c.description && (!isInput || !isCursor) && (
                <Box marginLeft={checkbox ? 7 : 5}>
                  <Text dim>{c.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} marginLeft={1}>
        <Text dim>
          {multiSelect && hasOptions
            ? "↑↓ move · 1-9 jump · Space toggle · Enter continue"
            : "↑↓ move · 1-9 jump · Enter continue"}
          {canDefer ? " · Esc answer later (selection is not submitted)" : " · Esc cancel"}
        </Text>
      </Box>
    </>
  );
}

// ─── Review phase ───────────────────────────────────────────────────

interface ReviewPhaseProps {
  lines: string[];
  reviewCursor: number;
}

function ReviewPhase({ lines, reviewCursor }: ReviewPhaseProps) {
  const actions: Choice[] = [
    { label: "Submit answers", description: "Send your answer to the agent" },
    { label: "Cancel", description: "Go back and change your selection" },
  ];
  return (
    <>
      <Box marginTop={1} marginLeft={1}>
        <Text bold>Review your answers</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} marginLeft={3}>
        {lines.map((l, i) => (
          <Box key={i}>
            <Text color="ansi:green">{"● "}</Text>
            <Text>{l}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} marginLeft={1}>
        <Text>Ready to submit your answers?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {actions.map((a, i) => {
          const isCursor = i === reviewCursor;
          const col = isCursor ? "ansi:cyan" : undefined;
          return (
            <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Box>
                <Text color={col}>{`${isCursor ? "❯" : " "} `}</Text>
                <Text color={col} bold={isCursor}>{`${i + 1}. ${a.label}`}</Text>
              </Box>
              <Box marginLeft={5}>
                <Text dim>{a.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} marginLeft={1}>
        <Text dim>{"↑↓ move · 1-2 jump · Enter select · Esc back"}</Text>
      </Box>
    </>
  );
}

// ─── Shared frame ───────────────────────────────────────────────────

function Frame({ header, children }: { header?: string; children: ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BORDER_COLOR}
      paddingX={1}
      marginLeft={1}
      marginY={0}
    >
      <Box>
        <Text color={BORDER_COLOR} bold>
          {"? "}
        </Text>
        <Text color={BORDER_COLOR} bold>
          {header ?? DEFAULT_HEADER}
        </Text>
      </Box>
      {children}
    </Box>
  );
}
