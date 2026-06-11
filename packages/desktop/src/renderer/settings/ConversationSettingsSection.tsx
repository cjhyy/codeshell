/**
 * 「对话」设置页 — no-repo 纯聊天的能力白名单(设计稿 §4)。
 *
 * 作用域 = no-repo cwd(~/.code-shell/no-repo)。core 端已把这个 cwd 的
 * skill / plugin 反转成"默认全关 + 白名单":凡没在 capabilityOverrides 里
 * 显式标 "on" 的 skill/plugin 都禁用。所以本页只管显示 / 写 on|inherit:
 *   - 开 = setCapabilityOverride(cwd, id, "on")
 *   - 关 = setCapabilityOverride(cwd, id, "inherit")  ← 回到默认全关
 * 开关的当前态以 projectOverride === "on" 为准(不靠 enabled,因为 core 端
 * 默认全关的语义可能晚于本页渲染落地)。
 *
 * builtin 区只读展示;"没有 cwd 就没意义"的那批工具置灰禁用(纯产品引导,
 * core 不改 builtin 默认)。agent / mcp 本期不渲染。
 *
 * 关键:cwd 必须取自 main 的 window.codeshell.noRepoCwd(),绝不在渲染进程
 * 自己拼 homedir()——否则写到的 capabilityOverrides 路径和运行时 Engine 的
 * config.cwd 对不上。
 */
import React, { useEffect, useRef, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import { MessageSquare, Sparkles, Puzzle, Wrench, Lock } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { notifySettingsChanged } from "../settingsBus";
import { useConfirm } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";

/**
 * builtin 工具里"对话无项目目录就没意义"的那批,置灰禁用(设计稿 §4)。
 * 以 cap.id 末段(builtin: 之后)匹配,大小写 + 分隔符无关,所以
 * "builtin:Read" / "builtin:apply-patch" / "builtin:ApplyPatch" 都命中。
 */
const CWD_DEPENDENT_BUILTINS = new Set([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "applypatch",
  "enterworktree",
  "exitworktree",
  "lsp",
  "notebookedit",
]);

/** Last id segment, lowercased, separators stripped — for robust matching. */
function builtinKey(id: string): string {
  const seg = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return seg.toLowerCase().replace(/[-_\s]/g, "");
}

function isCwdDependentBuiltin(cap: CapabilityDescriptor): boolean {
  return CWD_DEPENDENT_BUILTINS.has(builtinKey(cap.id));
}

export function ConversationSettingsSection() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [caps, setCaps] = useState<CapabilityDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  // Monotonic token so a slow earlier load can't clobber a newer one.
  const loadSeq = useRef(0);

  const reload = async (resolved: string) => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const next = await window.codeshell.listCapabilities(resolved);
      if (seq !== loadSeq.current) return;
      setCaps(next);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Authoritative cwd from main — never recompute homedir() here.
        const resolved = await window.codeshell.noRepoCwd();
        if (!alive) return;
        setCwd(resolved);
        await reload(resolved);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOverride = async (cap: CapabilityDescriptor, state: "on" | "off" | "inherit") => {
    if (!cwd) return;
    setSavingId(cap.id);
    setError(null);
    try {
      await window.codeshell.setCapabilityOverride(cwd, cap.id, state);
      notifySettingsChanged();
      await reload(cwd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const skills = caps.filter((c) => c.kind === "skill");
  const plugins = caps.filter((c) => c.kind === "plugin");
  const builtins = caps.filter((c) => c.kind === "builtin");

  // Anything the user has explicitly switched on (override === "on").
  const enabledOptIns = [...skills, ...plugins].filter((c) => c.projectOverride === "on");

  const onCloseAll = async () => {
    if (!cwd || enabledOptIns.length === 0) return;
    const ok = await confirm({
      title: "全部关闭",
      message: `将关闭 ${enabledOptIns.length} 项已开启的技能 / 插件,纯聊天回到默认全关状态。`,
      confirmLabel: "全部关闭",
    });
    if (!ok) return;
    setBulkBusy(true);
    setError(null);
    try {
      for (const c of enabledOptIns) {
        await window.codeshell.setCapabilityOverride(cwd, c.id, "inherit");
      }
      notifySettingsChanged();
      await reload(cwd);
      toast({ message: "已全部关闭,纯聊天对话回到默认全关。", variant: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const renderOptInRow = (cap: CapabilityDescriptor) => {
    const on = cap.projectOverride === "on";
    const busy = savingId === cap.id || bulkBusy;
    return (
      <div
        key={cap.id}
        className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5"
      >
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{cap.name}</div>
          {cap.description && (
            <div className="truncate text-xs text-muted-foreground">{cap.description}</div>
          )}
        </div>
        <Switch
          checked={on}
          disabled={busy}
          aria-label={`${cap.name} 开关`}
          onCheckedChange={(v) => void setOverride(cap, v ? "on" : "inherit")}
        />
      </div>
    );
  };

  const renderBuiltinRow = (cap: CapabilityDescriptor) => {
    const cwdLocked = isCwdDependentBuiltin(cap);
    const busy = savingId === cap.id || bulkBusy;
    // Builtins default ON in the conversation scope (core does not whitelist
    // them); the toggle writes an explicit `off` override to turn one off, and
    // `inherit` to return it to the default-on state. So "on" = not explicitly
    // off. cwd-dependent builtins stay locked off (no project dir in chat).
    const on = !cwdLocked && cap.projectOverride !== "off";
    return (
      <div
        key={cap.id}
        className={cn(
          "flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5",
          cwdLocked && "opacity-60",
        )}
      >
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{cap.name}</div>
          {cwdLocked ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={11} />
              对话无项目目录,不可用
            </div>
          ) : (
            cap.description && (
              <div className="truncate text-xs text-muted-foreground">{cap.description}</div>
            )
          )}
        </div>
        <Switch
          checked={on}
          disabled={cwdLocked || busy}
          aria-label={cwdLocked ? `${cap.name}(不可用)` : `${cap.name} 开关`}
          onCheckedChange={(v) => void setOverride(cap, v ? "inherit" : "off")}
        />
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-foreground"
          aria-hidden
        >
          <MessageSquare size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">对话能力</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            以下设置只影响<strong className="font-medium text-foreground">无项目的纯聊天对话</strong>
            (不绑代码目录)。技能和插件默认全部关闭,按需手动开启;对新对话生效。
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-status-err">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

      {!loading && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              已开启 {enabledOptIns.length} 项技能 / 插件
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={bulkBusy || enabledOptIns.length === 0}
              onClick={() => void onCloseAll()}
            >
              全部关闭
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles size={13} />
              技能
              <span className="text-muted-foreground/70">{skills.length}</span>
            </div>
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">尚无已安装的技能。</p>
            ) : (
              skills.map(renderOptInRow)
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Puzzle size={13} />
              插件
              <span className="text-muted-foreground/70">{plugins.length}</span>
            </div>
            {plugins.length === 0 ? (
              <p className="text-sm text-muted-foreground">尚无已安装的插件。</p>
            ) : (
              plugins.map(renderOptInRow)
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Wrench size={13} />
              内置工具
              <span className="text-muted-foreground/70">{builtins.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              内置工具默认开,可手动关掉不需要的;依赖项目目录的工具在纯聊天里不可用。
            </p>
            {builtins.length === 0 ? (
              <p className="text-sm text-muted-foreground">无内置工具。</p>
            ) : (
              builtins.map(renderBuiltinRow)
            )}
          </div>
        </>
      )}
    </section>
  );
}
