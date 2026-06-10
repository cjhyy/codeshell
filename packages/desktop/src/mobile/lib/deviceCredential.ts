/**
 * Device credential for the mobile remote.
 *
 * CONTRACT (do not "improve" by hashing): the main process
 * (trusted-device-store.ts) stores and compares the `secretHash` field
 * VERBATIM — `d.secretHash === input.secretHash`. There is no SHA-256 on
 * either side. The field is named "secretHash" historically but is really an
 * opaque shared secret. The phone therefore generates a stable random secret
 * per browser and sends it raw as `secretHash` for both pair.complete and
 * auth.device. Hashing it here would send main a value it never recorded →
 * auth.failed. (See also [[project_beta1_feedback_batch_fixes]]: addDevice
 * is get-or-create BY secretHash, so the secret must be stable per browser.)
 */
export function generateSecret(
  randomBytes: (n: number) => Uint8Array = (n) =>
    crypto.getRandomValues(new Uint8Array(n)),
): string {
  const b = randomBytes(32);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
