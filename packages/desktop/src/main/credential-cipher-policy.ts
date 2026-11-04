export interface CredentialSafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plaintext: string): Buffer;
}

/** Never turn a failed/unprotected keyring into a silently plaintext write. */
export function encryptDesktopCredential(
  storage: CredentialSafeStorage,
  plaintext: string,
  platform = process.platform,
): string {
  let protectedStorage = false;
  try {
    protectedStorage =
      storage.isEncryptionAvailable() &&
      (platform !== "linux" ||
        (storage.getSelectedStorageBackend?.() !== undefined &&
          storage.getSelectedStorageBackend?.() !== "basic_text"));
  } catch {
    /* unavailable keyring */
  }
  if (!protectedStorage)
    throw new Error("系统钥匙串不可用，无法安全保存凭据。请解锁钥匙串或启用系统密钥服务后重试。");
  return `enc:safeStorage:${storage.encryptString(plaintext).toString("base64")}`;
}
