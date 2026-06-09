/**
 * Pairing-token helpers. The desktop QR encodes `…/mobile?pairing=<token>`;
 * the phone reads the token off the URL to send pair.complete. One-use,
 * 10-minute tokens are enforced server-side (PairingTokenManager).
 */
export function parsePairingToken(search: string): string | null {
  return new URLSearchParams(search).get("pairing");
}
