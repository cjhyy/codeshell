/** The presentation lives beside the Codex runtime; DriveAgent's Codex worker reads it too. */
export { codexNativeApprovalPresentation } from "@cjhyy/code-shell-capability-coding/external-runtimes";

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Answer Codex's `request_user_input`: each question is put to the user in
 * turn through `ask`. `current()` is checked before and after every question;
 * once the runtime's authority is gone nothing more is asked or answered.
 */
export async function answerCodexUserInput(
  rawParams: unknown,
  ask: (question: string, options: Record<string, unknown>) => Promise<{ answer?: string }>,
  current: () => boolean,
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  if (!current()) return { answers: {} };
  const params = objectOf(rawParams) ?? {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const value of questions) {
    if (!current()) return { answers: {} };
    const question = objectOf(value);
    if (!question) continue;
    const id = typeof question.id === "string" ? question.id : "";
    const prompt = typeof question.question === "string" ? question.question : "";
    if (!id || !prompt) continue;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const item = objectOf(option);
          return item && typeof item.label === "string"
            ? [
                {
                  label: item.label,
                  description: typeof item.description === "string" ? item.description : "",
                },
              ]
            : [];
        })
      : undefined;
    const decision = await ask(prompt, {
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(options && options.length > 0 ? { options } : {}),
    });
    if (current() && decision.answer) answers[id] = { answers: [decision.answer] };
  }
  return { answers };
}
