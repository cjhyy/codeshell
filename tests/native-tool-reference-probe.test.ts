import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMITS,
  MAX_REQUEST_USD,
  catalog,
  main,
  makeBody,
  parseArgs,
  prepareEvidence,
  runProbe,
  sendExact,
  usageEvidence,
  validateBody,
} from "../docs/todo/prompt-cache-probes-20261111/native-tool-reference-probe.mjs";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "native-tool-reference-test-"));
  dirs.push(dir);
  return dir;
}
const KEY = "synthetic-credential-never-print-this";
async function options() {
  return parseArgs([
    "--live",
    "--authorized-paid-probe",
    "--budget-usd",
    "2",
    "--max-requests",
    "8",
    "--output-dir",
    await directory(),
  ]);
}
function response(index) {
  const call =
    index === 3
      ? {
          type: "tool_use",
          id: "toolu_search",
          name: "ToolSearch",
          input: { query: "select:Synthetic17" },
        }
      : index === 4
        ? {
            type: "tool_use",
            id: "toolu_native",
            name: "Synthetic17",
            input: { tag: "native-probe" },
          }
        : undefined;
  const content = call
    ? [{ type: "thinking", thinking: "opaque synthetic", signature: "unchanged" }, call]
    : [{ type: "text", text: "DONE" }];
  return {
    type: "message",
    model: LIMITS.model,
    provider: "Anthropic",
    id: "msg_" + index,
    stop_reason: call ? "tool_use" : "end_turn",
    content,
    usage: {
      input_tokens: index === 1 ? 6000 : 3000,
      cache_read_input_tokens: index === 6 ? 3000 : 0,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
      cost: 0.01,
    },
  };
}
function fixture(transform = (_index, value) => value) {
  const requests = [];
  return {
    requests,
    loadCredential: async () => KEY,
    transport: async (request) => {
      const index = requests.length;
      requests.push(structuredClone(request));
      return {
        status: 200,
        headers: { "set-cookie": KEY },
        rawBody: JSON.stringify(transform(index, response(index))),
      };
    },
  };
}

test("default dry run neither reads credentials nor calls transport", async () => {
  const lines = [];
  const fail = () => {
    throw new Error("Forbidden in dry run");
  };
  const result = await main([], {
    loadCredential: fail,
    transport: fail,
    write: (line) => lines.push(line),
  });
  expect(result.mode).toBe("dry-run");
  expect(result.stages).toHaveLength(7);
  expect(result.conservativeReservationUsd).toBeCloseTo(1.964544);
  expect(lines.join("\n")).toContain("No credentials were read");
  const outputDir = await directory();
  await main(["--dry-run", "--output-dir", outputDir], {
    loadCredential: fail,
    transport: fail,
    write: () => {},
  });
  expect((await readdir(outputDir)).sort()).toEqual([
    "dry-run-request-templates.json",
    "plan.json",
  ]);
});

test.each([
  ["--live"],
  ["--live", "--authorized-paid-probe"],
  ["--budget-usd", "3"],
  ["--budget-usd", "0.01"],
  ["--budget-usd", "NaN"],
  ["--max-requests", "9"],
  ["--max-requests", "6"],
  ["--endpoint", "https://example.com"],
  ["--live", "--dry-run"],
  ["--live", "--live"],
])("unsafe or incomplete CLI configuration fails before live work: %j", (...args) => {
  expect(() => parseArgs(args)).toThrow();
});

test("all baseline bodies are bounded, controlled, and place the tool marker correctly", () => {
  const bodies = [catalog(false, true), catalog(false), catalog(true)].map((tools) =>
    makeBody(
      tools,
      [{ role: "user", content: "Do not call any tool. Reply READY only." }],
      "fixed",
    ),
  );
  for (const body of bodies) {
    expect(Buffer.byteLength(validateBody(body))).toBeLessThan(25_000);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.provider.only).toEqual(["anthropic"]);
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.system[0].text.split("\n")).toHaveLength(81);
  }
  expect(bodies[1].tools).toHaveLength(25);
  expect(bodies[2].tools.filter((tool) => tool.defer_loading)).toHaveLength(24);
  expect(bodies[2].tools.filter((tool) => tool.cache_control).map((tool) => tool.name)).toEqual([
    "ToolSearch",
  ]);
  expect(
    bodies
      .map(({ tools: _tools, ...rest }) => JSON.stringify(rest))
      .every((value, _, values) => value === values[0]),
  ).toBe(true);
  bodies[2].tools[1].cache_control = { type: "ephemeral" };
  expect(() => validateBody(bodies[2])).toThrow();
  expect(MAX_REQUEST_USD * 8).toBeLessThan(2);
});

