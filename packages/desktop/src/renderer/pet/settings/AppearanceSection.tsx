import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT, type TranslationKey } from "../../i18n";
import type {
  MimiPresenceMode,
  MimiPresencePatch,
  MimiPresenceSnapshot,
} from "../../../shared/mimi-presence";
import {
  MIMI_APPEARANCES,
  MIMI_COMPANION_SIZE_NAMES,
  MIMI_COMPANION_SIZE_OPTIONS,
  type MimiAppearance,
} from "../../../shared/mimi-companion";

const CHARACTER_LABELS: Record<MimiAppearance, TranslationKey> = {
  "mimi-sprite": "pet.settings.characterMimi",
  "shiro-sprite": "pet.settings.characterShiro",
  "maki-sprite": "pet.settings.characterMaki",
};

/** A row of mutually exclusive choices drawn as buttons (character, mode). */
function ChoiceGroup<V extends string>({
  label,
  value,
  choices,
  dataAttribute,
  onChange,
}: {
  label: string;
  value: V;
  choices: Array<{
    value: V;
    label: string;
    hint?: string;
    disabled?: boolean;
    effective?: boolean;
  }>;
  dataAttribute: string;
  onChange: (value: V) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn("grid gap-2", choices.length > 2 ? "grid-cols-3" : "grid-cols-2")}
        role="radiogroup"
        aria-label={label}
      >
        {choices.map((choice) => {
          const selected = value === choice.value;
          return (
            <Button
              key={choice.value}
              type="button"
              variant={selected ? "default" : "outline"}
              role="radio"
              aria-checked={selected}
              {...{ [dataAttribute]: choice.value }}
              data-effective={choice.effective ? "true" : undefined}
              disabled={choice.disabled}
              className="h-auto min-w-0 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
              onClick={() => {
                if (!selected) onChange(choice.value);
              }}
            >
              <span className="text-sm font-medium">{choice.label}</span>
              {choice.hint && (
                <span className="text-xs font-normal text-muted-foreground">{choice.hint}</span>
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function RetryAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <span className="text-xs text-status-err [overflow-wrap:anywhere]">{message}</span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t("pet.settings.retry")}
        </Button>
      )}
    </div>
  );
}

/** Character, docked/moving mode, moving size, preview and failure state for the one Mimi. */
export function MimiPresenceControls({
  presence,
  onChange,
  onPreview,
  onRetry,
}: {
  presence: MimiPresenceSnapshot;
  onChange: (patch: MimiPresencePatch) => void;
  onPreview?: () => Promise<void>;
  onRetry?: () => void;
}) {
  const { t } = useT();
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // A legacy custom size that is not a preset stays selectable instead of vanishing.
  const sizes: number[] = (MIMI_COMPANION_SIZE_OPTIONS as readonly number[]).includes(presence.size)
    ? [...MIMI_COMPANION_SIZE_OPTIONS]
    : [...MIMI_COMPANION_SIZE_OPTIONS, presence.size].sort((a, b) => a - b);
  const sizeLabel = (size: number) => {
    const name = MIMI_COMPANION_SIZE_NAMES[size];
    return name
      ? t("mimiSettings.appearance.sizeNamed", { size, name: t(`pet.companion.size.${name}`) })
      : String(size);
  };
  return (
    <CardContent className="space-y-5 pt-0" data-mimi-presence-controls>
      {!presence.visible && (
        <p className="text-xs text-muted-foreground">{t("pet.settings.hiddenHint")}</p>
      )}
      <ChoiceGroup<MimiAppearance>
        label={t("pet.settings.characterLabel")}
        value={presence.appearance}
        dataAttribute="data-mimi-character"
        choices={MIMI_APPEARANCES.map((appearance) => ({
          value: appearance,
          label: t(CHARACTER_LABELS[appearance]),
        }))}
        onChange={(appearance) => onChange({ appearance })}
      />
      <div className="space-y-2">
        <ChoiceGroup<MimiPresenceMode>
          label={t("pet.settings.modeLabel")}
          value={presence.mode}
          dataAttribute="data-mimi-mode"
          choices={[
            {
              value: "docked",
              label: t("pet.settings.modeDocked"),
              hint: t("pet.settings.modeDockedHint"),
              effective: presence.effectiveMode === "docked",
            },
            {
              value: "moving",
              label: t("pet.settings.modeMoving"),
              hint: t("pet.settings.modeMovingHint"),
              disabled: !presence.movingAvailable,
              effective: presence.effectiveMode === "moving",
            },
          ]}
          onChange={(mode) => onChange({ mode })}
        />
        {!presence.movingAvailable && presence.movingUnavailableReason && (
          <p className="text-xs text-muted-foreground" data-mimi-moving-unavailable>
            {t("pet.settings.movingUnavailable", { reason: presence.movingUnavailableReason })}
          </p>
        )}
        {presence.movingError && (
          <RetryAlert
            message={t("pet.settings.movingFallback", { error: presence.movingError })}
            onRetry={onRetry}
          />
        )}
        {presence.dockedError && (
          <RetryAlert
            message={t("pet.settings.dockedFailed", { error: presence.dockedError })}
            onRetry={onRetry}
          />
        )}
      </div>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label className="text-xs text-muted-foreground">{t("pet.settings.sizeLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("mimiSettings.appearance.sizeHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-56">
            <SimpleSelect
              size="sm"
              ariaLabel={t("pet.settings.sizeLabel")}
              value={String(presence.size)}
              disabled={!presence.movingAvailable}
              onChange={(value) => onChange({ size: Number(value) })}
              options={sizes.map((size) => ({ value: String(size), label: sizeLabel(size) }))}
            />
          </div>
          {onPreview && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-mimi-preview
              disabled={!presence.movingAvailable || previewBusy || presence.previewing}
              onClick={() => {
                setPreviewError(null);
                setPreviewBusy(true);
                void onPreview()
                  .catch((error) =>
                    setPreviewError(error instanceof Error ? error.message : String(error)),
                  )
                  .finally(() => setPreviewBusy(false));
              }}
            >
              {presence.previewing ? t("pet.settings.previewing") : t("pet.settings.preview")}
            </Button>
          )}
        </div>
        {previewError && (
          <p className="text-xs text-status-err [overflow-wrap:anywhere]" role="alert">
            {previewError}
          </p>
        )}
      </div>
    </CardContent>
  );
}

export interface AppearanceSectionProps {
  widgetVisible: boolean;
  /** Actual presence from the main-process owner; null until it is known. */
  presence: MimiPresenceSnapshot | null;
  /** The last change or retry the owner refused. */
  presenceError?: string | null;
  onDismissPresenceError?: () => void;
  onVisibleChange: (visible: boolean) => void;
  onPresenceChange?: (patch: MimiPresencePatch) => void;
  onPreviewMoving?: () => Promise<void>;
  onRetryPresence?: () => void;
}

/** 形象与显示: the one "show Mimi" switch and how Mimi looks once shown. */
export function AppearanceSection({
  widgetVisible,
  presence,
  presenceError,
  onDismissPresenceError,
  onVisibleChange,
  onPresenceChange,
  onPreviewMoving,
  onRetryPresence,
}: AppearanceSectionProps) {
  const { t } = useT();
  return (
    <Card data-pet-setting="widget" className="rounded-2xl">
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <div className="min-w-0 flex-1 space-y-1.5">
          <CardTitle className="text-base">{t("pet.settings.widgetTitle")}</CardTitle>
          <CardDescription className="leading-5">
            {t("pet.settings.widgetDescription")}
          </CardDescription>
        </div>
        <Switch
          checked={presence ? presence.visible : widgetVisible}
          onCheckedChange={onVisibleChange}
          aria-label={t("pet.settings.widgetTitle")}
        />
      </CardHeader>
      {presenceError && (
        <CardContent className="pt-0">
          <div
            role="alert"
            data-mimi-presence-error
            className="flex flex-wrap items-center gap-2 rounded-xl bg-status-err/10 px-3 py-2"
          >
            <span className="min-w-0 flex-1 text-xs text-status-err [overflow-wrap:anywhere]">
              {t("mimiSettings.appearance.presenceFailed", { error: presenceError })}
            </span>
            {onDismissPresenceError && (
              <Button type="button" size="sm" variant="ghost" onClick={onDismissPresenceError}>
                {t("mimiSettings.appearance.dismiss")}
              </Button>
            )}
          </div>
        </CardContent>
      )}
      {presence && onPresenceChange && (
        <MimiPresenceControls
          presence={presence}
          onChange={onPresenceChange}
          onPreview={onPreviewMoving}
          onRetry={onRetryPresence}
        />
      )}
    </Card>
  );
}
