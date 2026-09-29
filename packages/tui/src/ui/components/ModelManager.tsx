/**
 * ModelManager — Ink-rendered model + provider management panel.
 *
 * Two tabs (Tab key cycles):
 *   - Models:    switch active model, sync OpenRouter snapshot, [A]dd model.
 *   - Providers: list configured providers, [a]dd / [r]efresh / [d]elete.
 *
 * Distinct from ModelSelector (Ctrl+M / /model — pure switcher). Stays
 * presentational: parent owns side effects and passes async handlers in.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import type { ProtocolModelEntry } from "@cjhyy/code-shell-core/internal";
import { fmtTokens, modelTags } from "./model-display.js";

interface SnapshotInfo {
  count: number;
  fetchedAt: string;
}

/**
 * Row data shown in the Providers tab. Counts/timestamps are derived by the
 * parent from settings.providers[] + the model cache so this component stays
 * presentational.
 */
export interface ProviderManagerEntry {
  key: string;
  label: string;
  kind: string;
  modelCount: number;
  cachedModels?: number;
  cachedAt?: string;
  // Full provider config fields (populated by App.tsx from settings.providers[])
  // so that ProviderModelFlow's "use existing" branch can fetch model lists
  // without an extra round-trip to the server.
  baseUrl?: string;
  apiKey?: string;
  protocol?: string;
  modelsPath?: string;
}

interface ModelManagerProps {
  entries: ProtocolModelEntry[];
  snapshot: SnapshotInfo;
  /** Providers configured in settings.providers[] (Task 11+). */
  providers?: ProviderManagerEntry[];
  /** Activate a model. */
  onSwitch: (key: string) => Promise<void>;
  /** Trigger an OpenRouter snapshot refresh. */
  onSync: () => Promise<{ ok: boolean; count: number; error?: string }>;
  /** Open the parent-rendered ProviderModelFlow (covers both add-provider and add-model). */
  onOpenFlow?: () => void;
  /** Force-refresh a provider's cached model list. */
  onRefreshProvider?: (key: string) => Promise<{ count: number; error?: string }>;
  /** Delete a provider (blocked if any model references it). */
  onDeleteProvider?: (key: string) => Promise<{ ok: boolean; error?: string }>;
  /** Delete a model entry. */
  onDeleteModel?: (key: string) => Promise<void>;
  onClose: () => void;
}

type Banner =
  | { kind: "idle" }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "busy"; text: string };

type Tab = "models" | "providers";

