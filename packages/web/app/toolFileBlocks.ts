/**
 * Desktop's FileToolCard shows Edit as `- old` / `+ new` blocks and Write as its
 * content instead of an escaped JSON blob. This projects the same view from the
 * tool arguments; anything not shown as a block stays in `rest` for the raw view.
 */
export type ToolFileBlock = { label: string; text: string; tone?: "removed" | "added" };

const str = (value: unknown): value is string => typeof value === "string";

export function toolFileBlocks(
  name: string,
  args: Record<string, unknown> | undefined,
): { blocks: ToolFileBlock[]; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...args };
  const blocks: ToolFileBlock[] = [];
  const pair = (oldText: unknown, newText: unknown, suffix = "") => {
    if (str(oldText)) blocks.push({ label: `- old${suffix}`, text: oldText, tone: "removed" });
    if (str(newText)) blocks.push({ label: `+ new${suffix}`, text: newText, tone: "added" });
  };
  switch (name) {
    case "Edit":
      if (!str(args?.old_string) && !str(args?.new_string)) break;
      pair(args?.old_string, args?.new_string);
      delete rest.old_string;
      delete rest.new_string;
      break;
    case "MultiEdit": {
      const raw: unknown = args?.edits;
      const edits: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [];
      if (!edits.length || !edits.every((edit) => edit && typeof edit === "object")) break;
      edits.forEach((edit, index) =>
        pair(edit.old_string, edit.new_string, edits.length > 1 ? ` #${index + 1}` : ""),
      );
      delete rest.edits;
      break;
    }
    case "Write": {
      const content = args?.content;
      if (!str(content)) break;
      blocks.push({ label: "content", text: content });
      delete rest.content;
      break;
    }
  }
  return { blocks, rest: blocks.length ? rest : { ...args } };
}
