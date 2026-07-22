import React from "react";
import { Brain, Check, ChevronDown, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PetMemoryEntry } from "../../preload/types";
import { useT } from "../i18n";
import { useConfirm } from "../ui/DialogProvider";

/**
 * Session-like management for Mimi's durable memory: every entry is listed,
 * inline-editable, and removable. The same store feeds Mimi's runtime context
 * and her Memory tool, so what the user sees here is exactly what Mimi knows.
 */
export function PetMemorySection() {
  const confirmRemoval = useConfirm();
  return <PetMemorySectionContent confirmRemoval={confirmRemoval} />;
}

/** Interaction body split from the dialog hook so renderer tests can exercise
 * the real edit/delete flows without depending on Radix portal emulation. */
export function PetMemorySectionContent({
  confirmRemoval,
}: {
  confirmRemoval: ReturnType<typeof useConfirm>;
}) {
  const { t } = useT();
  const api = window.codeshell.pet;
  const [entries, setEntries] = React.useState<PetMemoryEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState("");

  React.useEffect(() => {
    if (!api.listMemories) return;
    let disposed = false;
    api
      .listMemories()
      .then((loaded) => {
        if (!disposed) setEntries(loaded);
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    const unsubscribe = api.onMemoriesChanged?.((changed) => {
      if (!disposed) setEntries(changed);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

  if (!api.listMemories) return null;

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      const text = draft.trim();
      if (!text) return;
      await api.addMemory?.(text);
      setDraft("");
    });

  const saveEdit = () =>
    run(async () => {
      if (!editingId || !editText.trim()) return;
      await api.updateMemory?.(editingId, editText.trim());
      setEditingId(null);
    });

  const remove = async (entry: PetMemoryEntry): Promise<void> => {
    const approved = await confirmRemoval({
      title: t("pet.memory.deleteTitle"),
      message: t("pet.memory.deleteConfirm", { text: entry.text.slice(0, 80) }),
      confirmLabel: t("pet.memory.delete"),
      destructive: true,
    });
    if (approved) await run(() => api.removeMemory!(entry.id));
  };

  const count = entries?.length ?? 0;
  return (
    <section
      data-pet-memories="durable"
      className="rounded-2xl border border-border/60 bg-background/45 p-1"
    >
      <h3>
        <Button
          type="button"
          variant="ghost"
          aria-expanded={open}
          className="h-auto w-full justify-start gap-2.5 whitespace-normal rounded-xl px-2.5 py-2.5 text-left hover:bg-muted/55"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Brain size={16} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{t("pet.memory.title")}</span>
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {count > 0 ? t("pet.memory.summary", { count }) : t("pet.memory.empty")}
            </span>
          </span>
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
            {count}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </h3>
      {open && (
        <div className="space-y-2 px-1.5 pb-1.5 pt-2">
          {error && (
            <p className="rounded-xl bg-status-err/10 px-3 py-2 text-xs text-status-err">{error}</p>
          )}
          <div className="flex items-start gap-1.5">
            <Textarea
              value={draft}
              rows={1}
              maxLength={2000}
              placeholder={t("pet.memory.placeholder")}
              className="min-h-9 flex-1 resize-y rounded-xl text-xs leading-5"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={busy || !draft.trim()}
              className="h-9 rounded-xl text-[11px]"
              onClick={() => void add()}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Plus size={12} aria-hidden="true" />
              )}
              {t("pet.memory.add")}
            </Button>
          </div>
          {(entries ?? []).map((entry) => (
            <article
              key={entry.id}
              data-pet-memory={entry.id}
              className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2.5"
            >
              {editingId === entry.id ? (
                <div className="flex items-start gap-1.5">
                  <Textarea
                    value={editText}
                    rows={2}
                    maxLength={2000}
                    className="min-h-9 flex-1 resize-y rounded-xl text-xs leading-5"
                    onChange={(event) => setEditText(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("pet.memory.save")}
                    disabled={busy || !editText.trim()}
                    className="h-8 w-8 rounded-lg text-status-ok hover:bg-status-ok/10 hover:text-status-ok"
                    onClick={() => void saveEdit()}
                  >
                    <Check size={13} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("pet.memory.cancel")}
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted"
                    onClick={() => setEditingId(null)}
                  >
                    <X size={13} aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-xs leading-5 text-foreground">{entry.text}</p>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="rounded-full bg-muted px-1.5 py-0.5">
                      {t(
                        entry.source === "mimi" ? "pet.memory.sourceMimi" : "pet.memory.sourceUser",
                      )}
                    </span>
                    <span className="min-w-2 flex-1" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("pet.memory.edit")}
                      disabled={busy}
                      className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        setEditingId(entry.id);
                        setEditText(entry.text);
                      }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("pet.memory.delete")}
                      disabled={busy}
                      className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-status-err/10 hover:text-status-err"
                      onClick={() => void remove(entry)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
