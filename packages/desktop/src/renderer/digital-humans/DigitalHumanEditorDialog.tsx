import React from "react";
import { Check, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";
import {
  canAddDigitalHumanSkill,
  DIGITAL_HUMAN_PROFILE_LIMITS,
  type DigitalHumanProfileEntry,
  type DigitalHumanSkillEntry,
} from "./types";

const DIGITAL_HUMAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function CharacterCount({ value, max }: { value: string; max: number }) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "text-right text-[11px] tabular-nums text-muted-foreground",
        value.length > max && "text-status-err",
      )}
    >
      {value.length}/{max}
    </p>
  );
}

interface Props {
  open: boolean;
  profile?: DigitalHumanProfileEntry;
  existingIds: string[];
  skills: DigitalHumanSkillEntry[];
  projectSkills?: DigitalHumanSkillEntry[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (profile: Omit<DigitalHumanProfileEntry, "active">) => void;
}

export function DigitalHumanEditorDialog({
  open,
  profile,
  existingIds,
  skills,
  projectSkills = [],
  busy,
  onOpenChange,
  onSave,
}: Props) {
  const { t } = useT();
  const [id, setId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [basePreset, setBasePreset] = React.useState("general");
  const [mainInstruction, setMainInstruction] = React.useState("");
  const [version, setVersion] = React.useState("");
  const [portableMemory, setPortableMemory] = React.useState(true);
  const [selectedSkills, setSelectedSkills] = React.useState<Set<string>>(() => new Set());
  const [skillQuery, setSkillQuery] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setId(profile?.name ?? "");
    setLabel(profile?.label ?? "");
    setDescription(profile?.description ?? "");
    setBasePreset(profile?.basePreset ?? "general");
    setMainInstruction(profile?.mainInstruction ?? "");
    setVersion(profile?.version ?? "");
    setPortableMemory(profile?.portableMemory ?? true);
    setSelectedSkills(new Set(profile?.skills ?? []));
    setSkillQuery("");
  }, [open, profile]);

