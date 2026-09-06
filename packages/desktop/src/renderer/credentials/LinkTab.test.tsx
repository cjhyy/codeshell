import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { buildLinkCatalog } from "./link-catalog";
import type { LocalLinkProviderView } from "../../preload/types";
import type { MaskedCredentialView } from "./types";

// The mini-DOM cannot host Radix portals, so dialogs render inline (mirrors
// PetLongTaskSection.test.tsx). Must run before LinkTab/DialogProvider load.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

const {
  buildCliLinkConnectionRequest,
  ChatGatewayTab,
  CliQuickAuthPanel,
  gatewayCapabilityLabels,
  gatewayToolNames,
  LinkTab,
  resolvePreferredLinkRuntime,
} = await import("./LinkTab");
const { DialogProvider } = await import("../ui/DialogProvider");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function reactChildText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactChildText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return reactChildText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function buttonWithLabel(container: HTMLElement, label: string): any {
  return findElements(container, "BUTTON").find(
    (button) => reactChildText(reactPropsOf(button).children) === label,
  );
}

function buttonWithAriaLabel(container: HTMLElement, label: string): any {
  return findElements(container, "BUTTON").find(
    (button) => reactPropsOf(button)["aria-label"] === label,
  );
}

const LINK_PROVIDER_FIXTURES: LocalLinkProviderView[] = [
  {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    description: { zh: "读取仓库、Issue 和 PR。", en: "Read repositories, issues, and PRs." },
    brandText: "GH",
    icon: "github",
    accent: "neutral",
    featured: true,
    tokenLabel: "Fine-grained PAT",
    tokenPlaceholder: "github_pat_…",
    connectionMethods: [
      {
        id: "fine-grained-pat",
        displayName: { zh: "GitHub 登录 / PAT", en: "GitHub sign-in / PAT" },
        executionRuntime: "local",
        secretLocation: "device",
        authKind: "token",
        availability: "available",
        tokenLabel: "Fine-grained PAT",
        tokenPlaceholder: "github_pat_…",
        authGuide: {
          title: { zh: "创建 Fine-grained PAT", en: "Create a fine-grained PAT" },
          summary: { zh: "只授权必要仓库。", en: "Authorize only necessary repositories." },
          createCredentialUrl:
            "https://github.com/settings/personal-access-tokens/new?contents=read&issues=write&pull_requests=read",
          docsUrl: "https://docs.github.com/authentication",
          permissions: [{ id: "contents", label: "Contents: read", level: "required" }],
          steps: [
            { zh: "选择仓库。", en: "Choose repositories." },
            { zh: "生成 Token。", en: "Generate the token." },
            { zh: "粘贴并验证。", en: "Paste and verify it." },
          ],
        },
        quickAuth: {
          kind: "cli-session",
          command: "gh",
          displayName: { zh: "使用 GitHub CLI 登录", en: "Sign in with GitHub CLI" },
          summary: { zh: "复用本机 CLI 会话。", en: "Reuse the local CLI session." },
          installUrl: "https://cli.github.com/",
          privacyNote: {
            zh: "只保存本地绑定，每次 Action 都由 gh 执行。",
            en: "Only a local binding is stored; gh executes every Action.",
          },
        },
      },
      {
        id: "github-app",
        displayName: { zh: "GitHub App 官方授权", en: "GitHub App OAuth" },
        executionRuntime: "server",
        secretLocation: "server",
        authKind: "oauth",
        availability: "coming-soon",
      },
    ],
    actionIds: ["list_repositories"],
    actions: [
      { id: "list_repositories", title: "列出仓库", description: "列出仓库", risk: "read" },
    ],
  },
  {
    id: "figma",
    displayName: "Figma",
    category: "design",
    description: { zh: "读取设计文件。", en: "Read design files." },
    brandText: "Fi",
    icon: "figma",
    accent: "violet",
    tokenLabel: "Personal access token",
    tokenPlaceholder: "figd_…",
    connectionMethods: [
      {
        id: "personal-access-token",
        displayName: { zh: "Personal access token", en: "Personal access token" },
        executionRuntime: "local",
        secretLocation: "device",
        authKind: "token",
        availability: "available",
        tokenLabel: "Personal access token",
        tokenPlaceholder: "figd_…",
        authGuide: {
          title: { zh: "创建 Figma Token", en: "Create a Figma token" },
          summary: { zh: "选择最小读取权限。", en: "Choose minimum read scopes." },
          createCredentialUrl: "https://www.figma.com/settings",
          docsUrl: "https://developers.figma.com/docs/rest-api/personal-access-tokens/",
          permissions: [{ id: "file_content:read", label: "file_content:read", level: "required" }],
          steps: [
            { zh: "打开设置。", en: "Open settings." },
            { zh: "创建 Token。", en: "Create a token." },
            { zh: "粘贴并验证。", en: "Paste and verify it." },
          ],
        },
      },
      {
        id: "figma-oauth",
        displayName: { zh: "Figma 官方授权", en: "Figma OAuth" },
        executionRuntime: "server",
        secretLocation: "server",
        authKind: "oauth",
        availability: "coming-soon",
      },
    ],
    actionIds: ["get_file"],
    actions: [{ id: "get_file", title: "读取文件", description: "读取文件", risk: "read" }],
  },
];

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("LinkTab integrations", () => {
  test("distinguishes proactive delivery from direct send while Gateway is stopped", () => {
    const labels = gatewayCapabilityLabels(
      {
        inbound: { text: true, attachments: [] },
        outbound: {
          text: true,
          proactive: true,
          direct: true,
          button: "link",
          attachments: [],
        },
      },
      ((key: string) => key) as never,
    );

    expect(labels.outbound).toContain("ext.link.gatewayCapability.proactive");
    expect(labels.outbound).toContain("ext.link.gatewayCapability.direct");
    expect(
      gatewayToolNames({
        capabilities: {
          inbound: { text: true, attachments: [] },
          outbound: {
            text: true,
            proactive: true,
            direct: true,
            button: "link",
            attachments: [],
          },
        },
        proactiveReady: false,
      }),
    ).toBe("GatewayReply");
  });

  test("prefers a usable local connection and falls back to the server", () => {
    const local: MaskedCredentialView = {
      id: "link-github-fine-grained-pat",
      type: "link",
      label: "GitHub local",
      hasSecret: true,
      meta: { linkProvider: "github", linkExecutionRuntime: "local" },
    };
    const server: MaskedCredentialView = {
      id: "github-oauth",
      type: "oauth",
      label: "GitHub server",
      hasSecret: true,
      oauthStatus: { state: "valid" },
      meta: { oauthProvider: "github", linkExecutionRuntime: "server" },
    };

    expect(resolvePreferredLinkRuntime([server, local], "github")).toBe("local");
    expect(
      resolvePreferredLinkRuntime(
        [server, { ...local, oauthStatus: { state: "expired" } }],
        "github",
      ),
    ).toBe("server");
    expect(resolvePreferredLinkRuntime([server, { ...local, hasSecret: false }], "github")).toBe(
      "server",
    );
    expect(
      resolvePreferredLinkRuntime(
        [
          { ...server, oauthStatus: { state: "invalid" } },
          { ...local, hasSecret: false },
        ],
        "github",
      ),
    ).toBeNull();
  });

  test.each([undefined, { state: "valid" as const }])(
    "shows an unreadable saved Link as unavailable despite cached verification (%j)",
    async (oauthStatus) => {
      ensureMiniDom();
      const credentials: MaskedCredentialView[] = [
        {
          id: "github-local",
          type: "link",
          label: "GitHub local",
          hasSecret: false,
          oauthStatus,
          meta: {
            linkProvider: "github",
            linkExecutionRuntime: "local",
            linkAccountLabel: "previous-account",
            linkExecutionBackend: "cli",
            linkResourceLabels: ["previous-repository"],
          },
        },
        {
          id: "figma-local",
          type: "link",
          label: "Figma local",
          hasSecret: true,
          meta: {
            linkProvider: "figma",
            linkExecutionRuntime: "local",
            linkAccountLabel: "current-account",
          },
        },
      ];
      Object.assign(window, {
        codeshell: {
          credentials: { list: async () => credentials },
          links: { listLocalProviders: async () => LINK_PROVIDER_FIXTURES },
        },
      });
      const container = document.createElement("div") as unknown as HTMLElement;
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <DialogProvider>
            <LinkTab cwd="/repo" />
          </DialogProvider>,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const github = findElements(container, "ARTICLE").find(
        (card) =>
          reactPropsOf(card)["data-link-integration"] === "github" &&
          reactPropsOf(card)["data-link-runtime"] === "local",
      );
      expect(github).toBeDefined();
      const badge = findElements(github, "SPAN").find(
        (span) => reactChildText(reactPropsOf(span).children) === "凭据不可用",
      );
      expect(badge).toBeDefined();
      expect(reactPropsOf(badge).className).toContain("text-status-err");
      const githubText = reactChildText(reactPropsOf(github).children);
      expect(githubText).toContain("凭据缺失或当前设备无法读取，请重新连接。");
      expect(githubText).not.toContain("已验证");
      expect(githubText).not.toContain("previous-repository");
      expect(githubText).not.toContain("通过本机 gh");
      expect(buttonWithLabel(github, "重新连接")).toBeDefined();
      expect(
        findElements(container, "DIV").some(
          (div) => reactChildText(reactPropsOf(div).children) === "1已连接",
        ),
      ).toBe(true);

      const connected = buttonWithLabel(container, "已连接");
      await act(async () => {
        reactPropsOf(connected).onClick();
        await flushMicrotasks();
      });
      const cards = findElements(container, "ARTICLE");
      expect(cards).toHaveLength(1);
      expect(reactPropsOf(cards[0])["data-link-integration"]).toBe("figma");
      expect(reactChildText(reactPropsOf(cards[0]).children)).toContain("连接账号 current-account");
    },
  );

  test("renders Link apps and the independent Chat Gateway, then starts configured channels", async () => {
    ensureMiniDom();
    let starts = 0;
    let dingTalkSetupLoads = 0;
    const openedUrls: string[] = [];
    Object.assign(window, {
      codeshell: {
        imGateway: {
          status: async () => ({
            running: false,
            configPath: "/home/user/.code-shell/im-gateway/config.json",
            configExists: true,
            channels: ["telegram"],
            wechatConnected: false,
            channelStatuses: [
              {
                channel: "telegram" as const,
                enabled: true,
                state: "ready" as const,
              },
              {
                channel: "wechat" as const,
                enabled: true,
                state: "ready" as const,
                capabilities: {
                  inbound: { text: true, attachments: ["image", "audio", "file"] },
                  outbound: {
                    text: true,
                    proactive: true,
                    direct: true,
                    button: "none" as const,
                    attachments: ["image", "audio", "file"],
                  },
                },
                proactiveReady: false,
                proactiveReason: "awaiting-inbound-context" as const,
              },
              {
                channel: "dingtalk" as const,
                enabled: false,
                state: "disabled" as const,
              },
            ],
          }),
          start: async () => {
            starts += 1;
            return {
              running: true,
              configPath: "/home/user/.code-shell/im-gateway/config.json",
              configExists: true,
              channels: ["telegram"],
              wechatConnected: false,
            };
          },
          stop: async () => undefined,
          ensureConfig: async () => "/home/user/.code-shell/im-gateway/config.json",
          getDingTalkSetup: async () => {
            dingTalkSetupLoads += 1;
            return {
              enabled: false,
              clientId: "",
              hasClientSecret: false,
              secretStorage: "missing",
              allowedConversationIds: [],
              allowedUserIds: [],
            };
          },
          saveDingTalkSetup: async () => undefined,
          startDingTalkDiscovery: async () => ({ discoveryId: "discovery-1" }),
          stopDingTalkDiscovery: async () => false,
          loginWechat: async () => ({
            accountId: "wechat-owner",
            configPath: "/home/user/.code-shell/im-gateway/config.json",
          }),
          cancelWechatLogin: async () => false,
          submitWechatVerification: async () => true,
          onEvent: () => () => undefined,
        },
        openInEditor: async () => "editor",
        openPath: async (path: string) => path,
        openExternal: async (url: string) => void openedUrls.push(url),
        credentials: { list: async () => [] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => ({
            providerId: "github",
            command: "gh",
            installed: false,
            authenticated: false,
          }),
          connectCli: async () => undefined,
          connectLocal: async () => undefined,
        },
        mcpOAuth: {
          refresh: async () => undefined,
          login: async () => undefined,
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <LinkTab cwd="/repo" />
          <ChatGatewayTab />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const githubCards = findElements(container, "ARTICLE").filter(
      (article) => reactPropsOf(article)["data-link-integration"] === "github",
    );
    expect(githubCards.map((card) => reactPropsOf(card)["data-link-runtime"]).sort()).toEqual([
      "local",
      "server",
    ]);

    const toggleChannels = buttonWithAriaLabel(container, "展开或收起支持的聊天渠道");
    expect(toggleChannels).toBeDefined();
    await act(async () => {
      reactPropsOf(toggleChannels).onClick();
      await flushMicrotasks();
    });
    const wechatHint = findElements(container, "P").find(
      (paragraph) => reactPropsOf(paragraph)["data-gateway-proactive-hint"] === "wechat",
    );
    expect(reactChildText(reactPropsOf(wechatHint).children)).toBe(
      "主动发送暂不可用：请先从微信给 Mimi 发一条消息以刷新会话上下文。",
    );
    expect(buttonWithLabel(container, "连接个人微信")).toBeDefined();
    const configureDingTalk = buttonWithAriaLabel(container, "配置钉钉");
    expect(configureDingTalk).toBeDefined();
    await act(async () => {
      reactPropsOf(configureDingTalk).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(dingTalkSetupLoads).toBe(1);
    const telegramSetup = buttonWithAriaLabel(container, "Telegram：打开官方配置页");
    expect(telegramSetup).toBeDefined();
    await act(async () => {
      reactPropsOf(telegramSetup).onClick();
      await flushMicrotasks();
    });
    expect(openedUrls).toEqual(["https://t.me/BotFather"]);
    const start = buttonWithLabel(container, "启动");
    expect(start).toBeDefined();
    await act(async () => {
      reactPropsOf(start).onClick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushMicrotasks();
    });
    expect(starts).toBe(1);
    expect(buttonWithLabel(container, "停止")).toBeDefined();
  });

  test("keeps legacy link credentials without provider meta visible and deletable", async () => {
    ensureMiniDom();
    const removals: Array<[string, string, string]> = [];
    let all: MaskedCredentialView[] = [
      { id: "team-notion-token", type: "link", label: "旧版 Notion", hasSecret: true },
    ];
    Object.assign(window, {
      codeshell: {
        openExternal: async () => undefined,
        credentials: {
          list: async () => all,
          remove: async (cwd: string, scope: string, id: string) => {
            removals.push([cwd, scope, id]);
            all = all.filter((credential) => credential.id !== id);
          },
        },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => ({
            providerId: "github",
            command: "gh",
            installed: false,
            authenticated: false,
          }),
          connectCli: async () => undefined,
          connectLocal: async () => undefined,
        },
        mcpOAuth: {
          refresh: async () => undefined,
          login: async () => undefined,
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <LinkTab cwd="/repo" />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const legacyRow = findElements(container, "DIV").find(
      (node) => reactPropsOf(node)["data-link-legacy-credential"] === "team-notion-token",
    );
    expect(legacyRow).toBeDefined();
    expect(reactChildText(reactPropsOf(legacyRow).children)).toContain("旧版 Notion");

    const remove = buttonWithLabel(container, "删除");
    expect(remove).toBeDefined();
    await act(async () => {
      reactPropsOf(remove).onClick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushMicrotasks();
    });
    expect(removals).toEqual([["/repo", "user", "team-notion-token"]]);
    expect(
      findElements(container, "DIV").some(
        (node) => reactPropsOf(node)["data-link-legacy-credential"] === "team-notion-token",
      ),
    ).toBe(false);
  });

  test("connects a local method through links.connectLocal with the pasted secret", async () => {
    ensureMiniDom();
    const connectRequests: unknown[] = [];
    let cliStatusCalls = 0;
    Object.assign(window, {
      codeshell: {
        openExternal: async () => undefined,
        credentials: { list: async () => [] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => {
            cliStatusCalls += 1;
            return {
              providerId: "github",
              command: "gh",
              installed: false,
              authenticated: false,
            };
          },
          connectCli: async () => undefined,
          connectLocal: async (request: unknown) => {
            connectRequests.push(request);
            return { identity: { label: "octocat" } };
          },
        },
        mcpOAuth: {
          refresh: async () => undefined,
          login: async () => undefined,
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <LinkTab cwd="/repo" />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const githubLocalCard = findElements(container, "ARTICLE").find(
      (article) =>
        reactPropsOf(article)["data-link-integration"] === "github" &&
        reactPropsOf(article)["data-link-runtime"] === "local",
    );
    if (!githubLocalCard) throw new Error("missing GitHub local card");
    const connect = buttonWithLabel(githubLocalCard, "连接本地");
    expect(connect).toBeDefined();
    await act(async () => {
      reactPropsOf(connect).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(cliStatusCalls).toBe(1);
    const secretInput = findElements(container, "INPUT").find(
      (input) => reactPropsOf(input).id === "link-local-secret",
    );
    expect(secretInput).toBeDefined();
    await act(async () => {
      reactPropsOf(secretInput).onChange({ target: { value: "github_pat_local" } });
      await flushMicrotasks();
    });

    // The card trigger and the dialog submit share the "连接本地" label; the
    // dialog renders after the sections, so the submit is the last match.
    const saveButtons = findElements(container, "BUTTON").filter(
      (button) => reactChildText(reactPropsOf(button).children) === "连接本地",
    );
    const save = saveButtons[saveButtons.length - 1];
    expect(reactPropsOf(save).disabled).toBe(false);
    await act(async () => {
      reactPropsOf(save).onClick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushMicrotasks();
    });

    expect(connectRequests).toEqual([
      {
        cwd: "/repo",
        providerId: "github",
        methodId: "fine-grained-pat",
        label: "GitHub · GitHub 登录 / PAT",
        token: "github_pat_local",
        existingId: undefined,
      },
    ]);
  });

  test("offers a zero-copy CLI session before the manual token fallback", async () => {
    ensureMiniDom();
    const github = buildLinkCatalog(LINK_PROVIDER_FIXTURES, "zh")
      .flatMap((category) => category.items)
      .find((item) => item.id === "github");
    const quickAuth = github?.connectionMethods.find(
      (method) => method.executionRuntime === "local",
    )?.quickAuth;
    if (!quickAuth) throw new Error("missing GitHub CLI fixture");
    let connectClicks = 0;
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CliQuickAuthPanel
          providerName="GitHub"
          quickAuth={quickAuth}
          status={{
            providerId: "github",
            command: "gh",
            installed: true,
            authenticated: true,
            account: "octocat",
          }}
          checking={false}
          busy={false}
          onConnect={() => {
            connectClicks += 1;
          }}
          onInstall={() => undefined}
        />,
      );
      await flushMicrotasks();
    });
    expect(buttonWithLabel(container, "使用 @octocat 连接")).toBeDefined();
    expect(
      findElements(container, "P").some(
        (paragraph) => reactChildText(reactPropsOf(paragraph).children) === "使用 GitHub CLI 登录",
      ),
    ).toBe(true);
    const useCli = buttonWithLabel(container, "使用 @octocat 连接");
    await act(async () => {
      reactPropsOf(useCli).onClick();
      await flushMicrotasks();
    });
    expect(connectClicks).toBe(1);
    expect(
      buildCliLinkConnectionRequest({
        authenticated: true,
        cwd: "/repo",
        providerId: "github",
        methodId: "fine-grained-pat",
        label: "GitHub local",
      }),
    ).toEqual({
      cwd: "/repo",
      providerId: "github",
      methodId: "fine-grained-pat",
      label: "GitHub local",
      existingId: undefined,
      loginIfNeeded: false,
    });
  });

  test("downloads a supported missing CLI inside CodeShell instead of opening an install page", async () => {
    ensureMiniDom();
    const github = buildLinkCatalog(LINK_PROVIDER_FIXTURES, "zh")
      .flatMap((category) => category.items)
      .find((item) => item.id === "github");
    const quickAuth = github?.connectionMethods.find(
      (method) => method.executionRuntime === "local",
    )?.quickAuth;
    if (!quickAuth) throw new Error("missing GitHub CLI fixture");
    let managedInstalls = 0;
    let externalInstalls = 0;
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CliQuickAuthPanel
          providerName="GitHub"
          quickAuth={quickAuth}
          status={{
            providerId: "github",
            command: "gh",
            installed: false,
            authenticated: false,
          }}
          installStatus={{
            providerId: "github",
            supported: true,
            managedInstalled: false,
          }}
          checking={false}
          busy={false}
          onConnect={() => undefined}
          onManagedInstall={() => {
            managedInstalls += 1;
          }}
          onInstall={() => {
            externalInstalls += 1;
          }}
        />,
      );
      await flushMicrotasks();
    });

    const download = buttonWithLabel(container, "下载并登录 gh");
    expect(download).toBeDefined();
    await act(async () => {
      reactPropsOf(download).onClick();
      await flushMicrotasks();
    });
    expect(managedInstalls).toBe(1);
    expect(externalInstalls).toBe(0);
  });

  test("localizes provider content without duplicating it in the renderer", () => {
    const zh = buildLinkCatalog(LINK_PROVIDER_FIXTURES, "zh");
    const en = buildLinkCatalog(LINK_PROVIDER_FIXTURES, "en");
    expect(zh[0]?.items[0]?.description).toBe("读取仓库、Issue 和 PR。");
    expect(en[0]?.items[0]?.description).toBe("Read repositories, issues, and PRs.");
    expect(zh.flatMap((category) => category.items)).toHaveLength(2);
  });

  test("reloads invalid_grant metadata after refresh rejection and relogs with the same id", async () => {
    ensureMiniDom();
    const figma = LINK_PROVIDER_FIXTURES.find((item) => item.id === "figma");
    if (!figma) throw new Error("missing Figma catalog fixture");
    const serverMethod = figma.connectionMethods.find(
      (method) => method.executionRuntime === "server",
    );
    if (!serverMethod) throw new Error("missing Figma server method fixture");
    const previousProfileId = serverMethod.oauthProfileId;
    const previousAvailability = serverMethod.availability;
    serverMethod.oauthProfileId = "figma-profile";
    serverMethod.availability = "available";

    let invalidGrant = false;
    const loginInputs: unknown[] = [];
    const credential = (): MaskedCredentialView => ({
      id: "figma-oauth",
      type: "oauth",
      label: "Figma OAuth",
      hasSecret: true,
      oauthStatus: { state: "expired" },
      meta: {
        oauthProvider: "figma",
        ...(invalidGrant ? { lastRefreshErrorCode: "invalid_grant" as const } : {}),
      },
    });
    Object.assign(window, {
      codeshell: {
        imGateway: {
          status: async () => ({
            running: false,
            configPath: "/home/user/.code-shell/im-gateway/config.json",
            configExists: false,
            channels: [],
            wechatConnected: false,
          }),
          start: async () => undefined,
          stop: async () => undefined,
          ensureConfig: async () => "/home/user/.code-shell/im-gateway/config.json",
          loginWechat: async () => ({
            accountId: "wechat-owner",
            configPath: "/home/user/.code-shell/im-gateway/config.json",
          }),
          cancelWechatLogin: async () => false,
          submitWechatVerification: async () => true,
          onEvent: () => () => undefined,
        },
        openInEditor: async () => "editor",
        openPath: async (path: string) => path,
        openExternal: async () => undefined,
        credentials: { list: async () => [credential()] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => ({
            providerId: "github",
            command: "gh",
            installed: false,
            authenticated: false,
          }),
          connectCli: async () => undefined,
          connectLocal: async () => undefined,
        },
        mcpOAuth: {
          refresh: async () => {
            invalidGrant = true;
            throw new Error("OAuth credential requires login");
          },
          login: async (input: unknown) => {
            loginInputs.push(input);
            return { credential: credential() };
          },
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    try {
      await act(async () => {
        root?.render(
          <DialogProvider>
            <LinkTab cwd="/repo" />
          </DialogProvider>,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const refresh = buttonWithLabel(container, "刷新");
      expect(refresh).toBeDefined();
      await act(async () => {
        reactPropsOf(refresh).onClick();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const relogin = buttonWithLabel(container, "重新登录");
      expect(relogin).toBeDefined();
      await act(async () => {
        reactPropsOf(relogin).onClick();
        await flushMicrotasks();
      });
      expect(loginInputs).toEqual([
        { source: "catalog", profileId: "figma-profile", credentialId: "figma-oauth" },
      ]);
    } finally {
      serverMethod.oauthProfileId = previousProfileId;
      serverMethod.availability = previousAvailability;
    }
  });

  test("probes the CLI on page entry and flags a stale card when the live account differs", async () => {
    ensureMiniDom();
    const credentials: MaskedCredentialView[] = [
      {
        id: "github-local",
        type: "link",
        label: "GitHub local",
        hasSecret: true,
        meta: {
          linkProvider: "github",
          linkExecutionRuntime: "local",
          linkExecutionBackend: "cli",
          linkAccountId: "cjhyy",
          linkAccountLabel: "cjhyy",
          linkLastVerifiedAt: "2026-09-06T05:41:00.000Z",
        },
      },
    ];
    let cliStatusCalls = 0;
    Object.assign(window, {
      codeshell: {
        openExternal: async () => undefined,
        credentials: { list: async () => credentials },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => {
            cliStatusCalls += 1;
            return {
              providerId: "github",
              command: "gh",
              installed: true,
              authenticated: true,
              account: "someone-else",
            };
          },
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <LinkTab cwd="/repo" />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    // The card must probe on entry, without the connect dialog being opened.
    expect(cliStatusCalls).toBe(1);

    const github = findElements(container, "ARTICLE").find(
      (card) =>
        reactPropsOf(card)["data-link-integration"] === "github" &&
        reactPropsOf(card)["data-link-runtime"] === "local",
    );
    if (!github) throw new Error("missing GitHub local card");
    const liveness = findElements(github, "DIV").find(
      (node) => reactPropsOf(node)["data-link-liveness"] === "github",
    );
    expect(reactPropsOf(liveness ?? {})["data-link-liveness-state"]).toBe("mismatch");

    // The stored binding marker must survive an out-of-band probe: LinkAction
    // treats any change to it as a disconnect.
    expect(credentials[0]!.meta?.linkLastVerifiedAt).toBe("2026-09-06T05:41:00.000Z");
  });

  test("reports unknown, not failure, when the CLI probe cannot confirm the account", async () => {
    ensureMiniDom();
    const credentials: MaskedCredentialView[] = [
      {
        id: "github-local",
        type: "link",
        label: "GitHub local",
        hasSecret: true,
        meta: {
          linkProvider: "github",
          linkExecutionRuntime: "local",
          linkExecutionBackend: "cli",
          linkAccountId: "cjhyy",
          linkAccountLabel: "cjhyy",
        },
      },
    ];
    Object.assign(window, {
      codeshell: {
        openExternal: async () => undefined,
        credentials: { list: async () => credentials },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          cliStatus: async () => {
            throw new Error("network unreachable");
          },
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <LinkTab cwd="/repo" />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const github = findElements(container, "ARTICLE").find(
      (card) =>
        reactPropsOf(card)["data-link-integration"] === "github" &&
        reactPropsOf(card)["data-link-runtime"] === "local",
    );
    if (!github) throw new Error("missing GitHub local card");
    const liveness = findElements(github, "DIV").find(
      (node) => reactPropsOf(node)["data-link-liveness"] === "github",
    );
    // A failed probe is not proof of a signed-out account.
    expect(reactPropsOf(liveness ?? {})["data-link-liveness-state"]).toBe("unknown");
  });
});
