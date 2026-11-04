import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Brain,
  MessageCircleMore,
  Monitor,
  RotateCcw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { usePetSprite } from "../petSprite";
import { ModelPill, type ModelOption } from "../chat/ModelPill";
import { useT } from "../i18n";
import { writeSettings } from "../settingsBus";
import { useTargetedDebouncedSave } from "../settings/useTargetedDebouncedSave";
import { useToast } from "../ui/ToastProvider";
import {
  petPersonalizationFromSettings,
  petPersonalizationSettingsPatch,
  type PetPersonalization,
} from "../../shared/pet-settings";
import { SimpleSelect } from "@/components/ui/simple-select";
import type {
  MimiPresenceMode,
  MimiPresencePatch,
  MimiPresenceSnapshot,
} from "../../shared/mimi-presence";
import {
  isMimiAppearance,
  MIMI_COMPANION_DEFAULT_SIZE,
  MIMI_COMPANION_SIZE_OPTIONS,
} from "../../shared/mimi-companion";

type PetPersonalizationDraft = Required<PetPersonalization>;

const EMPTY_PERSONALIZATION: PetPersonalizationDraft = {
  responseLanguage: "",
  userProfile: "",
  communicationStyle: "",
  customInstructions: "",
};

// The user settings target survives page navigation. A new form must read after
// the previous form's flushed writes, and newer drafts must keep their order.
let personalizationWrites: Promise<void> = Promise.resolve();

function personalizationDraft(value: PetPersonalization): PetPersonalizationDraft {
  return {
    responseLanguage: value.responseLanguage ?? "",
    userProfile: value.userProfile ?? "",
    communicationStyle: value.communicationStyle ?? "",
    customInstructions: value.customInstructions ?? "",
  };
}

