/** Fixture-only storage spike. This module is deliberately absent from every package export. */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { SessionState } from "../../types.js";

export const STATE_LIMIT = 1024 * 1024;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const HEX = /^[a-f0-9]{64}$/;
export const EVENT_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const hex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);
const eventId = (value: unknown): value is string =>
  typeof value === "string" && EVENT_ID.test(value);
export type RawObject = Record<string, unknown>;
export type Position = { sequence: number; offset: number; hash: string };
export type Format = {
  version: 2;
  epoch: string;
  phase: "active";
  transitionId: string;
  v1Through: string;
  headerPin: string;
};
export type Control = {
  effectDigest: string;
  lastCommitted?: { txId: string; eventId: string; revision: number; effectDigest: string };
  pending?: {
    txId: string;
    eventId: string;
    begin: string;
    beforeRevision: number;
    afterRevision: number;
    beforeEffect: string;
    afterEffect: string;
    projectionDigest: string;
  };
};
export type DecodedState = { state: SessionState; format?: Format; control?: Control };

export class StorageFailure extends Error {
  constructor(
    readonly reason: "incomplete" | "unsupported" | "conflict" | "capacity" | "busy",
    message: string,
  ) {
    super(message);
  }
}
export function fail(message: string): never {
  throw new StorageFailure("incomplete", message);
}
export function object(value: unknown): value is RawObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function keys(value: RawObject, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    fail("Unknown or missing protected field");
}
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Pure CPU steps shared by synchronous verification and the yielding async driver. */
export function* parseJSONSteps(text: string, maxBytes = STATE_LIMIT): Generator<void, unknown> {
  if (Buffer.byteLength(text) > maxBytes) throw new StorageFailure("capacity", "JSON byte bound");
  let at = 0;
  let checkpoint = 0;
  function* tick(): Generator<void> {
    if (at - checkpoint >= 16_384) {
      checkpoint = at;
      yield;
    }
  }
  function* whitespace(): Generator<void> {
    while (at < text.length && /[ \t\n\r]/.test(text[at])) {
      at++;
      yield* tick();
    }
  }
  function* string(): Generator<void, string> {
    if (text[at++] !== '"') fail("Invalid JSON string");
    let start = at;
    const chunks: string[] = [];
    while (at < text.length) {
      if (text[at] === '"') {
        chunks.push(JSON.parse('"' + text.slice(start, at) + '"'));
        at++;
        return chunks.join("");
      }
      if (text[at] === "\\") {
        at++;
        if (text[at] === "u") at += 5;
        else at++;
      } else at++;
      if (at - start >= 16_384) {
        chunks.push(JSON.parse('"' + text.slice(start, at) + '"'));
        start = at;
        yield* tick();
      }
    }
    return fail("Unterminated JSON string");
  }
  function* value(depth: number): Generator<void, unknown> {
    if (depth > 128) fail("JSON depth bound");
    yield* whitespace();
    yield* tick();
    const first = text[at];
    if (first === '"') return yield* string();
    if (first === "{" || first === "[") {
      at++;
      const array = first === "[";
      const output: unknown[] | RawObject = array ? [] : {};
      const end = array ? "]" : "}";
      const seen = new Set<string>();
      yield* whitespace();
      if (text[at] === end) {
        at++;
        return output;
      }
      for (;;) {
        let key: string | undefined;
        if (!array) {
          yield* whitespace();
          key = yield* string();
          if (seen.has(key)) fail("Duplicate JSON key");
          seen.add(key);
          yield* whitespace();
          if (text[at++] !== ":") fail("Invalid JSON object");
        }
        const item = yield* value(depth + 1);
        if (array) (output as unknown[]).push(item);
        else
          Object.defineProperty(output, key!, {
            value: item,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        yield* whitespace();
        if (text[at] === end) {
          at++;
          return output;
        }
        if (text[at++] !== ",") fail("Invalid JSON separator");
      }
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return parsed;
      }
    }
    const start = at;
    while (at < text.length && /[0-9eE+.-]/.test(text[at])) {
      at++;
      yield* tick();
    }
    const spelling = text.slice(start, at);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(spelling)) fail("Invalid JSON value");
    const parsed = Number(spelling);
    if (!Number.isFinite(parsed)) fail("Nonfinite JSON number");
    return parsed;
  }
  const parsed = yield* value(0);
  yield* whitespace();
  if (at !== text.length) fail("Trailing JSON data");
  return parsed;
}

/** Reject duplicate keys without discarding evidence; sync and async use identical grammar. */
export function parseUnique(text: string, maxBytes = STATE_LIMIT): unknown {
  const steps = parseJSONSteps(text, maxBytes);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

function assertDataObject(value: object): void {
  if (utilTypes.isProxy(value)) fail("Proxy is not strict JSON");
  if (Object.getOwnPropertySymbols(value).length) fail("Symbol is not strict JSON");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (descriptor.get || descriptor.set) fail("Accessor is not strict JSON");
}
function denseArray(value: unknown[]): void {
  if (Object.keys(value).length !== value.length) fail("Sparse or decorated JSON array");
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail("Sparse JSON array");
}

function* canonicalString(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + 8192);
    // Never stringify a surrogate pair as two lone escaped surrogates at a slice boundary.
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(value[end])
    )
      end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

