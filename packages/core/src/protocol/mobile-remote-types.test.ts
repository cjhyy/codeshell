import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

test("published mobile DTOs discriminate base requests, failures and terminal pages", () => {
  const directory = mkdtempSync(join(tmpdir(), "mobile-base-types-"));
  try {
    const file = join(directory, "contract.mts");
    const entry = resolve(import.meta.dir, "../../dist/index.js").replace(/\\/g, "/");
    writeFileSync(
      file,
      `
import type { MobileClientEvent, MobileServerEvent } from ${JSON.stringify(entry)};
type Request = Extract<MobileClientEvent, {type: "session.legacyBase"}>;
type Reply = Extract<MobileServerEvent, {type: "session.legacyBase"}>;
const ids = { sessionId: "s", recoveryId: "r", requestId: "p" };
const first: Request = { type: "session.legacyBase", ...ids, throughEventId: "anchor" };
const next: Request = { type: "session.legacyBase", ...ids, cursor: "cursor" };
// @ts-expect-error both request anchors are forbidden
const both: Request = { type: "session.legacyBase", ...ids, throughEventId: "anchor", cursor: "cursor" };
// @ts-expect-error a request needs one anchor
const neither: Request = { type: "session.legacyBase", ...ids };
const failed: Reply = { type: "session.legacyBase", ...ids, ok: false, reason: "busy" };
const fields = { type: "session.legacyBase" as const, ...ids, ok: true as const, throughEventId: "anchor", index: 0, events: [] };
const terminal: Reply = { ...fields, complete: true };
const partial: Reply = { ...fields, complete: false, next: "cursor" };
// @ts-expect-error a partial reply needs its continuation
const missing: Reply = { ...fields, complete: false };
// @ts-expect-error a terminal reply cannot have a continuation
const extra: Reply = { ...fields, complete: true, next: "cursor" };
// @ts-expect-error a failed reply cannot release events
const leaked: Reply = { type: "session.legacyBase", ...ids, ok: false, reason: "incomplete", events: [] };
function consume(reply: Reply) {
  if (!reply.ok) {
    const reason: "busy" | "incomplete" = reply.reason;
    // @ts-expect-error failure has no projection offset
    reply.index;
    return reason;
  }
  const index: number = reply.index;
  if (reply.complete) { const absent: undefined = reply.next; return index; }
  const cursor: string = reply.next;
  return cursor;
}
const oldRequest: MobileClientEvent = { type: "session.select", sessionId: "s" };
const oldAuth: MobileServerEvent = { type: "auth.ok", device: { id: "d", name: "fixture", createdAt: 1 } };
`,
    );
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
