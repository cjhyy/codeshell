import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { AccountWebError } from "./account-api.js";

export const PASSKEY_SETTINGS_URL = "/settings/account/security";
export const PASSKEY_EXPLANATION = "使用指纹、Face ID 或设备 PIN 确认本人操作。";
export type PasskeyRequest = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
export type PasskeyPurpose =
  | "remote-access"
  | "desktop-remote-access"
  | "desktop-login"
  | "github-link"
  | "passkey-add"
  | "passkey-delete";
export interface PasskeyProof {
  stepUpToken: string;
  expiresAt: number;
}
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const challenge = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,4096}$/.test(value);

/** Refuse weaker or foreign-site ceremonies before invoking browser UI. The
 * server remains responsible for signature, origin, challenge and UV checks. */
export function registrationOptions(
  value: unknown,
  hostname: string,
): PublicKeyCredentialCreationOptionsJSON {
  const options = value as PublicKeyCredentialCreationOptionsJSON | undefined;
  if (
    !options ||
    options.rp?.id !== hostname ||
    !challenge(options.challenge) ||
    options.authenticatorSelection?.userVerification !== "required" ||
    !options.user?.id ||
    !options.user.name ||
    !options.user.displayName
  )
    throw new Error("Passkey 注册请求无效，请刷新后重试。");
  return { ...options, timeout: Math.min(options.timeout ?? 60000, 120000) };
}
export function authenticationOptions(
  value: unknown,
  hostname: string,
): PublicKeyCredentialRequestOptionsJSON {
  const options = value as PublicKeyCredentialRequestOptionsJSON | undefined;
  if (
    !options ||
    options.rpId !== hostname ||
    !challenge(options.challenge) ||
    options.userVerification !== "required"
  )
    throw new Error("Passkey 验证请求无效，请刷新后重试。");
  return { ...options, timeout: Math.min(options.timeout ?? 60000, 120000) };
}

let activeCeremony: symbol | undefined;
async function ceremony<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (!window.isSecureContext || !browserSupportsWebAuthn())
    throw new Error("此浏览器暂不支持 Passkey，请使用支持 Passkey 的浏览器打开此网站。");
  if (activeCeremony) throw new Error("请先完成或取消当前 Passkey 验证。");
  const owner = Symbol();
  activeCeremony = owner;
  const cancel = () => {
    if (activeCeremony === owner) WebAuthnAbortService.cancelCeremony();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await operation();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (activeCeremony === owner) activeCeremony = undefined;
  }
}
export function createBrowserPasskey(value: unknown, signal: AbortSignal) {
  const optionsJSON = registrationOptions(value, window.location.hostname);
  return ceremony(signal, () => startRegistration({ optionsJSON, useAutoRegister: false }));
}
export function verifyBrowserPasskey(value: unknown, signal: AbortSignal) {
  const optionsJSON = authenticationOptions(value, window.location.hostname);
  return ceremony(signal, () => startAuthentication({ optionsJSON, useBrowserAutofill: false }));
}
export function parsePasskeyCeremony(value: unknown) {
  const entry = value as { ceremonyId?: unknown; optionsJSON?: unknown } | undefined;
  if (!entry || !opaque(entry.ceremonyId) || !entry.optionsJSON)
    throw new Error("Passkey 请求无效，请重新发起。");
  return { ceremonyId: entry.ceremonyId, optionsJSON: entry.optionsJSON };
}
export function parsePasskeyProof(value: unknown): PasskeyProof {
  const proof = value as PasskeyProof | undefined;
  if (
    !proof ||
    !opaque(proof.stepUpToken) ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt <= Date.now() ||
    proof.expiresAt > Date.now() + 10 * 60000
  )
    throw new Error("Passkey 验证结果无效，请重新验证。");
  return { stepUpToken: proof.stepUpToken, expiresAt: proof.expiresAt };
}
/** Proofs live only in the action's stack and are consumed by its exact target. */
export async function requirePasskey(
  request: PasskeyRequest,
  purpose: PasskeyPurpose,
  target: string,
  signal: AbortSignal,
): Promise<PasskeyProof> {
  const options = parsePasskeyCeremony(
    await request("/passkeys/authentication/options", "POST", { purpose, target }, signal),
  );
  signal.throwIfAborted();
  const response = await verifyBrowserPasskey(options.optionsJSON, signal);
  signal.throwIfAborted();
  const result = await request(
    "/passkeys/authentication/verify",
    "POST",
    { ceremonyId: options.ceremonyId, response },
    signal,
  );
  signal.throwIfAborted();
  return parsePasskeyProof(result);
}
export function passkeyFailure(cause: unknown): string {
  if (
    cause instanceof AccountWebError &&
    ["passkey_not_configured", "passkeys_not_configured"].includes(cause.code ?? "")
  )
    return "请先在账号安全中添加 Passkey，再确认此操作。";
  if (cause instanceof Error && ["NotAllowedError", "AbortError"].includes(cause.name))
    return "Passkey 验证已取消或超时，可以重试。";
  return cause instanceof Error ? cause.message : "Passkey 验证未完成，请重试。";
}