  const normalizedId = id.trim();
  const duplicateId = !profile && existingIds.includes(normalizedId);
  const validId = DIGITAL_HUMAN_ID_RE.test(normalizedId) && !duplicateId;
  const knownSkillNames = new Set(skills.map((skill) => skill.name));
  const missingSkills: DigitalHumanSkillEntry[] = [...selectedSkills]
    .filter((name) => !knownSkillNames.has(name))
    .map((name) => ({ name, description: "", source: "user" }));
  const normalizedQuery = skillQuery.trim().toLocaleLowerCase();
  const visibleSkills = [...skills, ...missingSkills]
    .filter(
      (skill) =>
        !normalizedQuery ||
        skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
        skill.description.toLocaleLowerCase().includes(normalizedQuery),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleSkill = (name: string) => {
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (canAddDigitalHumanSkill(next.size, name)) next.add(name);
      return next;
    });
  };

  const textFieldsWithinLimits =
    id.length <= DIGITAL_HUMAN_PROFILE_LIMITS.id &&
    label.length <= DIGITAL_HUMAN_PROFILE_LIMITS.label &&
    description.length <= DIGITAL_HUMAN_PROFILE_LIMITS.description &&
    basePreset.length <= DIGITAL_HUMAN_PROFILE_LIMITS.basePreset &&
    mainInstruction.length <= DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction &&
    version.length <= DIGITAL_HUMAN_PROFILE_LIMITS.version;
  const selectedSkillsWithinLimits =
    selectedSkills.size <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount &&
    [...selectedSkills].every(
      (name) => name.length > 0 && name.length <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName,
    );
  const skillLimitReached = selectedSkills.size === DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const skillLimitExceeded = selectedSkills.size > DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const skillAdditionBlocked = selectedSkills.size >= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const canSave =
    validId &&
    Boolean(label.trim()) &&
    Boolean(basePreset.trim()) &&
    textFieldsWithinLimits &&
    selectedSkillsWithinLimits &&
    !busy;
  const submit = () => {
    if (!canSave) return;
    onSave({
      name: normalizedId,
      label: label.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      basePreset: basePreset.trim(),
      plugins: profile?.plugins ?? [],
      skills: [...selectedSkills].sort(),
      mcp: profile?.mcp ?? [],
      agents: profile?.agents ?? [],
      ...(mainInstruction.trim() ? { mainInstruction: mainInstruction.trim() } : {}),
      portableMemory,
      ...(version.trim() ? { version: version.trim() } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {profile ? t("digitalHumans.editor.titleEdit") : t("digitalHumans.editor.titleCreate")}
          </DialogTitle>
          <DialogDescription>{t("digitalHumans.editor.description")}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-6">
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">{t("digitalHumans.editor.identity")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("digitalHumans.editor.identityDescription")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="digital-human-id">{t("digitalHumans.editor.id")}</Label>
                  <Input
                    id="digital-human-id"
                    value={id}
                    onChange={(event) => setId(event.target.value.toLocaleLowerCase())}
                    placeholder={t("digitalHumans.editor.idPlaceholder")}
                    disabled={Boolean(profile)}
                    maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.id}
                  />
                  <p
                    className={cn(
                      "text-xs text-muted-foreground",
                      normalizedId && !validId && "text-status-err",
                    )}
                  >
                    {duplicateId
                      ? t("digitalHumans.editor.idDuplicate")
                      : profile
                        ? t("digitalHumans.editor.idLocked")
                        : t("digitalHumans.editor.idHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="digital-human-label">{t("digitalHumans.editor.name")}</Label>
                  <Input
                    id="digital-human-label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder={t("digitalHumans.editor.namePlaceholder")}
                    maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.label}
                  />
                  <CharacterCount value={label} max={DIGITAL_HUMAN_PROFILE_LIMITS.label} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="digital-human-summary">{t("digitalHumans.editor.summary")}</Label>
                <Input
                  id="digital-human-summary"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t("digitalHumans.editor.summaryPlaceholder")}
                  maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.description}
                />
                <CharacterCount
                  value={description}
                  max={DIGITAL_HUMAN_PROFILE_LIMITS.description}
                />
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">{t("digitalHumans.editor.method")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("digitalHumans.editor.methodDescription")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="digital-human-instruction">
                  {t("digitalHumans.editor.instruction")}
                </Label>
                <Textarea
                  id="digital-human-instruction"
                  value={mainInstruction}
                  onChange={(event) => setMainInstruction(event.target.value)}
                  placeholder={t("digitalHumans.editor.instructionPlaceholder")}
                  rows={7}
                  maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction}
                />
                <CharacterCount
                  value={mainInstruction}
                  max={DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="digital-human-preset">{t("digitalHumans.editor.preset")}</Label>
                  <Input
                    id="digital-human-preset"
                    value={basePreset}
                    onChange={(event) => setBasePreset(event.target.value)}
                    placeholder="general"
                    maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.basePreset}
                  />
                  <CharacterCount
                    value={basePreset}
                    max={DIGITAL_HUMAN_PROFILE_LIMITS.basePreset}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="digital-human-version">{t("digitalHumans.editor.version")}</Label>
                  <Input
                    id="digital-human-version"
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    placeholder="1.0.0"
                    maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.version}
                  />
                  <CharacterCount value={version} max={DIGITAL_HUMAN_PROFILE_LIMITS.version} />
                </div>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-3">
                <div>
                  <Label htmlFor="digital-human-memory">{t("digitalHumans.editor.memory")}</Label>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("digitalHumans.editor.memoryDescription")}
                  </p>
                </div>
                <Switch
                  id="digital-human-memory"
                  checked={portableMemory}
                  onCheckedChange={setPortableMemory}
                />
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">{t("digitalHumans.editor.skills")}</h3>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                    {t("digitalHumans.editor.skillsDescription")}
                  </p>
                </div>
                <Badge variant="secondary">
                  {t("digitalHumans.editor.selectedCount", {
                    count: selectedSkills.size,
                    limit: DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount,
                  })}
                </Badge>
              </div>
              {skillLimitReached || skillLimitExceeded ? (
                <p
                  id="digital-human-skill-limit"
                  role={skillLimitExceeded ? "alert" : "status"}
                  className={cn(
                    "text-xs text-status-warn",
                    skillLimitExceeded && "text-status-err",
                  )}
                >
                  {t(
                    skillLimitExceeded
                      ? "digitalHumans.editor.skillLimitExceeded"
                      : "digitalHumans.editor.skillLimitReached",
                    { limit: DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount },
                  )}
                </p>
              ) : null}
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  className="pl-9"
                  placeholder={t("digitalHumans.editor.skillSearch")}
                  aria-label={t("digitalHumans.editor.skillSearchLabel")}
                />
              </div>
              {visibleSkills.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("digitalHumans.editor.noSkills")}
                </div>
              ) : (
                <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                  {visibleSkills.map((skill) => {
                    const selected = selectedSkills.has(skill.name);
                    const missing = !knownSkillNames.has(skill.name);
                    const invalidName =
                      skill.name.length === 0 ||
                      skill.name.length > DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName;
                    const selectionBlocked = !selected && (skillAdditionBlocked || invalidName);
                    return (
                      <Button
                        key={skill.name}
                        type="button"
                        variant="outline"
                        className={cn(
                          "h-auto min-h-16 items-start justify-start px-3 py-2 text-left",
                          selected && "border-primary/50 bg-primary/5",
                        )}
                        aria-pressed={selected}
                        aria-label={t("digitalHumans.editor.skillToggle", {
                          name: skill.name,
                          state: selected
                            ? t("digitalHumans.editor.skillSelected")
                            : t("digitalHumans.editor.skillNotSelected"),
                        })}
                        aria-describedby={
                          !selected && skillAdditionBlocked
                            ? "digital-human-skill-limit"
                            : undefined
                        }
                        disabled={selectionBlocked}
                        onClick={() => toggleSkill(skill.name)}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border",
                            selected && "border-primary bg-primary text-primary-foreground",
                          )}
                        >
                          {selected ? <Check size={11} aria-hidden="true" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-xs font-medium">{skill.name}</span>
                            <Badge variant={missing || invalidName ? "warning" : "secondary"}>
                              {invalidName
                                ? t("digitalHumans.editor.skillNameTooLong", {
                                    limit: DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName,
                                  })
                                : missing
                                  ? t("digitalHumans.editor.skillMissing")
                                  : t(`digitalHumans.editor.source.${skill.source}`)}
                            </Badge>
                          </span>
                          {skill.description ? (
                            <span className="mt-1 line-clamp-2 block text-xs font-normal leading-4 text-muted-foreground">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              )}
              {projectSkills.length > 0 ? (
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <p className="text-xs font-medium">
                    {t("digitalHumans.editor.projectSkillsTitle")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("digitalHumans.editor.projectSkillsDescription")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {projectSkills.map((skill) => (
                      <Badge key={skill.name} variant="secondary">
                        {skill.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {busy ? t("digitalHumans.editor.saving") : t("digitalHumans.editor.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
