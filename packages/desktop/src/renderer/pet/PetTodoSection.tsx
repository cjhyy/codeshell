import React from "react";
import { ListTodo, Loader2 } from "lucide-react";
import type { PetSessionTodoItem, PetSessionTodos } from "../../preload/types";
import { useT } from "../i18n";

/**
 * Cross-session open-todo view for the Mimi workbench. Self-fetching: pulls
 * `window.codeshell.pet.getTodos()` on mount and whenever the snapshot version
 * advances (debounced), with a sequence guard so a slow response can never
 * overwrite a newer one. Structured TodoWrite items only — see
 * pet-todo-aggregator.ts.
 */
const FETCH_DEBOUNCE_MS = 2_000;

/**
 * Open items, in_progress before pending, preserving each source order within
 * a status. Pure so it can be unit-tested directly.
 */
export function orderTodoItems(todos: readonly PetSessionTodoItem[]): PetSessionTodoItem[] {
  const inProgress = todos.filter((todo) => todo.status === "in_progress");
  const pending = todos.filter((todo) => todo.status === "pending");
  return [...inProgress, ...pending];
}

export function PetTodoSection({
  snapshotVersion,
  generation,
  onOpen,
}: {
  snapshotVersion: number;
  generation: number;
  onOpen?: (agentSessionId: string) => void;
}) {
  // `generation` is accepted so callers can pass the same snapshot identity the
  // sibling sections use; the pull is keyed by version, which advances with it.
  void generation;
  const [groups, setGroups] = React.useState<PetSessionTodos[]>([]);
  const [loading, setLoading] = React.useState(true);
  const seqRef = React.useRef(0);
  const loadedOnceRef = React.useRef(false);

  React.useEffect(() => {
    let disposed = false;
    const run = (): void => {
      const seq = (seqRef.current += 1);
      const getTodos = window.codeshell.pet?.getTodos;
      if (!getTodos) {
        if (!disposed) setLoading(false);
        return;
      }
      void Promise.resolve(getTodos())
        .then((next) => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          setGroups(next);
          setLoading(false);
        })
        .catch(() => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          setLoading(false);
        });
    };
    const timer = setTimeout(run, loadedOnceRef.current ? FETCH_DEBOUNCE_MS : 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [snapshotVersion]);

  return (
    <PetTodoSectionView
      groups={groups}
      loading={loading && !loadedOnceRef.current}
      onOpen={onOpen}
    />
  );
}

export default function PetTodoSectionView({
  groups,
  loading,
  onOpen,
}: {
  groups: readonly PetSessionTodos[];
  loading: boolean;
  onOpen?: (agentSessionId: string) => void;
}) {
  const { t } = useT();
  // Count open items only. The aggregator already excludes completed todos, so
  // in practice this equals group.todos.length; guarding here keeps the badge
  // honest against the pure view's props.
  const totalOpen = groups.reduce((sum, group) => sum + orderTodoItems(group.todos).length, 0);
  return (
    <section
      data-pet-todos="cross-session"
      className="rounded-2xl border border-border/60 bg-background/45 p-1"
    >
      <div className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ListTodo size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t("pet.todo.title")}</span>
        </span>
        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
          {totalOpen}
        </span>
      </div>
      <div className="space-y-2 px-1.5 pb-1.5 pt-1">
        {loading ? (
          <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2
              size={12}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("pet.todo.loading")}
          </p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("pet.todo.empty")}</p>
        ) : (
          groups.map((group) => (
            <article
              key={group.sessionId}
              data-pet-todo-group={group.sessionId}
              className="rounded-2xl border border-border/60 bg-background/60 p-3"
            >
              {onOpen ? (
                <button
                  type="button"
                  data-pet-todo-open={group.sessionId}
                  aria-label={t("pet.todo.openSessionAria", { title: group.title })}
                  className="flex w-full min-w-0 items-baseline gap-2 text-left transition hover:text-primary"
                  onClick={() => onOpen(group.sessionId)}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {group.title}
                  </span>
                  {group.workspace && (
                    <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                      {group.workspace}
                    </span>
                  )}
                </button>
              ) : (
                <div className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {group.title}
                  </span>
                  {group.workspace && (
                    <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                      {group.workspace}
                    </span>
                  )}
                </div>
              )}
              <ul className="mt-2 space-y-1.5">
                {orderTodoItems(group.todos).map((todo) => (
                  <li
                    key={todo.id}
                    data-pet-todo-status={todo.status}
                    className="flex items-start gap-2 text-xs leading-5"
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        todo.status === "in_progress"
                          ? "bg-status-running"
                          : "bg-muted-foreground/55"
                      }`}
                    />
                    <span
                      className={
                        todo.status === "in_progress" ? "text-foreground" : "text-muted-foreground"
                      }
                    >
                      {todo.status === "in_progress" ? todo.activeForm : todo.subject}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
