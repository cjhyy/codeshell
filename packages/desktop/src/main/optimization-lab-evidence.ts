import { constants, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import {
  buildEvidenceBundle,
  type EvidenceBundle,
  type EvidenceSourceRun,
} from "@cjhyy/code-shell-capability-optimization-lab";
import { createHash } from "node:crypto";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
async function evidenceSource(root: string, dir: string) {
  const held: Array<{
    path: string;
    handle: Awaited<ReturnType<typeof fs.open>>;
    identity: string;
    canonical: string;
  }> = [];
  const identity = (info: { dev: number | bigint; ino: number | bigint }) =>
    `${info.dev}:${info.ino}`;
  const check = async () => {
    for (const entry of held) {
      const current = await fs.lstat(entry.path, { bigint: true });
      const opened = await entry.handle.stat({ bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !opened.isDirectory() ||
        identity(current) !== entry.identity ||
        identity(opened) !== entry.identity ||
        (await fs.realpath(entry.path)) !== entry.canonical
      )
        throw new Error("Evidence source directory changed");
    }
  };
  try {
    for (const path of [root, dir]) {
      await check();
      const prior = await fs.lstat(path, { bigint: true });
      if (!prior.isDirectory() || prior.isSymbolicLink())
        throw new Error("Unsafe evidence directory");
      const canonical = await fs.realpath(path);
      const handle = await fs.open(
        path,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      held.push({ path, handle, identity: identity(prior), canonical });
      await check();
    }
    if (held[1]!.canonical !== join(held[0]!.canonical, basename(dir)))
      throw new Error("Evidence source directory escaped its root");
    return {
      async read(name: string, tail = false) {
        await check();
        const result = await readSource(join(dir, name), tail);
        await check();
        return result;
      },
      async close() {
        for (const entry of held.reverse()) await entry.handle.close();
      },
    };
  } catch (error) {
    for (const entry of held.reverse()) await entry.handle.close();
    throw error;
  }
}

/** Selected source only. Stable inode, no symlink following, bounded tail and explicit loss. */
async function readSource(
  path: string,
  tail = false,
): Promise<{ text: string; truncated: boolean; identity: string }> {
  const prior = await fs.lstat(path, { bigint: true });
  if (
    !prior.isFile() ||
    prior.isSymbolicLink() ||
    prior.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (!tail && prior.size > BigInt(MAX_SOURCE_BYTES))
  )
    throw new Error("Unsafe or oversized evidence file");
  const file = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const same = (info: typeof prior) =>
      info.isFile() &&
      info.dev === prior.dev &&
      info.ino === prior.ino &&
      info.size === prior.size &&
      info.mtimeNs === prior.mtimeNs &&
      info.ctimeNs === prior.ctimeNs;
    if (!same(await file.stat({ bigint: true }))) throw new Error("Evidence changed while opening");
    const length = Number(
      prior.size > BigInt(MAX_SOURCE_BYTES) ? BigInt(MAX_SOURCE_BYTES) : prior.size,
    );
    const start = Number(prior.size) - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(buffer, read, length - read, start + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (
      read !== length ||
      !same(await file.stat({ bigint: true })) ||
      !same(await fs.lstat(path, { bigint: true }))
    )
      throw new Error("Evidence changed while reading");
    let bytes = buffer;
    let truncated = start > 0;
    if (start > 0) {
      const boundary = bytes.indexOf(10);
      bytes = boundary < 0 ? Buffer.alloc(0) : bytes.subarray(boundary + 1);
    }
    if (tail && bytes.length && bytes.at(-1) !== 10) {
      const boundary = bytes.lastIndexOf(10);
      bytes = boundary < 0 ? Buffer.alloc(0) : bytes.subarray(0, boundary + 1);
      truncated = true;
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      truncated,
      identity: `${prior.dev}:${prior.ino}:${prior.size}:${prior.mtimeNs}:${prior.ctimeNs}`,
    };
  } finally {
    await file.close();
  }
}

function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => object(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
function attachmentRefs(value: unknown): boolean {
  return Array.isArray(value) && value.some((block) => object(block) && block.type !== "text");
}
function events(raw: string): { rows: Record<string, any>[]; invalid: boolean } {
  const rows: Record<string, any>[] = [];
  let invalid = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!object(row)) throw new Error();
      rows.push(row);
    } catch {
      invalid = true;
    }
  }
  return { rows, invalid };
}
async function projectMatches(source: unknown, cwd: string): Promise<void> {
  if (typeof source !== "string" || (await fs.realpath(source)) !== (await fs.realpath(cwd)))
    throw new Error("Selected evidence is outside the current project");
}

/** Never resolves artifact/attachment paths or treats current state.model as a request snapshot. */
export async function previewOptimizationLabEvidence(
  cwd: string,
  runIds: string[],
  storage: { sessionsDir?: string; runsDir?: string } = {},
): Promise<EvidenceBundle> {
  if (
    !Array.isArray(runIds) ||
    runIds.length < 1 ||
    runIds.length > 20 ||
    new Set(runIds).size !== runIds.length
  )
    throw new Error("Select between 1 and 20 distinct run IDs");
  const sources: EvidenceSourceRun[] = [];
  for (const runId of runIds) {
    if (typeof runId !== "string") throw new Error("Invalid evidence run ID");
    const source: EvidenceSourceRun = {
      runId,
      sessionId: null,
      source: "managed_run",
      blocks: [],
      missingEvidence: [],
      truncated: false,
    };
    if (runId.startsWith("session:")) {
      const parts = runId.split(":");
      if (parts.length !== 3 || !safeId(parts[1]) || !safeId(parts[2]))
        throw new Error("Invalid evidence session receipt ID");
      const [, sessionId, receiptId] = parts;
      const root = storage.sessionsDir ?? sessionsRoot();
      const dir = join(root, sessionId);
      const fence = await evidenceSource(root, dir);
      try {
        const before = await fence.read("state.json");
        const state = JSON.parse(before.text);
        if (
          !object(state) ||
          state.ephemeral ||
          (state.kind !== undefined && state.kind !== "work") ||
          state.parentSessionId ||
          ["subagent", "pet"].includes(state.origin) ||
          /^(?:qchat-|pet-|panel-task-|\.pending-fork-)/.test(sessionId)
        )
          throw new Error("Unavailable evidence session");
        // Check project before opening transcript, even for an explicitly supplied foreign ID.
        await projectMatches(state.cwd, cwd);
        const raw = await fence.read("transcript.jsonl", true);
        const parsed = events(raw.text);
        const end = parsed.rows.findIndex(
          (event) =>
            event.id === receiptId &&
            event.type === "run_result" &&
            object(event.data) &&
            object(event.data.result) &&
            event.data.result.sessionId === sessionId,
        );
        if (end < 0)
          throw new Error("Selected durable receipt is unavailable in the bounded trace");
        const receipt = parsed.rows[end];
        const messageId = receipt.data.clientMessageId;
        if (typeof messageId !== "string" || !messageId || messageId.length > 512)
          throw new Error("Selected receipt has no durable input binding");
        let start = -1;
        for (let index = end - 1; index >= 0; index--) {
          const event = parsed.rows[index]!;
          if (
            event.type === "message" &&
            event.data?.role === "user" &&
            event.data?.clientMessageId === messageId
          ) {
            start = index;
            break;
          }
        }
        source.source = "session_receipt";
        source.sessionId = sessionId;
        source.truncated = raw.truncated || parsed.invalid || end - start > 200;
        if (start < 0)
          source.missingEvidence.push("Original user input is unavailable in the bounded trace.");
        const selected =
          start < 0 ? [receipt] : parsed.rows.slice(Math.max(start, end - 199), end + 1);
        const interleaved = selected.some(
          (event) =>
            event.type === "message" &&
            event.data?.role === "user" &&
            event.data?.clientMessageId !== messageId,
        );
        if (interleaved)
          source.missingEvidence.push(
            "Interleaved submissions lack exact tool/run bindings; their content and ambiguous tool events were omitted.",
          );
        for (const event of selected) {
          const data = object(event.data) ? event.data : {};
          if (data.contentRecorded === false)
            source.missingEvidence.push(
              "Model diagnostic content was not recorded (metadata-only).",
            );
          const eventId = typeof event.id === "string" ? event.id.slice(0, 512) : null;
          if (event.type === "message" && data.role === "user") {
            if (data.injected || data.clientMessageId !== messageId) continue;
            const text = content(data.content);
            if (text)
              source.blocks.push({
                kind: event === parsed.rows[start] ? "input" : "correction",
                eventId,
                text,
              });
            if (attachmentRefs(data.content))
              source.blocks.push({
                kind: "attachment",
                eventId,
                text: "Non-text attachment referenced by this event; bytes were not read or imported.",
              });
          } else if (!interleaved && /tool/.test(event.type))
            source.blocks.push({ kind: "tool", eventId, text: JSON.stringify(data) });
        }
        if (typeof receipt.data.result.text === "string")
          source.blocks.push({
            kind: "output",
            eventId: receiptId,
            text: receipt.data.result.text,
          });
        if (!source.blocks.some((block) => block.kind === "input"))
          source.missingEvidence.push("Original model-facing user text/messages are missing.");
        const after = await fence.read("state.json");
        if (after.identity !== before.identity || after.text !== before.text)
          throw new Error("Evidence source snapshot/project binding changed");
      } finally {
        await fence.close();
      }
    } else {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(runId) || runId.includes(".."))
        throw new Error("Invalid evidence run ID");
      const root = storage.runsDir ?? join(homedir(), ".code-shell", "runs");
      const dir = join(root, runId);
      const fence = await evidenceSource(root, dir);
      try {
        const before = await fence.read("run.json");
        const snapshot = JSON.parse(before.text);
        if (!object(snapshot)) throw new Error("Invalid evidence run snapshot");
        await projectMatches(snapshot.cwd, cwd);
        source.sessionId =
          typeof snapshot.sessionId === "string" ? snapshot.sessionId.slice(0, 512) : null;
        if (typeof snapshot.objective === "string" && snapshot.objective)
          source.blocks.push({ kind: "input", eventId: null, text: snapshot.objective });
        else source.missingEvidence.push("Run objective/input unavailable.");
        if (typeof snapshot.summary === "string")
          source.blocks.push({ kind: "output", eventId: null, text: snapshot.summary });
        else source.missingEvidence.push("Original terminal output unavailable.");
        try {
          const raw = await fence.read("events.jsonl", true);
          const parsed = events(raw.text);
          if (parsed.rows.some((event) => event.data?.contentRecorded === false))
            source.missingEvidence.push(
              "Model diagnostic content was not recorded (metadata-only).",
            );
          source.truncated = raw.truncated || parsed.invalid || parsed.rows.length > 200;
          for (const event of parsed.rows.slice(-200))
            if (/tool|correction/.test(String(event.type)))
              source.blocks.push({
                kind: /correction/.test(event.type) ? "correction" : "tool",
                eventId: typeof event.eventId === "string" ? event.eventId.slice(0, 512) : null,
                text: JSON.stringify(event.data ?? null),
              });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          source.missingEvidence.push("Run event trace unavailable.");
        }
        source.missingEvidence.push(
          "Attachments and artifact contents were not imported; only selected text evidence is available.",
        );
        const after = await fence.read("run.json");
        if (after.identity !== before.identity || after.text !== before.text)
          throw new Error("Evidence source snapshot/project binding changed");
      } finally {
        await fence.close();
      }
    }
    if (!source.blocks.some((block) => block.kind === "output"))
      source.missingEvidence.push("Original output unavailable.");
    sources.push(source);
  }
  const projectKey = createHash("sha256")
    .update(await fs.realpath(cwd))
    .digest("hex")
    .slice(0, 16);
  return buildEvidenceBundle(projectKey, sources);
}