export function ModelManager({
  entries,
  snapshot,
  providers,
  onSwitch,
  onSync,
  onOpenFlow,
  onRefreshProvider,
  onDeleteProvider,
  onDeleteModel,
  onClose,
}: ModelManagerProps) {
  const providerRows = providers ?? [];
  const [tab, setTab] = useState<Tab>("models");
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      entries.findIndex((e) => e.active),
    ),
  );
  const [providerCursor, setProviderCursor] = useState(0);
  const [banner, setBanner] = useState<Banner>({ kind: "idle" });

  useInput(async (raw, key) => {
    if (banner.kind === "busy") return;

    // Normalize letter shortcuts to lowercase so Shift+A == a, etc. — users
    // shouldn't have to guess which case a hotkey expects. Non-letter input
    // (digits, punctuation, "?") passes through unchanged.
    const ch = raw && raw.length === 1 && /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;

    // Tab toggles models ↔ providers. Esc/q closes.
    if (key.tab) {
      setTab((t) => (t === "models" ? "providers" : "models"));
      setBanner({ kind: "idle" });
      return;
    }
    if (key.escape || ch === "q") {
      onClose();
      return;
    }

    if (tab === "models") {
      await handleModelsInput(ch, key);
      return;
    }
    await handleProvidersInput(ch, key);
  });

  async function handleModelsInput(
    ch: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
  ): Promise<void> {
    // 'a' opens the unified ProviderModelFlow at any time, even with an empty
    // pool — that's the whole point of the flow. (ch is already lowercased by
    // the dispatcher so Shift+A also works.)
    if (ch === "a") {
      if (onOpenFlow) onOpenFlow();
      return;
    }
    if (entries.length === 0) {
      if (ch === "s") await runSync();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : entries.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c < entries.length - 1 ? c + 1 : 0));
      return;
    }
    if (key.return) {
      const target = entries[cursor];
      if (!target) return;
      // Always call onSwitch — even on the row already marked active. The
      // in-memory active mark can disagree with settings.activeKey on disk
      // (e.g. an earlier switch in this process didn't persist), and
      // re-invoking the switch is idempotent and ensures the disk catches
      // up. After the call, close so we land on the input box — mirrors
      // ModelSelector (Ctrl+M / /model) UX.
      setBanner({ kind: "busy", text: `切换到 ${target.key}…` });
      try {
        await onSwitch(target.key);
        onClose();
      } catch (err) {
        setBanner({ kind: "error", text: `切换失败: ${(err as Error).message}` });
      }
      return;
    }
    if (ch === "x") {
      if (!onDeleteModel) return;
      const target = entries[cursor];
      if (!target) return;
      setBanner({ kind: "busy", text: `删除 ${target.key}…` });
      try {
        await onDeleteModel(target.key);
        setBanner({ kind: "info", text: `✓ 已删除 ${target.key}` });
      } catch (err) {
        setBanner({ kind: "error", text: `删除失败: ${(err as Error).message}` });
      }
      return;
    }
    if (ch === "s") {
      await runSync();
      return;
    }
  }

  async function handleProvidersInput(
    ch: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
  ): Promise<void> {
    if (ch === "a") {
      if (onOpenFlow) onOpenFlow();
      return;
    }
    if (providerRows.length === 0) return;
    if (key.upArrow) {
      setProviderCursor((c) => (c > 0 ? c - 1 : providerRows.length - 1));
      return;
    }
    if (key.downArrow) {
      setProviderCursor((c) => (c < providerRows.length - 1 ? c + 1 : 0));
      return;
    }
    if (ch === "r") {
      if (!onRefreshProvider) return;
      const target = providerRows[providerCursor];
      if (!target) return;
      setBanner({ kind: "busy", text: `刷新 ${target.key} 模型清单…` });
      try {
        const r = await onRefreshProvider(target.key);
        if (r.error) setBanner({ kind: "error", text: `刷新失败: ${r.error}` });
        else setBanner({ kind: "info", text: `✓ 已缓存 ${r.count} 个模型` });
      } catch (err) {
        setBanner({ kind: "error", text: `刷新失败: ${(err as Error).message}` });
      }
      return;
    }
    if (ch === "d") {
      if (!onDeleteProvider) return;
      const target = providerRows[providerCursor];
      if (!target) return;
      if (target.modelCount > 0) {
        setBanner({
          kind: "error",
          text: `无法删除: 仍有 ${target.modelCount} 个模型引用 ${target.key}`,
        });
        return;
      }
      setBanner({ kind: "busy", text: `删除 ${target.key}…` });
      try {
        const r = await onDeleteProvider(target.key);
        if (!r.ok) setBanner({ kind: "error", text: `删除失败: ${r.error ?? "未知错误"}` });
        else setBanner({ kind: "info", text: `✓ 已删除 ${target.key}` });
      } catch (err) {
        setBanner({ kind: "error", text: `删除失败: ${(err as Error).message}` });
      }
      return;
    }
  }

  async function runSync(): Promise<void> {
    setBanner({ kind: "busy", text: "正在拉取 OpenRouter 模型清单…" });
    try {
      const r = await onSync();
      if (r.ok) {
        setBanner({ kind: "info", text: `✓ 已同步 ${r.count} 个模型 (本进程内生效)` });
      } else {
        setBanner({ kind: "error", text: `同步失败: ${r.error ?? "未知错误"}` });
      }
    } catch (err) {
      setBanner({ kind: "error", text: `同步失败: ${(err as Error).message}` });
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color="ansi:cyan" bold>
          {"✦ 模型管理"}
        </Text>
        <Text dim>{"  (Tab 切换面板, q/Esc 关闭)"}</Text>
      </Box>

      <Box marginLeft={2} marginTop={1}>
        <Text color={tab === "models" ? "ansi:cyan" : undefined} bold={tab === "models"}>
          {tab === "models" ? "● Models" : "○ Models"}
        </Text>
        <Text>{"   "}</Text>
        <Text color={tab === "providers" ? "ansi:cyan" : undefined} bold={tab === "providers"}>
          {tab === "providers" ? "● Providers" : "○ Providers"}
        </Text>
      </Box>

      {tab === "models" ? (
        <ModelsPane entries={entries} cursor={cursor} snapshot={snapshot} />
      ) : (
        <ProvidersPane providers={providerRows} cursor={providerCursor} />
      )}

      {banner.kind !== "idle" && (
        <Box marginLeft={2} marginTop={1}>
          <Text
            color={
              banner.kind === "error"
                ? "ansi:red"
                : banner.kind === "busy"
                  ? "ansi:yellow"
                  : "ansi:green"
            }
          >
            {banner.text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Panes ───────────────────────────────────────────────────────

function ModelsPane({
  entries,
  cursor,
  snapshot,
}: {
  entries: ProtocolModelEntry[];
  cursor: number;
  snapshot: SnapshotInfo;
}) {
  const keyWidth = entries.length ? Math.min(Math.max(...entries.map((e) => e.key.length)), 16) : 0;
  const ctxWidth = entries.length
    ? Math.min(Math.max(...entries.map((e) => fmtTokens(e.maxContextTokens).length)), 8)
    : 0;

  return (
    <>
      <Box marginLeft={2} marginTop={1}>
        <Text dim>{"快照: "}</Text>
        <Text>{`${snapshot.count} 个模型`}</Text>
        <Text dim>
          {snapshot.fetchedAt ? ` · ${formatFreshness(snapshot.fetchedAt)}` : " · 未拉取"}
        </Text>
      </Box>

      <Box marginLeft={2} marginTop={1}>
        <Text bold>{`模型池 (${entries.length}):`}</Text>
      </Box>

      {entries.length === 0 ? (
        <Box marginLeft={4}>
          <Text dim>{"未配置模型池。按 [s] 拉取最新清单，再用 /login 选择。"}</Text>
        </Box>
      ) : (
        <>
          <Box marginLeft={2}>
            <Text dim>
              {"  ".padEnd(keyWidth + 2)}模型路径{" ".repeat(28)}上下文{"  "}标签
            </Text>
          </Box>
          {entries.map((e, i) => {
            const focused = i === cursor;
            const prefix = focused ? "❯ " : "  ";
            const activeMark = e.active ? "  ← active" : "";
            const tags = modelTags(e.key, e.model);
            const tagStr = tags.length > 0 ? tags.join(", ") : "";
            return (
              <Box key={e.key} marginLeft={2}>
                <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                  {prefix}
                  {e.key.padEnd(keyWidth)}
                </Text>
                <Text>
                  {"  "}
                  {e.model.padEnd(32)}
                </Text>
                <Text dim>{fmtTokens(e.maxContextTokens).padStart(ctxWidth)}</Text>
                <Text>{"  "}</Text>
                <Text color="ansi:green">{tagStr}</Text>
                <Text color="ansi:green">{activeMark}</Text>
              </Box>
            );
          })}
        </>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dim>
          {"操作: "}
          <Text color="ansi:cyan">{"[Enter]"}</Text>
          {" 切换  "}
          <Text color="ansi:cyan">{"[a]"}</Text>
          {" 添加 provider+模型  "}
          <Text color="ansi:cyan">{"[x]"}</Text>
          {" 删除  "}
          <Text color="ansi:cyan">{"[s]"}</Text>
          {" 同步快照"}
        </Text>
      </Box>
    </>
  );
}

function ProvidersPane({
  providers,
  cursor,
}: {
  providers: ProviderManagerEntry[];
  cursor: number;
}) {
  return (
    <>
      <Box marginLeft={2} marginTop={1}>
        <Text bold>{`Providers (${providers.length})`}</Text>
      </Box>

      {providers.length === 0 ? (
        <Box marginLeft={4}>
          <Text dim>{"尚未配置任何 provider。按 [a] 添加。"}</Text>
        </Box>
      ) : (
        providers.map((p, i) => {
          const focused = i === cursor;
          const prefix = focused ? "❯ " : "  ";
          const cached =
            p.cachedModels !== undefined
              ? `${p.cachedModels} 缓存${p.cachedAt ? ` · ${formatFreshness(p.cachedAt)}` : ""}`
              : "未拉取";
          return (
            <Box key={p.key} marginLeft={2}>
              <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                {prefix}
                {p.label || p.key}
              </Text>
              <Text dim>{`  (${p.kind})  `}</Text>
              <Text>{`${p.modelCount} 模型  `}</Text>
              <Text dim>{cached}</Text>
            </Box>
          );
        })
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dim>
          {"操作: "}
          <Text color="ansi:cyan">{"[a]"}</Text>
          {" 添加 provider+模型  "}
          <Text color="ansi:cyan">{"[r]"}</Text>
          {" 刷新  "}
          <Text color="ansi:cyan">{"[d]"}</Text>
          {" 删除"}
        </Text>
      </Box>
    </>
  );
}

function formatFreshness(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const ageMs = Date.now() - t;
  const ageHr = Math.floor(ageMs / 3_600_000);
  if (ageHr < 1) return "几分钟前";
  if (ageHr < 24) return `${ageHr} 小时前`;
  const ageDay = Math.floor(ageHr / 24);
  if (ageDay < 7) return `${ageDay} 天前`;
  return new Date(iso).toLocaleDateString();
}
