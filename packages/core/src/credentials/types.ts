/** 常驻凭证:仅 token / link。Cookie 不进库(源常驻 persist:browser 分区,用时现抓)。 */
export type CredentialType = "token" | "link";

export interface Credential {
  /** 引用键,kebab-case,如 "my-figma-token"。全局/项目两层内唯一。 */
  id: string;
  type: CredentialType;
  /** 展示名。 */
  label: string;
  /** 密文:token 值;link 为 client id/secret 等的 JSON 字符串。UI 只显示掩码。 */
  secret?: string;
  /** 可选:静态暴露为该 shell env 变量名(进 readShellEnv)。 */
  exposeAsEnv?: string;
  /** link: 业务方 app 注册地址。 */
  meta?: { appUrl?: string };
}

export interface CredentialStoreFile {
  version: 1;
  credentials: Credential[];
}
