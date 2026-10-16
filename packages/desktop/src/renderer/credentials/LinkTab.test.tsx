import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { buildLinkCatalog } from "./link-catalog";
import type { CliLinkStatusView, LocalLinkProviderView } from "../../preload/types";
import type { MaskedCredentialView } from "./types";
import type { LinkSnapshot } from "../../../../link/src/management-types";

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
  resolveCliLiveness,
  resolvePreferredLinkRuntime,
} = await import("./LinkTab");
const { DialogProvider } = await import("../ui/DialogProvider");
const { LinkConnectionDialog } = await import("./LinkConnectionDialog");
const { FigmaConnectionCard } = await import("./FigmaConnectionCard");
const { LinkProviderCard } = await import("./LinkProviderCard");
const { useRemoteLinkSnapshot } = await import("./RemoteLinkSection");
const { Github, Figma } = await import("lucide-react");

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
    (button) =>
      reactPropsOf(button)["aria-label"] === label ||
      reactChildText(reactPropsOf(button).children) === label,
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

// Exercise the actual service projection; only its public remote catalog read is
// supplied locally. No authorization, provider request, or credential is created.
async function projectedCatalog(remoteIds: string[]): Promise<LinkSnapshot["providers"]> {
  const { CredentialStore, PlaintextCipher } = await import("@cjhyy/code-shell-core");
  const { createLinkService } = await import("../../../../server/src/links/service");
  const cwd = mkdtempSync(join(tmpdir(), "link-tab-catalog-"));
  const service = createLinkService({
    cwd,
    store: new CredentialStore(cwd, new PlaintextCipher(), join(cwd, "user")),
    remoteLink: () => ({
      issuer: "https://fixture.invalid",
      clientId: "fixture-client",
      redirectUri: "https://fixture.invalid/callback",
    }),
    readRemoteCatalog: async () => remoteIds,
  });
  try {
    await service.refreshRemoteCatalog({ ownerId: "fixture-owner", authorize: () => true });
    return service.snapshot().providers;
  } finally {
    service.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function visibleElements(node: unknown, tagName: string): any[] {
  if (reactPropsOf(node ?? {}).hidden) return [];
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => visibleElements(child, tagName)),
  ];
}

async function expandProvider(container: HTMLElement, id: string) {
  const card = findElements(container, "ARTICLE").find(
    (node) => reactPropsOf(node)["data-link-provider-card"] === id,
  );
  expect(card).toBeDefined();
  const toggle = findElements(card, "BUTTON").find(
    (node) => reactPropsOf(node)["data-link-provider-toggle"] !== undefined,
  );
  if (!reactPropsOf(toggle)["aria-expanded"])
    await act(async () => {
      reactPropsOf(toggle).onClick();
      await flushMicrotasks();
    });
  return card;
}
function providerCards(container: HTMLElement) {
  return visibleElements(container, "ARTICLE").filter(
    (node) => reactPropsOf(node)["data-link-provider-card"],
  );
}
function methodRows(container: HTMLElement, provider?: string, runtime?: string) {
  return findElements(container, "SECTION").filter(
    (node) =>
      reactPropsOf(node)["data-link-method-provider"] &&
      (!provider || reactPropsOf(node)["data-link-method-provider"] === provider) &&
      (!runtime || reactPropsOf(node)["data-link-runtime"] === runtime),
  );
}

async function renderProjectedCatalog(
  providers: LinkSnapshot["providers"],
  credentials: MaskedCredentialView[] = [],
  connections: LinkSnapshot["connections"] = [],
  failures: {
    providers?: boolean;
    snapshot?: boolean;
    remoteCatalog?: NonNullable<LinkSnapshot["remoteCatalog"]>["state"];
    pendingSnapshot?: Promise<LinkSnapshot>;
  } = {},
) {
  ensureMiniDom();
  Object.assign(window, {
    codeshell: {
      credentials: { list: async () => credentials },
      links: {
        listLocalProviders: async () => {
          if (failures.providers) throw new Error("Provider directory unreachable");
          return projectedCatalog([]);
        },
        remoteSnapshot: async () => {
          if (failures.snapshot) throw new Error("Link service unreachable");
          if (failures.pendingSnapshot) return failures.pendingSnapshot;
          return {
            providers,
            connections,
            revision: "fixture",
            capabilities: { token: true, cliBinding: true, deviceAuth: false, remoteAuth: true },
            remoteServer: { issuer: "https://fixture.invalid" },
            ...(failures.remoteCatalog ? { remoteCatalog: { state: failures.remoteCatalog } } : {}),
          };
        },
        cliStatus: async () => ({
          installed: true,
          authenticated: true,
          command: "gh",
          account: "fixture-cli",
        }),
      },
    },
  });
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DialogProvider>
        <LinkTab cwd="/fixture" />
      </DialogProvider>,
    );
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return container;
}

let root: Root | null = null;

function cliBinding(id: string, accountId = "42"): MaskedCredentialView {
  return {
    id,
    type: "link",
    label: "GitHub CLI",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkConnectionMethod: "fine-grained-pat",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "cli",
      linkAccountId: accountId,
      linkAccountLabel: "cjhyy",
      linkLastVerifiedAt: "2026-09-06T05:41:00.000Z",
    },
  };
}

