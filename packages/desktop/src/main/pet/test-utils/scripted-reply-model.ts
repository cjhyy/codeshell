import type {
  ReplyAction,
  ReplyInterpretation,
  ReplyItem,
} from "../pet-notice-reply-interpreter.js";

/**
 * A stand-in for the reply model in tests (never used in production). It
 * understands the old typed grammar the decision tests were written with:
 * `回答 <code> <answer>` names an item by its internal id (`ref`), and a bare
 * answer addresses the only open item. Answers: 1 / 允许本次 approve, 2 /
 * 拒绝 decline, 跳过 / 等待 skip or wait, numbers pick options, an option's
 * label picks it, anything else is free text (bare chat is unrelated).
 * Several items without a code are ambiguous, and so is an answer the item
 * cannot take.
 */
export async function scriptedReplyModel(
  message: string,
  items: ReplyItem[],
): Promise<ReplyInterpretation | undefined> {
  const coded = /^回答\s+([0-9a-f]{12})\s+([\s\S]+)$/iu.exec(message.trim());
  const item = coded
    ? items.find((entry) => entry.ref === coded[1]!.toUpperCase())
    : items.length === 1
      ? items[0]
      : undefined;
  if (!item) return coded ? { kind: "unrelated" } : { kind: "ambiguous", question: "是哪一件？" };
  const answer = (coded ? coded[2]! : message).trim();
  const resolve = (
    action: ReplyAction,
    extra: Partial<Extract<ReplyInterpretation, { kind: "resolve" }>> = {},
  ): ReplyInterpretation | undefined =>
    item.actions.includes(action)
      ? { kind: "resolve", item: item.ordinal, action, explicit: true, ...extra }
      : { kind: "ambiguous", question: "选项无效，请按消息里的选项回答。" };
  if (item.kind === "approval") {
    if (["1", "允许本次"].includes(answer)) return resolve("approve");
    if (["2", "拒绝"].includes(answer)) return resolve("deny");
    // Ordinary chat while something waits is not an answer.
    if (!coded) return { kind: "unrelated" };
    return { kind: "ambiguous", question: "请回复选项 1（允许本次）或 2（拒绝）。" };
  }
  if (item.kind === "question") {
    const options = item.options ?? [];
    if (options.includes(answer)) return resolve("answer", { choices: [answer] });
    if (answer === "拒绝") return resolve(item.actions.includes("skip") ? "skip" : "deny");
    // "Skip" for a question that cannot be skipped is not read as a decline.
    if (answer === "跳过")
      return item.actions.includes("skip")
        ? resolve("skip")
        : coded
          ? resolve("deny")
          : { kind: "unrelated" };
    if (["等待", "一直等"].includes(answer)) return resolve("wait");
    if (/^\d+(?:\s*[,，]\s*\d+)*$/u.test(answer)) {
      const picked = answer.split(/\s*[,，]\s*/u).map((value) => options[Number(value) - 1]);
      if (
        options.length === 0 ||
        picked.some((label) => label === undefined) ||
        (picked.length > 1 && item.multiSelect !== true)
      )
        return { kind: "ambiguous", question: "选项无效，请按消息里的选项回答。" };
      return resolve("answer", { choices: picked as string[] });
    }
    if (!coded) return { kind: "unrelated" };
    return resolve("answer", { answer });
  }
  return { kind: "unrelated" };
}
