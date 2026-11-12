// Offline synthetic fixtures. No imports, credentials, network, or real tool execution.
// Keep expected arguments out of model prompts: instructions intentionally use prose.

export const complexSchemaDefinitions = freeze([
  {
    name: "SyntheticProjectPlan",
    description:
      "Construct a synthetic project plan for an offline schema test. This tool performs no actions. Include optional fields only when requested.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "execution"],
      properties: {
        project: {
          type: "object",
          additionalProperties: false,
          required: ["code", "owner"],
          properties: {
            code: { type: "string", pattern: "^PRJ-[0-9]{3}$" },
            owner: {
              type: "object",
              additionalProperties: false,
              required: ["alias", "notification"],
              properties: {
                alias: { type: "string", minLength: 1, maxLength: 24 },
                notification: {
                  type: "object",
                  additionalProperties: false,
                  required: ["channel", "enabled"],
                  properties: {
                    channel: { type: "string", enum: ["radio", "paper"] },
                    enabled: { type: "boolean" },
                  },
                },
                badge: { type: "string", enum: ["blue", "green"] },
              },
            },
          },
        },
        execution: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "retry"],
          properties: {
            mode: { type: "string", enum: ["preview", "simulate"] },
            retry: {
              type: "object",
              additionalProperties: false,
              required: ["attempts", "backoffSeconds"],
              properties: {
                attempts: { type: "integer", minimum: 0, maximum: 5 },
                backoffSeconds: { type: "number", minimum: 0, maximum: 10 },
              },
            },
          },
        },
        note: { type: "string", minLength: 1, maxLength: 48 },
      },
    },
  },
  {
    name: "SyntheticBatchLabels",
    description:
      "Construct labels for imaginary specimens; nothing is stored or sent. Preserve the requested item order. Flags and items must not repeat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["batchId", "items", "dryRun"],
      properties: {
        batchId: { type: "string", pattern: "^B-[0-9]{3}$" },
        dryRun: { type: "boolean", const: true },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "category", "count", "flags"],
            properties: {
              id: { type: "string", pattern: "^item-[a-z]+$" },
              category: { type: "string", enum: ["sample", "control"] },
              count: { type: "integer", minimum: 1, maximum: 20 },
              flags: {
                type: "array",
                minItems: 0,
                maxItems: 3,
                uniqueItems: true,
                items: { type: "string", enum: ["fragile", "cold", "dark"] },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "SyntheticRenderJob",
    description:
      "Describe a pretend rendering job without reading files or executing work. Use exactly one source branch: inline text or an imaginary archive entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId", "source", "transform"],
      properties: {
        jobId: { type: "string", pattern: "^J-[0-9]{3}$" },
        source: {
          oneOf: [{ $ref: "#/$defs/inlineSource" }, { $ref: "#/$defs/archiveSource" }],
        },
        transform: { $ref: "#/$defs/transform" },
      },
      $defs: {
        inlineSource: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: {
            kind: { type: "string", const: "inline" },
            text: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
        archiveSource: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "archiveId", "entryIndex"],
          properties: {
            kind: { type: "string", const: "archive" },
            archiveId: { type: "string", pattern: "^arc-[a-z]{3}$" },
            entryIndex: { type: "integer", minimum: 0, maximum: 99 },
          },
        },
        transform: {
          type: "object",
          additionalProperties: false,
          required: ["format", "width"],
          properties: {
            format: { type: "string", enum: ["plain", "markdown"] },
            width: { type: "integer", minimum: 20, maximum: 120 },
          },
        },
      },
    },
  },
  {
    name: "SyntheticThresholdConfig",
    description:
      "Construct an imaginary sensor configuration; no device exists or is contacted. Explicit null and an omitted optional note have different meanings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sensorId", "calibration", "sampleWindow", "limits"],
      properties: {
        sensorId: { type: "string", pattern: "^SN-[A-Z]{2}-[0-9]{2}$" },
        calibration: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["offset", "scale"],
              properties: {
                offset: { type: "number", minimum: -2, maximum: 2, multipleOf: 0.25 },
                scale: { type: "number", exclusiveMinimum: 0, maximum: 4 },
              },
            },
          ],
        },
        sampleWindow: { type: "integer", minimum: 5, maximum: 60, multipleOf: 5 },
        limits: {
          type: "object",
          additionalProperties: false,
          required: ["low", "high"],
          properties: {
            low: { type: "number", minimum: -40, maximum: 100 },
            high: { type: "number", minimum: -40, maximum: 100 },
          },
        },
        operatorNote: {
          anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 32 }],
        },
      },
    },
  },
]);

