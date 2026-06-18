/**
 * 常驻凭证:token / link / cookie。
 * - token/link 第一期已有;cookie 第二期改为「具名 cookie 凭证」进库
 *   (用户主动按域拓取存,支持同域多账号),见 credential-use-gate 设计稿。
 */
export type CredentialType = "token" | "link" | "cookie";

export interface Credential {
  /**
   * 引用键,kebab-case,全局/项目两层内唯一。
   * - token/link 如 "my-figma-token"。
   * - cookie 为 `${platform}__${slug(label)}`,如 "xiaohongshu__accountA"
   *   (同一域可有多条不同账号,故 id 不等于域名)。
   */
  id: string;
  type: CredentialType;
  /** 展示名。 */
  label: string;
  /**
   * 密文(UI 只显示掩码):
   * - token: token 值;
   * - link: client id/secret 等的 JSON 字符串;
   * - cookie: 序列化的 cookie jar(JSON.stringify 的 ElectronCookieLike[])。
   */
  secret?: string;
  /** 可选:静态暴露为该 shell env 变量名(进 readShellEnv)。 */
  exposeAsEnv?: string;
  /**
   * 逐条「AI 可自动取用」开关:为 true 时该凭证免过审批门(等价于对它单独开了
   * 全局 credentialUse.autoApprove)。默认 false / 缺省 = 走全局开关 + 审批门。
   * 管的是「AI 取 cookie 文件走 HTTP 请求」(UseCredential)。
   */
  autoUseByAI?: boolean;
  /**
   * 逐条「AI 可自动注入浏览器」开关(仅 cookie):为 true 时 AI 调「注入浏览器」工具
   * (把该 cookie 灌进内置浏览器以登录态打开页面)免审批。默认 false = 弹审批。
   * 与 autoUseByAI 分开 —— 注入浏览器改的是浏览器登录态,比只读取用风险更高。
   */
  autoInjectByAI?: boolean;
  /**
   * link: 业务方 app 注册地址;cookie: 拓取所用平台与主域 + 抓取范围 + 切换策略。
   * - scope="all" 表示该 jar 是整分区全量抓的(切换时整包导回);缺省/"domain" = 仅该域。
   * - switchMode 决定「切换」时怎么写回浏览器:"clear"(默认)先清空整分区再注入(干净换号);
   *   "merge" 只覆盖同名 cookie、保留分区里其他站(不踢掉别的登录态)。
   */
  meta?: {
    appUrl?: string;
    platform?: string;
    domain?: string;
    scope?: "domain" | "all";
    switchMode?: "clear" | "merge";
  };
}

export interface CredentialStoreFile {
  version: 1;
  credentials: Credential[];
}
