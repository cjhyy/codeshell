/**
 * ModelManager — Ink-rendered model + provider + arena management panel.
 *
 * Three tabs (Tab key cycles):
 *   - Models:    switch active model, sync OpenRouter snapshot, [A]dd model.
 *   - Providers: list configured providers, [a]dd / [r]efresh / [d]elete.
 *   - Arena:     edit arena.participants list (add from pool / delete / save).
 *
 * Distinct from ModelSelector (Ctrl+M / /model — pure switcher). Stays
 * presentational: parent owns side effects and passes async handlers in.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import type { ProtocolModelEntry } from "../../protocol/types.js";

interface SnapshotInfo {
  count: number;
  fetchedAt: string;
}

/**
 * Settings stores arena.participants as Array<string | object>. The panel
 * surfaces strings (pool keys); object-form entries are shown read-only so
 * we don't clobber a user's hand-edited config.
 */
export type ArenaParticipantEntry =
  | { kind: "key"; value: string }
  | { kind: "object"; label: string };

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
  arenaParticipants: ArenaParticipantEntry[];
  /** Providers configured in settings.providers[] (Task 11+). */
  providers?: ProviderManagerEntry[];
  /** Activate a model. */
  onSwitch: (key: string) => Promise<void>;
  /** Trigger an OpenRouter snapshot refresh. */
  onSync: () => Promise<{ ok: boolean; count: number; error?: string }>;
  /** Persist updated participant list (string[]) to settings. */
  onSaveArena: (participants: string[]) => Promise<void>;
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

type Tab = "models" | "providers" | "arena";

