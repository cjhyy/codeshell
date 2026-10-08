import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EncryptionCipher } from "@cjhyy/code-shell-core";
import {
  ModelRequestKeyStore,
  assertDurableRequestOwner,
  type ModelRequestSigner,
  type ModelRequestSignInput,
} from "@cjhyy/code-shell-core/internal";

/** Host-owned authority; no renderer/model endpoint accepts these signing inputs. */
export function createDesktopModelRequestSigner(options: {
  hostDirectory: string;
  sessionStorageDir: string;
  cipher: EncryptionCipher;
  encryptionAvailable: () => boolean;
  hasActiveEphemeralOwner: (sessionId: string) => boolean;
}): ModelRequestSigner {
  const scopeId = createHash("sha256").update(options.sessionStorageDir).digest("hex");
  const keys = new ModelRequestKeyStore({
    directory: join(options.hostDirectory, "request-keys", "host-encrypted"),
    cipher: options.cipher,
    custodyMode: "host-encrypted",
  });
  const ephemeralIncarnations = new Map<string, string>();
  return {
    async sign(input: ModelRequestSignInput) {
      const subject = input?.subject;
      if (
        !subject ||
        typeof subject.sessionId !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(subject.sessionId) ||
        subject.storageScopeId !== scopeId
      )
        throw new Error("Request signing owner mismatch");
      if (subject.ephemeral === true) {
        if (!options.hasActiveEphemeralOwner(subject.sessionId))
          throw new Error("Ephemeral request signing owner is no longer active");
        const bound = ephemeralIncarnations.get(subject.sessionId);
        if (bound && bound !== subject.sessionInstanceId)
          throw new Error("Ephemeral request signing incarnation mismatch");
        // First use is authorized by native Quick Chat ownership, then pinned
        // for this worker generation. dispose() runs when that generation ends.
        ephemeralIncarnations.set(subject.sessionId, subject.sessionInstanceId);
        try {
          const signatures = await keys.sign(input);
          if (
            !options.hasActiveEphemeralOwner(subject.sessionId) ||
            ephemeralIncarnations.get(subject.sessionId) !== subject.sessionInstanceId
          )
            throw new Error("Ephemeral request signing owner changed");
          return signatures;
        } catch (error) {
          if (!bound && ephemeralIncarnations.get(subject.sessionId) === subject.sessionInstanceId)
            ephemeralIncarnations.delete(subject.sessionId);
          throw error;
        }
      }
      if (!options.encryptionAvailable())
        throw new Error("Host request key encryption unavailable");
      assertDurableRequestOwner(subject, options.sessionStorageDir);
      return keys.sign(input);
    },
    dispose() {
      ephemeralIncarnations.clear();
      keys.dispose();
    },
  };
}
