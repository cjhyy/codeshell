// The Host independently requires the complete v1 Services network acceptance.
export const DEVICE_RELAY_ACCEPTANCE_CHECKS = Object.freeze([
  "verified TLS, single-owner setup, directory login and Origin boundary",
  "owner revoked while enrollment body is pending cannot mint a ticket",
  "two actual RemoteHostManagers, two paired phones and five independent WebSockets",
  "directory, computer, phone, Origin and workspace authorizations stay separate",
  "real upload/file download byte equality, slow reader and authenticated fixture Range",
  "slow WebSocket reader receives complete final 2 MiB message before close",
  "HTTP cancellation reaches Host and real per-computer stream capacity is enforced",
  "phone revocation aborts its production download and tabs while preserving another phone's download",
  "disconnect after a committed POST and reconnect never replay the action",
  "re-enrollment keeps computer origin while rotating credential and fencing old connections",
  "real WSS tickets bind host/lease, consume once including failed handshakes, and fence old close callbacks",
  "restart preserves stable directory and owner, starts offline, and accepts only new ready leases",
  "computer revocation aborts active HTTP and rejects further traffic",
  "Host stop synchronously revokes connector target lifetime",
]);
