/** The presentation lives beside the Codex runtime; DriveAgent's Codex worker reads it too. */
export { codexNativeApprovalPresentation } from "@cjhyy/code-shell-capability-coding/external-runtimes";

/**
 * Whether "allow for this session" can be honored for a Codex native approval.
 * Only a plain command: Codex itself then stops asking about that same command
 * for the rest of its session. Patches, network access, terminal input and
 * permission grants are answered one at a time.
 */
export function codexNativeSessionGrantable(method: string, params: unknown): boolean {
  if (method !== "item/commandExecution/requestApproval") return false;
  const record = objectOf(params) ?? {};
  return record.kind !== "writeStdin" && !objectOf(record.networkApprovalContext);
}

/** The user's decision as Codex's answer; never wider than what was grantable. */
export function codexNativeApprovalAnswer(
  sessionGrantable: boolean,
  decision: { approved: boolean; always?: boolean; scope?: string },
): "accept" | "acceptForSession" | "decline" {
  if (!decision.approved) return "decline";
  return sessionGrantable && decision.always === true && decision.scope === "session"
    ? "acceptForSession"
    : "accept";
}

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
