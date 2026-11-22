const MAX_SETUP_LIST_ITEMS = 1_000;
export const MAX_SETUP_VALUE_CHARS = 4_096;
export function uniqueTrimmedStrings(values: readonly unknown[]): string[] {
  if (values.length > MAX_SETUP_LIST_ITEMS) {
    throw new Error(`白名单最多包含 ${MAX_SETUP_LIST_ITEMS} 项`);
  }
  return [
    ...new Set(
      values.flatMap((value) =>
        typeof value === "string" && value.trim() && value.length <= MAX_SETUP_VALUE_CHARS
          ? [value.trim()]
          : [],
      ),
    ),
  ];
}

export function dingTalkSetupInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("缺少钉钉配置参数");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || typeof input.clientId !== "string") {
    throw new Error("钉钉配置参数无效");
  }
  if (input.clientSecret !== undefined && typeof input.clientSecret !== "string") {
    throw new Error("钉钉 Client Secret 参数无效");
  }
  if (!Array.isArray(input.allowedConversationIds) || !Array.isArray(input.allowedUserIds)) {
    throw new Error("钉钉白名单参数无效");
  }
  return {
    enabled: input.enabled,
    clientId: input.clientId,
    ...(typeof input.clientSecret === "string" ? { clientSecret: input.clientSecret } : {}),
    allowedConversationIds: uniqueTrimmedStrings(input.allowedConversationIds),
    allowedUserIds: uniqueTrimmedStrings(input.allowedUserIds),
  };
}