export const complexSchemaCases = freeze([
  {
    id: "nested-optionals-present",
    toolName: "SyntheticProjectPlan",
    instruction:
      "Prepare project PRJ-017, owned by alias Finch. Enable the owner's radio notifications and assign the blue badge. Use preview execution with two retry attempts and a half-second backoff. Set the top-level note to exactly rehearsal only. Include no other optional values.",
    expectedArgs: {
      project: {
        code: "PRJ-017",
        owner: { alias: "Finch", notification: { channel: "radio", enabled: true }, badge: "blue" },
      },
      execution: { mode: "preview", retry: { attempts: 2, backoffSeconds: 0.5 } },
      note: "rehearsal only",
    },
  },
  {
    id: "nested-optionals-omitted",
    toolName: "SyntheticProjectPlan",
    instruction:
      "Prepare project PRJ-204 for owner alias Moss. Set the owner's notification channel to paper and disable notifications. Use simulate execution with zero retry attempts and zero-second backoff. Omit the owner's optional badge and the optional top-level note entirely.",
    expectedArgs: {
      project: {
        code: "PRJ-204",
        owner: { alias: "Moss", notification: { channel: "paper", enabled: false } },
      },
      execution: { mode: "simulate", retry: { attempts: 0, backoffSeconds: 0 } },
    },
  },
  {
    id: "array-two-items",
    toolName: "SyntheticBatchLabels",
    instruction:
      "Make dry-run batch B-031 with exactly two items in this order. First: item-amber, category sample, count three, flags cold then dark. Second: item-birch, category control, count one, with no flags. Keep each flag only once and preserve the stated item and flag order.",
    expectedArgs: {
      batchId: "B-031",
      dryRun: true,
      items: [
        { id: "item-amber", category: "sample", count: 3, flags: ["cold", "dark"] },
        { id: "item-birch", category: "control", count: 1, flags: [] },
      ],
    },
  },
  {
    id: "array-three-items",
    toolName: "SyntheticBatchLabels",
    instruction:
      "Make dry-run batch B-092 with three items in the listed order: item-coral is a control, count two, flagged fragile; item-dune is a sample, count five, flagged dark then cold; item-elm is a sample, count four, with no flags. Do not duplicate items or flags or add further values.",
    expectedArgs: {
      batchId: "B-092",
      dryRun: true,
      items: [
        { id: "item-coral", category: "control", count: 2, flags: ["fragile"] },
        { id: "item-dune", category: "sample", count: 5, flags: ["dark", "cold"] },
        { id: "item-elm", category: "sample", count: 4, flags: [] },
      ],
    },
  },
  {
    id: "oneof-inline-source",
    toolName: "SyntheticRenderJob",
    instruction:
      'Prepare job J-008 using an inline source. Its text has exactly two lines separated by one newline: the first line is Blue "kite" (keep the double quotes around kite), and the second line is second line. Transform it to markdown with width eighty. Include no archive fields or extra fields.',
    expectedArgs: {
      jobId: "J-008",
      source: { kind: "inline", text: 'Blue "kite"\nsecond line' },
      transform: { format: "markdown", width: 80 },
    },
  },
  {
    id: "oneof-archive-source",
    toolName: "SyntheticRenderJob",
    instruction:
      "Prepare job J-113 from the imaginary archive arc-elm, at entry index seven. Use the archive source branch, not inline text. Transform it to plain format with width forty. Do not include an inline text field or any additional fields.",
    expectedArgs: {
      jobId: "J-113",
      source: { kind: "archive", archiveId: "arc-elm", entryIndex: 7 },
      transform: { format: "plain", width: 40 },
    },
  },
  {
    id: "nullable-explicit-null",
    toolName: "SyntheticThresholdConfig",
    instruction:
      "Configure imaginary sensor SN-AQ-07 with explicitly null calibration. Set the sample window to twenty, the low limit to minus five, and the high limit to twelve point five. Include operatorNote as explicit null as well. Do not replace either null with an empty object, a string, or an omitted field.",
    expectedArgs: {
      sensorId: "SN-AQ-07",
      calibration: null,
      sampleWindow: 20,
      limits: { low: -5, high: 12.5 },
      operatorNote: null,
    },
  },
  {
    id: "nullable-object-and-omission",
    toolName: "SyntheticThresholdConfig",
    instruction:
      "Configure imaginary sensor SN-BX-42. Supply a calibration object with offset minus three quarters and scale one and a half. Set the sample window to fifteen, the low limit to minus ten point five, and the high limit to forty-two point twenty-five. Omit operatorNote entirely and add no extra fields.",
    expectedArgs: {
      sensorId: "SN-BX-42",
      calibration: { offset: -0.75, scale: 1.5 },
      sampleWindow: 15,
      limits: { low: -10.5, high: 42.25 },
    },
  },
]);

/** Compare JSON semantics exactly, ignoring object-key order but never array order. */
export function compareComplexSchemaArgs(actual, expected) {
  const expectedCanonical = canonical(expected);
  if (expectedCanonical === null)
    throw new TypeError("Expected arguments must be bounded plain JSON");
  const actualCanonical = canonical(actual);
  return {
    matches: actualCanonical !== null && actualCanonical === expectedCanonical,
    expectedCanonical,
    actualCanonical,
  };
}

function canonical(value) {
  let remaining = 20_000;
  const ancestors = new Set();
  function visit(entry, depth) {
    if (--remaining < 0 || depth > 64) throw new TypeError("JSON limit exceeded");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean")
      return JSON.stringify(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return JSON.stringify(entry);
    if (!entry || typeof entry !== "object" || ancestors.has(entry))
      throw new TypeError("Not plain JSON");
    const array = Array.isArray(entry);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      throw new TypeError("Not a plain object");
    const keys = Reflect.ownKeys(entry).filter((key) => !(array && key === "length"));
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("Symbol property");
    if (array && (keys.length !== entry.length || keys.some((key, index) => key !== String(index))))
      throw new TypeError("Sparse or extended array");
    ancestors.add(entry);
    const values = (array ? keys : keys.sort()).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new TypeError("Not a JSON data property");
      const child = visit(descriptor.value, depth + 1);
      return array ? child : `${JSON.stringify(key)}:${child}`;
    });
    ancestors.delete(entry);
    return array ? `[${values.join(",")}]` : `{${values.join(",")}}`;
  }
  try {
    return visit(value, 0);
  } catch {
    return null;
  }
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
