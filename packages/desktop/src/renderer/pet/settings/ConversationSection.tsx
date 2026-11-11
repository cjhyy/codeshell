import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelPill, type ModelOption } from "../../chat/ModelPill";
import { useT } from "../../i18n";
import { writeSettings } from "../../settingsBus";
import { useTargetedDebouncedSave } from "../../settings/useTargetedDebouncedSave";
import { useToast } from "../../ui/ToastProvider";
import {
  petPersonalizationFromSettings,
  petPersonalizationSettingsPatch,
  type PetPersonalization,
} from "../../../shared/pet-settings";

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
      data-pet-setting="personalization"
      data-pet-personalization-fields="true"
      aria-busy={loadState === "loading"}
      className="rounded-2xl"
    >
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">{t("pet.settings.personalizationTitle")}</CardTitle>
        <CardDescription className="leading-5">
          {t("pet.settings.personalizationDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
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

export interface ConversationSectionProps {
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  hasModelOverride: boolean;
  onSelectModel: (option: ModelOption) => void;
  onResetModel: () => void;
}

/** 对话: Mimi's manager-chat model and its personalization, edited in place. */
export function ConversationSection({
  activeModelKey,
  modelOptions,
  hasModelOverride,
  onSelectModel,
  onResetModel,
}: ConversationSectionProps) {
  const { t } = useT();
  return (
    <>
      <Card data-pet-setting="model" className="rounded-2xl">
        <CardHeader className="space-y-1.5">
          <CardTitle className="text-base">{t("pet.settings.modelTitle")}</CardTitle>
          <CardDescription className="leading-5">
            {t("pet.settings.modelDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
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
      <PetPersonalizationForm />
    </>
  );
}
