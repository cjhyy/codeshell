import { isDeepStrictEqual } from "node:util";
import { CredentialStore, type CredentialStoreFile } from "@cjhyy/code-shell-core";
import { credentialFiles } from "./credential-file-client.js";
import { DINGTALK_CREDENTIAL_ID } from "./im-dingtalk-credential.js";

/** Only the gateway's registered credential may reach the OS cipher. Keep every
 * other stored entry opaque, including records from a newer Desktop version. */
export async function withDingTalkCredential<T>(
  writing: boolean,
  work: (store: CredentialStore) => T,
  assertCurrent: () => void,
  beforeCommit?: () => Promise<void>,
  onCommit?: (undo: () => Promise<void>) => void,
): Promise<T> {
  const files = credentialFiles();
  return new CredentialStore().withAsyncCipher(
    {
      async read(address) {
        const snapshot = await files.read(address);
        assertCurrent();
        return {
          ...snapshot,
          file: {
            ...snapshot.file,
            credentials: snapshot.file.credentials.filter(
              (entry) => entry?.id === DINGTALK_CREDENTIAL_ID,
            ),
          },
        };
      },
      async commit(address, revision, next) {
        const base = await files.read(address);
        if (base.revision !== revision) return false;
        const file: CredentialStoreFile = {
          ...base.file,
          credentials: [
            ...base.file.credentials.filter((entry) => entry?.id !== DINGTALK_CREDENTIAL_ID),
            ...next.credentials,
          ],
        };
        await beforeCommit?.();
        assertCurrent();
        if (!(await files.commit(address, revision, file))) return false;
        // Compensate only the exact ciphertext we installed if the config CAS
        // later loses. A later credential edit wins, including unrelated edits.
        const previous = base.file.credentials.filter(
          (entry) => entry?.id === DINGTALK_CREDENTIAL_ID,
        );
        onCommit?.(async () => {
          for (let i = 0; i < 16; i++) {
            const now = await files.read(address);
            const ours = now.file.credentials.filter(
              (entry) => entry?.id === DINGTALK_CREDENTIAL_ID,
            );
            if (!isDeepStrictEqual(ours, next.credentials)) return;
            const restore = {
              ...now.file,
              credentials: [
                ...now.file.credentials.filter((entry) => entry?.id !== DINGTALK_CREDENTIAL_ID),
                ...previous,
              ],
            };
            if (await files.commit(address, now.revision, restore)) return;
          }
          throw Error("钉钉凭据刚被其他进程修改，请重新核对配置。");
        });
        return true;
      },
    },
    ["user"],
    writing ? "user" : undefined,
    work,
  );
}