export function ModelManager({
  entries,
  snapshot,
  arenaParticipants,
  providers,
  onSwitch,
  onSync,
  onSaveArena,
  onOpenFlow,
  onRefreshProvider,
  onDeleteProvider,
  onDeleteModel,
  onClose,
}: ModelManagerProps) {
  const providerRows = providers ?? [];
  const [tab, setTab] = useState<Tab>("models");
  const [cursor, setCursor] = useState(() =>
    Math.max(0, entries.findIndex((e) => e.active)),
  );
  const [providerCursor, setProviderCursor] = useState(0);
  const [banner, setBanner] = useState<Banner>({ kind: "idle" });

  // Local arena state — only persisted on [w]rite. Object-form entries are
  // preserved verbatim so hand-edited settings survive a round-trip.
  const [arena, setArena] = useState<ArenaParticipantEntry[]>(arenaParticipants);
  const [arenaCursor, setArenaCursor] = useState(0);
  const [picker, setPicker] = useState<{ idx: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  // Two-step Esc to discard unsaved changes. Tracked separately from `dirty`
  // so that if the panel unmounts (e.g. user sends a message) before the
  // second Esc, `dirty` is still true and the warning state is preserved.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useInput(async (raw, key) => {
    if (banner.kind === "busy") return;

    // Normalize letter shortcuts to lowercase so Shift+A == a, etc. — users
    // shouldn't have to guess which case a hotkey expects. Non-letter input
    // (digits, punctuation, "?") passes through unchanged.
    const ch = raw && raw.length === 1 && /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;

    // Any non-Esc input after the discard warning means the user changed
    // their mind — reset the confirmation so the next Esc warns again.
    if (confirmDiscard && !key.escape && ch !== "q") {
      setConfirmDiscard(false);
    }

    // Tab cycles models → providers → arena → models. Esc/q closes
    // (warns if unsaved).
    if (key.tab) {
      setTab((t) => (t === "models" ? "providers" : t === "providers" ? "arena" : "models"));
      setBanner({ kind: "idle" });
      return;
    }
    if (key.escape || ch === "q") {
      if (dirty && !confirmDiscard) {
        setBanner({ kind: "error", text: "未保存改动 — 按 [w] 保存或再次按 Esc 放弃" });
        setConfirmDiscard(true);
        return;
      }
      onClose();
      return;
    }

    if (tab === "models") {
      await handleModelsInput(ch, key);
      return;
    }
    if (tab === "providers") {
      await handleProvidersInput(ch, key);
      return;
    }
    await handleArenaInput(ch, key);
  });

  async function handleModelsInput(ch: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }): Promise<void> {
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

  async function handleProvidersInput(ch: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }): Promise<void> {
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

  async function handleArenaInput(ch: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }): Promise<void> {
    if (picker) {
      // Picker mode: choose a pool entry to add.
      if (key.upArrow) {
        setPicker({ idx: picker.idx > 0 ? picker.idx - 1 : entries.length - 1 });
        return;
      }
      if (key.downArrow) {
        setPicker({ idx: picker.idx < entries.length - 1 ? picker.idx + 1 : 0 });
        return;
      }
      if (key.return) {
        const chosen = entries[picker.idx];
        if (chosen) {
          setArena((prev) => [...prev, { kind: "key", value: chosen.key }]);
          setDirty(true);
          setBanner({ kind: "info", text: `已加入: ${chosen.key} (未保存)` });
        }
        setPicker(null);
        return;
      }
      // Any other key cancels picker.
      setPicker(null);
      return;
    }

    if (key.upArrow) {
      setArenaCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setArenaCursor((c) => (arena.length === 0 ? 0 : Math.min(arena.length - 1, c + 1)));
      return;
    }
    if (ch === "a") {
      if (entries.length === 0) {
        setBanner({ kind: "error", text: "模型池为空 — 先在 Models tab 同步快照" });
        return;
      }
      setPicker({ idx: 0 });
      setBanner({ kind: "info", text: "选一个模型加入 (Enter 确认, 任意键取消)" });
      return;
    }
    if (ch === "d") {
      if (arena.length === 0) return;
      const removed = arena[arenaCursor];
      setArena((prev) => prev.filter((_, i) => i !== arenaCursor));
      setArenaCursor((c) => Math.max(0, Math.min(arena.length - 2, c)));
      setDirty(true);
      const label = removed?.kind === "key" ? removed.value : removed?.label ?? "";
      setBanner({ kind: "info", text: `已移除: ${label} (未保存)` });
      return;
    }
    if (ch === "w") {
      // Object-form entries can't round-trip through this string-only panel
      // (we'd need a richer editor). Refuse rather than silently drop them.
      const objs = arena.filter((p) => p.kind === "object");
      if (objs.length > 0) {
        setBanner({
          kind: "error",
          text: `存在 ${objs.length} 个对象形式条目，请直接编辑 settings.json 后重启`,
        });
        return;
      }
      const list = arena.map((p) => (p as { kind: "key"; value: string }).value);
      setBanner({ kind: "busy", text: "保存中…" });
      try {
        await onSaveArena(list);
        setBanner({ kind: "info", text: `✓ 已保存 (${list.length} 个 participant)` });
        setDirty(false);
      } catch (err) {
        setBanner({ kind: "error", text: `保存失败: ${(err as Error).message}` });
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
        <Text color="ansi:cyan" bold>{"✦ 模型管理"}</Text>
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
        <Text>{"   "}</Text>
        <Text color={tab === "arena" ? "ansi:cyan" : undefined} bold={tab === "arena"}>
          {tab === "arena" ? "● Arena" : "○ Arena"}
        </Text>
      </Box>

      {tab === "models" ? (
        <ModelsPane entries={entries} cursor={cursor} snapshot={snapshot} />
      ) : tab === "providers" ? (
        <ProvidersPane providers={providerRows} cursor={providerCursor} />
      ) : (
        <ArenaPane
          arena={arena}
          cursor={arenaCursor}
          picker={picker}
          poolEntries={entries}
          dirty={dirty}
        />
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

/** Format a token count into a human-readable string. */
function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

/** Derive capability tags from model key/name. */
function modelTags(key: string, model: string): string[] {
  const tags: string[] = [];
  const lower = `${key} ${model}`.toLowerCase();
  if (/coder|code|devstral/i.test(lower)) tags.push("coding");
  if (/reason|think|r1|o3|o4|pro/i.test(lower)) tags.push("reasoning");
  if (/flash|mini|haiku|fast|small|nano/i.test(lower)) tags.push("fast");
  if (/cheap|free/i.test(lower)) tags.push("cheap");
  if (/large|max|ultra|opus|big/i.test(lower)) tags.push("powerful");
  return tags;
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
  const keyWidth = entries.length
    ? Math.min(Math.max(...entries.map((e) => e.key.length)), 16)
    : 0;
  const ctxWidth = entries.length
    ? Math.min(Math.max(...entries.map((e) => fmtTokens(e.maxContextTokens).length)), 8)
    : 0;

  return (
    <>
      <Box marginLeft={2} marginTop={1}>
        <Text dim>{"快照: "}</Text>
        <Text>{`${snapshot.count} 个模型`}</Text>
        <Text dim>{snapshot.fetchedAt ? ` · ${formatFreshness(snapshot.fetchedAt)}` : " · 未拉取"}</Text>
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
                <Text>{"  "}{e.model.padEnd(32)}</Text>
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

function ArenaPane({
  arena,
  cursor,
  picker,
  poolEntries,
  dirty,
}: {
  arena: ArenaParticipantEntry[];
  cursor: number;
  picker: { idx: number } | null;
  poolEntries: ProtocolModelEntry[];
  dirty: boolean;
}) {
  return (
    <>
      <Box marginLeft={2} marginTop={1}>
        <Text bold>{`Arena 参与者 (${arena.length})`}</Text>
        {dirty && <Text color="ansi:yellow">{"  • 未保存"}</Text>}
      </Box>

      {arena.length === 0 ? (
        <Box marginLeft={4}>
          <Text dim>{"未配置 — Arena 将回退到默认参与者。按 [a] 添加。"}</Text>
        </Box>
      ) : (
        arena.map((p, i) => {
          const focused = i === cursor;
          const prefix = focused ? "❯ " : "  ";
          if (p.kind === "key") {
            const pool = poolEntries.find((e) => e.key === p.value);
            return (
              <Box key={`k-${i}`} marginLeft={2}>
                <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                  {prefix}
                  {p.value}
                </Text>
                {pool && <Text dim>{"  "}{pool.model}</Text>}
                {!pool && <Text color="ansi:yellow">{"  (不在当前模型池)"}</Text>}
              </Box>
            );
          }
          return (
            <Box key={`o-${i}`} marginLeft={2}>
              <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                {prefix}
                {p.label}
              </Text>
              <Text dim>{"  (对象形式 · 只读)"}</Text>
            </Box>
          );
        })
      )}

      {picker && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text bold>{"从模型池选择:"}</Text>
          {poolEntries.map((e, i) => {
            const focused = i === picker.idx;
            const prefix = focused ? "❯ " : "  ";
            return (
              <Box key={e.key} marginLeft={2}>
                <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                  {prefix}
                  {e.key}
                </Text>
                <Text dim>{"  "}{e.model}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dim>
          {"操作: "}
          <Text color="ansi:cyan">{"[a]"}</Text>
          {" 添加  "}
          <Text color="ansi:cyan">{"[d]"}</Text>
          {" 删除  "}
          <Text color="ansi:cyan">{"[w]"}</Text>
          {" 保存"}
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
