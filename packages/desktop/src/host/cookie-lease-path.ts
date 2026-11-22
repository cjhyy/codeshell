import { tmpdir } from "node:os";
import { join } from "node:path";

export function cookieLeasePath(token: string) {
  if (typeof token !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token))
    throw Error("Invalid Cookie lease");
  // Preserve the Core startup sweep prefix for interrupted and older clients.
  return join(tmpdir(), `codeshell-cred-cookie-${token}.txt`);
}
