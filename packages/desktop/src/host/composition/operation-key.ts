import type { EncryptionCipher } from "@cjhyy/code-shell-core";
export class OperationKeyChanged extends Error {}
export interface PreparedOperationKey {
  wrapped: string;
  secret: string;
}
export function preparedOperationCipher(key: PreparedOperationKey | null): EncryptionCipher {
  return {
    encrypt() {
      throw new Error("Operation key was not prepared");
    },
    decrypt(wrapped) {
      if (!key || key.wrapped !== wrapped || !/^[a-f0-9]{64}$/.test(key.secret))
        throw new OperationKeyChanged("Operation key changed");
      return key.secret;
    },
  };
}
