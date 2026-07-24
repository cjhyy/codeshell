import React from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PetMemoryEntry } from "../../preload/types";
import { useT } from "../i18n";

/** Recent entries shown in the collapsed workbench preview. */
const PREVIEW_LIMIT = 5;

function sourceLabelKey(source: PetMemoryEntry["source"]) {
  if (source === "auto") return "pet.memory.sourceAuto" as const;
  if (source === "mimi") return "pet.memory.sourceMimi" as const;
  return "pet.memory.sourceUser" as const;
}

/**
 * Read-only workbench preview of Mimi's durable memory: the most recent entries
 * with their source, plus a link into the memory center for full management
 * (add/edit/delete + the event journal). Full CRUD moved to PetMemoryCenterPage
 * so the workbench stays a glanceable summary, not an editor.
 */
export function PetMemorySection({ onManage }: { onManage?: () => void }) {
  const { t } = useT();
  const api = window.codeshell.pet;
  const [entries, setEntries] = React.useState<PetMemoryEntry[] | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!api.listMemories) return;
    let disposed = false;
    api
      .listMemories()
      .then((loaded) => !disposed && setEntries(loaded))
      .catch(() => !disposed && setEntries([]));
    const unsubscribe = api.onMemoriesChanged?.((changed) => !disposed && setEntries(changed));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

  if (!api.listMemories) return null;

  const count = entries?.length ?? 0;
  const preview = (entries ?? []).slice(0, PREVIEW_LIMIT);

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
              {count > 0 ? t("pet.memory.summary", { count }) : t("pet.memory.recentEmpty")}
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
          {preview.map((entry) => (
            <article
              key={entry.id}
              data-pet-memory={entry.id}
              className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2.5"
            >
              <p className="text-xs leading-5 text-foreground">{entry.text}</p>
              <span className="mt-1.5 inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(sourceLabelKey(entry.source))}
              </span>
            </article>
          ))}
          {count === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t("pet.memory.empty")}</p>
          )}
          {onManage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center rounded-xl text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onManage}
            >
              {t("pet.memory.manage")}
              <ChevronRight size={13} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
