import { describe, expect, it } from "bun:test";
import {
  complexSchemaCases,
  complexSchemaDefinitions,
  compareComplexSchemaArgs,
} from "../docs/todo/prompt-cache-probes-20261111/complex-schema-cases-20261112.mjs";
import {
  validateToolArgsStrict,
  validateToolInputSchemaStrict,
} from "../packages/core/src/tool-system/validation.js";

function fixture(id: string) {
  const found = complexSchemaCases.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing fixture ${id}`);
  return found;
}

function definitionFor(id: string) {
  const { toolName } = fixture(id);
  const found = complexSchemaDefinitions.find((entry) => entry.name === toolName);
  if (!found) throw new Error(`Missing definition ${toolName}`);
  return found;
}

function argsFor(id: string): Record<string, any> {
  return structuredClone(fixture(id).expectedArgs);
}

function validate(id: string, args: Record<string, unknown>) {
  const definition = definitionFor(id);
  return validateToolArgsStrict(definition.name, args, definition.inputSchema);
}

describe("complex schema accuracy fixtures", () => {
  it("provides eight paired cases across four bounded, immutable ASCII definitions", () => {
    expect(complexSchemaDefinitions).toHaveLength(4);
    expect(complexSchemaCases).toHaveLength(8);
    expect(new Set(complexSchemaCases.map((entry) => entry.id)).size).toBe(8);
    const serialized = JSON.stringify(complexSchemaDefinitions);
    expect(Buffer.byteLength(serialized)).toBeLessThan(12_000);
    expect(serialized).toMatch(/^[\x00-\x7f]*$/);
    expect(Object.isFrozen(complexSchemaDefinitions)).toBe(true);
    for (const definition of complexSchemaDefinitions) {
      expect(complexSchemaCases.filter((entry) => entry.toolName === definition.name)).toHaveLength(
        2,
      );
      expect(definition.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(Object.isFrozen(definition.inputSchema.properties)).toBe(true);
      expect(validateToolInputSchemaStrict(definition.inputSchema)).toBeNull();
    }
    for (const entry of complexSchemaCases) {
      // Below 500 ASCII bytes is also below the 500-token output allowance.
      expect(Buffer.byteLength(JSON.stringify(entry.expectedArgs))).toBeLessThan(500);
      expect(entry.instruction.length).toBeGreaterThan(100);
      expect(entry.instruction).not.toContain(JSON.stringify(entry.expectedArgs));
      expect(entry.instruction).not.toContain("{");
      expect(Object.isFrozen(entry.expectedArgs)).toBe(true);
      expect(validate(entry.id, entry.expectedArgs)).toBeNull();
      expect(compareComplexSchemaArgs(entry.expectedArgs, entry.expectedArgs).matches).toBe(true);
    }
  });

  it("enforces nested required fields, primitive types and closed objects", () => {
    const id = "nested-optionals-present";
    const missing = argsFor(id);
    delete missing.project.owner.alias;
    expect(validate(id, missing)).not.toBeNull();
    const wrongType = argsFor(id);
    wrongType.project.owner.notification.enabled = "true";
    expect(validate(id, wrongType)).not.toBeNull();
    const extra = argsFor(id);
    extra.execution.retry.unrequested = 1;
    expect(validate(id, extra)).not.toBeNull();
    const omitted = argsFor("nested-optionals-omitted");
    expect(Object.hasOwn(omitted.project.owner, "badge")).toBe(false);
    expect(Object.hasOwn(omitted, "note")).toBe(false);
  });

  it("enforces object-array and flag uniqueness, enums and integer counts", () => {
    const id = "array-two-items";
    const repeatedItem = argsFor(id);
    repeatedItem.items.push(structuredClone(repeatedItem.items[0]));
    expect(validate(id, repeatedItem)).not.toBeNull();
    const repeatedFlag = argsFor(id);
    repeatedFlag.items[0].flags = ["cold", "cold"];
    expect(validate(id, repeatedFlag)).not.toBeNull();
    const wrongEnum = argsFor(id);
    wrongEnum.items[1].category = "unknown";
    expect(validate(id, wrongEnum)).not.toBeNull();
    const fraction = argsFor(id);
    fraction.items[0].count = 1.5;
    expect(validate(id, fraction)).not.toBeNull();
  });

  it("resolves local refs and rejects mixed or incomplete oneOf branches", () => {
    const id = "oneof-inline-source";
    const mixed = argsFor(id);
    mixed.source.archiveId = "arc-elm";
    expect(validate(id, mixed)).not.toBeNull();
    const incomplete = argsFor(id);
    delete incomplete.source.text;
    expect(validate(id, incomplete)).not.toBeNull();
    const wrongDiscriminator = argsFor("oneof-archive-source");
    wrongDiscriminator.source.kind = "inline";
    expect(validate("oneof-archive-source", wrongDiscriminator)).not.toBeNull();
    expect(argsFor(id).source.text).toBe('Blue "kite"\nsecond line');
  });

  it("enforces nullable branches, pattern and numeric constraints without coercion", () => {
    const id = "nullable-object-and-omission";
    for (const mutation of [
      (args: any) => (args.calibration.scale = 0),
      (args: any) => (args.calibration.offset = 0.1),
      (args: any) => (args.sampleWindow = 17),
      (args: any) => (args.sensorId = "sn-bx-42"),
      (args: any) => (args.extra = "forbidden"),
    ]) {
      const args = argsFor(id);
      mutation(args);
      expect(validate(id, args)).not.toBeNull();
    }
    const nulls = argsFor("nullable-explicit-null");
    expect(nulls.calibration).toBeNull();
    expect(nulls.operatorNote).toBeNull();
    expect(Object.hasOwn(argsFor(id), "operatorNote")).toBe(false);
  });

  it("rejects schema-valid answers that do not follow the requested semantics", () => {
    const mutations = [
      ["nested-optionals-present", (args: any) => (args.project.owner.alias = "Other")],
      ["array-two-items", (args: any) => args.items.reverse()],
      ["oneof-inline-source", (args: any) => (args.source.text = 'Blue "kite"\\nsecond line')],
      ["nullable-object-and-omission", (args: any) => (args.operatorNote = null)],
    ] as const;
    for (const [id, mutation] of mutations) {
      const args = argsFor(id);
      mutation(args);
      expect(validate(id, args)).toBeNull();
      expect(compareComplexSchemaArgs(args, fixture(id).expectedArgs).matches).toBe(false);
    }
  });
});

describe("complex schema semantic comparator", () => {
  it("ignores object-key order recursively while preserving JSON values and array order", () => {
    const expected = { b: [{ x: 1, y: null }], a: false };
    const actual = { a: false, b: [{ y: null, x: 1 }] };
    expect(compareComplexSchemaArgs(actual, expected)).toEqual({
      matches: true,
      expectedCanonical: '{"a":false,"b":[{"x":1,"y":null}]}',
      actualCanonical: '{"a":false,"b":[{"x":1,"y":null}]}',
    });
    for (const actual of [{ x: "1" }, { x: 1, extra: true }, {}, { x: null }])
      expect(compareComplexSchemaArgs(actual, { x: 1 }).matches).toBe(false);
    expect(compareComplexSchemaArgs([2, 1], [1, 2]).matches).toBe(false);
    expect(compareComplexSchemaArgs({ x: -0 }, { x: 0 }).matches).toBe(true);
  });

  it("rejects non-JSON input rather than dropping or coercing invalid values", () => {
    const cycle: any = {};
    cycle.self = cycle;
    let getterCalled = false;
    const getter = Object.defineProperty({}, "x", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return 1;
      },
    });
    for (const actual of [
      undefined,
      { x: undefined },
      { x: NaN },
      { x: Infinity },
      { x: 1n },
      { x: () => 1 },
      new Date(0),
      new Array(1),
      Object.assign([1], { extra: 2 }),
      { [Symbol("x")]: 1 },
      getter,
      cycle,
    ])
      expect(compareComplexSchemaArgs(actual, {})).toMatchObject({
        matches: false,
        actualCanonical: null,
      });
    expect(getterCalled).toBe(false);
    expect(() => compareComplexSchemaArgs({}, { x: undefined })).toThrow(TypeError);
  });

  it("bounds recursive work and handles own prototype-like keys as ordinary JSON data", () => {
    let tooDeep: any = {};
    for (let index = 0; index < 70; index++) tooDeep = { next: tooDeep };
    expect(compareComplexSchemaArgs(tooDeep, {}).actualCanonical).toBeNull();
    expect(compareComplexSchemaArgs(Array(20_001).fill(0), []).actualCanonical).toBeNull();
    const value = JSON.parse('{"__proto__":{"fixture":true},"constructor":"safe"}');
    expect(compareComplexSchemaArgs(value, structuredClone(value)).matches).toBe(true);
    expect(Object.hasOwn(Object.prototype, "fixture")).toBe(false);
  });
});