function PetPersonalizationForm() {
  const { t } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<PetPersonalizationDraft>(EMPTY_PERSONALIZATION);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const draftRef = useRef(draft);
  const loadGeneration = useRef(0);
  const alive = useRef(false);
  draftRef.current = draft;
  const persist = (value: PetPersonalizationDraft) => {
    // A slow earlier write must finish before a newer draft is persisted.
    const operation = personalizationWrites.then(() =>
      writeSettings("user", petPersonalizationSettingsPatch(value)),
    );
    personalizationWrites = operation.catch(() => {});
    return operation.then(
      () => {
        if (alive.current) setSaveError("");
      },
      (cause) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (alive.current) setSaveError(detail);
        else
          toast({ message: t("pet.settings.personalizationSaveFailed"), detail, variant: "error" });
      },
    );
  };
  const { schedule, flush } = useTargetedDebouncedSave("user:pet-personalization", persist);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadState("loading");
    setLoadError("");
    try {
      await personalizationWrites;
      const settings = await window.codeshell.getSettings("user");
      if (!alive.current || generation !== loadGeneration.current) return;
      const next = personalizationDraft(petPersonalizationFromSettings(settings));
      draftRef.current = next;
      setDraft(next);
      setLoadState("ready");
    } catch (cause) {
      if (!alive.current || generation !== loadGeneration.current) return;
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadGeneration.current += 1;
    };
  }, [load]);

  const update = (key: keyof PetPersonalizationDraft, value: string): void => {
    if (loadState !== "ready") return;
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    schedule(next);
  };

  return (
    <Card
      data-pet-personalization-fields="true"
      aria-busy={loadState === "loading"}
      className="rounded-2xl"
    >
      <CardContent className="grid gap-5 p-6">
        {loadState === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("ext.common.loading")}
          </p>
        )}
        {loadState === "error" && (
          <div className="grid gap-2">
            <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
              {t("ext.common.loadFailed", { error: loadError })}
            </p>
            <Button type="button" className="justify-self-start" onClick={() => void load()}>
              {t("ext.common.retry")}
            </Button>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="pet-response-language">{t("pet.settings.responseLanguageLabel")}</Label>
          <Input
            id="pet-response-language"
            value={draft.responseLanguage}
            disabled={loadState !== "ready"}
            maxLength={120}
            onChange={(event) => update("responseLanguage", event.target.value)}
            onBlur={flush}
            placeholder={t("pet.settings.responseLanguagePlaceholder")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pet-user-profile">{t("pet.settings.userProfileLabel")}</Label>
          <Textarea
            id="pet-user-profile"
            value={draft.userProfile}
            disabled={loadState !== "ready"}
            maxLength={2_000}
            onChange={(event) => update("userProfile", event.target.value)}
            onBlur={flush}
            placeholder={t("pet.settings.userProfilePlaceholder")}
            className="min-h-24 resize-y leading-relaxed"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pet-communication-style">
            {t("pet.settings.communicationStyleLabel")}
          </Label>
          <Textarea
            id="pet-communication-style"
            value={draft.communicationStyle}
            disabled={loadState !== "ready"}
            maxLength={2_000}
            onChange={(event) => update("communicationStyle", event.target.value)}
            onBlur={flush}
            placeholder={t("pet.settings.communicationStylePlaceholder")}
            className="min-h-24 resize-y leading-relaxed"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pet-custom-instructions">
            {t("pet.settings.customInstructionsLabel")}
          </Label>
          <Textarea
            id="pet-custom-instructions"
            value={draft.customInstructions}
            disabled={loadState !== "ready"}
            maxLength={6_000}
            onChange={(event) => update("customInstructions", event.target.value)}
            onBlur={flush}
            placeholder={t("pet.settings.customInstructionsPlaceholder")}
            className="min-h-32 resize-y leading-relaxed"
          />
        </div>
        {saveError ? (
          <div className="grid gap-2">
            <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
              {t("pet.settings.personalizationSaveFailed")}: {saveError}
            </p>
            <Button
              type="button"
              className="justify-self-start"
              onClick={() => {
                schedule(draftRef.current);
                flush();
              }}
            >
              {t("ext.common.retry")}
            </Button>
          </div>
        ) : loadState === "ready" ? (
          <p className="text-xs text-muted-foreground">
            {t("pet.settings.personalizationSaveHint")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface PetPersonalizationPageProps {
  onBack: () => void;
}

export function PetPersonalizationPage({ onBack }: PetPersonalizationPageProps) {
  const { t } = useT();

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label={t("pet.settings.personalizationTitle")}
      data-pet-personalization-page="standalone"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-5 py-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("pet.settings.personalizationBack")}
          title={t("pet.settings.personalizationBack")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            {t("pet.settings.personalizationTitle")}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {t("pet.settings.personalizationDescription")}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-5 lg:p-8">
          <PetPersonalizationForm />
        </div>
      </div>
    </section>
  );
}

/** Docked/moving mode, moving size, preview and failure state for the one Mimi. */
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
  const modes: Array<{ mode: MimiPresenceMode; label: string; hint: string; disabled: boolean }> = [
    {
      mode: "docked",
      label: t("pet.settings.modeDocked"),
      hint: t("pet.settings.modeDockedHint"),
      disabled: false,
    },
    {
      mode: "moving",
      label: t("pet.settings.modeMoving"),
      hint: t("pet.settings.modeMovingHint"),
      disabled: !presence.movingAvailable,
    },
  ];
  // A legacy custom size that is not a preset stays selectable instead of vanishing.
  const sizes: number[] = MIMI_COMPANION_SIZE_OPTIONS.includes(
    presence.size as (typeof MIMI_COMPANION_SIZE_OPTIONS)[number],
  )
    ? [...MIMI_COMPANION_SIZE_OPTIONS]
    : [...MIMI_COMPANION_SIZE_OPTIONS, presence.size].sort((a, b) => a - b);
  return (
    <CardContent className="space-y-4 pt-0" data-mimi-presence-controls>
      {!presence.visible && (
        <p className="text-xs text-muted-foreground">{t("pet.settings.hiddenHint")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Label className="text-xs text-muted-foreground">{t("pet.settings.characterLabel")}</Label>
        <div className="w-56">
          <SimpleSelect
            size="sm"
            value={presence.appearance}
            onChange={(value) => {
              if (isMimiAppearance(value)) onChange({ appearance: value });
            }}
            options={[
              { value: "mimi-sprite", label: t("pet.settings.characterMimi") },
              { value: "shiro-sprite", label: t("pet.settings.characterShiro") },
              { value: "maki-sprite", label: t("pet.settings.characterMaki") },
            ]}
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("pet.settings.modeLabel")}
        </div>
        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t("pet.settings.modeLabel")}
        >
          {modes.map((item) => {
            const selected = presence.mode === item.mode;
            return (
              <Button
                key={item.mode}
                type="button"
                variant={selected ? "default" : "outline"}
                role="radio"
                aria-checked={selected}
                data-mimi-mode={item.mode}
                data-effective={presence.effectiveMode === item.mode ? "true" : undefined}
                disabled={item.disabled}
                className="h-auto flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
                onClick={() => {
                  if (!selected) onChange({ mode: item.mode });
                }}
              >
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs font-normal text-muted-foreground">{item.hint}</span>
              </Button>
            );
          })}
        </div>
        {!presence.movingAvailable && presence.movingUnavailableReason && (
          <p className="text-xs text-muted-foreground" data-mimi-moving-unavailable>
            {t("pet.settings.movingUnavailable", { reason: presence.movingUnavailableReason })}
          </p>
        )}
        {presence.movingError && (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span className="text-xs text-status-err">
              {t("pet.settings.movingFallback", { error: presence.movingError })}
            </span>
            {onRetry && (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {t("pet.settings.retry")}
              </Button>
            )}
          </div>
        )}
        {presence.dockedError && (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span className="text-xs text-status-err">
              {t("pet.settings.dockedFailed", { error: presence.dockedError })}
            </span>
            {onRetry && (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {t("pet.settings.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Label className="text-xs text-muted-foreground">{t("pet.settings.sizeLabel")}</Label>
        <div className="w-56">
          <SimpleSelect
            size="sm"
            value={String(presence.size)}
            disabled={!presence.movingAvailable}
            onChange={(value) => onChange({ size: Number(value) })}
            options={sizes.map((size) => ({
              value: String(size),
              label:
                size === MIMI_COMPANION_DEFAULT_SIZE
                  ? t("pet.settings.sizeDefault", { size })
                  : t("pet.settings.sizeOption", { size }),
            }))}
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
        <p className="text-xs text-status-err" role="alert">
          {previewError}
        </p>
      )}
    </CardContent>
  );
}

export interface PetSettingsPageProps {
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  hasModelOverride: boolean;
  widgetVisible: boolean;
  /** Actual presence from the main-process owner; null until it is known. */
  presence?: MimiPresenceSnapshot | null;
  onSelectModel: (option: ModelOption) => void;
  onResetModel: () => void;
  onWidgetVisibleChange: (visible: boolean) => void;
  onPresenceChange?: (patch: MimiPresencePatch) => void;
  onPreviewMoving?: () => Promise<void>;
  onRetryPresence?: () => void;
  onOpenPersonalization: () => void;
  onOpenConnections: () => void;
  onOpenMemory: () => void;
  onBack: () => void;
}

export function PetSettingsPage({
  activeModelKey,
  modelOptions,
  hasModelOverride,
  widgetVisible,
  presence = null,
  onSelectModel,
  onResetModel,
  onWidgetVisibleChange,
  onPresenceChange,
  onPreviewMoving,
  onRetryPresence,
  onOpenPersonalization,
  onOpenConnections,
  onOpenMemory,
  onBack,
}: PetSettingsPageProps) {
  const { t } = useT();
  const dogIcon = usePetSprite();

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label={t("pet.settings.title")}
      data-pet-settings-page="standalone"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-5 py-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("pet.settings.back")}
          title={t("pet.settings.back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
          <img src={dogIcon} alt="" draggable={false} className="h-10 w-10 object-contain" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{t("pet.settings.title")}</h1>
          <p className="truncate text-sm text-muted-foreground">{t("pet.settings.subtitle")}</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-4xl gap-5 p-5 lg:p-8">
          <Card data-pet-setting="personalization" className="rounded-2xl">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">
                  {t("pet.settings.personalizationTitle")}
                </CardTitle>
                <CardDescription className="leading-5">
                  {t("pet.settings.personalizationDescription")}
                </CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onOpenPersonalization}>
                {t("pet.settings.managePersonalization")}
              </Button>
            </CardHeader>
          </Card>

          <Card data-pet-setting="model" className="rounded-2xl">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Settings2 size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">{t("pet.settings.modelTitle")}</CardTitle>
                <CardDescription className="leading-5">
                  {t("pet.settings.modelDescription")}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2 pl-16">
              <ModelPill
                activeKey={activeModelKey}
                options={modelOptions}
                onSelect={onSelectModel}
                disabled={modelOptions.length === 0}
                portal
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!hasModelOverride}
                onClick={onResetModel}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {t("pet.settings.useAppDefault")}
              </Button>
              {!hasModelOverride && (
                <span className="text-xs text-muted-foreground">
                  {t("pet.settings.followingAppDefault")}
                </span>
              )}
            </CardContent>
          </Card>

          <Card data-pet-setting="widget" className="rounded-2xl">
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Monitor size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">{t("pet.settings.widgetTitle")}</CardTitle>
                <CardDescription className="leading-5">
                  {t("pet.settings.widgetDescription")}
                </CardDescription>
              </div>
              <Switch
                checked={presence ? presence.visible : widgetVisible}
                onCheckedChange={onWidgetVisibleChange}
                aria-label={t("pet.settings.widgetTitle")}
              />
            </CardHeader>
            {presence && onPresenceChange && (
              <MimiPresenceControls
                presence={presence}
                onChange={onPresenceChange}
                onPreview={onPreviewMoving}
                onRetry={onRetryPresence}
              />
            )}
          </Card>

          <Card data-pet-setting="memory" className="rounded-2xl">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Brain size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">{t("pet.settings.memoryTitle")}</CardTitle>
                <CardDescription className="leading-5">
                  {t("pet.settings.memoryDescription")}
                </CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onOpenMemory}>
                {t("pet.settings.manageMemory")}
              </Button>
            </CardHeader>
          </Card>

          <Card data-pet-setting="connections" className="rounded-2xl">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MessageCircleMore size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">{t("pet.settings.connectionsTitle")}</CardTitle>
                <CardDescription className="leading-5">
                  {t("pet.settings.connectionsDescription")}
                </CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onOpenConnections}>
                {t("pet.settings.manageConnections")}
              </Button>
            </CardHeader>
          </Card>
        </div>
      </div>
    </section>
  );
}
