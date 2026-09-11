import { expect, test } from "bun:test";
import { BUILTIN_CATALOG } from "../../../../core/src/model-catalog/builtin.js";
import { buildInstance, modelSelectionPatch, credentialCandidates } from "./textConnections";

const entry = BUILTIN_CATALOG.find((entry) => entry.id === "openai-speech")!;
test("speech connections seed real model defaults and share only an appropriate provider key", () => {
  const connection = buildInstance(entry, "gpt-4o-mini-tts", new Set(), "speech");
  expect(connection.tag).toBe("speech");
  expect(connection.paramValues).toEqual({ voice: "coral", speed: 1 });
  expect(
    credentialCandidates(
      [
        { id: "openai-key", catalogId: "openai" },
        { id: "other-key", catalogId: "openrouter" },
      ],
      entry.id,
      BUILTIN_CATALOG,
    ).map((credential) => credential.id),
  ).toEqual(["openai-key"]);
});

test("changing the speech model removes unsupported style and replaces incompatible voices", () => {
  const instance = {
    ...buildInstance(entry, "gpt-4o-mini-tts", new Set(), "speech"),
    paramValues: { voice: "cedar", speed: 1.2, instructions: "温柔地朗读", unrelated: true },
  };
  const changed = modelSelectionPatch(instance, entry, "tts-1");
  expect(changed).toEqual({ model: "tts-1", paramValues: { voice: "alloy", speed: 1.2 } });
  const returned = modelSelectionPatch({ ...instance, ...changed }, entry, "gpt-4o-mini-tts");
  expect(returned.paramValues).toEqual({ voice: "alloy", speed: 1.2 });
  expect(instance.paramValues.instructions).toBe("温柔地朗读");
});
