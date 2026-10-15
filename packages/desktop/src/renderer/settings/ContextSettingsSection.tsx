import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { writeSettings } from "../settingsBus";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import type { TranslationKey } from "../i18n/dict";

const DEFAULT_RATIOS = {
  microcompactFloorRatio: 70,
  compactAtRatio: 85,
  summarizeAtRatio: 92,
} as const;

type RatioKey = keyof typeof DEFAULT_RATIOS;
type RatioState = Record<RatioKey, number>;

const FIELDS: Array<{
  key: RatioKey;
  title: TranslationKey;
  desc: TranslationKey;
  min: number;
  max: number;
}> = [
  {
    key: "microcompactFloorRatio",
    title: "settingsX.context.microTitle",
    desc: "settingsX.context.microDesc",
    min: 10,
    max: 95,
  },
  {
    key: "compactAtRatio",
    title: "settingsX.context.compactTitle",
    desc: "settingsX.context.compactDesc",
    min: 10,
    max: 98,
  },
  {
    key: "summarizeAtRatio",
    title: "settingsX.context.summarizeTitle",
    desc: "settingsX.context.summarizeDesc",
    min: 10,
    max: 99,
  },
];

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function percentOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRatios(input: RatioState): RatioState {
  const compactAtRatio = clamp(input.compactAtRatio, 10, 98);
  return {
    microcompactFloorRatio: Math.min(clamp(input.microcompactFloorRatio, 10, 95), compactAtRatio),
    compactAtRatio,
    summarizeAtRatio: Math.max(clamp(input.summarizeAtRatio, 10, 99), compactAtRatio),
  };
}

type RatioDrafts = Record<RatioKey, string>;

function toDrafts(ratios: RatioState): RatioDrafts {
  return Object.fromEntries(
    Object.entries(ratios).map(([key, value]) => [key, String(value)]),
  ) as RatioDrafts;
}

function validRatio(raw: string, min: number, max: number): boolean {
  const value = Number(raw);
  return raw.trim() !== "" && Number.isInteger(value) && value >= min && value <= max;
}