/** Canonical chunks share strict own-data validation and byte semantics with the sync codec. */
export function* canonicalSteps(value: unknown, depth = 0): Generator<string> {
  if (depth > 128) fail("Canonical depth bound");
  if (value !== null && typeof value === "object") assertDataObject(value);
  if (typeof value === "string") {
    yield* canonicalString(value);
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    yield JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    denseArray(value);
    yield "[";
    for (let i = 0; i < value.length; i++) {
      if (i) yield ",";
      yield* canonicalSteps(value[i], depth + 1);
    }
    yield "]";
    return;
  }
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    yield "{";
    let comma = false;
    for (const key of Object.keys(value).sort()) {
      if (comma) yield ",";
      comma = true;
      yield* canonicalString(key);
      yield ":";
      yield* canonicalSteps(value[key], depth + 1);
    }
    yield "}";
    return;
  }
  return fail("Non-JSON canonical value");
}

/** Old records retain their original JSON.stringify hashing; v2 canonical bytes are unchanged. */
export function canonical(value: unknown, depth = 0): string {
  return [...canonicalSteps(value, depth)].join("");
}

export function goalEffect(state: SessionState): string {
  return digest(canonical((state as unknown as RawObject).goalLifecycle ?? null));
}
function validateControl(raw: unknown): Control {
  if (!object(raw)) fail("Missing control proof");
  keys(raw, ["effectDigest"], ["lastCommitted", "pending"]);
  if (!hex(raw.effectDigest)) fail("Invalid control effect");
  if (raw.lastCommitted !== undefined) {
    if (!object(raw.lastCommitted)) fail("Invalid last control proof");
    keys(raw.lastCommitted, ["txId", "eventId", "revision", "effectDigest"]);
    if (
      !uuid(raw.lastCommitted.txId) ||
      !eventId(raw.lastCommitted.eventId) ||
      !integer(raw.lastCommitted.revision) ||
      !hex(raw.lastCommitted.effectDigest)
    )
      fail("Invalid last control proof");
  }
  if (raw.pending !== undefined) {
    if (!object(raw.pending)) fail("Invalid pending proof");
    keys(raw.pending, [
      "txId",
      "eventId",
      "begin",
      "beforeRevision",
      "afterRevision",
      "beforeEffect",
      "afterEffect",
      "projectionDigest",
    ]);
    if (
      !uuid(raw.pending.txId) ||
      !eventId(raw.pending.eventId) ||
      typeof raw.pending.begin !== "string" ||
      !integer(raw.pending.beforeRevision) ||
      raw.pending.afterRevision !== raw.pending.beforeRevision + 1 ||
      ![raw.pending.beforeEffect, raw.pending.afterEffect, raw.pending.projectionDigest].every(hex)
    )
      fail("Invalid pending proof");
  }
  return raw as unknown as Control;
}
export function decodeState(text: string): DecodedState {
  const raw = parseUnique(text);
  if (
    !object(raw) ||
    typeof raw.sessionId !== "string" ||
    typeof raw.startedAt !== "number" ||
    !Number.isFinite(raw.startedAt)
  )
    fail("Invalid Session identity");
  if (!object(raw.stateRevision)) {
    if (raw.stateRevision !== undefined && !integer(raw.stateRevision))
      fail("Invalid legacy revision");
    if (raw.outputJournalFormat !== undefined || raw.outputControl !== undefined)
      fail("Lost versioned revision");
    return { state: raw as unknown as SessionState };
  }
  keys(raw.stateRevision, ["version", "epoch", "value"]);
  if (raw.stateRevision.version !== 2)
    throw new StorageFailure("unsupported", "Unknown raw revision version");
  if (!uuid(raw.stateRevision.epoch) || !integer(raw.stateRevision.value))
    fail("Invalid versioned revision");
  const format = raw.outputJournalFormat;
  if (!object(format)) fail("Missing format proof");
  keys(format, ["version", "epoch", "phase", "transitionId", "v1Through", "headerPin"]);
  if (
    format.version !== 2 ||
    format.epoch !== raw.stateRevision.epoch ||
    format.phase !== "active" ||
    !uuid(format.transitionId) ||
    typeof format.v1Through !== "string" ||
    !hex(format.headerPin) ||
    raw.outputJournalIdentity !== format.headerPin
  )
    fail("Invalid format proof");
  const control = validateControl(raw.outputControl);
  const { outputJournalFormat: _format, outputControl: _control, ...state } = raw;
  state.stateRevision = raw.stateRevision.value;
  return { state: state as unknown as SessionState, format: format as unknown as Format, control };
}
export function encodeState(decoded: DecodedState): string {
  const state = stateJSON(decoded.state) as RawObject;
  delete state.outputJournalFormat;
  delete state.outputControl;
  if (decoded.format) {
    state.stateRevision = {
      version: 2,
      epoch: decoded.format.epoch,
      value: decoded.state.stateRevision,
    };
    state.outputJournalFormat = decoded.format;
    state.outputControl = decoded.control;
  }
  // Omit legal optional object fields without normalizing NaN/Infinity to null.
  const text = canonical(stateJSON(state)) + "\n";
  decodeState(text);
  return text;
}

function stateJSON(value: unknown, depth = 0): unknown {
  if (depth > 128) fail("State depth bound");
  if (value !== null && typeof value === "object") assertDataObject(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    denseArray(value);
    return value.map((item) => stateJSON(item, depth + 1));
  }
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stateJSON(item, depth + 1)]),
    );
  }
  return fail("Non-JSON state value");
}

/** All filesystem entry points use fatal decoding before parsing any state fields. */
export function decodeStateBytes(bytes: Uint8Array): DecodedState {
  if (bytes.byteLength > STATE_LIMIT) throw new StorageFailure("capacity", "State byte bound");
  return decodeState(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}