test("usage totals include cache reads and writes; missing counters remain unknown", () => {
  expect(
    usageEvidence({
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
        output_tokens: 2,
      },
    }).totalInput,
  ).toBe(34);
  expect(usageEvidence({ usage: { input_tokens: 4, output_tokens: 2 } })).toMatchObject({
    totalInput: null,
    cacheRead: null,
    cacheWrite: null,
    reportedCostUsd: null,
  });
});

test("complete offline conversation preserves raw assistant blocks and writes redacted evidence", async () => {
  const config = await options();
  const mock = fixture();
  const result = await runProbe(config, mock);
  expect(result.status).toBe("passed");
  expect(mock.requests).toHaveLength(7);
  expect(result.contextEvidence.supported).toBe(true);
  expect(result.nativeCallVerified).toBe(true);
  expect(result.warmCacheVerified).toBe(true);
  expect(mock.requests[4].body.messages[1].content).toEqual(response(3).content);
  expect(mock.requests[4].body.messages[2].content[0].content).toEqual([
    { type: "tool_reference", tool_name: "Synthetic17" },
  ]);
  expect(mock.requests[5].body.messages[3].content).toEqual(response(4).content);
  expect(mock.requests[5].body).toEqual(mock.requests[6].body);
  expect(
    mock.requests
      .slice(2)
      .every(
        (item) => JSON.stringify(item.body.tools) === JSON.stringify(mock.requests[2].body.tools),
      ),
  ).toBe(true);
  for (const request of mock.requests) expect(request.endpoint).toBe(LIMITS.endpoint);
  for (const file of await readdir(config.outputDir))
    expect(await readFile(join(config.outputDir, file), "utf8")).not.toContain(KEY);
  expect((await readdir(config.outputDir)).length).toBe(16);
});

test.each(["missing-usage", "too-expensive", "wrong-provider", "truncated"])(
  "live sequence stops after first invalid response: %s",
  async (mode) => {
    const mock = fixture((_index, value) => {
      if (mode === "missing-usage") delete value.usage.cache_read_input_tokens;
      if (mode === "too-expensive") value.usage.cost = 3;
      if (mode === "wrong-provider") value.provider = "Unexpected";
      if (mode === "truncated") value.stop_reason = "max_tokens";
      return value;
    });
    const result = await runProbe(await options(), mock);
    expect(result.status).toBe("stopped");
    expect(mock.requests).toHaveLength(1);
    if (mode === "missing-usage") expect(result.records[0].usage.totalInput).toBeNull();
  },
);

test("redirect is recorded and never followed or retried", async () => {
  let calls = 0;
  const result = await runProbe(await options(), {
    loadCredential: async () => KEY,
    transport: async () => {
      calls++;
      return {
        status: 307,
        headers: { location: "https://untrusted.invalid/" },
        rawBody: "redirect " + KEY,
      };
    },
  });
  expect(calls).toBe(1);
  expect(result.status).toBe("stopped");
  expect(result.reason).toContain("HTTP 307");
  expect(() => sendExact({ endpoint: "https://untrusted.invalid/", key: KEY, body: {} })).toThrow(
    "exact URL",
  );
});

test("nonempty evidence destination is rejected before credential loading", async () => {
  const config = await options();
  await writeFile(join(config.outputDir, "keep.txt"), "pre-existing");
  let loaded = false;
  await expect(
    runProbe(config, {
      loadCredential: async () => {
        loaded = true;
        return KEY;
      },
    }),
  ).rejects.toThrow("empty");
  expect(loaded).toBe(false);
  expect(await readFile(join(config.outputDir, "keep.txt"), "utf8")).toBe("pre-existing");
  await expect(prepareEvidence("relative-path")).rejects.toThrow("absolute");
});
