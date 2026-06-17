import React, { useEffect, useState } from "react";
import type { DesktopSessionSummary } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

interface Props {
  onNewSession?: () => void;
}

export function SessionsView({ onNewSession }: Props) {
  const { t } = useT();
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = async () => {
    try {
      const [list, titleMap] = await Promise.all([
        window.codeshell.listSessions(),
        window.codeshell.listSessionTitles(),
      ]);
      setSessions(list);
      setTitles(titleMap);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (error) return <div className="p-6 text-sm text-status-err">{t("auto.sessions.readError", { error })}</div>;
  if (!sessions) return <div className="p-6 text-sm text-muted-foreground">{t("auto.sessions.loading")}</div>;

  const filtered = filter
    ? sessions.filter(
        (s) =>
          s.id.toLowerCase().includes(filter.toLowerCase()) ||
          (titles[s.id] ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : sessions;

  const startEdit = (s: DesktopSessionSummary) => {
    setEditing(s.id);
    setEditDraft(titles[s.id] ?? "");
  };

  const commitEdit = async () => {
    if (!editing) return;
    try {
      await window.codeshell.renameSession(editing, editDraft.trim());
    } catch (err) {
      console.error("renameSession failed", err);
    }
    setEditing(null);
    setEditDraft("");
    void refresh();
  };

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <Input
          className="h-8 max-w-xs"
          placeholder={t("auto.sessions.searchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="flex-1" />
        <Button size="sm" onClick={onNewSession}>{t("auto.sessions.newSession")}</Button>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>{t("auto.sessions.refresh")}</Button>
      </div>
      {filtered.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">{t("auto.sessions.noMatch")}</div>
      ) : (
        <ul className="space-y-1 overflow-y-auto">
          {filtered.map((s) => {
            const title = titles[s.id];
            const isEditing = editing === s.id;
            return (
              <li key={s.id} className="flex items-center gap-3 rounded-md p-2 text-sm hover:bg-accent">
                {isEditing ? (
                  <Input
                    autoFocus
                    className="h-8 flex-1"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitEdit();
                      else if (e.key === "Escape") { setEditing(null); setEditDraft(""); }
                    }}
                    onBlur={() => void commitEdit()}
                    placeholder={t("auto.sessions.titlePlaceholder")}
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate" onDoubleClick={() => startEdit(s)}>
                      {title ? (
                        <>
                          <strong>{title}</strong>{" "}
                          <span className="text-xs text-muted-foreground">{s.id.slice(0, 8)}</span>
                        </>
                      ) : (
                        <span className="font-mono text-xs">{s.id}</span>
                      )}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => startEdit(s)}>{t("auto.sessions.rename")}</Button>
                  </>
                )}
                <span className="text-xs text-muted-foreground">{formatBytes(s.size)}</span>
                <span className="text-xs text-muted-foreground">{new Date(s.updatedAt).toLocaleString()}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-status-err"
                  onClick={async () => {
                    try {
                      await window.codeshell.deleteSession(s.id);
                    } catch (err) {
                      console.error("deleteSession failed", err);
                    }
                    void refresh();
                  }}
                >
                  {t("auto.sessions.delete")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

