import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTodos } from "./todo-snapshot.js";

interface RawTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function makeSessionDir(todoWrites: RawTodo[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "pet-disclosure-todo-"));
  const lines = todoWrites.map((todos, index) =>
    JSON.stringify({
      id: `e${index}`,
      type: "tool_use",
      timestamp: 1000 + index,
      turnNumber: index,
      data: { toolName: "TodoWrite", args: { todos } },
    }),
  );
  writeFileSync(join(dir, "transcript.jsonl"), lines.join("\n") + "\n", "utf-8");
  return dir;
}

describe("readSessionTodos", () => {
  test("newest snapshot wins, returns items in order with statuses", async () => {
    const dir = makeSessionDir([
      [{ content: "old task", status: "pending" }],
      [
        { content: "write tests", status: "completed", activeForm: "Writing tests" },
        { content: "implement feature", status: "in_progress" },
        { content: "ship it", status: "pending" },
      ],
    ]);

    const result = await readSessionTodos(dir);

    expect(result).toEqual([
      { id: "1", subject: "write tests", activeForm: "Writing tests", status: "completed" },
      {
        id: "2",
        subject: "implement feature",
        activeForm: "implement feature",
        status: "in_progress",
      },
      { id: "3", subject: "ship it", activeForm: "ship it", status: "pending" },
    ]);
  });

  test("all-completed snapshot returns an empty array", async () => {
    const dir = makeSessionDir([
      [
        { content: "task a", status: "completed" },
        { content: "task b", status: "completed" },
      ],
    ]);

    const result = await readSessionTodos(dir);

    expect(result).toEqual([]);
  });

  test("no TodoWrite event returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-disclosure-todo-none-"));
    writeFileSync(
      join(dir, "transcript.jsonl"),
      JSON.stringify({
        id: "e0",
        type: "message",
        timestamp: 1000,
        turnNumber: 0,
        data: { role: "user", content: "hi" },
      }) + "\n",
      "utf-8",
    );

    const result = await readSessionTodos(dir);

    expect(result).toBeNull();
  });
});
