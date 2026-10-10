import { describe, expect, test } from "bun:test";
import type { SessionState } from "../../types.js";
import {
  canonical,
  decodeState,
  decodeStateBytes,
  digest,
  encodeState,
  goalEffect,
  parseUnique,
  STATE_LIMIT,
  StorageFailure,
  type DecodedState,
} from "./codec.js";
import {
  CompleteIdentityIndex,
  IdentityPool,
  INDEX_BYTES,
  MAX_IDENTITIES,
  POOL_BYTES,
} from "./id-index.js";

function fixture(): DecodedState {
  const state = {
    sessionId: "fixture-session",
    startedAt: 123,
    stateRevision: 7,
    outputJournalIdentity: "a".repeat(64),
    workspaceProfile: "actual-profile-binding",
    cwd: "/fixture-only",
    kind: "chat",
    archivedAt: 456,
    parentSessionId: null,
    summary: undefined,
  } as unknown as SessionState;
  return {
    state,
    format: {
      version: 2,
      epoch: "11111111-1111-4111-8111-111111111111",
      phase: "active",
      transitionId: "22222222-2222-4222-8222-222222222222",
      v1Through: "opaque-existing-cursor",
      headerPin: "a".repeat(64),
    },
    control: { effectDigest: goalEffect(state) },
  };
}

