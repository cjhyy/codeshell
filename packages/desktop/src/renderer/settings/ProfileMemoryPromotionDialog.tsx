import React from "react";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Textarea } from "@/components/ui/textarea";
import type { RendererMemoryEntryFull } from "../../preload/types";
import type {
  ProfileMemoryPromotionDraft,
  ProfileMemoryPromotionReview,
} from "../../shared/profile-memory-promotion";
import { requireProjectConfigurationTarget } from "../configurationTarget";
import { useT, type TFunction } from "../i18n/I18nProvider";
import { useConfirm } from "../ui/ConfirmDialog";

type TargetProfile = { name: string; label: string; portableMemory: boolean };
const memoryTypes = [
  ["user", "settingsX.memory.typeUser"],
  ["feedback", "settingsX.memory.typeFeedback"],
  ["project", "settingsX.memory.typeProject"],
  ["reference", "settingsX.memory.typeReference"],
] as const;

const typeLabel = (type: ProfileMemoryPromotionDraft["type"], t: TFunction) =>
  t(memoryTypes.find(([value]) => value === type)![1]);

function reviewDetail(review: ProfileMemoryPromotionReview, cwd: string, t: TFunction): string {
  const source = review.source;
  const draft = review.draft;
  return [
    t("settingsX.memory.promotionSource", { project: cwd, name: source.name }),
    t(
      source.scope === "dream"
        ? "settingsX.memory.scopeDreamLabel"
        : "settingsX.memory.scopeUserLabel",
    ),
    `${t("settingsX.memory.fieldType")}: ${typeLabel(source.type, t)}`,
    `${t("settingsX.memory.fieldDescription")}: ${source.description}`,
    `${t("settingsX.memory.fieldContent")}:\n${source.content}`,
    "",
    t("settingsX.memory.promotionTargetReview", {
      label: review.target.label,
      name: review.target.profileName,
    }),
    t(
      review.target.portableMemory
        ? "settingsX.memory.promotionEnabled"
        : "settingsX.memory.promotionDisabled",
    ),
    `${t("settingsX.memory.fieldName")}: ${draft.name}`,
    `${t("settingsX.memory.fieldDescription")}: ${draft.description}`,
    `${t("settingsX.memory.fieldType")}: ${typeLabel(draft.type, t)}`,
    t(draft.pinned ? "settingsX.memory.pinned" : "settingsX.memory.promotionNotPinned"),
    `${t("settingsX.memory.fieldContent")}:\n${draft.content}`,
    "",
    t("settingsX.memory.promotionKeepsSource"),
  ].join("\n");
}

