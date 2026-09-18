import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "../types.js";
import { ContextManager, type ContextManagerConfig } from "./manager.js";
import { estimateStringTokens } from "./token-counter.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function session(config: Partial<ContextManagerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-tool-output-"));
  temporaryDirectories.push(directory);
  const transcriptPath = join(directory, "transcript.jsonl");
  const manager = new ContextManager({ maxTokens: 1_000_000, ...config });
  manager.setTranscriptPath(transcriptPath);
  return { manager, transcriptPath, outputDirectory: join(directory, "tool-results") };
}

function conversation(results: ContentBlock[]): Message[] {
  return [
    { role: "user", content: "Run the checks and preserve the final diagnostics." },
    {
      role: "assistant",
      content: results.map((result) => ({
        type: "tool_use",
        id: result.tool_use_id,
        name: "Bash",
        input: { command: `check-${result.tool_use_id}` },
      })),
    },
    { role: "user", content: results },
  ];
}

function result(id: string, content: ContentBlock["content"]): ContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

function findResult(messages: Message[], id: string): ContentBlock {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const block = message.content.find(
      (candidate) => candidate.type === "tool_result" && candidate.tool_use_id === id,
    );
    if (block) return block;
  }
  throw new Error(`Missing tool result ${id}`);
}

function visibleText(block: ContentBlock): string {
  if (typeof block.content === "string") return block.content;
  return (block.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n\n");
}

function savedOutputPath(preview: string): string {
  const match = /Full output saved to: ([^\n]+)/.exec(preview);
  if (!match) throw new Error("Reduced result must identify its recoverable full output");
  return match[1]!;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("ContextManager tool output budgets", () => {
  test.each(["sync", "async"] as const)(
    "%s saves the complete 35k output before shortening it and keeps head/tail errors",
    async (mode) => {
      const { manager } = session();
      const head = "BUILD START: validating release artifacts\n";
      const tail = "\nERROR: final validation failed (exit 1)\n";
      const fullOutput = head + "x".repeat(35_000 - head.length - tail.length) + tail;
      const messages = freeze(conversation([result("release-check", fullOutput)]));
      const originalBytes = JSON.stringify(messages);

      const output =
        mode === "sync" ? manager.manage(messages) : await manager.manageAsync(messages);
      const preview = visibleText(findResult(output, "release-check"));

      expect(fullOutput.length).toBe(35_000);
      expect(preview.length).toBeLessThan(30_000);
      expect(preview).toContain(head.trim());
      expect(preview).toContain(tail.trim());
      expect(readFileSync(savedOutputPath(preview), "utf8")).toBe(fullOutput);
      expect(JSON.stringify(messages)).toBe(originalBytes);
    },
  );

  test("all text parts share one result budget while image identity and error metadata survive", async () => {
    const { manager, transcriptPath } = session({ toolOutputTokenLimit: 1_200 });
    const first = "FIRST TEXT PART\n" + "a".repeat(3_700);
    const last = "b".repeat(3_700) + "\nERROR: screenshot verification failed";
    const beforeImage: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVhZC1pbWFnZQ==" },
    };
    const betweenImage: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "dGFpbC1pbWFnZQ==" },
    };
    const block: ContentBlock = {
      ...result("multimodal-check", [
        beforeImage,
        { type: "text", text: first },
        betweenImage,
        { type: "text", text: last },
      ]),
      id: "provider-error-result",
      is_error: true,
    };
    const messages = freeze(conversation([block]));
    const originalBytes = JSON.stringify(messages);

    // Each part fits by itself; only their combined text exceeds the configured cap.
    expect(estimateStringTokens(first)).toBeLessThan(1_200);
    expect(estimateStringTokens(last)).toBeLessThan(1_200);
    const output = await manager.manageAsync(messages);
    const reduced = findResult(output, "multimodal-check");
    const preview = visibleText(reduced);

    expect(estimateStringTokens(preview)).toBeLessThanOrEqual(1_200);
    expect(preview).toContain("FIRST TEXT PART");
    expect(preview).toContain("ERROR: screenshot verification failed");
    expect(readFileSync(savedOutputPath(preview), "utf8")).toBe(`${first}\n\n${last}`);
    expect(reduced.tool_use_id).toBe("multimodal-check");
    expect(reduced.id).toBe("provider-error-result");
    expect(reduced.is_error).toBe(true);
    expect(Array.isArray(reduced.content)).toBe(true);
    const parts = reduced.content as ContentBlock[];
    const images = parts.filter((part) => part.type === "image");
    expect(images).toEqual([beforeImage, betweenImage]);
    expect(images[0]).toBe(beforeImage);
    expect(images[1]).toBe(betweenImage);
    expect(parts.map((part) => part.type)).toEqual(["image", "text", "image", "text"]);
    expect(parts[0]).toBe(beforeImage);
    expect(parts[1]!.text).toContain("FIRST TEXT PART");
    expect(parts[2]).toBe(betweenImage);
    expect(parts[3]!.text).toContain("ERROR: screenshot verification failed");
    expect(JSON.stringify(messages)).toBe(originalBytes);

    const reloaded = freeze(JSON.parse(originalBytes) as Message[]);
    const resumed = new ContextManager({ maxTokens: 1_000_000, toolOutputTokenLimit: 1_200 });
    resumed.setTranscriptPath(transcriptPath);
    resumed.initReplacementStateFromMessages(reloaded);
    expect(JSON.stringify(await resumed.manageAsync(reloaded))).toBe(JSON.stringify(output));
  });

  test("parallel results count actual previews toward their aggregate budget without mutating history", () => {
    const { manager, outputDirectory } = session();
    const results = Array.from({ length: 7 }, (_, index) =>
      result(`parallel-${index}`, `${index}`.repeat(25_000)),
    );
    const messages = freeze(conversation(results));
    const originalBytes = JSON.stringify(messages);
    const output = manager.manage(messages);
    const texts = results.map((block) => visibleText(findResult(output, block.tool_use_id!)));

    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(100_000);
    expect(texts.reduce((sum, text) => sum + estimateStringTokens(text), 0)).toBeLessThanOrEqual(
      20_000,
    );
    // Treating previews as free would persist only four (leaving 18,750 raw
    // tokens); the four real previews push that total back over 20,000.
    const savedFiles = readdirSync(outputDirectory).filter((name) => name.endsWith(".txt"));
    expect(savedFiles.length).toBeGreaterThanOrEqual(5);
    for (let index = 0; index < texts.length; index++) {
      const preview = texts[index]!;
      if (preview === visibleText(results[index]!)) continue;
      expect(readFileSync(savedOutputPath(preview), "utf8")).toBe(visibleText(results[index]!));
    }
    expect(output[0]).toBe(messages[0]);
    expect(output[1]).toBe(messages[1]);
    expect(JSON.stringify(messages)).toBe(originalBytes);
  });

  test("resuming original transcript messages restores byte-identical previews and preserves old prefixes", () => {
    const { manager, transcriptPath } = session();
    const results = [
      result("long-check", "START\n" + "z".repeat(35_000) + "\nERROR: long-check failed"),
      ...Array.from({ length: 7 }, (_, index) =>
        result(`resume-parallel-${index}`, `${index}`.repeat(25_000)),
      ),
    ];
    const messages = freeze(conversation(results));
    // The transcript deliberately contains the original large results, never
    // the previews produced by the first manager.
    writeFileSync(transcriptPath, messages.map((message) => JSON.stringify(message)).join("\n"));
    const firstView = manager.manage(messages);
    const firstViewBytes = JSON.stringify(firstView);
    const reloaded: Message[] = readFileSync(transcriptPath, "utf8")
      .split("\n")
      .map((line) => JSON.parse(line));
    const originalReloadedBytes = JSON.stringify(reloaded);
    freeze(reloaded);

    const resumed = new ContextManager({ maxTokens: 1_000_000 });
    resumed.setTranscriptPath(transcriptPath);
    resumed.initReplacementStateFromMessages(reloaded);
    expect(JSON.stringify(resumed.manage(reloaded))).toBe(firstViewBytes);

    const appended = freeze([
      ...reloaded,
      ...conversation([
        result("later-check", "LATER START\n" + "w".repeat(35_000) + "\nERROR: later check failed"),
      ]).slice(1),
    ]);
    const continued = resumed.manage(appended);
    expect(JSON.stringify(continued.slice(0, reloaded.length))).toBe(firstViewBytes);
    expect(JSON.stringify(manager.manage(appended).slice(0, reloaded.length))).toBe(firstViewBytes);
    expect(
      readFileSync(savedOutputPath(visibleText(findResult(continued, "later-check"))), "utf8"),
    ).toBe(visibleText(findResult(appended, "later-check")));
    expect(JSON.stringify(reloaded)).toBe(originalReloadedBytes);
  });

  test("Chinese and emoji outputs obey estimated token budgets without splitting surrogate pairs", () => {
    const config = { maxToolResultChars: 30_000, toolOutputTokenLimit: 900 };
    const { manager } = session(config);
    const fullOutput = "检查开始 🚀\n" + "编译检查通过🧪".repeat(2_000) + "\n错误：最后一步失败 ❌";
    expect(fullOutput.length).toBeLessThan(config.maxToolResultChars);
    expect(estimateStringTokens(fullOutput)).toBeGreaterThan(config.toolOutputTokenLimit);
    const messages = freeze(conversation([result("unicode-check", fullOutput)]));
    const preview = visibleText(findResult(manager.manage(messages), "unicode-check"));

    expect(estimateStringTokens(preview)).toBeLessThanOrEqual(config.toolOutputTokenLimit);
    expect(hasUnpairedSurrogate(preview)).toBe(false);
    expect(preview).toContain("检查开始 🚀");
    expect(preview).toContain("错误：最后一步失败 ❌");
    expect(readFileSync(savedOutputPath(preview), "utf8")).toBe(fullOutput);

    // Also cover the truncation backstop when no transcript path is available;
    // vary the cut boundary so both halves of an emoji can meet the boundary.
    for (const characterLimit of [101, 102, 103, 104]) {
      const fallback = new ContextManager({
        maxTokens: 1_000_000,
        maxToolResultChars: characterLimit,
        toolOutputTokenLimit: 60,
      });
      const raw = "🚀".repeat(150) + "中".repeat(150) + "🧪".repeat(150);
      const reduced = visibleText(
        findResult(fallback.manage(conversation([result("no-disk", raw)])), "no-disk"),
      );
      expect(reduced.length).toBeGreaterThan(0);
      expect(reduced.length).toBeLessThanOrEqual(characterLimit);
      expect(estimateStringTokens(reduced)).toBeLessThanOrEqual(60);
      expect(hasUnpairedSurrogate(reduced)).toBe(false);
    }
  });
});
