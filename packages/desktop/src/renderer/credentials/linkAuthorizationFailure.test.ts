import { expect, test } from "bun:test";
import type { LinkAuthorizationFailure } from "@cjhyy/code-shell-link";
import { linkAuthorizationFailureMessage } from "./linkAuthorizationFailure";
import { translate } from "../i18n/translate";

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);

test("authorization failures show the reviewed stage, cause and account verification detail", () => {
  expect(
    linkAuthorizationFailureMessage(
      {
        stage: "credential_verification",
        code: "protocol_error",
        verificationStage: "account_verification",
        reason: "account_identity_unavailable",
        httpStatus: 401,
      },
      t,
    ),
  ).toBe("验证连接 · 服务返回的结果不完整 · 确认账号 · 暂未能确认账号身份 · HTTP 401");
});

test("upstream URLs, bodies and unknown failure fields never enter UI diagnostics", () => {
  const failure = {
    stage: "discovery_registration",
    code: "network_error",
    httpStatus: 9999,
    message: "https://provider.invalid?token=private",
    body: "private-body",
  } as LinkAuthorizationFailure;
  const message = linkAuthorizationFailureMessage(failure, t)!;
  expect(message).toBe("准备服务连接 · 暂时无法连接服务，请检查网络后重试");
  expect(message).not.toContain("private");
  expect(message).not.toContain("9999");
  expect(
    linkAuthorizationFailureMessage(
      { stage: "untrusted", code: "untrusted" } as unknown as LinkAuthorizationFailure,
      t,
    ),
  ).toContain("连接未完成");
  expect(linkAuthorizationFailureMessage(undefined, t)).toBeUndefined();
});
