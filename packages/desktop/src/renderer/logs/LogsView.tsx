import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

type Bucket = "ui-ink" | "engine" | "desktop";
const BUCKETS: Bucket[] = ["desktop", "engine", "ui-ink"];

export function LogsView() {
  const { t } = useT();
  const [bucket, setBucket] = useState<Bucket>("desktop");
  const [lines, setLines] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");

  const refresh = async (b: Bucket = bucket) => {
    setLines(null);
    const all = await window.codeshell.tailLog(b, 500);
    setLines(all);
  };

  useEffect(() => {
    void refresh(bucket);
  }, [bucket]);

  const filtered =
    lines === null
      ? null
      : filter
        ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
        : lines;

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {BUCKETS.map((b) => (
            <button
              key={b}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (bucket === b ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
              }
              onClick={() => setBucket(b)}
            >
              {b}
            </button>
          ))}
        </div>
        <input
          className="h-8 max-w-xs flex-1 rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={t("auto.logs.grepPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button size="sm" variant="outline" onClick={() => void refresh()}>{t("auto.logs.refresh")}</Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
        {filtered === null
          ? t("auto.logs.loading")
          : filtered.length === 0
            ? t("auto.logs.noLines")
            : filtered.join("\n")}
      </pre>
    </div>
  );
}
