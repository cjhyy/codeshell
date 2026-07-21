import { ArrowLeft, MessageCircleMore, Monitor, RotateCcw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { ModelPill, type ModelOption } from "../chat/ModelPill";
import { useT } from "../i18n";

export interface PetSettingsPageProps {
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  hasModelOverride: boolean;
  widgetVisible: boolean;
  onSelectModel: (option: ModelOption) => void;
  onResetModel: () => void;
  onWidgetVisibleChange: (visible: boolean) => void;
  onOpenConnections: () => void;
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
  onBack,
}: PetSettingsPageProps) {
  const { t } = useT();

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
