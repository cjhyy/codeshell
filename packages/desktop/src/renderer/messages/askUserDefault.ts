/**
 * What a timed-out model question defaults to. Mirrors Core's
 * `recommendedAnswer`: the recommended option(s), otherwise a skip.
 */
export function recommendedAnswer(question: {
  options?: ReadonlyArray<{ label: string; recommended?: boolean }>;
  multiSelect?: boolean;
}): string | undefined {
  const labels = (question.options ?? [])
    .filter((option) => option.recommended === true)
    .map((option) => option.label);
  if (labels.length === 0) return undefined;
  return question.multiSelect ? labels.join(", ") : labels[0];
}
