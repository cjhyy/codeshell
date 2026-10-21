import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const denied = () => {
  throw new Error("Identity migration fixture forbids network");
};
const network = [
  [globalThis, "fetch"],
  [http, "get"],
  [http, "request"],
  [https, "get"],
  [https, "request"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
  [tls, "connect"],
] as const;
const originals = network.map(([target, key]) => ({
  target: target as any,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
for (const { target, key } of originals) target[key] = denied;
syncBuiltinESMExports();
afterAll(() => {
  for (const { target, key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  syncBuiltinESMExports();
});

const { migrateOutputJournalIdentity } = await import("./output-journal-identity-migration.js");
const { SessionOutputJournal, readOutputJournal } = await import("./output-journal.js");
const { SessionOutputCoverageStore } = await import("./output-coverage-state.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture(incomplete = true, unpaired = false) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "codeshell-identity-migration-")));
  roots.push(parent);
  const root = join(parent, "sessions"),
    id = "legacy-session",
    directory = join(root, id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transcript = Buffer.from(
    JSON.stringify({ id: "meta", type: "session_meta", timestamp: 1, data: { sessionId: id } }) +
      "\n" +
      JSON.stringify({
        id: "failed-run",
        type: "message",
        timestamp: 2,
        data: { role: "user", content: "保留聊天🙂", clientMessageId: "failed-input" },
      }) +
      "\n",
  );
  fs.writeFileSync(join(directory, "transcript.jsonl"), transcript, { mode: 0o600 });
  const anchor = join(directory, "output-journal.jsonl"),
    headPath = join(directory, "output-journal-head.json");
  fs.writeFileSync(anchor, "", { mode: 0o600 });
  fs.writeFileSync(headPath, "", { mode: 0o600 });
  const oldDev = fs.statSync(directory).dev + 19;
  const header = {
    version: 1,
    durableHead: 1,
    storageScope: hash(root),
    sessionIncarnation: "incarnation",
    journalId: "journal",
    sessionId: id,
    startedAt: 1,
    legacyBaseThroughEventId: "meta",
  };
  const headerText = JSON.stringify(header),
    seed = hash(headerText + "\n");
  const identity = hash(
    `${hash(root)}\n${headerText}\n${oldDev}:${fs.statSync(directory).ino}\n${oldDev}:${fs.statSync(anchor).ino}`,
  );
  const coverageIdentity = hash(`${root}\n${id}\n${oldDev}:${fs.statSync(directory).ino}\n1`);
  let sequence = 0,
    offset = Buffer.byteLength(headerText + "\n"),
    previousHash = seed;
  const lines = [headerText];
  const cursors: string[] = [];
  for (const event of [
    { type: "session_user_message", clientMessageId: "prior-input", text: "hello" },
    { type: "text_delta", text: "历史回答🙂" },
    { type: "turn_complete", reason: "completed" },
  ]) {
    const value = {
      version: 2,
      sequence: ++sequence,
      run: { id: "fixture-run" },
      event,
      previousHash,
    };
    previousHash = hash(JSON.stringify(value));
    const line = JSON.stringify({ ...value, hash: previousHash });
    lines.push(line);
    offset += Buffer.byteLength(line + "\n");
    cursors.push(
      Buffer.from(JSON.stringify({ identity, sequence, offset, hash: previousHash })).toString(
        "base64url",
      ),
    );
  }
  fs.writeFileSync(anchor, lines.join("\n") + "\n");
  const head = { version: 1, identity, sequence, offset, hash: previousHash };
  const data = Buffer.alloc(4096, 0x20);
  Buffer.from(JSON.stringify({ head, sha256: hash(JSON.stringify(head)) })).copy(data);
  fs.writeFileSync(headPath, data);
  const state = {
    sessionId: id,
    startedAt: 1,
    runId: "fixture-run",
    status: "model_error",
    outputRecoveryIncomplete: incomplete,
    outputJournalIdentity: seed,
    outputJournalHead: {
      version: 2,
      identity,
      sequence: 0,
      offset: Buffer.byteLength(headerText + "\n"),
      hash: seed,
      file: { dev: oldDev, ino: fs.statSync(headPath).ino },
    },
    outputCoverageIdentity: coverageIdentity,
    outputCoverage: {
      version: 1,
      incarnation: coverageIdentity,
      journalIdentity: seed,
      unpaired,
      inputIds: [],
      lastInputId: "prior-input",
    },
  };
  const statePath = join(directory, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state) + "\n", { mode: 0o600 });
  fs.mkdirSync(join(directory, "attachments"), { mode: 0o700 });
  fs.writeFileSync(join(directory, "attachments", "retained.txt"), "原有附件", { mode: 0o600 });
  return {
    parent,
    root,
    id,
    directory,
    anchor,
    headPath,
    statePath,
    transcript,
    headBytes: data,
    anchorBytes: fs.readFileSync(anchor),
    evidence: join(parent, "evidence"),
    identity,
    coverageIdentity,
    cursors,
  };
}
const options = { acceptLegacyIdentity: true, resumeWithRecordedGap: true };
function state(f: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(f.statePath, "utf8"));
}
function expectPreserved(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(f.anchor)).toEqual(f.anchorBytes);
  expect(fs.readFileSync(f.headPath)).toEqual(f.headBytes);
  expect(fs.readFileSync(join(f.directory, "transcript.jsonl"))).toEqual(f.transcript);
  expect(fs.readFileSync(join(f.directory, "attachments", "retained.txt"), "utf8")).toBe(
    "原有附件",
  );
}

test("explicit re-admission preserves chats, old cursors and known gaps while allowing future output", () => {
  const f = fixture(true, true);
  expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
  const result = migrateOutputJournalIdentity(f.root, f.id, f.evidence, options);
  expect(result).toMatchObject({
    status: "migrated",
    journalIdentity: f.identity,
    coverageIdentity: f.coverageIdentity,
    historicalGap: true,
    transcriptSha256: hash(f.transcript),
  });
  expectPreserved(f);
  const current = state(f);
  expect(current.outputRecoveryIncomplete).toBe(false);
  expect(current.outputJournalHead.version).toBe(3);
  expect(current.outputJournalBinding.journalIdentity).toBe(f.identity);
  expect(current.outputCoverage.unpaired).toBe(true);
  expect(current.outputIdentityRecovery.previousOutputRecoveryIncomplete).toBe(true);
  const page = readOutputJournal(f.root, f.id, { after: f.cursors[0] });
  expect(page.status).toBe("ok");
  expect(page.complete).toBe(true);
  expect(page.frames.map((frame) => frame.event?.type)).toEqual(["text_delta", "turn_complete"]);
  expect(new SessionOutputCoverageStore(() => f.root).read(f.id)).toMatchObject({
    status: "ok",
    unpaired: true,
    incarnation: f.coverageIdentity,
  });
  const writer = new SessionOutputJournal(f.root, f.id, "fixture-run");
  writer.append({ type: "text_delta", text: "新的输出" });
  expect(readOutputJournal(f.root, f.id, { after: f.cursors[2] }).frames[0]?.event).toMatchObject({
    text: "新的输出",
  });
  expect(fs.readFileSync(join(f.directory, "transcript.jsonl"))).toEqual(f.transcript);
});

test("healthy legacy migration does not manufacture a historical gap", () => {
  const f = fixture(false, false);
  const result = migrateOutputJournalIdentity(f.root, f.id, f.evidence, {
    acceptLegacyIdentity: true,
  });
  expect(result.historicalGap).toBe(false);
  expect(state(f).outputCoverage.unpaired).toBe(false);
  expectPreserved(f);
});

test("legacy re-admission and resuming an incomplete Session each require explicit acceptance", () => {
  const f = fixture();
  const original = fs.readFileSync(f.statePath);
  expect(() =>
    migrateOutputJournalIdentity(f.root, f.id, f.evidence, { acceptLegacyIdentity: false }),
  ).toThrow("--accept-legacy-identity");
  expect(() =>
    migrateOutputJournalIdentity(f.root, f.id, f.evidence, { acceptLegacyIdentity: true }),
  ).toThrow("--resume-with-recorded-gap");
  expect(fs.readFileSync(f.statePath)).toEqual(original);
  expect(fs.existsSync(f.evidence)).toBe(false);
  expectPreserved(f);
});

for (const phase of [
  "evidence-durable",
  "barrier-durable",
  "state-durable",
  "consumer-verified",
] as const)
  test(`migration retries the same evidence after interruption at ${phase}`, () => {
    const f = fixture();
    expect(() =>
      migrateOutputJournalIdentity(f.root, f.id, f.evidence, {
        ...options,
        onCheckpoint: (at) => {
          if (at === phase) throw new Error("simulated interruption");
        },
      }),
    ).toThrow("simulated interruption");
    expectPreserved(f);
    if (phase !== "evidence-durable")
      expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
    const result = migrateOutputJournalIdentity(f.root, f.id, f.evidence, options);
    expect(result.status).toBe(
      ["state-durable", "consumer-verified"].includes(phase) ? "already_migrated" : "migrated",
    );
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
    expect(fs.existsSync(join(f.directory, "output-journal-repair-pending.json"))).toBe(false);
    expect(migrateOutputJournalIdentity(f.root, f.id, f.evidence, options).status).toBe(
      "already_migrated",
    );
    expectPreserved(f);
  });

test("identity migration refuses changed output and inode replacement without modifying state", () => {
  for (const damage of ["chain", "head-inode"] as const) {
    const f = fixture();
    const originalState = fs.readFileSync(f.statePath);
    if (damage === "chain") {
      const data = fs.readFileSync(f.anchor);
      const at = data.indexOf(Buffer.from("历史回答"));
      data[at] ^= 1;
      fs.writeFileSync(f.anchor, data);
    } else {
      const data = fs.readFileSync(f.headPath);
      fs.unlinkSync(f.headPath);
      fs.writeFileSync(f.headPath, data, { mode: 0o600 });
    }
    expect(() => migrateOutputJournalIdentity(f.root, f.id, f.evidence, options)).toThrow();
    expect(fs.readFileSync(f.statePath)).toEqual(originalState);
    expect(fs.existsSync(join(f.directory, "output-journal-repair-pending.json"))).toBe(false);
  }
});

test("identity migration refuses a checksummed chain ending in an unfinished fragment group", () => {
  const f = fixture();
  const lines = fs.readFileSync(f.anchor, "utf8").trimEnd().split("\n");
  const value = {
    version: 2,
    sequence: 3,
    run: { id: "fixture-run" },
    fragment: {
      id: "unfinished",
      index: 0,
      total: 2,
      data: Buffer.from("partial event").toString("base64"),
    },
    previousHash: JSON.parse(lines[2]!).hash,
  };
  const finalHash = hash(JSON.stringify(value));
  lines[3] = JSON.stringify({ ...value, hash: finalHash });
  const journal = Buffer.from(lines.join("\n") + "\n");
  fs.writeFileSync(f.anchor, journal);
  const head = {
    ...JSON.parse(fs.readFileSync(f.headPath, "utf8")).head,
    offset: journal.length,
    hash: finalHash,
  };
  const block = Buffer.alloc(4096, 0x20);
  Buffer.from(JSON.stringify({ head, sha256: hash(JSON.stringify(head)) })).copy(block);
  fs.writeFileSync(f.headPath, block);
  const originalState = fs.readFileSync(f.statePath);
  expect(() => migrateOutputJournalIdentity(f.root, f.id, f.evidence, options)).toThrow(
    "complete event boundary",
  );
  expect(fs.readFileSync(f.statePath)).toEqual(originalState);
  expect(fs.readFileSync(f.anchor)).toEqual(journal);
  expect(fs.existsSync(f.evidence)).toBe(false);
});

test("an unrelated pending repair cannot be adopted by identity re-admission", () => {
  const f = fixture();
  fs.writeFileSync(join(f.directory, "output-journal-repair-pending.json"), "unrelated repair", {
    mode: 0o600,
  });
  expect(() => migrateOutputJournalIdentity(f.root, f.id, f.evidence, options)).toThrow(
    "different repair",
  );
  expect(state(f).outputRecoveryIncomplete).toBe(true);
  expect(fs.existsSync(f.evidence)).toBe(false);
});

test("a changed source after durable evidence remains fenced and cannot be retried into success", () => {
  const f = fixture();
  expect(() =>
    migrateOutputJournalIdentity(f.root, f.id, f.evidence, {
      ...options,
      onCheckpoint: (phase) => {
        if (phase === "barrier-durable") fs.appendFileSync(f.anchor, "lost bytes");
      },
    }),
  ).toThrow();
  expect(fs.existsSync(join(f.directory, "output-journal-repair-pending.json"))).toBe(true);
  expect(() => migrateOutputJournalIdentity(f.root, f.id, f.evidence, options)).toThrow();
  expect(state(f).outputRecoveryIncomplete).toBe(true);
});

test("copied migration evidence cannot re-admit a copied Session or a different store", () => {
  const f = fixture();
  migrateOutputJournalIdentity(f.root, f.id, f.evidence, options);
  const other = join(f.parent, "other-sessions");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.cpSync(f.directory, join(other, f.id), { recursive: true });
  expect(() => migrateOutputJournalIdentity(other, f.id, f.evidence, options)).toThrow(
    "different operation",
  );
  expect(readOutputJournal(other, f.id).status).not.toBe("ok");
});

test("the offline CLI requires its exact flags and migrates without a provider environment", () => {
  const f = fixture();
  const cli = fileURLToPath(new URL("../cli/output-journal-repair.ts", import.meta.url));
  const run = (extra: string[]) =>
    spawnSync(process.execPath, [cli, "migrate-identity", f.root, f.id, f.evidence, ...extra], {
      cwd: f.parent,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: f.parent,
        CODE_SHELL_HOME: join(f.parent, "unused-app-home"),
      },
    });
  const rejected = run(["--accept-legacy-identity", "--force"]);
  expect(rejected.status).toBe(1);
  expect(fs.existsSync(f.evidence)).toBe(false);
  const result = run(["--accept-legacy-identity", "--resume-with-recorded-gap"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "migrated", historicalGap: true });
  expect(fs.existsSync(join(f.parent, "unused-app-home"))).toBe(false);
  expectPreserved(f);
});

test("evidence inside the Session store and symbolic-link inventory entries are refused", () => {
  const f = fixture();
  const originalState = fs.readFileSync(f.statePath);
  expect(() =>
    migrateOutputJournalIdentity(f.root, f.id, join(f.root, "evidence"), options),
  ).toThrow("outside the Session store");
  fs.symlinkSync(f.anchor, join(f.directory, "unexpected-alias"));
  expect(() => migrateOutputJournalIdentity(f.root, f.id, f.evidence, options)).toThrow(
    "symbolic link",
  );
  expect(fs.readFileSync(f.statePath)).toEqual(originalState);
  expect(fs.existsSync(f.evidence)).toBe(false);
});
