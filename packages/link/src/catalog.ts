import type { LinkAuthGuide, LinkLocalizedText, LinkProviderManifest } from "./types.js";

const text = (zh: string, en: string): LinkLocalizedText => ({ zh, en });

function localToken(
  id: string,
  displayName: LinkLocalizedText,
  tokenLabel: string,
  tokenPlaceholder: string,
  authGuide: LinkAuthGuide,
) {
  return {
    id,
    displayName,
    executionRuntime: "local" as const,
    secretLocation: "device" as const,
    authKind: "token" as const,
    availability: "available" as const,
    tokenLabel,
    tokenPlaceholder,
    authGuide,
  };
}

function managedOAuth(displayName: string) {
  return {
    id: "managed-oauth",
    displayName: text(`${displayName} 官方授权`, `${displayName} OAuth`),
    executionRuntime: "server" as const,
    secretLocation: "server" as const,
    authKind: "oauth" as const,
    availability: "coming-soon" as const,
  };
}

export const LINK_PROVIDER_MANIFESTS: LinkProviderManifest[] = [
  {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    description: text(
      "读取仓库、文件、Issue 和 Pull Request。",
      "Read repositories, files, issues, and pull requests.",
    ),
    brandText: "GH",
    icon: "github",
    accent: "neutral",
    featured: true,
    connectionMethods: [
      {
        ...localToken(
          "fine-grained-pat",
          text("GitHub 登录 / Fine-grained PAT", "GitHub sign-in / fine-grained PAT"),
          "Fine-grained PAT",
          "github_pat_…",
          {
            title: text("创建 Fine-grained PAT", "Create a fine-grained PAT"),
            summary: text(
              "适合只授权指定仓库；创建页面会预填当前 Link Actions 所需权限。",
              "Best for selected repositories; the creation page pre-fills permissions required by the current Link Actions.",
            ),
            createCredentialUrl:
              "https://github.com/settings/personal-access-tokens/new?name=CodeShell+Link&description=Local+GitHub+connection+for+CodeShell&expires_in=90&contents=read&issues=write&pull_requests=read&metadata=read",
            docsUrl:
              "https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
            permissions: [
              { id: "contents", label: "Contents: read", level: "required" },
              { id: "issues", label: "Issues: write", level: "required" },
              { id: "pull_requests", label: "Pull requests: read", level: "required" },
              { id: "metadata", label: "Metadata: read", level: "required" },
            ],
            steps: [
              text(
                "选择资源所有者和允许 CodeShell 访问的仓库。",
                "Choose the resource owner and repositories CodeShell may access.",
              ),
              text(
                "确认预填权限，设置有效期并生成 Token。",
                "Review the pre-filled permissions, set an expiry, and generate the token.",
              ),
              text(
                "复制 Token，回到这里粘贴并验证。",
                "Copy the token, return here, and verify it.",
              ),
            ],
            note: text(
              "Token 只显示一次；建议设置有效期并仅选择必要仓库。",
              "The token is shown once; set an expiry and select only necessary repositories.",
            ),
          },
        ),
        browserAuth: {
          kind: "browser-oauth",
          flow: "device-code",
          displayName: text("在浏览器登录 GitHub", "Sign in to GitHub in your browser"),
          summary: text(
            "无需安装 gh。CodeShell 显示一次性验证码，你在 GitHub 完成授权后即可连接。",
            "No gh installation required. CodeShell shows a one-time code and connects after you approve access on GitHub.",
          ),
          docsUrl:
            "https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token",
          privacyNote: text(
            "授权页由 GitHub 托管；密码不经过 CodeShell。授权结果仅加密保存在当前设备。",
            "GitHub hosts the authorization page, so your password never passes through CodeShell. The resulting credential is encrypted only on this device.",
          ),
        },
        quickAuth: {
          kind: "cli-session",
          command: "gh",
          displayName: text("使用 GitHub CLI 登录", "Sign in with GitHub CLI"),
          summary: text(
            "直接复用本机 GitHub CLI 会话，不复制或保存 GitHub Token。",
            "Reuse the GitHub CLI session on this device without copying or storing its GitHub token.",
          ),
          installUrl: "https://cli.github.com/",
          privacyNote: text(
            "Link 仅保存一条本地绑定记录；每次 Action 都由 gh 执行。断开 Link 不会退出 gh。",
            "Link stores only a local binding; every Action runs through gh. Disconnecting Link does not sign gh out.",
          ),
        },
      },
      { ...managedOAuth("GitHub App"), id: "github-app" },
    ],
    actionIds: [
      "list_repositories",
      "get_readme",
      "get_file",
      "list_issues",
      "get_issue",
      "list_pull_requests",
      "get_pull_request",
      "create_issue",
    ],
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    category: "developer",
    description: text("查看项目和分配给你的 Issue。", "View projects and issues assigned to you."),
    brandText: "GL",
    icon: "github",
    accent: "orange",
    connectionMethods: [
      {
        ...localToken(
          "personal-access-token",
          text("GitLab 登录 / Personal access token", "GitLab sign-in / personal access token"),
          "Personal access token",
          "glpat-…",
          {
            title: text("创建 GitLab Access Token", "Create a GitLab access token"),
            summary: text(
              "只读项目和 Issue，使用 read_api 即可。",
              "The read_api scope is enough to read projects and issues.",
            ),
            createCredentialUrl:
              "https://gitlab.com/-/user_settings/personal_access_tokens?name=CodeShell%20Link&description=Local%20GitLab%20connection%20for%20CodeShell&scopes=read_api",
            docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
            permissions: [{ id: "read_api", label: "read_api", level: "required" }],
            steps: [
              text(
                "打开创建页并确认名称、有效期和 read_api 权限。",
                "Open the creation page and confirm the name, expiry, and read_api scope.",
              ),
              text("生成后立即复制 Token。", "Generate and immediately copy the token."),
              text(
                "回到 CodeShell 粘贴并验证账号。",
                "Return to CodeShell, paste it, and verify the account.",
              ),
            ],
          },
        ),
        browserAuth: {
          kind: "browser-oauth",
          flow: "device-code",
          displayName: text("在浏览器登录 GitLab", "Sign in to GitLab in your browser"),
          summary: text(
            "无需安装 glab；通过 GitLab 设备授权页完成登录。",
            "No glab installation required; complete sign-in on GitLab's device authorization page.",
          ),
          docsUrl: "https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow",
          privacyNote: text(
            "登录和授权都在 GitLab 完成，访问凭证只留在当前设备。",
            "Sign-in and approval happen on GitLab; the resulting credential stays only on this device.",
          ),
        },
        quickAuth: {
          kind: "cli-session",
          command: "glab",
          displayName: text("使用 GitLab CLI 登录", "Sign in with GitLab CLI"),
          summary: text(
            "通过浏览器授权 glab，并直接复用本机 CLI 会话，不导出 GitLab Token。",
            "Authorize glab in the browser and reuse its local session without exporting the GitLab token.",
          ),
          installUrl: "https://docs.gitlab.com/cli/",
          privacyNote: text(
            "Link 仅保存一条本地绑定记录；每次 Action 都由 glab 执行。断开 Link 不会退出 glab。",
            "Link stores only a local binding; every Action runs through glab. Disconnecting Link does not sign glab out.",
          ),
        },
      },
      managedOAuth("GitLab"),
    ],
    actionIds: ["list_projects", "list_issues"],
  },
  {
    id: "sentry",
    displayName: "Sentry",
    category: "developer",
    description: text("查看组织和项目。", "View organizations and projects."),
    brandText: "Se",
    icon: "conversation",
    accent: "rose",
    connectionMethods: [
      localToken(
        "auth-token",
        text("Organization auth token", "Organization auth token"),
        "Organization auth token",
        "sntrys_…",
        {
          title: text("创建 Sentry Auth Token", "Create a Sentry auth token"),
          summary: text(
            "优先通过组织的 Internal Integration 创建最小权限 Token。",
            "Prefer an organization internal integration for a least-privilege token.",
          ),
          createCredentialUrl: "https://sentry.io/settings/account/api/auth-tokens/",
          docsUrl: "https://docs.sentry.io/api/guides/create-auth-token/",
          permissions: [
            { id: "org:read", label: "org:read", level: "required" },
            { id: "project:read", label: "project:read", level: "required" },
          ],
          steps: [
            text(
              "有组织管理员权限时，优先创建 Internal Integration。",
              "If you administer the organization, create an internal integration first.",
            ),
            text("仅授予 org:read 和 project:read。", "Grant only org:read and project:read."),
            text(
              "复制生成的 Token，回到这里验证。",
              "Copy the generated token and verify it here.",
            ),
          ],
          note: text(
            "个人 Auth Token 也可使用，但组织 Token 更便于撤销和审计。",
            "A user auth token also works, but an organization token is easier to revoke and audit.",
          ),
        },
      ),
      managedOAuth("Sentry"),
    ],
    actionIds: ["list_organizations", "list_projects"],
  },
  {
    id: "vercel",
    displayName: "Vercel",
    category: "developer",
    description: text("查看项目和部署状态。", "View projects and deployment status."),
    brandText: "V",
    icon: "github",
    accent: "neutral",
    connectionMethods: [
      {
        ...localToken(
          "access-token",
          text("Vercel 登录 / Access token", "Vercel sign-in / access token"),
          "Access token",
          "Vercel access token",
          {
            title: text("创建 Vercel Access Token", "Create a Vercel access token"),
            summary: text(
              "创建只用于 CodeShell 的 Token，并选择正确的个人账号或 Team。",
              "Create a token only for CodeShell and select the correct personal account or team.",
            ),
            createCredentialUrl: "https://vercel.com/account/settings/tokens",
            docsUrl: "https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token",
            permissions: [
              { id: "account-scope", label: "Account / Team scope", level: "required" },
            ],
            steps: [
              text(
                "打开 Token 设置并创建一个 CodeShell 专用 Token。",
                "Open token settings and create a CodeShell-only token.",
              ),
              text(
                "选择需要访问的个人账号或 Team，并设置有效期。",
                "Choose the personal account or team to access and set an expiry.",
              ),
              text("复制 Token，回到这里验证。", "Copy the token and verify it here."),
            ],
          },
        ),
        quickAuth: {
          kind: "cli-session",
          command: "vercel",
          displayName: text("使用 Vercel CLI 登录", "Sign in with Vercel CLI"),
          summary: text(
            "通过官方设备授权复用本机 Vercel CLI 会话，不复制 Access Token。",
            "Use Vercel's official device authorization and reuse the local CLI session without copying an access token.",
          ),
          installUrl: "https://vercel.com/docs/cli",
          privacyNote: text(
            "Link 仅保存本地绑定；项目和部署读取都由 vercel api 执行。",
            "Link stores only a local binding; project and deployment reads run through vercel api.",
          ),
        },
      },
      managedOAuth("Vercel"),
    ],
    actionIds: ["list_projects", "list_deployments"],
  },
  {
    id: "slack",
    displayName: "Slack",
    category: "communication",
    description: text("列出频道并读取最近消息。", "List channels and read recent messages."),
    brandText: "S",
    icon: "conversation",
    accent: "fuchsia",
    connectionMethods: [
      localToken(
        "app-token",
        text("Slack App token", "Slack app token"),
        "Bot or user token",
        "xoxb-… / xoxp-…",
        {
          title: text("创建并安装 Slack App", "Create and install a Slack app"),
          summary: text(
            "Slack 不直接生成个人 Key；先创建 App、配置权限，再安装到工作区。",
            "Slack does not issue a simple personal key; create an app, configure scopes, then install it to a workspace.",
          ),
          createCredentialUrl: "https://api.slack.com/apps",
          docsUrl: "https://api.slack.com/tutorials/tracks/getting-a-token",
          permissions: [
            { id: "channels:read", label: "channels:read", level: "required" },
            { id: "channels:history", label: "channels:history", level: "required" },
            {
              id: "groups:read",
              label: "groups:read",
              level: "optional",
              description: text("需要列出私有频道时添加。", "Add to list private channels."),
            },
            {
              id: "groups:history",
              label: "groups:history",
              level: "optional",
              description: text(
                "需要读取私有频道消息时添加。",
                "Add to read private-channel history.",
              ),
            },
          ],
          steps: [
            text(
              "在 Slack API 创建 App，并选择目标工作区。",
              "Create an app in Slack API and choose the target workspace.",
            ),
            text(
              "在 OAuth & Permissions 添加 Bot Token Scopes。",
              "Add the bot token scopes under OAuth & Permissions.",
            ),
            text(
              "安装 App 到工作区；需要读消息的频道还要邀请该 App。",
              "Install the app, then invite it to channels whose history it should read.",
            ),
            text(
              "复制 Bot User OAuth Token（xoxb-）并回到这里验证。",
              "Copy the Bot User OAuth Token (xoxb-) and verify it here.",
            ),
          ],
        },
      ),
      managedOAuth("Slack"),
    ],
    actionIds: ["list_channels", "get_channel_history"],
  },
  {
    id: "notion",
    displayName: "Notion",
    category: "work",
    description: text(
      "搜索并读取已共享的页面和数据库。",
      "Search and read shared pages and databases.",
    ),
    brandText: "N",
    icon: "notes",
    accent: "neutral",
    connectionMethods: [
      {
        ...localToken(
          "internal-integration",
          text("Notion 登录 / Internal integration", "Notion sign-in / internal integration"),
          "Internal integration token",
          "ntn_… / secret_…",
          {
            title: text("创建 Notion Internal Integration", "Create a Notion internal integration"),
            summary: text(
              "创建 Integration 后，还必须把具体页面或数据库共享给它。",
              "After creating the integration, explicitly share pages or databases with it.",
            ),
            createCredentialUrl: "https://www.notion.so/profile/integrations",
            docsUrl: "https://developers.notion.com/guides/get-started/internal-connections",
            permissions: [{ id: "read-content", label: "Read content", level: "required" }],
            steps: [
              text(
                "创建 Internal Integration，并选择工作区。",
                "Create an internal integration and select the workspace.",
              ),
              text(
                "Capabilities 中只保留读取内容所需权限。",
                "Keep only the capability required to read content.",
              ),
              text(
                "在每个需要访问的页面中，通过 Connections 添加该 Integration。",
                "Add the integration under Connections on every page it should access.",
              ),
              text(
                "复制 Internal Integration Secret 并回到这里验证。",
                "Copy the internal integration secret and verify it here.",
              ),
            ],
            note: text(
              "没有共享给 Integration 的页面不会出现在搜索结果中。",
              "Pages not shared with the integration will not appear in search results.",
            ),
          },
        ),
        quickAuth: {
          kind: "cli-session",
          command: "ntn",
          displayName: text("使用 Notion CLI 登录", "Sign in with Notion CLI"),
          summary: text(
            "在浏览器选择 Notion 工作区，凭证由系统钥匙串保存。",
            "Choose a Notion workspace in the browser; the credential stays in the system keychain.",
          ),
          installUrl: "https://developers.notion.com/cli/get-started/overview",
          privacyNote: text(
            "Link 不读取 Notion Token；搜索和页面读取都由 ntn api 执行。",
            "Link never reads the Notion token; search and page reads run through ntn api.",
          ),
        },
      },
      managedOAuth("Notion"),
    ],
    actionIds: ["search", "get_page"],
  },
  {
    id: "linear",
    displayName: "Linear",
    category: "work",
    description: text("查看分配给你的 Issue 和团队。", "View assigned issues and teams."),
    brandText: "L",
    icon: "notes",
    accent: "indigo",
    connectionMethods: [
      localToken(
        "personal-api-key",
        text("Personal API key", "Personal API key"),
        "Personal API key",
        "lin_api_…",
        {
          title: text("创建 Linear Personal API Key", "Create a Linear personal API key"),
          summary: text(
            "个人本地连接使用 Personal API Key；面向其他用户的产品应升级 OAuth。",
            "Use a personal API key for a local personal connection; products for other users should use OAuth.",
          ),
          createCredentialUrl: "https://linear.app/settings/api",
          docsUrl: "https://linear.app/developers/graphql",
          permissions: [
            { id: "workspace-access", label: "Your workspace access", level: "required" },
          ],
          steps: [
            text(
              "打开 Linear 的 Security & access / API 设置。",
              "Open Linear Security & access / API settings.",
            ),
            text(
              "创建一个名为 CodeShell Link 的 Personal API Key。",
              "Create a personal API key named CodeShell Link.",
            ),
            text("复制 Key 并回到这里验证。", "Copy the key and verify it here."),
          ],
        },
      ),
      managedOAuth("Linear"),
    ],
    actionIds: ["list_issues", "list_teams"],
  },
  {
    id: "todoist",
    displayName: "Todoist",
    category: "work",
    description: text("查看项目和未完成任务。", "View projects and incomplete tasks."),
    brandText: "T",
    icon: "notes",
    accent: "red",
    connectionMethods: [
      {
        ...localToken(
          "developer-token",
          text("Todoist 登录 / Developer token", "Todoist sign-in / developer token"),
          "Developer API token",
          "Todoist API token",
          {
            title: text("获取 Todoist API Token", "Get a Todoist API token"),
            summary: text(
              "个人 API Token 位于 Todoist 的开发者集成设置中。",
              "Your personal API token is in Todoist's developer integrations settings.",
            ),
            createCredentialUrl: "https://app.todoist.com/app/settings/integrations/developer",
            docsUrl: "https://developer.todoist.com/",
            permissions: [{ id: "account-data", label: "Your Todoist account", level: "required" }],
            steps: [
              text(
                "打开 Settings → Integrations → Developer。",
                "Open Settings → Integrations → Developer.",
              ),
              text("找到 API token 并复制。", "Find and copy the API token."),
              text("回到这里粘贴并验证。", "Return here, paste it, and verify it."),
            ],
            note: text(
              "重置 Todoist API Token 后，旧连接会立即失效。",
              "Resetting the Todoist API token immediately invalidates the old connection.",
            ),
          },
        ),
        quickAuth: {
          kind: "cli-session",
          command: "td",
          displayName: text("使用 Todoist CLI 登录", "Sign in with Todoist CLI"),
          summary: text(
            "通过浏览器授权官方 td CLI；Link 默认申请只读 data:read。",
            "Authorize the official td CLI in the browser; Link requests the read-only data:read scope.",
          ),
          installUrl: "https://www.todoist.com/cli",
          privacyNote: text(
            "Token 保存在系统凭证管理器；Link 不导出它，项目和任务由 td 读取。",
            "The token stays in the system credential manager; Link never exports it and reads through td.",
          ),
        },
      },
      managedOAuth("Todoist"),
    ],
    actionIds: ["list_projects", "list_tasks"],
  },
  {
    id: "airtable",
    displayName: "Airtable",
    category: "work",
    description: text("查看 Base、数据表与字段结构。", "View bases, tables, and field schemas."),
    brandText: "A",
    icon: "notes",
    accent: "amber",
    connectionMethods: [
      localToken(
        "personal-access-token",
        text("Personal access token", "Personal access token"),
        "Personal access token",
        "pat…",
        {
          title: text(
            "创建 Airtable Personal Access Token",
            "Create an Airtable personal access token",
          ),
          summary: text(
            "权限和资源范围要同时配置；只选 CodeShell 需要读取的 Base。",
            "Configure both scopes and resources; select only bases CodeShell should read.",
          ),
          createCredentialUrl: "https://airtable.com/create/tokens",
          docsUrl: "https://airtable.com/developers/web/api/scopes",
          permissions: [{ id: "schema.bases:read", label: "schema.bases:read", level: "required" }],
          steps: [
            text("创建一个名为 CodeShell Link 的 PAT。", "Create a PAT named CodeShell Link."),
            text("添加 schema.bases:read scope。", "Add the schema.bases:read scope."),
            text(
              "在 Access 中选择允许读取的 Base 或 Workspace。",
              "Under Access, select allowed bases or workspaces.",
            ),
            text(
              "生成并复制 Token，回到这里验证。",
              "Generate and copy the token, then verify it here.",
            ),
          ],
        },
      ),
      managedOAuth("Airtable"),
    ],
    actionIds: ["list_bases", "list_tables"],
  },
  {
    id: "figma",
    displayName: "Figma",
    category: "design",
    description: text("读取文件结构摘要和评论。", "Read file structure summaries and comments."),
    brandText: "Fi",
    icon: "figma",
    accent: "violet",
    connectionMethods: [
      localToken(
        "personal-access-token",
        text("Personal access token", "Personal access token"),
        "Personal access token",
        "figd_…",
        {
          title: text("创建 Figma Personal Access Token", "Create a Figma personal access token"),
          summary: text(
            "为文件内容、评论和当前用户分别授予最小读取权限。",
            "Grant the minimum read scopes for file content, comments, and the current user.",
          ),
          createCredentialUrl: "https://www.figma.com/settings",
          docsUrl: "https://developers.figma.com/docs/rest-api/personal-access-tokens/",
          permissions: [
            { id: "current_user:read", label: "current_user:read", level: "required" },
            { id: "file_content:read", label: "file_content:read", level: "required" },
            { id: "file_comments:read", label: "file_comments:read", level: "required" },
          ],
          steps: [
            text(
              "打开 Figma Settings → Security → Personal access tokens。",
              "Open Figma Settings → Security → Personal access tokens.",
            ),
            text(
              "创建 Token，选择上方三个读取 scope，并设置有效期。",
              "Create a token, select the three read scopes above, and set an expiry.",
            ),
            text(
              "复制只显示一次的 Token，回到这里验证。",
              "Copy the one-time token and verify it here.",
            ),
          ],
          note: text(
            "Token 只能访问你的 Figma 账号本身有权限的文件。",
            "The token can only access files already available to your Figma account.",
          ),
        },
      ),
      { ...managedOAuth("Figma"), id: "figma-oauth" },
    ],
    actionIds: ["get_file", "get_comments"],
  },
];

export function getLinkProviderManifest(providerId: string): LinkProviderManifest | undefined {
  return LINK_PROVIDER_MANIFESTS.find((provider) => provider.id === providerId);
}

export function localizeLinkText(value: LinkLocalizedText, locale: "zh" | "en"): string {
  return value[locale];
}
