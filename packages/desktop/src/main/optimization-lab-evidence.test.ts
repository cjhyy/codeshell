import { afterEach, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewOptimizationLabEvidence } from "./optimization-lab-evidence.js";
const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("held source/root directories and the project snapshot cannot be replaced after a trace read", async () => {
  for (const replace of ["source", "root", "snapshot"] as const) {
    const s = await setup();
    const dir = join(s.runsDir, "selected");
    await mkdir(dir);
    const originalSnapshot = JSON.stringify({
      cwd: s.cwd,
      objective: "selected input",
      summary: "selected output",
    });
    await writeFile(join(dir, "run.json"), originalSnapshot);
    await writeFile(
      join(dir, "events.jsonl"),
      JSON.stringify({ eventId: "tool", type: "tool_result", data: { text: "selected trace" } }) +
        "\n",
    );
    const originalOpen = fs.open.bind(fs);
    const spy = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const file = await originalOpen(...args);
      if (String(args[0]) === join(dir, "events.jsonl")) {
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          if (replace === "snapshot") {
            await writeFile(
              join(dir, "run.json"),
              JSON.stringify({ cwd: s.other, objective: "foreign data" }),
            );
            return;
          }
          const changed = replace === "root" ? s.runsDir : dir;
          await rename(changed, `${changed}-old`);
          await mkdir(changed);
          if (replace === "root") await mkdir(dir);
          // Identical bytes do not make a replacement directory the original source.
          await writeFile(join(dir, "run.json"), originalSnapshot);
          await writeFile(join(dir, "events.jsonl"), "");
        };
      }
      return file;
    }) as typeof fs.open);
    spies.push(spy);
    await expect(previewOptimizationLabEvidence(s.cwd, ["selected"], s)).rejects.toThrow(/changed/);
    spy.mockRestore();
    spies.pop();
  }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lab-evidence-host-"));
  roots.push(root);
  const cwd = join(root, "project"),
    other = join(root, "other"),
    sessionsDir = join(root, "sessions"),
    runsDir = join(root, "runs");
  for (const dir of [cwd, other, sessionsDir, runsDir]) await mkdir(dir);
  return { root, cwd, other, sessionsDir, runsDir };
}
test("imports only the selected receipt, marks missing historical config and torn tails, ignores current model", async () => {
  const s = await setup();
  const dir = join(s.sessionsDir, "session-1");
  await mkdir(dir);
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ cwd: s.cwd, model: "current-not-historical", kind: "work" }),
  );
  await writeFile(
    join(dir, "transcript.jsonl"),
    [
      {
        id: "old-input",
        type: "message",
        data: { role: "user", content: "unselected private input", clientMessageId: "old" },
      },
      {
        id: "old-result",
        type: "run_result",
        data: {
          clientMessageId: "old",
          result: { sessionId: "session-1", text: "unselected output" },
        },
      },
      {
        id: "input",
        type: "message",
        data: {
          role: "user",
          content: [
            { type: "text", text: "selected input sk-abcdefghijklmnopqrstuv" },
            { type: "image", source: { data: "never-import-image-bytes" } },
          ],
          clientMessageId: "one",
        },
      },
      {
        id: "tool",
        type: "tool_result",
        data: { authorization: "Bearer concealed", result: "tool evidence" },
      },
      {
        id: "receipt",
        type: "run_result",
        data: {
          clientMessageId: "one",
          result: { sessionId: "session-1", text: "historical wrong output" },
        },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + '\n{"torn":',
  );
  const bundle = await previewOptimizationLabEvidence(s.cwd, ["session:session-1:receipt"], s);
  const text = JSON.stringify(bundle);
  for (const excluded of [
    "unselected private",
    "unselected output",
    "current-not-historical",
    "never-import-image-bytes",
    "concealed",
    "abcdefghijklmnopqrstuv",
  ])
    expect(text).not.toContain(excluded);
  expect(text).toContain("historical wrong output");
  expect(bundle.runs[0]!.truncated).toBe(true);
  expect(bundle.runs[0]!.historicalConfiguration).toBe("unavailable");
  expect(bundle.runs[0]!.blocks.some((block) => block.kind === "attachment")).toBe(true);
});
test("foreign project is refused before its trace and symlink sources never open", async () => {
  const s = await setup();
  const dir = join(s.sessionsDir, "foreign");
  await mkdir(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify({ cwd: s.other }));
  // No transcript exists: project denial must occur first.
  await expect(
    previewOptimizationLabEvidence(s.cwd, ["session:foreign:receipt"], s),
  ).rejects.toThrow("outside");
  await symlink(dir, join(s.sessionsDir, "linked"));
  await expect(
    previewOptimizationLabEvidence(s.cwd, ["session:linked:receipt"], s),
  ).rejects.toThrow("Unsafe");
  await expect(previewOptimizationLabEvidence(s.cwd, ["../foreign"], s)).rejects.toThrow("Invalid");
  await expect(previewOptimizationLabEvidence(s.cwd, ["foreign", "foreign"], s)).rejects.toThrow(
    "distinct",
  );
});
test("legacy run without trace stays a bounded problem source, not a replay", async () => {
  const s = await setup();
  const dir = join(s.runsDir, "legacy");
  await mkdir(dir);
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      cwd: s.cwd,
      objective: "selected task",
      summary: "old answer",
      model: "current",
    }),
  );
  const bundle = await previewOptimizationLabEvidence(s.cwd, ["legacy"], s);
  expect(bundle.runs[0]!.missingEvidence.join(" ")).toContain("trace unavailable");
  expect(JSON.stringify(bundle)).not.toContain('"current"');
});
test("metadata-only and missing messages never manufacture an input; interleaved submissions stay private", async () => {
  const s = await setup();
  const dir = join(s.sessionsDir, "metadata");
  await mkdir(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify({ cwd: s.cwd }));
  const rows = [
    { id: "input", type: "message", data: { role: "user", content: [], clientMessageId: "one" } },
    {
      id: "diagnostic",
      type: "llm_request",
      data: { contentRecorded: false, model: "metadata-model" },
    },
    {
      id: "other",
      type: "message",
      data: {
        role: "user",
        content: "unselected concurrent private data",
        clientMessageId: "two",
        steerId: "not-a-receipt-binding",
      },
    },
    { id: "tool", type: "tool_result", data: { text: "ambiguous private tool result" } },
    {
      id: "receipt",
      type: "run_result",
      data: { clientMessageId: "one", result: { sessionId: "metadata", text: "old answer" } },
    },
  ];
  await writeFile(
    join(dir, "transcript.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const bundle = await previewOptimizationLabEvidence(s.cwd, ["session:metadata:receipt"], s);
  expect(bundle.runs[0]!.blocks.some((block) => block.kind === "input")).toBe(false);
  expect(bundle.runs[0]!.missingEvidence.join(" ")).toContain("metadata-only");
  expect(bundle.runs[0]!.missingEvidence.join(" ")).toContain("messages are missing");
  expect(JSON.stringify(bundle)).not.toContain("unselected concurrent private data");
  expect(JSON.stringify(bundle)).not.toContain("ambiguous private tool result");
});