/** A manual copy, with a server-bound review of the final edited destination. */
export function ProfileMemoryPromotionDialog({
  cwd,
  scope,
  source,
  onClose,
  onCopied,
}: {
  cwd: string;
  scope: "user" | "dream";
  source: RendererMemoryEntryFull & { id: string };
  onClose: () => void;
  onCopied: (profileLabel: string, portableMemory: boolean) => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [profiles, setProfiles] = React.useState<TargetProfile[]>([]);
  const [profileName, setProfileName] = React.useState("");
  const [draft, setDraft] = React.useState<ProfileMemoryPromotionDraft>(() => ({
    name: source.name,
    description: source.description,
    type: source.type,
    content: source.content,
    pinned: !!source.pinned,
  }));
  const [loading, setLoading] = React.useState(true);
  const [profileLoadError, setProfileLoadError] = React.useState<string | null>(null);
  const [profileLoadAttempt, setProfileLoadAttempt] = React.useState(0);
  const [stage, setStage] = React.useState<"editing" | "reviewing" | "committing">("editing");
  const [error, setError] = React.useState<string | null>(null);
  const active = React.useRef(true);
  const generation = React.useRef(0);
  const busyLock = React.useRef(false);
  const committingLock = React.useRef(false);
  const busy = stage !== "editing";
  const committing = stage === "committing";
  const target = profiles.find((profile) => profile.name === profileName);

  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);

  React.useEffect(() => {
    const revision = ++generation.current;
    const isCurrent = () => active.current && generation.current === revision;
    setLoading(true);
    setProfileLoadError(null);
    setProfiles([]);
    setProfileName("");
    void (async () => {
      try {
        const list = await window.codeshell.listProfiles(requireProjectConfigurationTarget(cwd));
        if (isCurrent()) setProfiles(list);
      } catch (caught) {
        if (isCurrent()) {
          setProfileLoadError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
  }, [cwd, profileLoadAttempt]);

  const close = () => {
    if (committingLock.current) return;
    active.current = false;
    generation.current += 1;
    onClose();
  };

  const changeDraft = (patch: Partial<ProfileMemoryPromotionDraft>) => {
    if (busyLock.current) return;
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const reviewAndCopy = async () => {
    if (!active.current || loading || busyLock.current || !target) return;
    if (!draft.name.trim()) {
      setError(t("settingsX.memory.nameRequired"));
      return;
    }
    busyLock.current = true;
    const revision = ++generation.current;
    const isCurrent = () => active.current && generation.current === revision;
    setStage("reviewing");
    setError(null);
    try {
      const review = await window.codeshell.previewProfileMemoryPromotion({
        cwd,
        source: { scope, id: source.id },
        profileName: target.name,
        draft,
      });
      if (!isCurrent()) return;
      if (
        review.source.id !== source.id ||
        review.source.scope !== scope ||
        review.target.profileName !== target.name
      ) {
        throw new Error(t("settingsX.memory.promotionReviewChanged"));
      }
      const accepted = await confirm({
        title: t("settingsX.memory.promotionConfirmTitle"),
        message: t("settingsX.memory.promotionConfirmMessage"),
        detail: reviewDetail(review, cwd, t),
        confirmLabel: t("settingsX.memory.promotionCommit"),
      });
      if (!accepted || !isCurrent()) return;
      committingLock.current = true;
      setStage("committing");
      await window.codeshell.commitProfileMemoryPromotion({ cwd, reviewId: review.reviewId });
      if (!isCurrent()) return;
      onCopied(review.target.label, review.target.portableMemory);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) {
        committingLock.current = false;
        busyLock.current = false;
        setStage("editing");
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" showClose={!committing}>
        <DialogHeader>
          <DialogTitle>{t("settingsX.memory.promotionTitle")}</DialogTitle>
          <DialogDescription>{t("settingsX.memory.promotionDescription")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs leading-5">
          <p>{t("settingsX.memory.promotionSource", { project: cwd, name: source.name })}</p>
          <p className="text-muted-foreground">{t("settingsX.memory.promotionKeepsSource")}</p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
            <span className="text-xs font-medium">{t("settingsX.memory.promotionTarget")}</span>
            <SimpleSelect
              value={profileName}
              ariaLabel={t("settingsX.memory.promotionTarget")}
              placeholder={t("settingsX.memory.promotionPickTarget")}
              disabled={loading || busy}
              options={profiles.map((profile) => ({
                value: profile.name,
                label: `${profile.label} (${profile.name})`,
              }))}
              onChange={(name) => {
                if (busyLock.current) return;
                setProfileName(name);
                setError(null);
              }}
            />
            {loading ? (
              <span className="text-xs text-muted-foreground">
                {t("settingsX.memory.promotionLoading")}
              </span>
            ) : profileLoadError ? (
              <span className="flex items-center gap-2">
                <span role="alert" className="text-xs text-status-err">
                  {profileLoadError}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (active.current && !busyLock.current) {
                      setProfileLoadAttempt((attempt) => attempt + 1);
                    }
                  }}
                >
                  {t("settingsX.memory.promotionRetryProfiles")}
                </Button>
              </span>
            ) : profiles.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("settingsX.memory.promotionNoProfiles")}
              </span>
            ) : target ? (
              <span className="text-xs text-muted-foreground">
                {t(
                  target.portableMemory
                    ? "settingsX.memory.promotionEnabled"
                    : "settingsX.memory.promotionDisabled",
                )}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium">{t("settingsX.memory.fieldName")}</span>
            <Input
              value={draft.name}
              disabled={busy}
              onChange={(e) => changeDraft({ name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium">{t("settingsX.memory.fieldType")}</span>
            <SimpleSelect
              value={draft.type}
              ariaLabel={t("settingsX.memory.fieldType")}
              disabled={busy}
              options={memoryTypes.map(([value, key]) => ({ value, label: t(key) }))}
              onChange={(type: ProfileMemoryPromotionDraft["type"]) => changeDraft({ type })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
            <span className="text-xs font-medium">{t("settingsX.memory.fieldDescription")}</span>
            <Input
              value={draft.description}
              disabled={busy}
              onChange={(e) => changeDraft({ description: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
            <span className="text-xs font-medium">{t("settingsX.memory.fieldContent")}</span>
            <Textarea
              rows={10}
              value={draft.content}
              disabled={busy}
              onChange={(e) => changeDraft({ content: e.target.value })}
              className="leading-6"
            />
          </label>
          <label className="flex items-center gap-2 text-xs md:col-span-2">
            <Checkbox
              checked={!!draft.pinned}
              disabled={busy}
              onCheckedChange={(checked) => changeDraft({ pinned: checked === true })}
            />
            {t("settingsX.memory.pin")}
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={committing} onClick={close}>
            {t("settingsX.memory.cancel")}
          </Button>
          <Button
            type="button"
            disabled={loading || busy || !target}
            onClick={() => void reviewAndCopy()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
            {t(
              committing
                ? "settingsX.memory.saving"
                : busy
                  ? "settingsX.memory.promotionReviewing"
                  : "settingsX.memory.promotionReview",
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
