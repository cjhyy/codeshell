import type { Credential } from "@cjhyy/code-shell-core";
export const DINGTALK_CREDENTIAL_ID = "im-gateway-dingtalk";
export function dingTalkCredential(clientId: string, clientSecret: string): Credential {
  return {
    id: DINGTALK_CREDENTIAL_ID,
    type: "link",
    label: "DingTalk Chat Gateway",
    secret: JSON.stringify({ version: 1, clientSecret }),
    meta: { platform: "dingtalk", clientId },
  };
}
export function dingTalkCredentialSecret(credential: Credential | undefined): string | undefined {
  if (!credential?.secret) return undefined;
  try {
    const parsed = JSON.parse(credential.secret) as { clientSecret?: unknown };
    return typeof parsed.clientSecret === "string" && parsed.clientSecret.trim()
      ? parsed.clientSecret.trim()
      : undefined;
  } catch {
    if (credential.secret.startsWith("enc:")) return undefined;
    return credential.secret.trim() || undefined;
  }
}
