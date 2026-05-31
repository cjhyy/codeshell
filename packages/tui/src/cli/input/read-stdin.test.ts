import { describe, test, expect } from "bun:test";
import { Readable } from "node:stream";
import { resolveTaskFromArgOrStdin } from "./read-stdin.js";

function pipe(text: string): Readable & { isTTY?: boolean } {
  const s = Readable.from([Buffer.from(text, "utf-8")]) as Readable & { isTTY?: boolean };
  s.isTTY = false; // piped, not a terminal
  return s;
}

function tty(): Readable & { isTTY?: boolean } {
  const s = Readable.from([]) as Readable & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

describe("resolveTaskFromArgOrStdin", () => {
  test("prefers the positional task argument over stdin", async () => {
    const task = await resolveTaskFromArgOrStdin("explicit task", pipe("piped task"));
    expect(task).toBe("explicit task");
  });

  test("reads the prompt from stdin when no task and stdin is piped", async () => {
    const task = await resolveTaskFromArgOrStdin(undefined, pipe("list files\n"));
    expect(task).toBe("list files");
  });

  test("returns undefined when no task and stdin is a TTY (does not hang)", async () => {
    const task = await resolveTaskFromArgOrStdin(undefined, tty());
    expect(task).toBeUndefined();
  });

  test("treats an empty positional arg as absent and falls back to stdin", async () => {
    const task = await resolveTaskFromArgOrStdin("  ", pipe("from stdin"));
    expect(task).toBe("from stdin");
  });

  test("returns undefined when piped stdin is empty/whitespace", async () => {
    const task = await resolveTaskFromArgOrStdin(undefined, pipe("   \n"));
    expect(task).toBeUndefined();
  });
});
