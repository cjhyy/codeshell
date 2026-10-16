import type { LinkAuthorizationFailure } from "@cjhyy/code-shell-link";
import type { TFunction } from "../i18n/I18nProvider";

/** Show only reviewed Host fields, never an upstream response or arbitrary error text. */
export function linkAuthorizationFailureMessage(
  failure: LinkAuthorizationFailure | undefined,
  t: TFunction,
): string | undefined {
  if (!failure) return undefined;
  const stages = {
    validation: "validation",
    authorization: "authorization",
    discovery_registration: "discoveryRegistration",
    authorization_callback: "authorizationCallback",
    token_exchange: "tokenExchange",
    credential_verification: "credentialVerification",
  } as const;
  const codes = {
    invalid_request: "invalidRequest",
    access_denied: "accessDenied",
    timeout: "timeout",
    network_error: "networkError",
    server_error: "serverError",
    protocol_error: "protocolError",
  } as const;
  const checks = {
    credential_binding: "credentialBinding",
    mcp_initialize: "mcpInitialize",
    tool_discovery: "toolDiscovery",
    account_verification: "accountVerification",
    capability_verification: "capabilityVerification",
  } as const;
  const reasons = {
    binding_mismatch: "bindingMismatch",
    cancelled: "cancelled",
    network_error: "networkError",
    http_error: "serverError",
    protocol_error: "protocolError",
    tool_unavailable: "toolUnavailable",
    invalid_pagination: "protocolError",
    response_too_large: "responseTooLarge",
    account_tool_error: "accountToolError",
    account_identity_unavailable: "accountIdentityUnavailable",
    no_read_capabilities: "noReadCapabilities",
  } as const;
  const stage = stages[failure.stage];
  const code = codes[failure.code];
  if (!stage || !code) return t("ext.link.authorizationFailure.safeFailure");
  const messages = [
    t(`ext.link.authorizationFailure.${stage}`),
    t(`ext.link.authorizationFailure.${code}`),
  ];
  if (failure.verificationStage && checks[failure.verificationStage])
    messages.push(t(`ext.link.authorizationFailure.${checks[failure.verificationStage]}`));
  if (failure.reason && reasons[failure.reason])
    messages.push(t(`ext.link.authorizationFailure.${reasons[failure.reason]}`));
  if (
    Number.isInteger(failure.httpStatus) &&
    failure.httpStatus! >= 100 &&
    failure.httpStatus! <= 599
  )
    messages.push(`HTTP ${failure.httpStatus}`);
  return messages.join(" · ");
}
