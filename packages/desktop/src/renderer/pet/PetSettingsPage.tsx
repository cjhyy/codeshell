import { useEffect, useRef, useState } from "react";
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
import {
  petPersonalizationFromSettings,
  petPersonalizationSettingsPatch,
  type PetPersonalization,
} from "../../shared/pet-settings";

type PetPersonalizationDraft = Required<PetPersonalization>;

const EMPTY_PERSONALIZATION: PetPersonalizationDraft = {
  responseLanguage: "",
  userProfile: "",
  communicationStyle: "",
  customInstructions: "",
};

function personalizationDraft(value: PetPersonalization): PetPersonalizationDraft {
  return {
    responseLanguage: value.responseLanguage ?? "",
    userProfile: value.userProfile ?? "",
    communicationStyle: value.communicationStyle ?? "",
    customInstructions: value.customInstructions ?? "",
  };
}

function PetPersonalizationCard() {
  const { t } = useT();
  const [draft, setDraft] = useState<PetPersonalizationDraft>(EMPTY_PERSONALIZATION);
  const draftRef = useRef(draft);
  const loadGeneration = useRef(0);
  draftRef.current = draft;
  const { schedule, flush } = useTargetedDebouncedSave(
    "user:pet-personalization",
    (value: PetPersonalizationDraft) =>
      writeSettings("user", petPersonalizationSettingsPatch(value)),
  );

  useEffect(() => {
    const generation = ++loadGeneration.current;
    void (async () => {
      const settings = await window.codeshell.getSettings("user");
      if (generation !== loadGeneration.current) return;
      const next = personalizationDraft(petPersonalizationFromSettings(settings));
      draftRef.current = next;
      setDraft(next);
    })();
    return () => {
      if (generation === loadGeneration.current) loadGeneration.current += 1;
    };
  }, []);

  const update = (key: keyof PetPersonalizationDraft, value: string): void => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    schedule(next);
  };

  return (
    <Card data-pet-setting="personalization" className="rounded-2xl">
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <CardTitle className="text-base">{t("pet.settings.personalizationTitle")}</CardTitle>
          <CardDescription className="leading-5">
            {t("pet.settings.personalizationDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5 pl-16">
        <div className="grid gap-2">
          <Label htmlFor="pet-response-language">{t("pet.settings.responseLanguageLabel")}</Label>
          <Input
            id="pet-response-language"
            value={draft.responseLanguage}
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
            maxLength={6_000}
            onChange={(event) => update("customInstructions", event.target.value)}
            onBlur={flush}
            placeholder={t("pet.settings.customInstructionsPlaceholder")}
            className="min-h-32 resize-y leading-relaxed"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("pet.settings.personalizationSaveHint")}</p>
      </CardContent>
    </Card>
  );
}

export interface PetSettingsPageProps {
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  hasModelOverride: boolean;
  widgetVisible: boolean;
  onSelectModel: (option: ModelOption) => void;
  onResetModel: () => void;
  onWidgetVisibleChange: (visible: boolean) => void;
  onOpenConnections: () => void;
  onOpenMemory: () => void;
  onBack: () => void;
}

export function PetSettingsPage({
  activeModelKey,
  modelOptions,
  hasModelOverride,
  widgetVisible,
  onSelectModel,
  onResetModel,
  onWidgetVisibleChange,
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
          <PetPersonalizationCard />

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
                checked={widgetVisible}
                onCheckedChange={onWidgetVisibleChange}
                aria-label={t("pet.settings.widgetTitle")}
              />
            </CardHeader>
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
