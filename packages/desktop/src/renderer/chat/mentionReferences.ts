import type { InputAttachmentMeta } from "../../preload/types";

interface MentionBinding {
  start: number;
  end: number;
  attachment: InputAttachmentMeta;
}

export interface MentionReferences {
  draft: string;
  bindings: MentionBinding[];
}

export interface MentionEditSelection {
  start: number;
  end: number;
  caret: number;
}

/** Move only untouched selections. Deleted/edited text never reauthorizes an old reference. */
export function reconcileMentionReferences(
  state: MentionReferences,
  draft: string,
  selection?: MentionEditSelection,
): MentionReferences {
  const previous = state.draft;
  if (previous === draft) return state;
  let start = 0;
  while (start < previous.length && start < draft.length && previous[start] === draft[start])
    start++;
  let end = previous.length;
  let nextEnd = draft.length;
  while (end > start && nextEnd > start && previous[end - 1] === draft[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  let exactSelection = false;
  if (selection) {
    let selectedStart = selection.start;
    let selectedEnd = selection.end;
    if (selectedStart === selectedEnd && draft.length < previous.length) {
      selectedStart = selection.caret;
      selectedEnd = selectedStart + previous.length - draft.length;
    }
    const inserted = draft.length - previous.length + selectedEnd - selectedStart;
    if (
      Number.isInteger(selectedStart) &&
      Number.isInteger(selectedEnd) &&
      selectedStart >= 0 &&
      selectedEnd >= selectedStart &&
      selectedEnd <= previous.length &&
      inserted >= 0 &&
      previous.slice(0, selectedStart) === draft.slice(0, selectedStart) &&
      previous.slice(selectedEnd) === draft.slice(selectedStart + inserted)
    ) {
      start = selectedStart;
      end = selectedEnd;
      nextEnd = start + inserted;
      exactSelection = true;
    }
  }
  const delta = nextEnd - end;
  const bindings = state.bindings.flatMap((binding) => {
    let { start: from, end: to } = binding;
    if (end <= from) {
      from += delta;
      to += delta;
    } else if (start < to) return [];
    else if (exactSelection && start === to && end === to && nextEnd > start) return [];
    const token = previous.slice(binding.start, binding.end);
    if (
      draft.slice(from, to) !== token ||
      (from > 0 && !/\s/u.test(draft[from - 1]!)) ||
      (to < draft.length && !/\s/u.test(draft[to]!))
    )
      return [];
    return [{ ...binding, start: from, end: to }];
  });
  return { draft, bindings };
}

export function bindMentionReference(
  state: MentionReferences,
  draft: string,
  start: number,
  end: number,
  attachment: InputAttachmentMeta | null,
): MentionReferences {
  const current = reconcileMentionReferences(state, draft);
  if (!attachment) return current;
  return { draft, bindings: [...current.bindings, { start, end, attachment }] };
}

export function currentMentionReferences(
  state: MentionReferences,
  draft: string,
): InputAttachmentMeta[] {
  const references: InputAttachmentMeta[] = [];
  for (const { attachment } of reconcileMentionReferences(state, draft).bindings)
    if (!references.some((item) => item.kind === attachment.kind && item.path === attachment.path))
      references.push(attachment);
  return references;
}
