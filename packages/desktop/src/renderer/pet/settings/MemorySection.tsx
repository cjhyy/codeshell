import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "../../i18n";
import type { PetApi } from "../../../preload/pet-api";
import type { PetJournalEntry, PetMemoryEntry } from "../../../preload/types";

type MemoryApi = Pick<
  PetApi,
  | "listMemories"
  | "onMemoriesChanged"
  | "listJournal"
  | "onJournalChanged"
  | "getMemoryAutoExtract"
  | "setMemoryAutoExtract"
>;

function defaultApi(): MemoryApi | undefined {
  try {
    return window.codeshell?.pet;
  } catch {
    return undefined;
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 记忆: the auto-extract switch, what Mimi holds, and the way into the memory center. */
export function MemorySection({
  onOpenMemoryCenter,
  api = defaultApi(),
}: {
  onOpenMemoryCenter: () => void;
  api?: MemoryApi;
}) {
  const { t } = useT();
  const [memories, setMemories] = useState<PetMemoryEntry[] | null>(null);
  const [journal, setJournal] = useState<PetJournalEntry[] | null>(null);
  const [autoExtract, setAutoExtract] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let disposed = false;
    api
      ?.listMemories?.()
      .then((entries) => !disposed && setMemories(entries))
      .catch((cause) => !disposed && setLoadError(errorText(cause)));
    api
      ?.listJournal?.()
      .then((entries) => !disposed && setJournal(entries))
      .catch(() => !disposed && setJournal([]));
    api
      ?.getMemoryAutoExtract?.()
      .then((value) => !disposed && setAutoExtract(value))
      // Main treats an unreadable flag as on; show the same.
      .catch(() => !disposed && setAutoExtract(true));
    const offMemories = api?.onMemoriesChanged?.((entries) => !disposed && setMemories(entries));
    const offJournal = api?.onJournalChanged?.((entries) => !disposed && setJournal(entries));
    return () => {
      disposed = true;
      offMemories?.();
      offJournal?.();
    };
  }, [api]);

  const toggle = (next: boolean): void => {
    setAutoExtract(next);
    setSaveError("");
    void api?.setMemoryAutoExtract?.(next).catch((cause) => {
      setAutoExtract(!next);
      setSaveError(errorText(cause));
    });
  };

  const counts = [
    { key: "memories", label: t("mimiSettings.memory.memoriesCount"), value: memories?.length },
    {
      key: "auto",
      label: t("mimiSettings.memory.autoCount"),
      value: memories?.filter((entry) => entry.source === "auto").length,
    },
    { key: "journal", label: t("mimiSettings.memory.journalCount"), value: journal?.length },
  ];

  return (
    <>
      {autoExtract !== null && api?.setMemoryAutoExtract && (
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
              onCheckedChange={toggle}
              aria-label={t("pet.memoryCenter.autoExtractTitle")}
            />
          </CardHeader>
          {saveError && (
            <CardContent className="pt-0">
              <p role="alert" className="text-xs text-status-err [overflow-wrap:anywhere]">
                {t("mimiSettings.memory.saveFailed", { error: saveError })}
              </p>
            </CardContent>
          )}
        </Card>
      )}
      <Card className="rounded-2xl" data-pet-setting="memory">
        <CardContent className="grid gap-4 p-6 max-[480px]:p-4">
          {loadError ? (
            <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
              {t("mimiSettings.memory.loadFailed", { error: loadError })}
            </p>
          ) : (
            <dl className="grid grid-cols-3 gap-3" data-pet-memory-summary>
              {counts.map(({ key, label, value }) => (
                <div key={key} className="min-w-0" data-pet-memory-count={key}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight">
                    {value ?? "–"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            {t("pet.settings.memoryDescription")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            data-pet-open-memory-center
            onClick={onOpenMemoryCenter}
          >
            {t("pet.settings.manageMemory")}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
