import React from "react";
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { PetJournalEntry, PetMemoryEntry, PetSegmentMessage } from "../../preload/types";
import { useT } from "../i18n";
import { useConfirm } from "../ui/DialogProvider";

export interface PetMemoryCenterPageProps {
  onBack: () => void;
}

/**
 * Mimi memory center: durable-memory management and the event journal, reached
 * from Mimi settings. The durable-memory tab is the full CRUD surface (the
 * workbench section is now a read-only preview that links here); the journal tab
 * is the archived-segment timeline with lazily-revealed transcript原文.
 */
export function PetMemoryCenterPage({ onBack }: PetMemoryCenterPageProps) {
  const { t } = useT();
  const confirmRemoval = useConfirm();

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label={t("pet.memoryCenter.title")}
      data-pet-memory-center="standalone"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-5 py-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("pet.memoryCenter.back")}
          title={t("pet.memoryCenter.back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Brain size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{t("pet.memoryCenter.title")}</h1>
          <p className="truncate text-sm text-muted-foreground">{t("pet.memoryCenter.subtitle")}</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-5 lg:p-8">
          <Tabs defaultValue="memories">
            <TabsList className="mb-5">
              <TabsTrigger value="memories">{t("pet.memoryCenter.tabMemories")}</TabsTrigger>
              <TabsTrigger value="journal">{t("pet.memoryCenter.tabJournal")}</TabsTrigger>
            </TabsList>
            <TabsContent value="memories">
              <MemoriesTab confirmRemoval={confirmRemoval} />
            </TabsContent>
            <TabsContent value="journal">
              <JournalTab />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </section>
  );
}

function sourceLabelKey(source: PetMemoryEntry["source"]) {
  if (source === "auto") return "pet.memory.sourceAuto" as const;
  if (source === "mimi") return "pet.memory.sourceMimi" as const;
  return "pet.memory.sourceUser" as const;
}

export function MemoriesTab({ confirmRemoval }: { confirmRemoval: ReturnType<typeof useConfirm> }) {
  const { t } = useT();
  const api = window.codeshell.pet;
  const [entries, setEntries] = React.useState<PetMemoryEntry[] | null>(null);
  const [autoExtract, setAutoExtract] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState("");

  React.useEffect(() => {
    let disposed = false;
    api
      .listMemories?.()
      .then((loaded) => !disposed && setEntries(loaded))
      .catch(
        (cause) => !disposed && setError(cause instanceof Error ? cause.message : String(cause)),
      );
    api
      .getMemoryAutoExtract?.()
      .then((value) => !disposed && setAutoExtract(value))
      .catch(() => !disposed && setAutoExtract(true));
    const unsubscribe = api.onMemoriesChanged?.((changed) => !disposed && setEntries(changed));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

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

  const toggleAutoExtract = (next: boolean): void => {
    setAutoExtract(next);
    void api.setMemoryAutoExtract?.(next).catch((cause) => {
      setAutoExtract(!next);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="space-y-5" data-pet-memory-tab="durable">
      {autoExtract !== null && api.setMemoryAutoExtract && (
        <Card className="rounded-2xl" data-pet-setting="auto-extract">
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <div className="min-w-0 flex-1 space-y-1.5">
              <CardTitle className="text-base">{t("pet.memoryCenter.autoExtractTitle")}</CardTitle>
              <CardDescription className="leading-5">
                {t("pet.memoryCenter.autoExtractDescription")}
              </CardDescription>
            </div>
            <Switch
              checked={autoExtract}
              onCheckedChange={toggleAutoExtract}
              aria-label={t("pet.memoryCenter.autoExtractTitle")}
            />
          </CardHeader>
        </Card>
      )}

      {error && (
        <p className="rounded-xl bg-status-err/10 px-3 py-2 text-xs text-status-err">{error}</p>
      )}

      <div className="flex items-start gap-2">
        <Textarea
          value={draft}
          rows={2}
          maxLength={2000}
          placeholder={t("pet.memory.placeholder")}
          className="min-h-10 flex-1 resize-y rounded-xl text-sm leading-6"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="button"
          disabled={busy || !draft.trim()}
          className="h-10 rounded-xl"
          onClick={() => void add()}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Plus size={14} aria-hidden="true" />
          )}
          {t("pet.memory.add")}
        </Button>
      </div>

      <div className="space-y-2">
        {(entries ?? []).map((entry) => (
          <article
            key={entry.id}
            data-pet-memory={entry.id}
            className="rounded-2xl border border-border/60 bg-background/60 px-3.5 py-3"
          >
            {editingId === entry.id ? (
              <div className="flex items-start gap-1.5">
                <Textarea
                  value={editText}
                  rows={2}
                  maxLength={2000}
                  className="min-h-9 flex-1 resize-y rounded-xl text-sm leading-6"
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
                  <Check size={14} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("pet.memory.cancel")}
                  className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted"
                  onClick={() => setEditingId(null)}
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm leading-6 text-foreground">{entry.text}</p>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full bg-muted px-1.5 py-0.5">
                    {t(sourceLabelKey(entry.source))}
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
                    <Pencil size={13} aria-hidden="true" />
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
                    <Trash2 size={13} aria-hidden="true" />
                  </Button>
                </div>
              </>
            )}
          </article>
        ))}
        {entries !== null && entries.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            {t("pet.memory.empty")}
          </p>
        )}
      </div>
    </div>
  );
}

