import React from "react";
import {
  Archive,
  Bot,
  Check,
  Circle,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  Save,
  X,
} from "lucide-react";
import type { PetTodoItem, PetTodoStatus } from "../../preload/types";
import { useT } from "../i18n";
import { useOptionalPetState } from "./PetStateProvider";

const STATUS_TONE: Record<PetTodoStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  in_progress: "bg-status-running/10 text-status-running",
  blocked: "bg-status-warn/10 text-status-warn",
  completed: "bg-status-ok/10 text-status-ok",
  archived: "bg-muted text-muted-foreground",
};

function replaceTodo(entries: readonly PetTodoItem[], item: PetTodoItem): PetTodoItem[] {
  if (item.status === "archived") return entries.filter((entry) => entry.id !== item.id);
  const next = entries.filter((entry) => entry.id !== item.id);
  next.push(item);
  return next.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function PetTodoSection() {
  const { t } = useT();
  const { dispatch } = useOptionalPetState();
  const api = window.codeshell.pet;
  const [entries, setEntries] = React.useState<PetTodoItem[]>([]);
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingText, setEditingText] = React.useState("");
  const [busyIds, setBusyIds] = React.useState<Set<string>>(() => new Set());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!api.listTodos) {
      setLoading(false);
      return;
    }
    let active = true;
    const unsubscribe = api.onTodosChanged?.((items) => {
      if (!active) return;
      setEntries(items.filter((item) => item.status !== "archived"));
      setError(null);
    });
    void api
      .listTodos()
      .then((items) => {
        if (active) setEntries(items.filter((item) => item.status !== "archived"));
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api]);

  const mutate = React.useCallback(
    async (key: string, operation: () => Promise<PetTodoItem>): Promise<void> => {
      setBusyIds((current) => new Set(current).add(key));
      setError(null);
      try {
        const item = await operation();
        setEntries((current) => replaceTodo(current, item));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  const create = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !api.createTodo) return;
    setDraft("");
    await mutate("__create__", () => api.createTodo!(text));
  };

  const saveEdit = async (entry: PetTodoItem): Promise<void> => {
    const text = editingText.trim();
    if (!text || !api.updateTodo) return;
    await mutate(entry.id, () => api.updateTodo!(entry.id, text));
    setEditingId(null);
    setEditingText("");
  };

  const setStatus = (entry: PetTodoItem, status: PetTodoStatus): void => {
    if (!api.setTodoStatus) return;
    void mutate(entry.id, () => api.setTodoStatus!(entry.id, status));
  };

  const askMimi = (entry: PetTodoItem): void => {
    dispatch({
      type: "set-chat-draft",
      draft: t("pet.todo.askMimiPrompt", { text: entry.text }),
    });
  };

  const activeCount = entries.filter((entry) => entry.status !== "completed").length;
  return (
    <section
      data-pet-todos="durable"
      className="rounded-2xl border border-border/60 bg-background/45 p-3"
      aria-labelledby="pet-todo-heading"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ListTodo size={17} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <h3 id="pet-todo-heading" className="text-sm font-semibold tracking-tight">
            {t("pet.todo.title")}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("pet.todo.summary", { count: activeCount })}
          </p>
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void create();
          }}
          maxLength={500}
          placeholder={t("pet.todo.placeholder")}
          aria-label={t("pet.todo.placeholder")}
          className="min-w-0 flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
        />
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          disabled={!draft.trim() || busyIds.has("__create__") || !api.createTodo}
          onClick={() => void create()}
        >
          {busyIds.has("__create__") ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={13} aria-hidden="true" />
          )}
          {t("pet.todo.add")}
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-lg bg-status-err/10 px-2.5 py-2 text-xs text-status-err">
          {error}
        </p>
      )}

      <div className="mt-3 space-y-1.5">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t("pet.todo.loading")}
          </div>
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-xs leading-5 text-muted-foreground">
            {t("pet.todo.empty")}
          </p>
        ) : (
          entries.map((entry) => {
            const busy = busyIds.has(entry.id);
            const editing = editingId === entry.id;
            return (
              <div
                key={entry.id}
                className="group/todo rounded-xl border border-transparent bg-muted/30 px-2.5 py-2 transition hover:border-border/60 hover:bg-background"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    type="button"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-status-ok disabled:opacity-40"
                    disabled={busy || !api.setTodoStatus}
                    onClick={() =>
                      setStatus(entry, entry.status === "completed" ? "pending" : "completed")
                    }
                    aria-label={
                      entry.status === "completed"
                        ? t("pet.todo.reopenAria", { text: entry.text })
                        : t("pet.todo.completeAria", { text: entry.text })
                    }
                  >
                    {busy ? (
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    ) : entry.status === "completed" ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Circle size={15} aria-hidden="true" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <input
                        autoFocus
                        value={editingText}
                        maxLength={500}
                        onChange={(event) => setEditingText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveEdit(entry);
                          if (event.key === "Escape") setEditingId(null);
                        }}
                        className="w-full rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none focus:border-primary/40"
                      />
                    ) : (
                      <p
                        className={`break-words text-sm leading-5 ${
                          entry.status === "completed"
                            ? "text-muted-foreground line-through"
                            : "text-foreground"
                        }`}
                      >
                        {entry.text}
                      </p>
                    )}
                    <span
                      className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[entry.status]}`}
                    >
                      {t(`pet.todo.status.${entry.status}`)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-primary transition hover:bg-primary/10 disabled:opacity-40"
                          disabled={busy || !editingText.trim()}
                          onClick={() => void saveEdit(entry)}
                          aria-label={t("pet.todo.save")}
                        >
                          <Save size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          onClick={() => setEditingId(null)}
                          aria-label={t("pet.todo.cancel")}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
                        {entry.status !== "completed" && (
                          <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-primary transition hover:bg-primary/10"
                            onClick={() => askMimi(entry)}
                            title={t("pet.todo.askMimi")}
                          >
                            <Bot size={13} aria-hidden="true" />
                            {t("pet.todo.askMimi")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          onClick={() => {
                            setEditingId(entry.id);
                            setEditingText(entry.text);
                          }}
                          aria-label={t("pet.todo.editAria", { text: entry.text })}
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                          disabled={busy || !api.setTodoStatus}
                          onClick={() => setStatus(entry, "archived")}
                          aria-label={t("pet.todo.archiveAria", { text: entry.text })}
                          title={t("pet.todo.archive")}
                        >
                          <Archive size={13} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