export function ContextSettingsSection() {
  const { t } = useT();
  const toast = useToast();
  const fieldPrefix = useId();
  const [drafts, setDrafts] = useState<RatioDrafts>(() => toDrafts(DEFAULT_RATIOS));
  const [lastValid, setLastValid] = useState<RatioState>({ ...DEFAULT_RATIOS });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState<"save" | "reset" | null>(null);
  const [touched, setTouched] = useState<Partial<Record<RatioKey, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const alive = useRef(false);
  const loadSequence = useRef(0);
  const writing = useRef(false);
  const inputs = useRef<Partial<Record<RatioKey, HTMLInputElement>>>({});
  const returnFocus = useRef<HTMLElement | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryFocus = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoadState("loading");
    setLoadError("");
    try {
      const settings = ((await window.codeshell.getSettings("user")) ?? {}) as Record<
        string,
        unknown
      >;
      if (!alive.current || sequence !== loadSequence.current) return;
      const context = objectOf(settings.context);
      const next = normalizeRatios({
        microcompactFloorRatio: percentOf(
          context.microcompactFloorRatio,
          DEFAULT_RATIOS.microcompactFloorRatio,
        ),
        compactAtRatio: percentOf(context.compactAtRatio, DEFAULT_RATIOS.compactAtRatio),
        summarizeAtRatio: percentOf(context.summarizeAtRatio, DEFAULT_RATIOS.summarizeAtRatio),
      });
      setDrafts(toDrafts(next));
      setLastValid(next);
      setTouched({});
      setSubmitted(false);
      setLoadState("ready");
    } catch (error) {
      if (!alive.current || sequence !== loadSequence.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    if (loadState === "loading" || !retryFocus.current) return;
    retryFocus.current = false;
    if (document.activeElement !== document.body) return;
    if (loadState === "ready") inputs.current.microcompactFloorRatio?.focus();
    else retryButton.current?.focus();
  }, [loadState]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadSequence.current++;
    };
  }, [load]);

  useEffect(() => {
    if (saving || !returnFocus.current) return;
    const opener = returnFocus.current;
    returnFocus.current = null;
    if (document.activeElement === document.body && opener.isConnected) opener.focus();
  }, [saving]);

  const setDraft = (field: (typeof FIELDS)[number], value: string): void => {
    setDrafts((previous) => ({ ...previous, [field.key]: value }));
    if (validRatio(value, field.min, field.max)) {
      setLastValid((previous) => ({ ...previous, [field.key]: Number(value) }));
    }
  };

  const persist = async (reset: boolean) => {
    if (loadState !== "ready" || writing.current) return;
    const invalid = FIELDS.find((field) => !validRatio(drafts[field.key], field.min, field.max));
    if (!reset && invalid) {
      setSubmitted(true);
      inputs.current[invalid.key]?.focus();
      return;
    }
    const next = reset
      ? { ...DEFAULT_RATIOS }
      : normalizeRatios(
          Object.fromEntries(
            Object.entries(drafts).map(([key, value]) => [key, Number(value)]),
          ) as RatioState,
        );
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    writing.current = true;
    setSaving(reset ? "reset" : "save");
    try {
      await writeSettings("user", {
        context: {
          microcompactFloorRatio: reset ? null : next.microcompactFloorRatio / 100,
          compactAtRatio: reset ? null : next.compactAtRatio / 100,
          summarizeAtRatio: reset ? null : next.summarizeAtRatio / 100,
        },
      });
      if (!alive.current) return;
      setDrafts(toDrafts(next));
      setLastValid(next);
      setTouched({});
      setSubmitted(false);
      toast({ message: t("settingsX.context.saved"), variant: "success" });
    } catch (error) {
      if (!alive.current) return;
      toast({
        message: `${t("settingsX.context.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      });
    } finally {
      writing.current = false;
      if (alive.current) {
        returnFocus.current = opener;
        setSaving(null);
      }
    }
  };

  return (
    <section
      className="mb-6 flex max-w-3xl flex-col gap-4"
      aria-busy={loadState === "loading" || saving !== null}
    >
      <div>
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.context.title")}
        </h3>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{t("settingsX.context.desc")}</p>
      </div>
      {loadState === "loading" && (
        <p className="text-xs text-muted-foreground" role="status">
          {t("settingsX.context.loading")}
        </p>
      )}
      {loadState === "error" && (
        <div className="rounded-md border border-status-err/30 bg-status-err/5 p-3">
          <p className="break-words text-xs text-status-err" role="alert">
            {t("settingsX.context.loadFailed", { error: loadError })}
          </p>
          <Button
            ref={retryButton}
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              retryFocus.current = true;
              void load();
            }}
          >
            {t("settingsX.context.retry")}
          </Button>
        </div>
      )}
      {loadState === "ready" && (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void persist(false);
          }}
        >
          <div className="grid gap-3">
            {FIELDS.map((field) => {
              const id = `${fieldPrefix}-${field.key}`;
              const invalid = !validRatio(drafts[field.key], field.min, field.max);
              const showError = invalid && (submitted || touched[field.key]);
              return (
                <div
                  key={field.key}
                  className="rounded-md border border-border bg-background px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3 max-[520px]:flex-col">
                    <div className="min-w-0">
                      <label htmlFor={id} className="text-sm font-medium text-foreground">
                        {t(field.title)}
                      </label>
                      <p
                        id={`${id}-description`}
                        className="m-0 mt-1 text-xs text-muted-foreground"
                      >
                        {t(field.desc)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                      <Input
                        id={id}
                        ref={(node) => {
                          if (node) inputs.current[field.key] = node;
                          else delete inputs.current[field.key];
                        }}
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={1}
                        value={drafts[field.key]}
                        disabled={saving !== null}
                        className="h-8 w-20 text-right"
                        aria-invalid={showError || undefined}
                        aria-describedby={`${id}-description${showError ? ` ${id}-error` : ""}`}
                        onChange={(event) => setDraft(field, event.currentTarget.value)}
                        onBlur={() =>
                          setTouched((previous) => ({ ...previous, [field.key]: true }))
                        }
                      />
                      <span aria-hidden>%</span>
                    </div>
                  </div>
                  <Slider
                    min={field.min}
                    max={field.max}
                    value={[lastValid[field.key]]}
                    disabled={saving !== null}
                    className="mt-3"
                    aria-label={t(field.title)}
                    aria-describedby={`${id}-description`}
                    onValueChange={([value]) => setDraft(field, String(value))}
                  />
                  {showError && (
                    <p id={`${id}-error`} className="m-0 mt-2 text-xs text-status-err" role="alert">
                      {t("settingsX.context.invalidRatio", { min: field.min, max: field.max })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="m-0 text-xs text-muted-foreground">{t("settingsX.context.orderHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving !== null}>
              {saving === "save" ? t("settingsX.context.saving") : t("settingsX.context.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void persist(true)}
              disabled={saving !== null}
            >
              {saving === "reset" ? t("settingsX.context.resetting") : t("settingsX.context.reset")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