async function connectionStatusFixture(
  options: {
    credentials?: MaskedCredentialView[];
    connections?: LinkSnapshot["connections"];
    read?: (cwd: string) => Promise<MaskedCredentialView[]>;
    probe?: (cwd: string) => Promise<CliLinkStatusView>;
    snapshot?: (cwd: string) => Promise<void>;
  } = {},
) {
  ensureMiniDom();
  const providers = await projectedCatalog(["github"]);
  const calls = {
    reads: [] as string[],
    catalogs: 0,
    snapshots: [] as Array<[string, boolean]>,
    probes: [] as string[],
    mutations: 0,
  };
  const mutation = async () => {
    calls.mutations++;
    throw new Error("Status refresh cannot mutate authorization");
  };
  Object.assign(window, {
    codeshell: {
      credentials: {
        list: async (cwd: string) => {
          calls.reads.push(cwd);
          return options.read ? options.read(cwd) : (options.credentials ?? [cliBinding("cli")]);
        },
      },
      links: {
        listLocalProviders: async () => {
          calls.catalogs++;
          return providers;
        },
        remoteSnapshot: async (cwd: string, force = false) => {
          calls.snapshots.push([cwd, force]);
          await options.snapshot?.(cwd);
          return {
            providers,
            connections: options.connections ?? [],
            revision: "fixture",
            remoteCatalog: { state: "ready" },
            capabilities: { token: true, cliBinding: true, deviceAuth: false },
          };
        },
        cliStatus: async (_providerId: string, cwd: string) => {
          calls.probes.push(cwd);
          return options.probe
            ? options.probe(cwd)
            : {
                providerId: "github",
                command: "gh",
                installed: true,
                authenticated: true,
                account: "cjhyy",
                accountId: "42",
              };
        },
        authorizationStart: mutation,
        remoteDisconnect: mutation,
      },
      mcpOAuth: { login: mutation, refresh: mutation, logout: mutation },
    },
  });
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  const renderAt = async (cwd = "/repo") => {
    await act(async () => {
      root!.render(
        <DialogProvider>
          <LinkTab cwd={cwd} />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
  };
  await renderAt();
  return { container, calls, renderAt };
}

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
  test("renders one shared provider entry with collapsed connection management and keeps search/filter", async () => {
    const credentials: MaskedCredentialView[] = [
      {
        id: "saved-github",
        type: "link",
        label: "GitHub account",
        hasSecret: true,
        meta: {
          linkProvider: "github",
          linkExecutionRuntime: "local",
          linkConnectionMethod: "fine-grained-pat",
        },
      },
      {
        id: "saved-figma",
        type: "link",
        label: "Figma account",
        hasSecret: true,
        meta: {
          linkProvider: "figma",
          linkExecutionRuntime: "local",
          linkConnectionMethod: "personal-access-token",
        },
      },
    ];
    const container = await renderProjectedCatalog(
      await projectedCatalog(["github", "figma"]),
      credentials,
    );
    expect(providerCards(container)).toHaveLength(10);
    expect(
      new Set(providerCards(container).map((card) => reactPropsOf(card)["data-link-provider-card"]))
        .size,
    ).toBe(10);
    expect(
      findElements(container, "SECTION").some(
        (node) => reactPropsOf(node)["data-link-runtime-section"],
      ),
    ).toBe(false);
    expect(
      findElements(container, "DIV")
        .filter((node) => reactPropsOf(node)["data-link-provider-details"])
        .every((node) => reactPropsOf(node).hidden),
    ).toBe(true);
    const figma = await expandProvider(container, "figma");
    expect(reactPropsOf(figma).className).toContain("col-span-full");
    expect(
      findElements(container, "SVG").some(
        (node) => reactPropsOf(node)["data-link-service-icon"] === "gitlab",
      ),
    ).toBe(true);
    const github = await expandProvider(container, "github");
    expect(reactPropsOf(github).className).toContain("col-span-full");
    expect(methodRows(container, "figma", "server")).toHaveLength(1);
    expect(reactChildText(reactPropsOf(figma).children)).not.toContain("即将开放");
    expect(buttonWithLabel(figma, "连接设计上下文")).toBeDefined();
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "已连接")).onClick();
      await flushMicrotasks();
    });
    expect(
      providerCards(container)
        .map((card) => reactPropsOf(card)["data-link-provider-card"])
        .sort(),
    ).toEqual(["figma", "github"]);
    await act(async () => {
      reactPropsOf(
        findElements(container, "INPUT").find((node) => reactPropsOf(node).type === "search"),
      ).onChange({ target: { value: "Figma" } });
      await flushMicrotasks();
    });
    expect(providerCards(container)).toHaveLength(1);
    expect(reactPropsOf(providerCards(container)[0])["data-link-provider-card"]).toBe("figma");
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "设计")).onClick();
      await flushMicrotasks();
    });
    expect(providerCards(container)).toHaveLength(1);
    expect(reactPropsOf(providerCards(container)[0])["data-link-provider-card"]).toBe("figma");
    await act(async () => {
      reactPropsOf(
        findElements(container, "INPUT").find((node) => reactPropsOf(node).type === "search"),
      ).onChange({ target: { value: "GitHub" } });
      await flushMicrotasks();
    });
    expect(providerCards(container)).toHaveLength(1);
    expect(reactPropsOf(providerCards(container)[0])["data-link-provider-card"]).toBe("github");
  });

  test("partial remote catalogs never duplicate providers or render coming-soon account fallbacks", async () => {
    const container = await renderProjectedCatalog(await projectedCatalog(["github"]));
    expect(providerCards(container)).toHaveLength(10);
    expect(methodRows(container, "github", "server")).toHaveLength(1);
    expect(
      providerCards(container).every(
        (card) => !reactChildText(reactPropsOf(card).children).includes("即将开放"),
      ),
    ).toBe(true);
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "需处理")).onClick();
      await flushMicrotasks();
    });
    expect(providerCards(container)).toHaveLength(0);
  });

  test("an app starts with one primary connect action and reveals PAT and MCP only in advanced settings", async () => {
    const providers = await projectedCatalog(["figma"]);
    const provider = providers.find((item) => item.id === "figma")!;
    provider.authModes = [
      {
        id: "remote-link",
        methodId: "remote-link",
        kind: "redirect",
        label: "Figma OAuth",
        available: true,
        preferred: true,
      },
      { id: "mcp-oauth", methodId: "mcp", kind: "redirect", label: "MCP", available: true },
      {
        id: "token",
        methodId: "personal-access-token",
        kind: "credential-input",
        label: "PAT",
        available: true,
      },
    ];
    const container = await renderProjectedCatalog(providers);
    const card = providerCards(container).find(
      (node) => reactPropsOf(node)["data-link-provider-card"] === "figma",
    );
    const primary = visibleElements(card, "BUTTON").filter(
      (node) => reactPropsOf(node)["data-link-primary-connect"] === "figma",
    );
    expect(primary).toHaveLength(1);
    expect(reactPropsOf(primary[0]).disabled).toBe(false);
    expect(visibleElements(card, "SECTION")).toHaveLength(0);
    expect(
      visibleElements(card, "BUTTON").map((node) => reactChildText(reactPropsOf(node).children)),
    ).not.toContain("连接设计上下文");
    const mutations: unknown[][] = [];
    const mutation = async (...args: unknown[]) => {
      mutations.push(args);
      throw new Error("Presentation must not authorize or disconnect");
    };
    Object.assign(window.codeshell.links, {
      authorizationStart: mutation,
      authorizationCancel: mutation,
      remoteDisconnect: mutation,
    });
    await expandProvider(container, "figma");
    const visibleOptions = () =>
      visibleElements(card, "DIV")
        .filter((node) => reactPropsOf(node)["data-link-option"])
        .map((node) => reactPropsOf(node)["data-link-option"]);
    expect(visibleOptions()).toEqual(
      expect.arrayContaining(["remote-link", "mcp-oauth", "method:personal-access-token:new"]),
    );
    expect(
      visibleElements(card, "SECTION").filter(
        (node) => reactPropsOf(node)["data-link-runtime"] === "local",
      ),
    ).toHaveLength(1);
    expect(
      visibleElements(card, "BUTTON").some(
        (node) => reactChildText(reactPropsOf(node).children) === "连接设计上下文",
      ),
    ).toBe(true);
    await act(async () => {
      reactPropsOf(
        findElements(card, "BUTTON").find(
          (node) => reactPropsOf(node)["data-link-advanced-toggle"] === "figma",
        ),
      ).onClick();
      await flushMicrotasks();
    });
    expect(visibleOptions()).toEqual(["remote-link"]);
    expect(mutations).toHaveLength(0);
  });

  test("a healthy primary account keeps the app connected while retaining an unhealthy advanced account", async () => {
    const connections: LinkSnapshot["connections"] = [
      {
        id: "healthy-api",
        providerId: "figma",
        methodId: "remote-link",
        runtime: "server",
        authSource: "remote-link",
        label: "API account",
        account: { id: "api-owner", label: "API owner", resources: ["Design"] },
        status: "connected",
        capabilityIds: ["figma.get_file"],
        revision: "api-revision",
        scope: "user",
        editable: true,
      },
      {
        id: "expired-mcp",
        providerId: "figma",
        methodId: "mcp",
        runtime: "local",
        authSource: "mcp-oauth",
        label: "MCP account",
        account: { id: "mcp-owner", label: "MCP owner", resources: [] },
        status: "expired",
        capabilityIds: ["figma.get_design_context"],
        revision: "mcp-revision",
        scope: "user",
        editable: true,
      },
    ];
    const original = structuredClone(connections);
    const container = await renderProjectedCatalog(
      await projectedCatalog(["figma"]),
      [],
      connections,
    );
    const card = await expandProvider(container, "figma");
    expect(
      visibleElements(card, "SPAN").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toContain("已连接");
    expect(
      findElements(card, "SPAN").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toContain("API owner · MCP owner · 2 个连接");
    expect(
      visibleElements(card, "ARTICLE").map((node) => reactPropsOf(node)["data-remote-link"]),
    ).toContain("healthy-api");
    expect(
      visibleElements(card, "DIV").filter(
        (node) => reactPropsOf(node)["data-figma-mcp-connection"] === "expired-mcp",
      ),
    ).toHaveLength(0);
    expect(
      findElements(card, "DIV").filter(
        (node) => reactPropsOf(node)["data-figma-mcp-connection"] === "expired-mcp",
      ),
    ).toHaveLength(1);
    await act(async () => {
      reactPropsOf(
        findElements(card, "BUTTON").find(
          (node) => reactPropsOf(node)["data-link-advanced-toggle"] === "figma",
        ),
      ).onClick();
      await flushMicrotasks();
    });
    expect(
      visibleElements(card, "DIV").filter(
        (node) => reactPropsOf(node)["data-figma-mcp-connection"] === "expired-mcp",
      ),
    ).toHaveLength(1);
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "需处理")).onClick();
      await flushMicrotasks();
    });
    expect(
      providerCards(container).some(
        (node) => reactPropsOf(node)["data-link-provider-card"] === "figma",
      ),
    ).toBe(false);
    expect(connections).toEqual(original);
  });

  test.each(["unavailable", "changed"] as const)(
    "the primary MCP connect action reveals a fresh-snapshot %s error without starting another channel",
    async (failure) => {
      const providers = await projectedCatalog(["figma"]);
      const provider = providers.find((item) => item.id === "figma")!;
      provider.authModes = [
        {
          id: "mcp-oauth",
          methodId: "mcp",
          kind: "redirect",
          label: "MCP",
          available: true,
          preferred: true,
        },
        {
          id: "remote-link",
          methodId: "remote-link",
          kind: "redirect",
          label: "API",
          available: true,
        },
      ];
      const oldAccount: LinkSnapshot["connections"][number] = {
        id: "existing-github",
        providerId: "github",
        methodId: "remote-link",
        runtime: "server",
        authSource: "remote-link",
        label: "Existing account",
        account: { id: "existing-owner", label: "Existing owner", resources: ["owner/repo"] },
        status: "connected",
        capabilityIds: ["github.get_file"],
        revision: "existing-revision",
        scope: "user",
        editable: true,
      };
      const appearedAccount: LinkSnapshot["connections"][number] = {
        ...oldAccount,
        id: "appeared-mcp",
        providerId: "figma",
        methodId: "mcp",
        runtime: "local",
        authSource: "mcp-oauth",
        label: "Appeared account",
        account: { id: "new-owner", label: "New owner", resources: [] },
        capabilityIds: ["figma.get_design_context"],
        revision: "appeared-revision",
      };
      const initialAccounts = [oldAccount];
      const container = await renderProjectedCatalog(providers, [], initialAccounts);
      const snapshot = await window.codeshell.links.remoteSnapshot("/fixture");
      const current = {
        ...snapshot,
        connections: failure === "changed" ? [oldAccount, appearedAccount] : initialAccounts,
      };
      let reads = 0;
      let starts = 0;
      let cancellations = 0;
      let disconnections = 0;
      Object.assign(window.codeshell.links, {
        remoteSnapshot: async () => {
          if (reads++ === 0 && failure === "unavailable")
            throw new Error("Fixture snapshot unavailable");
          return current;
        },
        authorizationStart: async () => {
          starts++;
          throw new Error("Guarded connect must not authorize");
        },
        authorizationCancel: async () => {
          cancellations++;
        },
        remoteDisconnect: async () => {
          disconnections++;
        },
      });
      const card = providerCards(container).find(
        (node) => reactPropsOf(node)["data-link-provider-card"] === "figma",
      );
      const details = findElements(card, "DIV").find(
        (node) => reactPropsOf(node)["data-link-provider-details"] === "figma",
      );
      expect(reactPropsOf(details).hidden).toBe(true);
      const connect = visibleElements(card, "BUTTON").find(
        (node) => reactPropsOf(node)["data-link-primary-connect"] === "figma",
      );
      expect(reactPropsOf(connect).disabled).toBe(false);
      await act(async () => {
        reactPropsOf(connect).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
        await flushMicrotasks();
      });
      expect(reactPropsOf(details).hidden).toBe(false);
      expect(
        visibleElements(card, "P")
          .filter((node) => reactPropsOf(node).role === "alert")
          .map((node) => reactChildText(reactPropsOf(node).children))
          .join(" "),
      ).toContain(failure === "unavailable" ? "Fixture snapshot unavailable" : "连接或权限已变化");
      expect(reads).toBeGreaterThan(0);
      expect(starts).toBe(0);
      expect(cancellations).toBe(0);
      expect(disconnections).toBe(0);
      expect(initialAccounts).toEqual([oldAccount]);
      expect(current.connections).toEqual(
        failure === "changed" ? [oldAccount, appearedAccount] : [oldAccount],
      );
      expect(
        findElements(container, "ARTICLE").some(
          (node) => reactPropsOf(node)["data-remote-link"] === oldAccount.id,
        ),
      ).toBe(true);
      if (failure === "changed")
        expect(
          findElements(card, "DIV").some(
            (node) => reactPropsOf(node)["data-figma-mcp-connection"] === appearedAccount.id,
          ),
        ).toBe(true);
    },
  );

  test("preserves every saved OAuth method independently inside the provider", async () => {
    const providers = await projectedCatalog(["figma"]);
    providers
      .find((provider) => provider.id === "figma")!
      .connectionMethods.push({
        id: "scoped-figma-oauth",
        displayName: { zh: "独立 OAuth", en: "Separate OAuth" },
        executionRuntime: "server",
        secretLocation: "server",
        authKind: "oauth",
        availability: "available",
        oauthProfileId: "fixture-oauth-profile",
      });
    const container = await renderProjectedCatalog(providers, [
      {
        id: "legacy-figma",
        type: "oauth",
        label: "Saved OAuth account",
        hasSecret: true,
        oauthStatus: { state: "valid" },
        meta: {
          oauthProvider: "figma",
          linkExecutionRuntime: "server",
          linkConnectionMethod: "figma-oauth",
        },
      },
    ]);
    expect(
      providerCards(container).filter(
        (card) => reactPropsOf(card)["data-link-provider-card"] === "figma",
      ),
    ).toHaveLength(1);
    expect(methodRows(container, "figma", "server")).toHaveLength(3);
    expect(
      methodRows(container, "figma").some((row) =>
        reactChildText(reactPropsOf(row).children).includes("Saved OAuth account"),
      ),
    ).toBe(true);
    expect(
      methodRows(container, "figma").some((row) =>
        reactChildText(reactPropsOf(row).children).includes("独立 OAuth"),
      ),
    ).toBe(true);
  });

  test("unavailable remote modes retain saved accounts with an honest service status", async () => {
    const providers = await projectedCatalog(["figma"]);
    providers
      .find((provider) => provider.id === "figma")!
      .authModes!.find((mode) => mode.id === "remote-link")!.available = false;
    const account: LinkSnapshot["connections"][number] = {
      id: "saved-remote-figma",
      providerId: "figma",
      methodId: "remote-link",
      label: "Offline Figma",
      runtime: "server",
      authSource: "remote-link",
      status: "unavailable",
      capabilityIds: [],
      account: { label: "fixture-account", resources: [] },
      revision: "saved",
      scope: "user",
      editable: true,
    };
    const container = await renderProjectedCatalog(providers, [], [account]);
    const card = await expandProvider(container, "figma");
    expect(
      findElements(card, "ARTICLE").some(
        (node) => reactPropsOf(node)["data-remote-link"] === account.id,
      ),
    ).toBe(true);
    expect(reactChildText(reactPropsOf(card).children)).not.toContain("即将开放");
    expect(
      findElements(card, "SPAN").some(
        (node) => reactChildText(reactPropsOf(node).children) === "服务暂不可达",
      ),
    ).toBe(true);
    expect(buttonWithLabel(card, "断开")).toBeDefined();
  });

  test.each(["unavailable", "stale"] as const)(
    "directory state %s preserves a valid API grant and independent local MCP availability",
    async (catalogState) => {
      const providers = await projectedCatalog(["figma"]);
      providers
        .find((provider) => provider.id === "figma")!
        .authModes!.find((mode) => mode.id === "remote-link")!.available = false;
      providers
        .find((provider) => provider.id === "figma")!
        .authModes!.push({
          id: "mcp-oauth",
          methodId: "mcp",
          kind: "redirect",
          label: "MCP",
          available: true,
        });
      const account: LinkSnapshot["connections"][number] = {
        id: "valid-saved",
        providerId: "figma",
        methodId: "remote-link",
        label: "Saved design account",
        runtime: "server",
        authSource: "remote-link",
        status: "connected",
        capabilityIds: ["figma.get_file"],
        account: { id: "owner", label: "Designer", resources: ["Design system"] },
        revision: "saved",
        scope: "user",
        editable: true,
      };
      const container = await renderProjectedCatalog(providers, [], [account], {
        remoteCatalog: catalogState,
      });
      const card = await expandProvider(container, "figma");
      expect(
        findElements(card, "SPAN").some(
          (node) => reactChildText(reactPropsOf(node).children) === "已连接",
        ),
      ).toBe(true);
      expect(reactPropsOf(buttonWithLabel(card, "添加文件")).disabled).toBe(true);
      expect(reactPropsOf(buttonWithLabel(card, "连接设计上下文")).disabled).toBe(false);
      expect(
        findElements(card, "P").some((node) =>
          reactChildText(reactPropsOf(node).children).includes("尚未配置桌面 Link 服务"),
        ),
      ).toBe(false);
      expect(
        findElements(container, "P").map((node) => reactChildText(reactPropsOf(node).children)),
      ).toContain("服务目录暂不可达");
      expect(
        findElements(container, "P").some((node) =>
          reactChildText(reactPropsOf(node).children).includes("无法读取应用连接状态"),
        ),
      ).toBe(false);
      expect(
        findElements(container, "P").some((node) =>
          reactChildText(reactPropsOf(node).children).includes("账号和权限仍保留"),
        ),
      ).toBe(true);
      await act(async () => {
        reactPropsOf(buttonWithLabel(container, "已连接")).onClick();
        await flushMicrotasks();
      });
      expect(
        providerCards(container).map((node) => reactPropsOf(node)["data-link-provider-card"]),
      ).toEqual(["figma"]);
      expect(account.status).toBe("connected");
      expect(account.revision).toBe("saved");
    },
  );

  test("only an explicitly unconfigured directory describes the remote service as unconfigured", async () => {
    const providers = await projectedCatalog(["figma"]);
    providers
      .find((provider) => provider.id === "figma")!
      .authModes!.find((mode) => mode.id === "remote-link")!.available = false;
    const account: LinkSnapshot["connections"][number] = {
      id: "unconfigured-api",
      providerId: "figma",
      methodId: "remote-link",
      label: "Saved API",
      runtime: "server",
      authSource: "remote-link",
      status: "connected",
      capabilityIds: ["figma.get_file"],
      account: { label: "Designer", resources: ["Design system"] },
      revision: "saved",
      scope: "user",
      editable: true,
    };
    const container = await renderProjectedCatalog(providers, [], [account], {
      remoteCatalog: "unconfigured",
    });
    const card = await expandProvider(container, "figma");
    expect(
      findElements(card, "P").some((node) =>
        reactChildText(reactPropsOf(node).children).includes("尚未配置桌面 Link 服务"),
      ),
    ).toBe(true);
    expect(account.status).toBe("connected");
    expect(buttonWithLabel(card, "断开")).toBeDefined();
  });

  test("the first pending snapshot shows checking and cannot grant local MCP authority", async () => {
    const providers = await projectedCatalog(["figma"]);
    providers
      .find((provider) => provider.id === "figma")!
      .authModes!.push({
        id: "mcp-oauth",
        methodId: "mcp",
        kind: "redirect",
        label: "MCP",
        available: true,
      });
    let resolveSnapshot!: (snapshot: LinkSnapshot) => void;
    const pendingSnapshot = new Promise<LinkSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const saved: MaskedCredentialView = {
      id: "saved-api-pending",
      type: "oauth",
      label: "Saved API",
      hasSecret: true,
      meta: {
        linkProvider: "figma",
        linkConnectionMethod: "remote-link",
        linkExecutionRuntime: "server",
        linkExecutionBackend: "remote",
      },
    };
    const container = await renderProjectedCatalog(providers, [saved], [], { pendingSnapshot });
    const card = await expandProvider(container, "figma");
    expect(
      findElements(card, "P").some((node) =>
        reactChildText(reactPropsOf(node).children).includes("正在检查应用连接"),
      ),
    ).toBe(true);
    expect(
      findElements(card, "P").some((node) =>
        reactChildText(reactPropsOf(node).children).includes("尚未配置桌面 Link 服务"),
      ),
    ).toBe(false);
    expect(
      findElements(card, "SPAN").some(
        (node) => reactChildText(reactPropsOf(node).children) === "服务暂不可达",
      ),
    ).toBe(false);
    expect(reactPropsOf(buttonWithLabel(card, "连接设计上下文")).disabled).toBe(true);
    expect(findElements(container, "DIV").some((node) => reactPropsOf(node).role === "alert")).toBe(
      false,
    );
    await act(async () => {
      resolveSnapshot({
        providers,
        connections: [
          {
            id: saved.id,
            providerId: "figma",
            methodId: "remote-link",
            label: saved.label,
            runtime: "server",
            authSource: "remote-link",
            status: "connected",
            capabilityIds: ["figma.get_file"],
            account: { label: "Designer", resources: ["Design"] },
            revision: "host-confirmed-api",
            scope: "user",
            editable: true,
          },
        ],
        revision: "host-confirmed",
        capabilities: { token: true, cliBinding: true, deviceAuth: false },
        remoteCatalog: { state: "unavailable" },
      });
      await flushMicrotasks();
    });
    expect(reactPropsOf(buttonWithLabel(card, "连接设计上下文")).disabled).toBe(false);
    expect(
      findElements(card, "P").some((node) =>
        reactChildText(reactPropsOf(node).children).includes("正在检查应用连接"),
      ),
    ).toBe(false);
    expect(
      findElements(card, "SECTION").some(
        (node) => reactPropsOf(node)["data-link-saved-unavailable"] === saved.id,
      ),
    ).toBe(false);
  });

  test("provider and snapshot failures preserve saved Host accounts without inventing authorization", async () => {
    const saved: MaskedCredentialView = {
      id: "saved-mcp",
      type: "oauth",
      label: "Saved design account",
      hasSecret: true,
      meta: {
        linkProvider: "figma",
        linkExecutionRuntime: "local",
        linkExecutionBackend: "mcp",
        linkAuthSource: "mcp-oauth",
        linkConnectionMethod: "mcp",
      },
    };
    const container = await renderProjectedCatalog([], [saved], [], {
      providers: true,
      snapshot: true,
    });
    expect(providerCards(container)).toHaveLength(1);
    const card = await expandProvider(container, "figma");
    expect(
      findElements(card, "SECTION").some(
        (node) => reactPropsOf(node)["data-link-saved-unavailable"] === saved.id,
      ),
    ).toBe(true);
    expect(reactChildText(reactPropsOf(card).children)).not.toContain("即将开放");
    expect(findElements(container, "DIV").some((node) => reactPropsOf(node).role === "alert")).toBe(
      true,
    );
    expect(
      findElements(container, "P").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toContain("无法读取应用连接状态");
    expect(reactPropsOf(buttonWithLabel(card, "连接设计上下文")).disabled).toBe(true);
  });

  test("multiple saved local accounts are retained as separate connection rows", async () => {
    const credentials = ["first", "second"].map(
      (id): MaskedCredentialView => ({
        id,
        type: "link",
        label: `Account ${id}`,
        hasSecret: true,
        meta: {
          linkProvider: "github",
          linkExecutionRuntime: "local",
          linkConnectionMethod: "fine-grained-pat",
        },
      }),
    );
    const container = await renderProjectedCatalog(await projectedCatalog([]), credentials);
    expect(methodRows(container, "github", "local")).toHaveLength(2);
    expect(
      providerCards(container).filter(
        (card) => reactPropsOf(card)["data-link-provider-card"] === "github",
      ),
    ).toHaveLength(1);
    const card = await expandProvider(container, "github");
    const advanced = findElements(card, "BUTTON").find(
      (node) => reactPropsOf(node)["data-link-advanced-toggle"] === "github",
    );
    expect(reactPropsOf(advanced)["aria-expanded"]).toBe(false);
    expect(
      visibleElements(card, "SECTION")
        .filter((node) => reactPropsOf(node)["data-link-runtime"] === "local")
        .map((node) =>
          findElements(node, "H5").map((title) => reactChildText(reactPropsOf(title).children)),
        ),
    ).toEqual([["Account first"], ["Account second"]]);
  });

  test("starts remote authorization directly and confirms the saved connection through status", async () => {
    ensureMiniDom();
    const calls: unknown[] = [];
    let cancellations = 0;
    let disconnections = 0;
    const opened: unknown[][] = [];
    let connected = false;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const connection = {
      id: "remote-github",
      providerId: "github",
      methodId: "remote-link",
      runtime: "server",
      authSource: "remote-link",
      label: "GitHub",
      account: { label: "alice", resources: ["owner/repo"] },
      capabilityIds: [],
      scope: "user",
      status: "connected",
      editable: true,
      revision: "one",
    };
    const pending = {
      id: "native-attempt",
      providerId: "github",
      methodId: "remote-link",
      state: "pending",
      expiresAt,
      step: {
        id: "redirect-one",
        kind: "redirect",
        authorizationUrl: "https://private-link.example/oauth/authorize",
        expiresAt,
      },
    };
    Object.assign(window, {
      codeshell: {
        credentials: { list: async () => [] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          remoteSnapshot: async () => ({
            providers: [
              {
                ...LINK_PROVIDER_FIXTURES[0],
                connectionMethods: (await projectedCatalog(["github"]))[0].connectionMethods,
                authModes: [
                  {
                    id: "remote-link",
                    methodId: "remote-link",
                    kind: "redirect",
                    label: "GitHub 授权",
                    preferred: true,
                    available: true,
                  },
                ],
              },
            ],
            capabilities: { remoteAuth: true, authorizationSteps: 1 },
            remoteServer: { issuer: "https://private-link.example" },
            connections: connected ? [connection] : [],
          }),
          authorizationStart: async (...args: unknown[]) => {
            calls.push(args);
            return pending;
          },
          authorizationGet: async () =>
            connected ? { ...pending, state: "connected", step: undefined, connection } : pending,
          authorizationCancel: async () => {
            cancellations++;
          },
          remoteDisconnect: async () => {
            disconnections++;
          },
          authorizationOpen: async (...args: unknown[]) => {
            opened.push(args);
          },
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <React.StrictMode>
          <LinkTab cwd="/repo" />
        </React.StrictMode>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const card = await expandProvider(container, "github");
    const github = methodRows(container, "github", "server");
    expect(github).toHaveLength(1);
    expect(findElements(github[0], "INPUT")).toHaveLength(0);
    expect(reactChildText(reactPropsOf(github[0]).children)).not.toContain("private-link.example");
    await act(async () => {
      reactPropsOf(
        findElements(card, "BUTTON").find(
          (node) => reactPropsOf(node)["data-link-primary-connect"] === "github",
        ),
      ).onClick();
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[]).slice(2)).toEqual([
      { providerId: "github", methodId: "remote-link", label: "GitHub", expectedRevision: null },
      "remote-link",
    ]);
    const authorizationStep = () =>
      findElements(container, "DIV").find(
        (node) => reactPropsOf(node)["data-link-authorization-step"] === "redirect",
      );
    const originalStep = authorizationStep();
    expect(originalStep).toBeDefined();
    const advanced = findElements(card, "BUTTON").find(
      (node) => reactPropsOf(node)["data-link-advanced-toggle"] === "github",
    );
    const toggle = findElements(card, "BUTTON").find(
      (node) => reactPropsOf(node)["data-link-provider-toggle"] !== undefined,
    );
    for (const control of [advanced, advanced, toggle, toggle]) {
      await act(async () => {
        reactPropsOf(control).onClick();
        await flushMicrotasks();
      });
      expect(authorizationStep()).toBe(originalStep);
    }
    const search = findElements(container, "INPUT").find(
      (node) => reactPropsOf(node).type === "search",
    );
    for (const query of ["No matching app", ""]) {
      await act(async () => {
        reactPropsOf(search).onChange({ target: { value: query } });
        await flushMicrotasks();
      });
      expect(authorizationStep()).toBe(originalStep);
      expect(providerCards(container).some((node) => node === card)).toBe(!query);
    }
    expect(calls).toHaveLength(1);
    expect(cancellations).toBe(0);
    expect(disconnections).toBe(0);
    // Reopening continues the Host-owned attempt instead of starting another authorization.
    expect(opened).toHaveLength(0);
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "在系统浏览器中继续授权 ↗")).onClick();
      await flushMicrotasks();
    });
    expect(opened).toEqual([["/repo", "native-attempt"]]);
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "已连接")).onClick();
      await flushMicrotasks();
    });
    expect(cancellations).toBe(0);
    await act(async () => {
      connected = true;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await flushMicrotasks();
    });
    expect(buttonWithLabel(container, "完成")).toBeDefined();
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "完成")).onClick();
      await flushMicrotasks();
    });
    expect(buttonWithLabel(container, "添加账号")).toBeDefined();
    expect(buttonWithLabel(container, "改名")).toBeDefined();
  });

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

  test("connected Figma accounts ask for a file only when Add file is chosen", async () => {
    const connection: LinkSnapshot["connections"][number] = {
      id: "remote-figma",
      providerId: "figma",
      methodId: "remote-link",
      runtime: "server",
      authSource: "remote-link",
      label: "Design account",
      account: { id: "figma-account", label: "Designer", resources: [] },
      capabilityIds: ["figma.get_file", "figma.get_comments"],
      scope: "user",
      status: "connected",
      editable: true,
      revision: "figma-revision",
    };
    const container = await renderProjectedCatalog(
      await projectedCatalog(["figma"]),
      [],
      [connection],
    );
    const calls: unknown[][] = [];
    const cancelled: string[] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    Object.assign(window.codeshell.links, {
      authorizationStart: async (...args: unknown[]) => {
        calls.push(args);
        return {
          id: "add-file-attempt",
          providerId: "figma",
          state: "pending",
          step: {
            id: "file-redirect",
            kind: "redirect",
            authorizationUrl: "https://fixture.invalid/oauth/authorize",
            expiresAt,
          },
        };
      },
      authorizationGet: async () => ({ id: "add-file-attempt", state: "pending" }),
      authorizationCancel: async (_cwd: string, id: string) => {
        cancelled.push(id);
      },
    });
    const card = await expandProvider(container, "figma");
    const figma = findElements(card, "SECTION").find(
      (node) =>
        reactPropsOf(node)["data-link-method-provider"] === "figma" &&
        reactPropsOf(node)["data-link-runtime"] === "server",
    );
    const account = visibleElements(card, "ARTICLE").find(
      (node) => reactPropsOf(node)["data-remote-link"] === connection.id,
    );
    expect(buttonWithLabel(account, "添加文件")).toBeDefined();
    expect(findElements(figma, "INPUT")).toHaveLength(0);
    expect(reactChildText(reactPropsOf(figma).children)).toContain("账号已连接");
    expect(calls).toHaveLength(0);
    await act(async () => {
      reactPropsOf(buttonWithLabel(account, "添加文件")).onClick();
      await flushMicrotasks();
    });
    const input = findElements(container, "INPUT").find(
      (node) => reactPropsOf(node)["aria-label"] === "Figma 文件链接",
    );
    const url = "https://www.figma.com/design/FileChosen/Design?node-id=0-1";
    await act(async () => {
      reactPropsOf(input).onChange({ target: { value: url } });
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(0);
    await act(async () => {
      reactPropsOf(
        findElements(container, "FORM").find((form) => buttonWithLabel(form, "继续授权文件")),
      ).onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(2)).toEqual([
      {
        providerId: "figma",
        methodId: "remote-link",
        label: "Design account",
        connectionId: "remote-figma",
        expectedRevision: "figma-revision",
        resourceUrl: url,
      },
      "remote-link",
    ]);
    expect(connection.account?.resources).toEqual([]);
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "取消")).onClick();
      await flushMicrotasks();
    });
    expect(cancelled).toContain("add-file-attempt");
    expect(buttonWithLabel(container, "添加文件")).toBeDefined();
  });

  test("uses a sole valid connection and requires a choice when several are saved", () => {
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

    expect(resolvePreferredLinkRuntime([server, local], "github")).toBeNull();
    expect(resolvePreferredLinkRuntime([local], "github")).toBe("local");
    expect(resolvePreferredLinkRuntime([server], "github")).toBe("server");
    expect(
      resolvePreferredLinkRuntime(
        [server, { ...local, oauthStatus: { state: "expired" } }],
        "github",
      ),
    ).toBeNull();
    expect(
      resolvePreferredLinkRuntime([server, { ...local, hasSecret: false }], "github"),
    ).toBeNull();
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

      const github = findElements(container, "SECTION").find(
        (card) =>
          reactPropsOf(card)["data-link-method-provider"] === "github" &&
          reactPropsOf(card)["data-link-runtime"] === "local",
      );
      expect(github).toBeDefined();
      const badge = findElements(github, "SPAN").find(
        (span) => reactChildText(reactPropsOf(span).children) === "凭据不可用",
      );
      expect(badge).toBeDefined();
      expect(reactPropsOf(badge).className).toContain("text-status-warn");
      const githubText = reactChildText(reactPropsOf(github).children);
      expect(githubText).toContain("凭据缺失或当前设备无法读取，请重新连接。");
      expect(githubText).not.toContain("已验证");
      expect(githubText).not.toContain("previous-repository");
      expect(githubText).not.toContain("通过本机 gh");
      expect(buttonWithLabel(github, "重新连接")).toBeDefined();
      expect(
        findElements(container, "P").some(
          (paragraph) =>
            reactChildText(reactPropsOf(paragraph).children) ===
            `1 / ${LINK_PROVIDER_FIXTURES.length} 个应用已连接`,
        ),
      ).toBe(true);

      const connected = buttonWithLabel(container, "已连接");
      await act(async () => {
        reactPropsOf(connected).onClick();
        await flushMicrotasks();
      });
      const cards = providerCards(container);
      expect(cards).toHaveLength(1);
      expect(reactPropsOf(cards[0])["data-link-provider-card"]).toBe("figma");
      expect(reactChildText(reactPropsOf(cards[0]).children)).toContain("current-account");
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

    const githubCards = methodRows(container, "github").filter(
      (article) => reactPropsOf(article)["data-link-method-provider"] === "github",
    );
    expect(githubCards.map((card) => reactPropsOf(card)["data-link-runtime"])).toEqual(["local"]);

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

  test("submits a local credential only through the current authorization step", async () => {
    ensureMiniDom();
    const starts: unknown[][] = [];
    const responses: unknown[][] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const pending = {
      id: "token-attempt",
      providerId: "github",
      methodId: "fine-grained-pat",
      state: "pending",
      expiresAt,
      step: {
        id: "token-one",
        kind: "credential-input",
        purpose: "credential",
        expiresAt,
        fields: [{ id: "token", label: "Fine-grained PAT", secret: true, required: true }],
      },
    };
    Object.assign(window, {
      codeshell: {
        credentials: { list: async () => [] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          remoteSnapshot: async () => ({
            providers: [
              {
                ...LINK_PROVIDER_FIXTURES[0],
                authModes: [
                  {
                    id: "token",
                    methodId: "fine-grained-pat",
                    kind: "credential-input",
                    label: "Token",
                    preferred: true,
                    available: true,
                  },
                ],
              },
            ],
            connections: [],
            capabilities: { authorizationSteps: 1 },
          }),
          authorizationStart: async (...args: unknown[]) => {
            starts.push(args);
            return pending;
          },
          authorizationGet: async () => pending,
          authorizationCancel: async () => undefined,
          authorizationRespond: async (...args: unknown[]) => {
            responses.push(args);
            return {
              ...pending,
              state: "connected",
              step: undefined,
              connection: {
                id: "local-github",
                providerId: "github",
                methodId: "fine-grained-pat",
                runtime: "local",
                authSource: "manual-token",
                status: "connected",
                capabilityIds: [],
                revision: "saved-one",
                scope: "user",
                editable: true,
                label: "GitHub",
                account: { label: "octocat", resources: [] },
              },
            };
          },
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<LinkTab cwd="/repo" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const github = findElements(container, "SECTION").find(
      (card) =>
        reactPropsOf(card)["data-link-method-provider"] === "github" &&
        reactPropsOf(card)["data-link-runtime"] === "local",
    );
    await act(async () => {
      reactPropsOf(buttonWithLabel(github, "连接本地")).onClick();
      await flushMicrotasks();
    });
    expect(starts[0]?.slice(2)).toEqual([
      {
        providerId: "github",
        methodId: "fine-grained-pat",
        label: "GitHub",
        expectedRevision: null,
      },
      "token",
    ]);
    const secretInput = findElements(container, "INPUT").find(
      (input) => reactPropsOf(input).name === "token",
    );
    expect(reactPropsOf(secretInput).type).toBe("password");
    await act(async () => {
      reactPropsOf(secretInput).onChange({ target: { value: "github_pat_local" } });
      await flushMicrotasks();
    });
    expect(reactPropsOf(buttonWithLabel(container, "验证并连接")).disabled).toBe(false);
    const form = findElements(container, "FORM").find((node) =>
      reactPropsOf(node).className?.includes("link-authorization-fields"),
    );
    await act(async () => {
      reactPropsOf(form).onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    expect(responses).toEqual([
      [
        "/repo",
        "token-attempt",
        { stepId: "token-one", operation: "submit", input: { token: "github_pat_local" } },
      ],
    ]);
    expect(
      findElements(container, "INPUT").some((input) => reactPropsOf(input).name === "token"),
    ).toBe(false);
    expect(buttonWithLabel(container, "完成")).toBeDefined();
  });

  test("cancels startup by request ID and ignores an authorization arriving after closing", async () => {
    ensureMiniDom();
    const cancellations: string[] = [];
    let resolveStart: (value: unknown) => void = () => {};
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    Object.assign(window, {
      codeshell: {
        credentials: { list: async () => [] },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          remoteSnapshot: async () => ({
            providers: [
              {
                ...LINK_PROVIDER_FIXTURES[0],
                authModes: [
                  {
                    id: "token",
                    methodId: "fine-grained-pat",
                    kind: "credential-input",
                    label: "Token",
                    available: true,
                  },
                ],
              },
            ],
            connections: [],
            capabilities: { authorizationSteps: 1 },
          }),
          authorizationStart: () =>
            new Promise((resolve) => {
              resolveStart = resolve;
            }),
          authorizationCancel: async (_cwd: string, id: string) => {
            cancellations.push(id);
          },
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<LinkTab cwd="/repo" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const github = findElements(container, "SECTION").find(
      (card) =>
        reactPropsOf(card)["data-link-method-provider"] === "github" &&
        reactPropsOf(card)["data-link-runtime"] === "local",
    );
    await act(async () => {
      reactPropsOf(buttonWithLabel(github, "连接本地")).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(buttonWithLabel(container, "取消")).onClick();
      await flushMicrotasks();
    });
    expect(cancellations).toHaveLength(1);
    await act(async () => {
      resolveStart({
        id: "late-attempt",
        providerId: "github",
        state: "pending",
        step: { id: "late-step", kind: "processing", expiresAt },
      });
      await flushMicrotasks();
    });
    expect(cancellations).toContain("late-attempt");
    expect(buttonWithLabel(container, "完成")).toBeUndefined();
    expect(
      findElements(container, "INPUT").some((input) => reactPropsOf(input).name === "token"),
    ).toBe(false);
  });

  test("authorization modes stay hidden until advanced settings and disclosures preserve the pending attempt", async () => {
    ensureMiniDom();
    const starts: unknown[][] = [];
    const cancellations: string[] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const pending = {
      id: "mode-attempt",
      providerId: "github",
      methodId: "fine-grained-pat",
      state: "pending",
      step: { id: "mode-processing", kind: "processing", expiresAt },
    };
    Object.assign(window, {
      codeshell: {
        links: {
          authorizationStart: async (...args: unknown[]) => {
            starts.push(args);
            return pending;
          },
          authorizationGet: async () => pending,
          authorizationCancel: async (_cwd: string, id: string) => {
            cancellations.push(id);
          },
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LinkConnectionDialog
          cwd="/fixture"
          providerName="GitHub"
          icon={Github}
          modes={[
            {
              id: "cli-session",
              methodId: "fine-grained-pat",
              kind: "local-session",
              label: "GitHub CLI",
              available: true,
              preferred: true,
            },
            {
              id: "token",
              methodId: "fine-grained-pat",
              kind: "credential-input",
              label: "PAT",
              available: true,
            },
          ]}
          input={{
            providerId: "github",
            methodId: "fine-grained-pat",
            label: "GitHub",
            expectedRevision: null,
          }}
          onClose={() => undefined}
          onConnected={() => {
            throw new Error("Disclosure must not complete authorization");
          }}
        />,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const advanced = buttonWithLabel(container, "高级设置");
    expect(advanced).toBeDefined();
    const visibleModes = () =>
      visibleElements(container, "BUTTON").filter(
        (node) => reactPropsOf(node)["data-link-auth-mode"],
      );
    expect(visibleModes()).toHaveLength(0);
    expect(
      findElements(container, "BUTTON").filter((node) => reactPropsOf(node)["data-link-auth-mode"]),
    ).toHaveLength(2);
    const originalStep = findElements(container, "DIV").find(
      (node) => reactPropsOf(node)["data-link-authorization-step"] === "processing",
    );
    expect(originalStep).toBeDefined();
    for (const expanded of [true, false, true, false]) {
      await act(async () => {
        reactPropsOf(advanced).onClick();
        await flushMicrotasks();
      });
      expect(reactPropsOf(advanced)["aria-expanded"]).toBe(expanded);
      expect(visibleModes()).toHaveLength(expanded ? 2 : 0);
      expect(
        findElements(container, "DIV").find(
          (node) => reactPropsOf(node)["data-link-authorization-step"] === "processing",
        ),
      ).toBe(originalStep);
    }
    expect(starts).toHaveLength(1);
    expect(starts[0]!.slice(2)).toEqual([
      {
        providerId: "github",
        methodId: "fine-grained-pat",
        label: "GitHub",
        expectedRevision: null,
      },
      "cli-session",
    ]);
    expect(cancellations).toHaveLength(0);
  });

  test.each([
    { canInstall: true, supported: true, expected: true },
    { canInstall: false, supported: true, expected: false },
    { canInstall: true, supported: false, expected: false },
  ])(
    "offers CLI installation independently from CLI login permission (%j)",
    async ({ canInstall, supported, expected }) => {
      ensureMiniDom();
      let starts = 0;
      let installations = 0;
      let installChecks = 0;
      let connected = 0;
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      Object.assign(window, {
        codeshell: {
          links: {
            authorizationStart: async () => ({
              id: `cli-install-${++starts}`,
              providerId: "github",
              methodId: "fine-grained-pat",
              state: "pending",
              expiresAt,
              step: {
                id: `cli-step-${starts}`,
                kind: "local-session",
                expiresAt,
                session: {
                  installed: installations > 0,
                  authenticated: false,
                  canLogin: false,
                  canInstall,
                },
              },
            }),
            authorizationCancel: async () => undefined,
            cliInstallStatus: async () => {
              installChecks++;
              return { supported };
            },
            installCli: async () => {
              installations++;
            },
          },
        },
      });
      const container = document.createElement("div") as unknown as HTMLElement;
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <LinkConnectionDialog
            cwd="/repo"
            providerName="GitHub"
            icon={Github}
            input={{
              providerId: "github",
              methodId: "fine-grained-pat",
              label: "GitHub",
              expectedRevision: null,
            }}
            modes={[
              {
                id: "cli-session",
                methodId: "fine-grained-pat",
                kind: "local-session",
                label: "CLI",
                available: true,
              },
            ]}
            onClose={() => undefined}
            onConnected={() => {
              connected++;
            }}
          />,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });
      const install = buttonWithLabel(container, "安装并继续连接");
      expect(Boolean(install)).toBe(expected);
      expect(installChecks).toBe(canInstall ? 1 : 0);
      expect(buttonWithLabel(container, "登录账号")).toBeUndefined();
      if (expected) {
        await act(async () => {
          reactPropsOf(install).onClick();
          await flushMicrotasks();
          await flushMicrotasks();
        });
        expect(installations).toBe(1);
        expect(starts).toBe(2);
        expect(buttonWithLabel(container, "安装并继续连接")).toBeUndefined();
        expect(connected).toBe(0);
      }
    },
  );

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

      expect(
        methodRows(container, "figma").filter((row) =>
          reactChildText(reactPropsOf(row).children).includes("Figma OAuth"),
        ),
      ).toHaveLength(1);
      const oauthRow = methodRows(container, "figma", "server").find((row) =>
        findElements(row, "DIV").some(
          (node) => reactChildText(reactPropsOf(node).children) === "Figma OAuth",
        ),
      );
      const refresh = buttonWithLabel(oauthRow, "刷新");
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
              accountId: "different-id",
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

    const github = findElements(container, "SECTION").find(
      (card) =>
        reactPropsOf(card)["data-link-method-provider"] === "github" &&
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

    const github = findElements(container, "SECTION").find(
      (card) =>
        reactPropsOf(card)["data-link-method-provider"] === "github" &&
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

describe("Link metadata request lifecycle", () => {
  test("CLI account labels never replace a stable identity in liveness checks", () => {
    const status = { installed: true, authenticated: true, account: "cjhyy", accountId: "42" };
    expect(resolveCliLiveness(status, "42")).toBe("ok");
    expect(resolveCliLiveness({ ...status, account: "renamed" }, "42")).toBe("ok");
    expect(resolveCliLiveness({ ...status, accountId: "99" }, "42")).toBe("mismatch");
    expect(resolveCliLiveness({ ...status, accountId: undefined }, "cjhyy")).toBe("unknown");
  });

  test("one provider probe compares each CLI binding's own stable account ID", async () => {
    const credentials = [cliBinding("first", "42"), cliBinding("second", "99")];
    const f = await connectionStatusFixture({ credentials });
    const rows = methodRows(f.container, "github", "local");
    expect(rows).toHaveLength(2);
    expect(
      rows.map(
        (row) =>
          reactPropsOf(
            findElements(row, "DIV").find(
              (node) => reactPropsOf(node)["data-link-liveness"] === "github",
            ),
          )["data-link-liveness-state"],
      ),
    ).toEqual(["ok", "mismatch"]);
    expect(f.calls.probes).toEqual(["/repo"]);
    expect(credentials.map((record) => record.meta?.linkLastVerifiedAt)).toEqual([
      "2026-09-06T05:41:00.000Z",
      "2026-09-06T05:41:00.000Z",
    ]);
  });

  test("one account summary retains every distinct CLI and remote connection", async () => {
    const connections: LinkSnapshot["connections"] = ["cli", "remote-one", "remote-two"].map(
      (id, index) => ({
        id,
        providerId: "github",
        methodId: index ? "remote-link" : "fine-grained-pat",
        label: id,
        runtime: index ? "server" : "local",
        authSource: index ? "remote-link" : "cli-session",
        status: "connected",
        account: { id: "42", label: "cjhyy", resources: index ? [`repo-${index}`] : [] },
        capabilityIds: ["github.get_file"],
        revision: id,
        scope: "user",
        editable: true,
      }),
    );
    const f = await connectionStatusFixture({ connections });
    const card = await expandProvider(f.container, "github");
    expect(
      findElements(card, "SPAN").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toContain("cjhyy · 3 个连接");
    const remoteAccounts = findElements(card, "ARTICLE").filter(
      (node) => reactPropsOf(node)["data-remote-link"],
    );
    expect(remoteAccounts).toHaveLength(2);
    expect(
      remoteAccounts.map((account) =>
        findElements(account, "P").map((node) => reactChildText(reactPropsOf(node).children)),
      ),
    ).toEqual([
      ["cjhyy", "repo-1"],
      ["cjhyy", "repo-2"],
    ]);
    expect(methodRows(card, "github", "local")).toHaveLength(1);
    expect(
      findElements(card, "P").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toEqual(expect.arrayContaining(["repo-1", "repo-2"]));
    expect(f.calls.mutations).toBe(0);
  });

  test("manual refresh and focus reload accounts, directory and CLI without changing authorization", async () => {
    let resolveProbe!: (status: CliLinkStatusView) => void;
    let blocked = false;
    const pending = new Promise<CliLinkStatusView>((resolve) => {
      resolveProbe = resolve;
    });
    const f = await connectionStatusFixture({
      probe: async () =>
        blocked
          ? pending
          : {
              providerId: "github",
              command: "gh",
              installed: true,
              authenticated: true,
              account: "cjhyy",
              accountId: "42",
            },
    });
    expect(f.calls.reads).toHaveLength(1);
    blocked = true;
    await act(async () => {
      reactPropsOf(buttonWithLabel(f.container, "刷新连接状态")).onClick();
      await flushMicrotasks();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(reactPropsOf(buttonWithLabel(f.container, "刷新连接状态")).disabled).toBe(true);
    expect(f.calls.reads).toHaveLength(2);
    expect(f.calls.probes).toHaveLength(2);
    expect(f.calls.snapshots).toEqual([
      ["/repo", false],
      ["/repo", true],
    ]);
    await act(async () => {
      resolveProbe({
        providerId: "github",
        command: "gh",
        installed: true,
        authenticated: true,
        account: "cjhyy",
        accountId: "42",
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(reactPropsOf(buttonWithLabel(f.container, "刷新连接状态")).disabled).toBe(false);
    blocked = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(f.calls.reads).toHaveLength(3);
    expect(f.calls.catalogs).toBe(3);
    expect(f.calls.probes).toHaveLength(3);
    expect(f.calls.snapshots.at(-1)).toEqual(["/repo", false]);
    expect(f.calls.mutations).toBe(0);
    await act(async () => {
      root!.unmount();
      await flushMicrotasks();
    });
    root = null;
    window.dispatchEvent(new Event("focus"));
    expect(f.calls.reads).toHaveLength(3);
  });

  test("a previous project's delayed CLI result cannot clear the current load error", async () => {
    let resolveProbe!: (status: CliLinkStatusView) => void;
    const pending = new Promise<CliLinkStatusView>((resolve) => {
      resolveProbe = resolve;
    });
    const f = await connectionStatusFixture({
      read: async (cwd) => {
        if (cwd === "/other") throw new Error("Current project credentials unavailable");
        return [cliBinding("first")];
      },
      probe: async () => pending,
    });
    await f.renderAt("/other");
    await act(async () => {
      resolveProbe({
        providerId: "github",
        command: "gh",
        installed: true,
        authenticated: true,
        account: "cjhyy",
        accountId: "42",
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(
      findElements(f.container, "P").map((node) => reactChildText(reactPropsOf(node).children)),
    ).toContain("Current project credentials unavailable");
    expect(f.calls.reads).toEqual(["/repo", "/other"]);
  });

  test("an old project's completed action cannot invalidate the new project's load", async () => {
    const legacy: MaskedCredentialView = {
      id: "github-oauth",
      type: "oauth",
      label: "Saved OAuth",
      hasSecret: true,
      meta: { oauthProvider: "github" },
    };
    let finishAction!: () => void;
    let finishRead!: (value: MaskedCredentialView[]) => void;
    const action = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const read = new Promise<MaskedCredentialView[]>((resolve) => {
      finishRead = resolve;
    });
    const f = await connectionStatusFixture({
      read: async (cwd) => (cwd === "/repo" ? [legacy] : read),
    });
    window.codeshell.mcpOAuth.refresh = async () => {
      await action;
      return {} as never;
    };
    const row = methodRows(f.container, "github", "server").find((node) =>
      findElements(node, "DIV").some(
        (item) => reactChildText(reactPropsOf(item).children) === "Saved OAuth",
      ),
    );
    await act(async () => {
      reactPropsOf(buttonWithLabel(row, "刷新")).onClick();
      await flushMicrotasks();
    });
    await f.renderAt("/other");
    await act(async () => {
      finishAction();
      await flushMicrotasks();
    });
    await act(async () => {
      finishRead([]);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(f.calls.reads).toEqual(["/repo", "/other"]);
    expect(reactPropsOf(buttonWithLabel(f.container, "刷新连接状态")).disabled).toBe(false);
  });

  test("a slower earlier snapshot cannot replace a newer refresh", async () => {
    ensureMiniDom();
    let resolveFirst!: (value: LinkSnapshot) => void;
    const first = new Promise<LinkSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const latest: LinkSnapshot = {
      providers: [],
      connections: [],
      capabilities: { token: true, cliBinding: false, deviceAuth: false },
      revision: "latest",
    };
    let calls = 0;
    Object.assign(window, {
      codeshell: { links: { remoteSnapshot: async () => (++calls === 1 ? first : latest) } },
    });
    let state!: ReturnType<typeof useRemoteLinkSnapshot>;
    function Host() {
      state = useRemoteLinkSnapshot("/repo");
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root!.render(<Host />);
      await flushMicrotasks();
    });
    expect(state.loading).toBe(true);
    await act(async () => {
      await state.reload();
      await flushMicrotasks();
    });
    expect(state.snapshot?.revision).toBe("latest");
    expect(state.loading).toBe(false);
    await act(async () => {
      resolveFirst({ ...latest, revision: "stale" });
      await flushMicrotasks();
    });
    expect(state.snapshot?.revision).toBe("latest");
  });

  test("a previous project's delayed credential load cannot replace the current accounts", async () => {
    ensureMiniDom();
    let resolveFirst!: (value: MaskedCredentialView[]) => void;
    const first = new Promise<MaskedCredentialView[]>((resolve) => {
      resolveFirst = resolve;
    });
    const account = (id: string): MaskedCredentialView => ({
      id,
      type: "link",
      label: id,
      hasSecret: true,
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "local",
        linkConnectionMethod: "fine-grained-pat",
      },
    });
    Object.assign(window, {
      codeshell: {
        credentials: {
          list: async (cwd: string) => (cwd === "/first" ? first : [account("second-account")]),
        },
        links: {
          listLocalProviders: async () => LINK_PROVIDER_FIXTURES,
          remoteSnapshot: async () => ({
            providers: LINK_PROVIDER_FIXTURES,
            connections: [],
            capabilities: { token: true, cliBinding: false, deviceAuth: false },
            revision: "snapshot",
          }),
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root!.render(<LinkTab cwd="/first" />);
      await flushMicrotasks();
    });
    await act(async () => {
      root!.render(<LinkTab cwd="/second" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await act(async () => {
      resolveFirst([account("first-account")]);
      await flushMicrotasks();
    });
    const card = await expandProvider(container, "github");
    expect(reactChildText(reactPropsOf(card).children)).toContain("second-account");
    expect(reactChildText(reactPropsOf(card).children)).not.toContain("first-account");
  });
});

describe("reviewed Link authorization failures", () => {
  test.each(["reviewed", "transport"] as const)(
    "shows safe %s diagnostics without leaking upstream content",
    async (mode) => {
      ensureMiniDom();
      const failure = {
        stage: "credential_verification",
        code: "protocol_error",
        verificationStage: "account_verification",
        reason: "account_identity_unavailable",
        body: "private-provider-body",
      };
      Object.assign(window, {
        codeshell: {
          links: {
            authorizationStart: async (_cwd: string, id: string) => {
              if (mode === "transport")
                throw new Error("https://private-provider.invalid/token?secret=private");
              return {
                id,
                providerId: "figma",
                methodId: "mcp",
                state: "failed",
                errorCode: "authorization_failed",
                failure,
              };
            },
            authorizationCancel: async () => undefined,
          },
        },
      });
      const container = document.createElement("div") as unknown as HTMLElement;
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <LinkConnectionDialog
            cwd="/repo"
            providerName="Figma"
            icon={Figma}
            modes={[
              {
                id: "mcp-oauth",
                methodId: "mcp",
                kind: "redirect",
                label: "Design context",
                available: true,
              },
            ]}
            input={{ providerId: "figma", methodId: "mcp", label: "Figma", expectedRevision: null }}
            onClose={() => undefined}
            onConnected={() => {
              throw new Error("failed authorization cannot connect");
            }}
          />,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });
      const alerts = findElements(container, "P").filter(
        (node) => reactPropsOf(node).role === "alert",
      );
      expect(alerts).toHaveLength(1);
      const text = reactChildText(reactPropsOf(alerts[0]).children);
      expect(text).toContain(mode === "reviewed" ? "确认账号" : "连接未完成");
      expect(text).not.toContain("private");
      expect(text).not.toContain("https://");
    },
  );
});

describe("unified Figma connection card", () => {
  const apiConnection: LinkSnapshot["connections"][number] = {
    id: "figma-api",
    providerId: "figma",
    methodId: "remote-link",
    label: "API account",
    runtime: "server",
    authSource: "remote-link",
    status: "connected",
    account: {
      id: "api-user",
      label: "API user",
      resources: ["Design"],
      resourceGroups: [{ id: "files", items: [{ id: "FileOne", label: "Design" }] }],
    },
    capabilityIds: ["figma.get_file"],
    revision: "api-one",
    scope: "user",
    editable: true,
  };
  const mcpConnection: LinkSnapshot["connections"][number] = {
    id: "figma-mcp",
    providerId: "figma",
    methodId: "mcp",
    label: "MCP account",
    runtime: "local",
    authSource: "mcp-oauth",
    status: "connected",
    account: { id: "mcp-user", label: "MCP user", resources: [] },
    capabilityIds: ["figma.get_design_context"],
    revision: "mcp-one",
    scope: "user",
    editable: true,
  };

  async function renderCard(connections = [apiConnection]) {
    ensureMiniDom();
    let snapshot: LinkSnapshot = {
      providers: [
        {
          ...LINK_PROVIDER_FIXTURES[1]!,
          authModes: [
            {
              id: "remote-link",
              methodId: "remote-link",
              kind: "redirect",
              label: "API",
              available: true,
            },
            { id: "mcp-oauth", methodId: "mcp", kind: "redirect", label: "MCP", available: true },
          ],
        },
      ],
      connections,
      capabilities: { token: true, cliBinding: false, deviceAuth: false, remoteAuth: true },
      revision: "initial",
    };
    const starts: unknown[][] = [];
    const refreshes: string[] = [];
    const disconnects: unknown[][] = [];
    let changed = 0;
    let update!: () => void;
    let nextSnapshot: (() => Promise<LinkSnapshot>) | undefined;
    Object.assign(window, {
      codeshell: {
        links: {
          remoteSnapshot: async () => (nextSnapshot ? nextSnapshot() : snapshot),
          authorizationStart: async (...args: unknown[]) => {
            starts.push(args);
            snapshot = {
              ...snapshot,
              connections: [
                ...snapshot.connections.filter((item) => item.id !== mcpConnection.id),
                mcpConnection,
              ],
            };
            return {
              id: args[1],
              providerId: "figma",
              methodId: "mcp",
              state: "connected",
              connection: mcpConnection,
            };
          },
          authorizationCancel: async () => undefined,
          remoteDisconnect: async (...args: unknown[]) => {
            disconnects.push(args);
            snapshot = {
              ...snapshot,
              connections: snapshot.connections.filter((item) => item.id !== args[1]),
            };
          },
        },
        mcpOAuth: {
          refresh: async (id: string) => {
            refreshes.push(id);
            return {};
          },
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    function Host() {
      const [, forceUpdate] = React.useReducer((value) => value + 1, 0);
      update = forceUpdate;
      return (
        <LinkProviderCard
          id="figma"
          name="Figma"
          description="Design service"
          icon={Figma}
          brandClass=""
          status="Not connected"
        >
          <FigmaConnectionCard
            cwd="/repo"
            snapshot={snapshot}
            loadError=""
            reload={async () => forceUpdate()}
            onChanged={() => changed++}
            localApi={<span>Local API credential</span>}
          />
        </LinkProviderCard>
      );
    }
    await act(async () => {
      root!.render(<Host />);
      await flushMicrotasks();
    });
    const click = async (label: string) => {
      const channel = [
        ...findElements(container, "DIV"),
        ...findElements(container, "SECTION"),
      ].find((node) => reactPropsOf(node)["data-figma-channel"] === "mcp");
      const button = buttonWithLabel(channel, label);
      expect(button).toBeDefined();
      await act(async () => {
        reactPropsOf(button).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
      });
    };
    return {
      container,
      starts,
      refreshes,
      disconnects,
      click,
      snapshot: () => snapshot,
      changed: () => changed,
      setSnapshot: (value: LinkSnapshot) => {
        snapshot = value;
      },
      nextSnapshot: (read: (() => Promise<LinkSnapshot>) | undefined) => {
        nextSnapshot = read;
      },
      update: async () => {
        await act(async () => {
          update();
          await flushMicrotasks();
        });
      },
    };
  }

  test("API and MCP share one card, authorize independently, and never read on connection", async () => {
    const f = await renderCard();
    expect(
      findElements(f.container, "ARTICLE").filter(
        (node) => reactPropsOf(node)["data-link-provider-card"] === "figma",
      ),
    ).toHaveLength(1);
    expect(
      [...findElements(f.container, "DIV"), ...findElements(f.container, "SECTION")].filter(
        (node) => reactPropsOf(node)["data-figma-channel"],
      ),
    ).toHaveLength(2);
    expect(buttonWithLabel(f.container, "连接设计上下文")).toBeDefined();
    expect(f.starts).toHaveLength(0);
    await f.click("连接设计上下文");
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.slice(2)).toEqual([
      {
        providerId: "figma",
        methodId: "mcp",
        label: "Figma MCP",
        connectionId: undefined,
        expectedRevision: null,
      },
      "mcp-oauth",
    ]);
    expect(f.snapshot().connections.map((item) => item.id)).toEqual(["figma-api", "figma-mcp"]);
    expect(buttonWithLabel(f.container, "连接设计上下文")).toBeUndefined();
    await f.click("刷新授权");
    expect(f.refreshes).toEqual(["figma-mcp"]);
    await f.click("断开");
    expect(f.disconnects).toEqual([["/repo", "figma-mcp", "mcp-one"]]);
    expect(f.snapshot().connections).toEqual([apiConnection]);
  });

  test("fresh account/revision checks reject stale MCP management without affecting API", async () => {
    const f = await renderCard([apiConnection, mcpConnection]);
    f.setSnapshot({
      ...f.snapshot(),
      connections: [apiConnection, { ...mcpConnection, revision: "mcp-two" }],
    });
    await f.click("刷新授权");
    expect(f.refreshes).toHaveLength(0);
    expect(f.disconnects).toHaveLength(0);
    expect(f.starts).toHaveLength(0);
    expect(
      findElements(f.container, "P").some(
        (node) =>
          reactPropsOf(node).role === "alert" &&
          reactChildText(reactPropsOf(node).children).includes("连接或权限已变化"),
      ),
    ).toBe(true);
    await f.click("刷新授权");
    expect(f.refreshes).toEqual(["figma-mcp"]);
  });

  test("an account appearing during connect requires explicit review instead of silent login", async () => {
    const f = await renderCard();
    f.setSnapshot({ ...f.snapshot(), connections: [apiConnection, mcpConnection] });
    await f.click("连接设计上下文");
    expect(f.starts).toHaveLength(0);
    expect(buttonWithLabel(f.container, "刷新授权")).toBeDefined();
    expect(f.snapshot().connections).toEqual([apiConnection, mcpConnection]);
  });
});
