export type WechatLoginEvent =
  | { type: "wechat-qr"; loginId: string; url: string }
  | { type: "wechat-status"; loginId: string; status: string }
  | { type: "wechat-verification-required"; loginId: string };

export interface WechatLoginOperations {
  "im/wechatLogin": {
    input: { loginId: string };
    result: { accountId: string; configPath: string };
  };
  "im/wechatVerify": { input: { loginId: string; code: string }; result: boolean };
}
