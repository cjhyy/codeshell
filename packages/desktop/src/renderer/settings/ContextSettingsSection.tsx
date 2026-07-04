import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100)
    : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRatios(input: RatioState): RatioState {
  const compactAtRatio = clamp(input.compactAtRatio, 10, 98);
  return {
    microcompactFloorRatio: Math.min(
      clamp(input.microcompactFloorRatio, 10, 95),
      compactAtRatio,
    ),
    compactAtRatio,
    summarizeAtRatio: Math.max(
      clamp(input.summarizeAtRatio, 10, 99),
      compactAtRatio,
    ),
  };
}

export function ContextSettingsSection() {
  const { t } = useT();
  const toast = useToast();
  const [ratios, setRatios] = useState<RatioState>({ ...DEFAULT_RATIOS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const settings = ((await window.codeshell.getSettings("user")) ?? {}) as Record<string, unknown>;
      const context = objectOf(settings.context);
      setRatios(
        normalizeRatios({
          microcompactFloorRatio: percentOf(
            context.microcompactFloorRatio,
            DEFAULT_RATIOS.microcompactFloorRatio,
          ),
          compactAtRatio: percentOf(context.compactAtRatio, DEFAULT_RATIOS.compactAtRatio),
          summarizeAtRatio: percentOf(
            context.summarizeAtRatio,
            DEFAULT_RATIOS.summarizeAtRatio,
          ),
        }),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setRatio = (key: RatioKey, value: number): void => {
    const field = FIELDS.find((f) => f.key === key);
    if (!field) return;
    setRatios((prev) => ({
      ...prev,
      [key]: clamp(Math.round(value), field.min, field.max),
    }));
  };

  const save = async () => {
    const next = normalizeRatios(ratios);
    setRatios(next);
    setSaving(true);
    try {
      await writeSettings("user", {
        context: {
          microcompactFloorRatio: next.microcompactFloorRatio / 100,
          compactAtRatio: next.compactAtRatio / 100,
          summarizeAtRatio: next.summarizeAtRatio / 100,
        },
      });
      toast({ message: t("settingsX.context.saved"), variant: "success" });
    } catch (e) {
      toast({
        message: `${t("settingsX.context.saveFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const next = { ...DEFAULT_RATIOS };
    setRatios(next);
    setSaving(true);
    try {
      await writeSettings("user", {
        context: {
          microcompactFloorRatio: null,
          compactAtRatio: null,
          summarizeAtRatio: null,
        },
      });
      toast({ message: t("settingsX.context.saved"), variant: "success" });
    } catch (e) {
      toast({
        message: `${t("settingsX.context.saveFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-6 flex max-w-3xl flex-col gap-4">
      <div>
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.context.title")}
        </h3>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          {t("settingsX.context.desc")}
        </p>
      </div>

      <div className="grid gap-3">
        {FIELDS.map((field) => (
          <div
            key={field.key}
            className="rounded-md border border-border bg-background px-3 py-3"
          >
            <div className="flex items-start justify-between gap-3 max-[520px]:flex-col">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t(field.title)}
                </div>
                <p className="m-0 mt-1 text-xs text-muted-foreground">
                  {t(field.desc)}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                <Input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={ratios[field.key]}
                  disabled={loading || saving}
                  className="h-8 w-20 text-right"
                  onChange={(e) => setRatio(field.key, Number(e.currentTarget.value))}
                />
                <span>%</span>
              </label>
            </div>
            <input
              type="range"
              min={field.min}
              max={field.max}
              value={ratios[field.key]}
              disabled={loading || saving}
              className="mt-3 w-full accent-primary"
              aria-label={t(field.title)}
              onChange={(e) => setRatio(field.key, Number(e.currentTarget.value))}
            />
          </div>
        ))}
      </div>

      <p className="m-0 text-xs text-muted-foreground">
        {t("settingsX.context.orderHint")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save()} disabled={loading || saving}>
          {saving ? t("settingsX.context.saving") : t("settingsX.context.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void reset()}
          disabled={loading || saving}
        >
          {t("settingsX.context.reset")}
        </Button>
      </div>
    </section>
  );
}
