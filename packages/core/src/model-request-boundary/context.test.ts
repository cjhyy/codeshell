import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaintextCipher } from "../credentials/cipher.js";
import { Transcript } from "../session/transcript.js";
import { canonicalDigest } from "./canonical.js";
import { ModelRequestKeyStore } from "./custody.js";
import {
  ModelRequestBoundaryError,
  requestBoundaryFetch,
  withModelRequestBoundary,
  withProviderRequestProjection,
  type ModelRequestBinding,
} from "./context.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(writer?: ConstructorParameters<typeof Transcript>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-boundary-"));
  directories.push(directory);
  const transcript = new Transcript(join(directory, "session", "transcript.jsonl"), writer);
  transcript.appendMessage("user", "synthetic question");
  const binding: ModelRequestBinding = {
    subject: {
      sessionId: "synthetic-session",
      storageScopeId: "a".repeat(64),
      sessionInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    transcript,
    signer: new ModelRequestKeyStore({
      directory: join(directory, "host-keys"),
      cipher: new PlaintextCipher(),
      custodyMode: "owner-only-plaintext",
    }),
    compositionDigest: "c".repeat(64),
    configVersion: 7,
    provider: "openai",
    model: "synthetic-model",
  };
  return { directory, transcript, binding };
}
const body = {
  model: "synthetic-model",
  messages: [
    { role: "system", content: "synthetic hidden instruction" },
    { role: "user", content: "synthetic question" },
  ],
  tools: [
    { type: "function", function: { name: "SyntheticTool", parameters: { type: "object" } } },
  ],
};
function receipt(binding: ModelRequestBinding, requestId = "physical-1") {
  return {
    requestId,
    accountingSessionId: binding.subject.sessionInstanceId,
    sessionId: binding.subject.sessionId,
  };
}
describe("request boundary at the configured provider fetch", () => {
  test("durably anchors actual projection before handoff; retry anchors share one logical boundary", async () => {
    const { binding, transcript } = fixture();
    let sends = 0;
    const fetch = requestBoundaryFetch(
      async () => {
        sends++;
        const onDisk = readFileSync(transcript.getFilePath(), "utf8");
        expect(onDisk).toContain(`physical-${sends}`);
        return new Response("{}");
      },
      () => receipt(binding, `physical-${sends + 1}`),
    );
    await withModelRequestBoundary(
      binding,
      { step: 2, assistantMessageId: "assistant-slot" },
      undefined,
      () =>
        withProviderRequestProjection("openai-chat", body, async () => {
          await fetch("http://fixture.invalid", { body: JSON.stringify(body) });
          await fetch("http://fixture.invalid", { body: JSON.stringify(body) });
        }),
    );
    const boundaries = transcript.getEvents("model_request_boundary");
    const attempts = transcript.getEvents("model_request_attempt");
    expect(boundaries).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.data.logicalCallId).toBe(attempts[1]!.data.logicalCallId);
    expect(attempts[0]!.data.boundaryEventId).toBe(boundaries[0]!.id);
    expect(attempts.map((event) => event.data.attemptNumber)).toEqual([1, 2]);
    expect(boundaries[0]!.data.toolCatalogDigest).toBe(canonicalDigest(body.tools));
    expect(boundaries[0]!.data.configVersion).toBe(7);
    expect(boundaries[0]!.data.sourceEventRange).toEqual({
      firstEventId: transcript.getEvents()[0]!.id,
      lastEventId: transcript.getEvents()[0]!.id,
      eventCount: 1,
    });
    expect(JSON.stringify(boundaries)).not.toContain("synthetic hidden instruction");
    expect(JSON.stringify(boundaries)).not.toContain(canonicalDigest(body.messages));
    const resumed = Transcript.loadFromFile(transcript.getFilePath());
    expect(resumed.toMessages()).toEqual(transcript.toMessages());
    expect(resumed.getEvents("model_request_attempt")).toHaveLength(2);
  });

  test("wire mutation and wrong Session identity abort before custody or transport", async () => {
    for (const mutation of ["body", "identity"] as const) {
      const { binding, transcript } = fixture();
      let signs = 0;
      let sends = 0;
      let aborted = false;
      const original = binding.signer;
      binding.signer = {
        sign: (input) => {
          signs++;
          return original.sign(input);
        },
      };
      const fetch = requestBoundaryFetch(
        async () => {
          sends++;
          return new Response("{}");
        },
        () =>
          mutation === "identity"
            ? { ...receipt(binding), accountingSessionId: "other-instance" }
            : receipt(binding),
      );
      await expect(
        withModelRequestBoundary(binding, undefined, undefined, async (signal) => {
          signal!.addEventListener("abort", () => {
            aborted = true;
          });
          return withProviderRequestProjection("openai-chat", body, () =>
            fetch("http://fixture.invalid", {
              body: JSON.stringify(
                mutation === "body"
                  ? { ...body, messages: [{ role: "user", content: "changed" }] }
                  : body,
              ),
            }),
          );
        }),
      ).rejects.toBeInstanceOf(ModelRequestBoundaryError);
      expect({ signs, sends, aborted }).toEqual({ signs: 0, sends: 0, aborted: true });
      expect(transcript.getEvents("model_request_attempt")).toHaveLength(0);
    }
  });

  test("custody or boundary/attempt durability failure is fatal and performs zero sends", async () => {
    for (const failure of ["custody", "model_request_boundary", "model_request_attempt"] as const) {
      const { binding, transcript } = fixture((file, line) => {
        if (line.includes(`"type":"${failure}"`)) throw new Error("synthetic disk failure");
        // Custom writer is trusted to complete the event synchronously.
      });
      if (failure === "custody")
        binding.signer = {
          sign: async () => {
            throw new Error("synthetic custody failure");
          },
        };
      let sends = 0;
      const fetch = requestBoundaryFetch(
        async () => {
          sends++;
          return new Response("{}");
        },
        () => receipt(binding),
      );
      await expect(
        withModelRequestBoundary(binding, undefined, undefined, () =>
          withProviderRequestProjection("openai-chat", body, () =>
            fetch("http://fixture.invalid", { body: JSON.stringify(body) }),
          ),
        ),
      ).rejects.toBeInstanceOf(ModelRequestBoundaryError);
      expect(sends).toBe(0);
      expect(transcript.getEvents("model_request_attempt")).toHaveLength(0);
    }
  });

  test("plain fetch and explicitly unbound nested calls do not inherit main audit context", async () => {
    const { binding, transcript } = fixture();
    let sends = 0;
    const fetch = requestBoundaryFetch(
      async () => {
        sends++;
        return new Response("{}");
      },
      () => receipt(binding),
    );
    await fetch("http://fixture.invalid");
    await withModelRequestBoundary(binding, undefined, undefined, () =>
      withProviderRequestProjection("openai-chat", body, () =>
        withModelRequestBoundary(undefined, undefined, undefined, () =>
          withProviderRequestProjection("openai-chat", { ...body, model: "aux-model" }, () =>
            fetch("http://fixture.invalid", {
              body: JSON.stringify({ ...body, model: "aux-model" }),
            }),
          ),
        ),
      ),
    );
    expect(sends).toBe(2);
    expect(transcript.getEvents("model_request_boundary")).toHaveLength(0);
  });

  test("a bound main invocation cannot send without its provider projection snapshot", async () => {
    const { binding, transcript } = fixture();
    let sends = 0;
    const fetch = requestBoundaryFetch(
      async () => {
        sends++;
        return new Response("{}");
      },
      () => receipt(binding),
    );
    await expect(
      withModelRequestBoundary(binding, undefined, undefined, () =>
        fetch("http://fixture.invalid", { body: JSON.stringify(body) }),
      ),
    ).rejects.toBeInstanceOf(ModelRequestBoundaryError);
    expect(sends).toBe(0);
    expect(transcript.getEvents("model_request_boundary")).toHaveLength(0);
  });

  test("the validated body cannot change while the Host is signing", async () => {
    const { binding } = fixture();
    const original = binding.signer;
    const init = { body: JSON.stringify(body) };
    binding.signer = {
      async sign(input) {
        init.body = JSON.stringify({
          ...body,
          messages: [{ role: "user", content: "mutated while signing" }],
        });
        return original.sign(input);
      },
    };
    let delivered: unknown;
    const fetch = requestBoundaryFetch(
      async (_input, received) => {
        delivered = JSON.parse(received!.body as string);
        return new Response("{}");
      },
      () => receipt(binding),
    );
    await withModelRequestBoundary(binding, undefined, undefined, () =>
      withProviderRequestProjection("openai-chat", body, () =>
        fetch("http://fixture.invalid", init),
      ),
    );
    expect(delivered).toEqual(body);
  });
});
