/** Host display coverage, not an output journal or a model-run permission fence. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { lockSync } from "../utils/lockfile.js";

export interface PersistedOutputCoverage {
  version: 1;
  incarnation: string;
  journalIdentity?: string;
  unpaired: boolean;
  inputIds: string[];
  /** Only the latest actual, fsync-completed journal user anchor. */
  lastInputId?: string;
}
export interface SessionOutputCoverageProof {
  status: "ok" | "unavailable" | "incomplete";
  incarnation?: string;
  journalIdentity?: string;
  unpaired: boolean;
  inputIds: string[];
}
type State = Record<string, unknown> & {
  sessionId: string;
  startedAt: number;
  outputJournalIdentity?: string;
  outputCoverageIdentity?: string;
  outputCoverage?: PersistedOutputCoverage;
};
const LIMIT = 1024 * 1024;
const hex = /^[a-f0-9]{64}$/;
const idValid = (id: unknown): id is string =>
  typeof id === "string" && !!id.trim() && id.length <= 512;
const bytes = (ids: string[]) => ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
const failed = () => new Error("Session output coverage cannot be verified");

export function outputCoverageIncarnation(
  root: string,
  sessionId: string,
  startedAt: number,
): string {
  const canonicalRoot = realpathSync(root);
  const stat = lstatSync(join(canonicalRoot, sessionId), { bigint: true });
  return createHash("sha256")
    .update(`${canonicalRoot}\n${sessionId}\n${stat.dev}:${stat.ino}\n${startedAt}`)
    .digest("hex");
}
function location(root: string, sessionId: string) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) || sessionId.includes(".."))
    throw failed();
  const canonicalRoot = realpathSync(root);
  const directory = join(canonicalRoot, sessionId);
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failed();
  const target = join(directory, "state.json");
  const fd = openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  let state: State;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(LIMIT)) throw failed();
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw failed();
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(target, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink()
    )
      throw failed();
    state = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data));
  } finally {
    closeSync(fd);
  }
  if (
    !state ||
    state.sessionId !== sessionId ||
    typeof state.startedAt !== "number" ||
    !Number.isFinite(state.startedAt)
  )
    throw failed();
  if (state.ephemeral || sessionId.startsWith("qchat-"))
    throw Object.assign(failed(), { code: "ENOENT" });
  if (
    state.outputJournalIdentity !== undefined &&
    (typeof state.outputJournalIdentity !== "string" || !hex.test(state.outputJournalIdentity))
  )
    throw failed();
  const incarnation = outputCoverageIncarnation(canonicalRoot, sessionId, state.startedAt);
  return { directory, target, state, incarnation, stat };
}
function coverage(at: ReturnType<typeof location>): PersistedOutputCoverage | undefined {
  const { state, incarnation } = at;
  if (state.outputCoverageIdentity === undefined && state.outputCoverage === undefined)
    return undefined;
  const proof = state.outputCoverage;
  if (
    state.outputCoverageIdentity !== incarnation ||
    !proof ||
    proof.version !== 1 ||
    proof.incarnation !== incarnation ||
    typeof proof.unpaired !== "boolean" ||
    !Array.isArray(proof.inputIds) ||
    proof.inputIds.length > 128 ||
    proof.inputIds.some((id) => !idValid(id)) ||
    new Set(proof.inputIds).size !== proof.inputIds.length ||
    bytes(proof.inputIds) > 32 * 1024 ||
    (proof.lastInputId !== undefined && !idValid(proof.lastInputId)) ||
    (proof.journalIdentity !== undefined && proof.journalIdentity !== state.outputJournalIdentity)
  )
    throw failed();
  return proof;
}
function assertSame(at: ReturnType<typeof location>) {
  const current = location(at.directory + "/..", at.state.sessionId);
  if (
    current.incarnation !== at.incarnation ||
    current.state.outputJournalIdentity !== at.state.outputJournalIdentity
  )
    throw failed();
}
function write(at: ReturnType<typeof location>, proof: PersistedOutputCoverage): void {
  const text = Buffer.from(
    JSON.stringify({ ...at.state, outputCoverageIdentity: at.incarnation, outputCoverage: proof }) +
      "\n",
  );
  if (text.length > LIMIT) throw failed();
  const temp = join(at.directory, `.output-coverage-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let primary: unknown;
  const errors: unknown[] = [];
  try {
    assertSame(at);
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < text.length) {
      const count = writeSync(fd, text, offset, Math.min(64 * 1024, text.length - offset), offset);
      if (!count) throw failed();
      offset += count;
    }
    fsyncSync(fd);
    const closing = fd;
    fd = undefined;
    closeSync(closing);
    assertSame(at);
    renameSync(temp, at.target);
    if (process.platform !== "win32") {
      const directory = openSync(at.directory, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    assertSame(at);
  } catch (cause) {
    primary = cause;
    errors.push(cause);
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch (cause) {
        errors.push(cause);
      }
    try {
      unlinkSync(temp);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") errors.push(cause);
    }
  }
  if (errors.length > 1)
    throw new AggregateError(errors, "Output coverage persistence failed", { cause: primary });
  if (errors.length) throw errors[0];
}
/** Called only while the journal already owns state.json.lock, after anchor fsync. */
export function acknowledgeOutputCoverageAnchor(
  root: string,
  sessionId: string,
  journalIdentity: string,
  inputId: unknown,
): void {
  if (!idValid(inputId)) return;
  const at = location(root, sessionId);
  if (at.state.outputJournalIdentity !== journalIdentity) throw failed();
  const old = coverage(at);
  const proof: PersistedOutputCoverage = {
    version: 1,
    incarnation: at.incarnation,
    journalIdentity,
    unpaired: old?.unpaired ?? false,
    inputIds: (old?.inputIds ?? []).filter((id) => id !== inputId),
    lastInputId: inputId,
  };
  write(at, proof);
}
/** Whole-state writers never gain authority to clear or overwrite Host proof. */
export function preserveOutputCoverage(
  state: { outputCoverageIdentity?: string; outputCoverage?: PersistedOutputCoverage },
  persisted: { outputCoverageIdentity?: string; outputCoverage?: PersistedOutputCoverage },
): void {
  if (persisted.outputCoverageIdentity !== undefined)
    state.outputCoverageIdentity = persisted.outputCoverageIdentity;
  else delete state.outputCoverageIdentity;
  if (persisted.outputCoverage !== undefined)
    state.outputCoverage = structuredClone(persisted.outputCoverage);
  else delete state.outputCoverage;
}
/** One Host's admission bindings; disk proof survives Host/worker generations. */
export class SessionOutputCoverageStore {
  private readonly bindings = new Map<string, string>();
  private readonly failures = new Set<string>();
  constructor(private readonly root: () => string) {}
  private bind(sessionId: string, at: ReturnType<typeof location>): void {
    const old = this.bindings.get(sessionId);
    if (old !== undefined && old !== at.incarnation) throw failed();
    this.bindings.set(sessionId, at.incarnation);
  }
  read(sessionId: string): SessionOutputCoverageProof {
    try {
      if (this.failures.has(sessionId)) throw failed();
      const at = location(this.root(), sessionId);
      this.bind(sessionId, at);
      const proof = coverage(at);
      return {
        status: at.state.outputJournalIdentity ? "ok" : "unavailable",
        incarnation: at.incarnation,
        journalIdentity: at.state.outputJournalIdentity,
        unpaired: proof?.unpaired ?? false,
        inputIds: proof?.inputIds.slice() ?? [],
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" && !this.bindings.has(sessionId))
        return { status: "unavailable", unpaired: false, inputIds: [] };
      this.failures.add(sessionId);
      return { status: "incomplete", unpaired: true, inputIds: [] };
    }
  }
  record(
    sessionId: string,
    delta: { unpaired: boolean; inputIds: string[] },
  ): SessionOutputCoverageProof {
    let at: ReturnType<typeof location>;
    try {
      if (this.failures.has(sessionId)) throw failed();
      at = location(this.root(), sessionId);
      this.bind(sessionId, at);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" && !this.bindings.has(sessionId))
        return { status: "unavailable", unpaired: false, inputIds: [] };
      this.failures.add(sessionId);
      throw cause;
    }
    let release: (() => void) | undefined;
    const errors: unknown[] = [];
    try {
      release = lockSync(at.target, {
        realpath: false,
        retries: 0,
        stale: 10_000,
        update: 5_000,
      });
      const current = location(this.root(), sessionId);
      this.bind(sessionId, current);
      const old = coverage(current);
      const ids = [...new Set([...(old?.inputIds ?? []), ...delta.inputIds])].filter(
        (id) => id !== old?.lastInputId,
      );
      const overflow = ids.length > 128 || ids.some((id) => !idValid(id)) || bytes(ids) > 32 * 1024;
      const proof: PersistedOutputCoverage = {
        version: 1,
        incarnation: current.incarnation,
        journalIdentity: current.state.outputJournalIdentity,
        unpaired: !!old?.unpaired || delta.unpaired || overflow,
        inputIds: overflow ? [] : ids,
        ...(old?.lastInputId ? { lastInputId: old.lastInputId } : {}),
      };
      if (JSON.stringify(old) !== JSON.stringify(proof)) write(current, proof);
    } catch (cause) {
      this.failures.add(sessionId);
      errors.push(cause);
    } finally {
      try {
        release?.();
      } catch (cause) {
        this.failures.add(sessionId);
        errors.push(cause);
      }
    }
    if (errors.length > 1)
      throw new AggregateError(errors, "Output coverage persistence failed", { cause: errors[0] });
    if (errors.length) throw errors[0];
    return this.read(sessionId);
  }
  forget(sessionId: string): void {
    this.bindings.delete(sessionId);
    this.failures.delete(sessionId);
  }
}