describe("non-activated storage codec spike", () => {
  test("preserves top-level Profile/catalog metadata and exposes a numeric revision", () => {
    const input = fixture();
    const text = encodeState(input);
    const raw = JSON.parse(text);
    expect(raw.workspaceProfile).toBe(input.state.workspaceProfile);
    expect(raw.cwd).toBe(input.state.cwd);
    expect(raw.parentSessionId).toBeNull();
    expect(raw.archivedAt).toBe(456);
    expect(raw.sessionId).toBe(input.state.sessionId);
    expect(raw.state).toBeUndefined();
    expect(raw.stateRevision).toEqual({ version: 2, epoch: input.format!.epoch, value: 7 });
    const decoded = decodeState(text);
    expect(decoded.state.stateRevision).toBe(7);
    expect(decoded.state).not.toHaveProperty("outputJournalFormat");
    expect(decoded.format).toEqual(input.format);
    expect(encodeState(decoded)).toBe(text);
  });

  test("legacy numeric state remains valid without inventing new proof", () => {
    const input = fixture().state;
    const result = decodeState(JSON.stringify(input));
    expect(result.state.stateRevision).toBe(7);
    expect(result.format).toBeUndefined();
    expect(result.control).toBeUndefined();
  });

  test("encoded state counts LF at the exact byte bound before decoding", () => {
    const input = fixture();
    const state = input.state as unknown as Record<string, unknown>;
    state.nativePadding = "";
    const baseBytes = Buffer.byteLength(encodeState(input));
    const padding = "s".repeat(STATE_LIMIT - baseBytes);
    state.nativePadding = padding;
    const exact = encodeState(input);
    expect(exact.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(exact)).toBe(STATE_LIMIT);
    expect(encodeState(decodeStateBytes(Buffer.from(exact)))).toBe(exact);

    state.nativePadding = padding + "s";
    const raw = JSON.parse(exact);
    raw.nativePadding += "s";
    expect(Buffer.byteLength(canonical(raw) + "\n")).toBe(STATE_LIMIT + 1);
    let rejected = false;
    try {
      encodeState(input);
    } catch (cause) {
      rejected = true;
      expect(cause).toBeInstanceOf(StorageFailure);
      expect((cause as StorageFailure).reason).toBe("capacity");
      expect((cause as Error).message).toBe("State byte bound");
    }
    expect(rejected).toBe(true);
  });

  test("unknown/lost protected version and duplicate keys fail closed", () => {
    for (const mutate of [
      (raw: any) => {
        raw.stateRevision.version = 3;
      },
      (raw: any) => {
        raw.stateRevision.surprise = true;
      },
      (raw: any) => {
        raw.stateRevision.epoch = "wrong";
      },
      (raw: any) => {
        raw.stateRevision = 7;
      },
      (raw: any) => {
        delete raw.outputControl;
      },
      (raw: any) => {
        raw.outputJournalFormat.headerPin = "b".repeat(64);
      },
      (raw: any) => {
        raw.outputControl.surprise = true;
      },
    ]) {
      const raw = JSON.parse(encodeState(fixture()));
      mutate(raw);
      expect(() => decodeState(JSON.stringify(raw))).toThrow();
    }
    expect(() => parseUnique('{"x":1,"x":2}')).toThrow("Duplicate");
    expect(() => parseUnique('{"x":{"y":1,"\\u0079":2}}')).toThrow("Duplicate");
    expect(() => parseUnique('{"x":[1,]}')).toThrow();
    expect(() => parseUnique('{"x":1} trailing')).toThrow();
    expect(parseUnique('{"escaped":"a\\\"b","nested":[true,null,-1.5e2]}')).toEqual({
      escaped: 'a"b',
      nested: [true, null, -150],
    });
  });

  test("byte/depth and non-JSON bounds are explicit failures", () => {
    expect(() => parseUnique('"oversize"', 2)).toThrow("byte bound");
    expect(() => parseUnique("[".repeat(130) + "0" + "]".repeat(130))).toThrow("depth");
    expect(() => parseUnique("1e999")).toThrow("Nonfinite");
    expect(() => canonical(new Date())).toThrow("Non-JSON");
    expect(() => canonical({ undefined: undefined })).toThrow("Non-JSON");
    expect(() => canonical({ number: Infinity })).toThrow("Non-JSON");
  });

  test("sparse arrays cannot silently change strict JSON projection", () => {
    for (const length of [1, 2]) {
      const sparse = new Array(length);
      expect(() => canonical(sparse)).toThrow("Sparse");
      const input = fixture();
      (input.state as unknown as Record<string, unknown>).metadata = sparse;
      expect(() => encodeState(input)).toThrow("Sparse");
    }
  });

  test("strict JSON rejects own accessors and proxies before reading them", () => {
    let reads = 0;
    const value = {
      get data() {
        reads++;
        return reads;
      },
    };
    expect(() => canonical(value)).toThrow("Accessor");
    expect(reads).toBe(0);
    const array = [1];
    Object.defineProperty(array, "0", {
      get() {
        reads++;
        return reads;
      },
    });
    expect(() => canonical(array)).toThrow("Accessor");
    expect(reads).toBe(0);
    expect(() => canonical(new Proxy({}, {}))).toThrow("Proxy");
    const input = fixture();
    Object.defineProperty(input.state, "metadata", {
      enumerable: true,
      get() {
        reads++;
        return reads;
      },
    });
    expect(() => encodeState(input)).toThrow("Accessor");
    expect(reads).toBe(0);
  });

  test("protected strings reject array coercion", () => {
    for (const mutate of [
      (raw: any) => {
        raw.outputControl.effectDigest = [raw.outputControl.effectDigest];
      },
      (raw: any) => {
        raw.outputJournalFormat.transitionId = [raw.outputJournalFormat.transitionId];
      },
      (raw: any) => {
        raw.outputControl.lastCommitted = {
          txId: [raw.outputJournalFormat.transitionId],
          eventId: "event",
          revision: 7,
          effectDigest: "a".repeat(64),
        };
      },
      (raw: any) => {
        raw.outputControl.lastCommitted = {
          txId: raw.outputJournalFormat.transitionId,
          eventId: "event",
          revision: 7,
          effectDigest: ["a".repeat(64)],
        };
      },
    ]) {
      const raw = JSON.parse(encodeState(fixture()));
      mutate(raw);
      expect(() => decodeState(JSON.stringify(raw))).toThrow();
    }
  });

  test("encoding rejects nonfinite metadata without normalizing it to null", () => {
    for (const number of [Infinity, -Infinity, NaN]) {
      const input = fixture();
      (input.state as unknown as Record<string, unknown>).metadata = { nested: [number] };
      expect(() => encodeState(input)).toThrow();
    }
  });

  test("state byte entry rejects malformed UTF8 before parse can replace it", () => {
    const valid = Buffer.from(encodeState(fixture()));
    expect(decodeStateBytes(valid).state.stateRevision).toBe(7);
    const bad = Buffer.from(valid);
    bad[bad.indexOf(Buffer.from("actual-profile-binding"))] = 0xff;
    expect(() => decodeStateBytes(bad)).toThrow();
  });

  test("state byte entry rejects a UTF8 BOM", () => {
    const bytes = Buffer.from(encodeState(fixture()));
    expect(() =>
      decodeStateBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
    ).toThrow();
  });

  test("protected event ids obey their own stable-id rule", () => {
    for (const eventId of ["", "a".repeat(129), "with space", "with/slash", "汉字", ".invalid"]) {
      const raw = JSON.parse(encodeState(fixture()));
      raw.outputControl.lastCommitted = {
        txId: raw.outputJournalFormat.transitionId,
        eventId,
        revision: 7,
        effectDigest: "a".repeat(64),
      };
      expect(() => decodeState(JSON.stringify(raw))).toThrow();
    }
  });
});

