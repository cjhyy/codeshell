import { X509Certificate } from "node:crypto";

/** Test-only leaf pin: Electron's formatted fingerprint is not Node's hex fingerprint256. */
export function verifyChooserCertificate(request, expectedFingerprint) {
  if (request?.hostname !== "127.0.0.1" || typeof request.certificate?.data !== "string") return -2;
  try {
    return new X509Certificate(request.certificate.data).fingerprint256 === expectedFingerprint
      ? 0
      : -2;
  } catch {
    return -2;
  }
}