export function JournalTab() {
  const { t } = useT();
  const api = window.codeshell.pet;
  const [entries, setEntries] = React.useState<PetJournalEntry[] | null>(null);

  React.useEffect(() => {
    let disposed = false;
    api
      .listJournal?.()
      .then((loaded) => !disposed && setEntries(loaded))
      .catch(() => !disposed && setEntries([]));
    const unsubscribe = api.onJournalChanged?.((changed) => !disposed && setEntries(changed));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

  if (entries !== null && entries.length === 0) {
    return (
      <p
        data-pet-journal="empty"
        className="rounded-2xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground"
      >
        {t("pet.memoryCenter.journalEmpty")}
      </p>
    );
  }

  return (
    <div className="space-y-2.5" data-pet-memory-tab="journal">
      {(entries ?? []).map((entry) => (
        <JournalCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function JournalCard({ entry }: { entry: PetJournalEntry }) {
  const { t } = useT();
  const api = window.codeshell.pet;
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<PetSegmentMessage[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const toggleTranscript = (): void => {
    const next = !open;
    setOpen(next);
    if (next && messages === null && !loading && api.getSegmentMessages) {
      setLoading(true);
      api
        .getSegmentMessages(entry.range)
        .then((loaded) => setMessages(loaded))
        .catch(() => setMessages([]))
        .finally(() => setLoading(false));
    }
  };

  return (
    <article
      data-pet-journal-entry={entry.segmentId}
      className="rounded-2xl border border-border/60 bg-background/60 px-4 py-3.5"
    >
      <h3 className="text-sm font-semibold text-foreground">{entry.title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{entry.summary}</p>
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("pet.memoryCenter.journalMessageCount", { count: entry.messageCount })}</span>
        <span className="min-w-2 flex-1" />
        {api.getSegmentMessages && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-lg text-[11px]"
            aria-expanded={open}
            onClick={toggleTranscript}
          >
            {open ? t("pet.memoryCenter.hideTranscript") : t("pet.memoryCenter.viewTranscript")}
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
          {loading && (
            <p className="text-xs text-muted-foreground">
              {t("pet.memoryCenter.transcriptLoading")}
            </p>
          )}
          {!loading && messages !== null && messages.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("pet.memoryCenter.transcriptEmpty")}</p>
          )}
          {(messages ?? []).map((message, index) => (
            <div key={index} className="text-xs leading-5">
              <span
                className={`mr-1.5 font-semibold ${
                  message.role === "user" ? "text-primary" : "text-foreground"
                }`}
              >
                {message.role === "user"
                  ? t("pet.memoryCenter.speakerUser")
                  : t("pet.memoryCenter.speakerMimi")}
                :
              </span>
              <span className="whitespace-pre-wrap text-foreground/90">{message.text}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