describe("complete bounded identity proof spike", () => {
  test("a miss is unknown before authentication, and eviction never means absent", () => {
    const pool = new IdentityPool();
    const index = new CompleteIdentityIndex(pool);
    try {
      expect(() => index.lookup("missing", digest("p"), "stamp", () => "")).toThrow("rebuild");
      index.authenticate("stamp");
      expect(index.lookup("missing", digest("p"), "stamp", () => "")).toBeUndefined();
      index.invalidate();
      expect(() => index.lookup("missing", digest("p"), "stamp", () => "")).toThrow("rebuild");
    } finally {
      index.dispose();
    }
    expect(pool.bytes).toBe(0);
  });

  test("verified identity returns original receipt and rejects different projection", () => {
    const pool = new IdentityPool();
    const index = new CompleteIdentityIndex(pool);
    try {
      const binding = new Map<number, string>();
      for (let i = 0; i < 2000; i++) {
        binding.set(i + 1, `event-${i}`);
        index.addVerified(
          `event-${i}`,
          digest(`projection-${i}`),
          { sequence: i * 2 + 1, offset: i * 100 + 100, bindingOffset: i + 1 },
          (offset) => binding.get(offset)!,
        );
      }
      index.authenticate("verified-exact-stamp");
      expect(index.count).toBe(2000);
      expect(
        index.lookup(
          "event-5",
          digest("projection-5"),
          "verified-exact-stamp",
          (offset) => binding.get(offset)!,
        ),
      ).toEqual({ sequence: 11, offset: 600, bindingOffset: 6 });
      expect(() =>
        index.lookup(
          "event-5",
          digest("different"),
          "verified-exact-stamp",
          (offset) => binding.get(offset)!,
        ),
      ).toThrow("different projection");
      expect(() =>
        index.lookup(
          "event-5",
          digest("projection-5"),
          "changed-stamp",
          (offset) => binding.get(offset)!,
        ),
      ).toThrow("rebuild");
      expect(() =>
        index.addVerified(
          "event-5",
          digest("projection-5"),
          { sequence: 9999, offset: 9999, bindingOffset: 9999 },
          (offset) => binding.get(offset)!,
        ),
      ).toThrow("Duplicate committed");
    } finally {
      index.dispose();
    }
  });

  test("fixed typed array allocations fit two indexes and refuse a third", () => {
    expect(MAX_IDENTITIES).toBe(262144);
    expect(INDEX_BYTES).toBeLessThanOrEqual(46 * 1024 * 1024);
    expect(POOL_BYTES).toBe(96 * 1024 * 1024);
    const pool = new IdentityPool();
    const first = new CompleteIdentityIndex(pool);
    const second = new CompleteIdentityIndex(pool);
    try {
      expect(pool.bytes).toBe(2 * INDEX_BYTES);
      expect(() => new CompleteIdentityIndex(pool)).toThrow("pool exhausted");
      expect(() => new CompleteIdentityIndex(new IdentityPool())).toThrow("pool exhausted");
      first.dispose();
      const replacement = new CompleteIdentityIndex(pool);
      replacement.dispose();
      for (let i = 0; i < 100; i++) {
        const rotating = new CompleteIdentityIndex(pool);
        rotating.authenticate(`stamp-${i}`);
        rotating.dispose();
      }
      expect(pool.arenaCount).toBe(2);
      expect(pool.backingBytes).toBe(2 * INDEX_BYTES);
      expect(() => first.lookup("id", digest("p"), "stamp", () => "id")).toThrow("rebuild");
    } finally {
      first.dispose();
      second.dispose();
    }
    expect(pool.bytes).toBe(0);
  });
});
