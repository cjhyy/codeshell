import React from "react";
import {
  Brain,
  CircleAlert,
  Check,
  ChevronRight,
  Download,
  LoaderCircle,
  Puzzle,
  Search,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
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
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { requireProjectConfigurationTarget } from "../configurationTarget";
import {
  canAddDigitalHumanSkill,
  digitalHumanMissingSkillNames,
  digitalHumanNamedProjectRequirementSkillNames,
  digitalHumanSkillSourcesByName,
  DIGITAL_HUMAN_PROFILE_LIMITS,
  hasDigitalHumanCatchAllSkillRequirement,
  normalizeDigitalHumanSkillRepo,
  replaceDigitalHumanSkillSources,
  type DigitalHumanProfileEntry,
  type DigitalHumanSkillEntry,
} from "./types";

const DIGITAL_HUMAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
type EditorSection = "identity" | "prompt" | "skills" | "settings";
type SkillFilter = "all" | "selected";

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
  projectPath?: string | null;
  busy: boolean;
  installing?: boolean;
  onRequirementsInstalled?: () => void | Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  onSave: (
    profile: Omit<DigitalHumanProfileEntry, "active">,
    options?: { installRequirements?: boolean },
  ) => void;
}

export function DigitalHumanEditorDialog({
  open,
  profile,
  existingIds,
  skills,
  projectSkills = [],
  projectPath,
  busy,
  installing = false,
  onRequirementsInstalled,
  onOpenChange,
  onSave,
}: Props) {
  const { t } = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [id, setId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [mainInstruction, setMainInstruction] = React.useState("");
  const [portableMemory, setPortableMemory] = React.useState(true);
  const [exclusiveCapabilities, setExclusiveCapabilities] = React.useState(false);
  const [selectedSkills, setSelectedSkills] = React.useState<Set<string>>(() => new Set());
  const [skillQuery, setSkillQuery] = React.useState("");
  const [skillFilter, setSkillFilter] = React.useState<SkillFilter>("all");
  const [skillInstallRepos, setSkillInstallRepos] = React.useState<Record<string, string>>({});
  const [section, setSection] = React.useState<EditorSection>("identity");
  const [installingRequirements, setInstallingRequirements] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setId(profile?.name ?? "");
    setLabel(profile?.label ?? "");
    setDescription(profile?.description ?? "");
    setMainInstruction(profile?.mainInstruction ?? "");
    setPortableMemory(profile?.portableMemory ?? true);
    setExclusiveCapabilities(profile?.exclusiveCapabilities ?? false);
    setSelectedSkills(new Set(profile?.skills ?? []));
    setSkillQuery("");
    setSkillFilter("all");
    setSkillInstallRepos(digitalHumanSkillSourcesByName(profile?.requires));
    setSection("identity");
    setInstallingRequirements(false);
    // A same-profile save may refresh the parent object while this dialog stays
    // open (for example when the user cancels the subsequent install review).
    // Re-initialize only for a real open/target change so the active section
    // and the user's local editor state do not jump unexpectedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.name]);

  const normalizedId = id.trim();
  const duplicateId = !profile && existingIds.includes(normalizedId);
  const validId = DIGITAL_HUMAN_ID_RE.test(normalizedId) && !duplicateId;
  // The whole Skill catalog is derived here, so it must not be recomputed on
  // every keystroke in the identity fields (label/id/instruction). These memos
  // depend only on the catalog inputs and the Skill selection.
  const requires = profile?.requires;
  const {
    installedSkillsByName,
    missingSkillNameSet,
    missingSkills,
    projectRequirementSkillNames,
    hasCatchAllSkillRequirement,
    existingSkillSources,
  } = React.useMemo(() => {
    // Named requirements are project-scoped. A user-wide Skill with the same
    // name remains visible, but it does not satisfy the declared project install.
    const installed = [...skills, ...projectSkills];
    const byName = new Map(installed.map((skill) => [skill.name, skill]));
    const missingNames = digitalHumanMissingSkillNames([...selectedSkills], requires, installed);
    return {
      installedSkillsByName: byName,
      missingSkillNameSet: new Set(missingNames),
      missingSkills: missingNames.map(
        (name): DigitalHumanSkillEntry =>
          byName.get(name) ?? {
            name,
            description: "",
            source: "user",
          },
      ),
      projectRequirementSkillNames: digitalHumanNamedProjectRequirementSkillNames(requires),
      hasCatchAllSkillRequirement: hasDigitalHumanCatchAllSkillRequirement(requires),
      existingSkillSources: digitalHumanSkillSourcesByName(requires),
    };
  }, [skills, projectSkills, selectedSkills, requires]);

  const visibleSkills = React.useMemo(() => {
    const selectedProjectSkills = projectSkills.filter((skill) => selectedSkills.has(skill.name));
    const normalizedQuery = skillQuery.trim().toLocaleLowerCase();
    const pickerSkillsByName = new Map(
      [...skills, ...selectedProjectSkills, ...missingSkills].map((skill) => [skill.name, skill]),
    );
    return [...pickerSkillsByName.values()]
      .filter(
        (skill) =>
          !normalizedQuery ||
          skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
          skill.description.toLocaleLowerCase().includes(normalizedQuery),
      )
      .filter((skill) => skillFilter === "all" || selectedSkills.has(skill.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, projectSkills, selectedSkills, missingSkills, skillQuery, skillFilter]);

  const installedSkillCount = installedSkillsByName.size;
  const disabledSkillCount = React.useMemo(
    () => [...installedSkillsByName.values()].filter((skill) => skill.enabled === false).length,
    [installedSkillsByName],
  );

  const {
    missingSkillSourceRows,
    changedSkillInstallRepos,
    skillInstallSourcesValid,
    allMissingSkillsHaveSource,
    missingSkillsWithoutSource,
    nextSkillRequirements,
  } = React.useMemo(() => {
    // Catch-all requirements are reviewed as one repository. Named requirements
    // get one editable row per missing Skill, including sources that were
    // already saved — a wrong repository must not become impossible to fix.
    const editableMissingSkillNames = hasCatchAllSkillRequirement
      ? []
      : missingSkills.map((skill) => skill.name);
    const rows = editableMissingSkillNames.map((name) => {
      const value = skillInstallRepos[name] ?? existingSkillSources[name] ?? "";
      const normalizedValue = value.trim();
      const repo = normalizeDigitalHumanSkillRepo(value);
      return {
        name,
        value,
        repo,
        valid: normalizedValue.length === 0 || repo !== null,
      };
    });
    const changed = Object.fromEntries(
      rows
        .map((row) => [row.name, row.value] as const)
        .filter(([name, value]) => value.trim() !== (existingSkillSources[name] ?? "")),
    );
    return {
      missingSkillSourceRows: rows,
      changedSkillInstallRepos: changed,
      skillInstallSourcesValid: rows.every((row) => row.valid),
      allMissingSkillsHaveSource: rows.length > 0 && rows.every((row) => row.repo !== null),
      missingSkillsWithoutSource: rows.filter((row) => row.repo === null),
      nextSkillRequirements: replaceDigitalHumanSkillSources(requires?.skills ?? [], changed),
    };
  }, [
    hasCatchAllSkillRequirement,
    missingSkills,
    skillInstallRepos,
    existingSkillSources,
    requires,
  ]);

  const requirementLimitExceeded =
    nextSkillRequirements.length > DIGITAL_HUMAN_PROFILE_LIMITS.requirementCount;
  const canInstallMissingSkills = Boolean(
    profile &&
    projectPath &&
    hasCatchAllSkillRequirement &&
    !busy &&
    !installing &&
    !installingRequirements,
  );

  const installMissingSkills = async () => {
    if (
      !profile ||
      !projectPath ||
      !hasCatchAllSkillRequirement ||
      busy ||
      installing ||
      installingRequirements
    ) {
      return;
    }
    setInstallingRequirements(true);
    try {
      const target = requireProjectConfigurationTarget(projectPath);
      const preview = await window.codeshell.previewProfileRequirements(profile.name, target);
      const detail = [...preview.willRun, ...preview.warnings, ...preview.blockers].join("\n");

      if (!preview.needsInstall) {
        if (preview.blockers.length > 0) {
          await confirm({
            title: t("digitalHumans.requirements.blockedTitle"),
            message: t("digitalHumans.requirements.blockedMessage"),
            detail,
            confirmLabel: t("common.confirm"),
          });
        }
        await onRequirementsInstalled?.();
        if (preview.blockers.length === 0) {
          toast({
            message: t("digitalHumans.editor.missingSkillsRefreshed"),
            variant: "success",
          });
        }
        return;
      }

      const accepted = await confirm({
        title: t("digitalHumans.requirements.installTitle"),
        message: t("digitalHumans.requirements.installMessage"),
        detail,
        confirmLabel: t("digitalHumans.requirements.install"),
      });
      if (!accepted) return;

      const result = await window.codeshell.installProfileRequirements(profile.name, target);
      await onRequirementsInstalled?.();
      if (!result.ok) {
        toast({
          message: t("digitalHumans.requirements.installFailed", {
            error: result.errors.join("; "),
          }),
          variant: "error",
        });
        return;
      }
      toast({
        message: t("digitalHumans.editor.missingSkillsInstalled"),
        variant: "success",
      });
    } catch (caught) {
      toast({
        message: t("digitalHumans.requirements.installFailed", {
          error: caught instanceof Error ? caught.message : String(caught),
        }),
        variant: "error",
      });
    } finally {
      setInstallingRequirements(false);
    }
  };

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
    mainInstruction.length <= DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction;
  const selectedSkillsWithinLimits =
    selectedSkills.size <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount &&
    [...selectedSkills].every(
      (name) => name.length > 0 && name.length <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName,
    );
  const skillLimitReached = selectedSkills.size === DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const skillLimitExceeded = selectedSkills.size > DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const skillAdditionBlocked = selectedSkills.size >= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount;
  const operationBusy = busy || installingRequirements;
  const canSave =
    validId &&
    Boolean(label.trim()) &&
    textFieldsWithinLimits &&
    selectedSkillsWithinLimits &&
    skillInstallSourcesValid &&
    !requirementLimitExceeded &&
    !operationBusy;
  const canSaveAndInstall = Boolean(
    canSave && profile && projectPath && allMissingSkillsHaveSource,
  );
  /**
   * Has the user typed anything not yet saved? Radix closes the dialog on a
   * backdrop click or Esc, which silently discarded a half-written digital
   * human — the main reason editing felt unsafe.
   */
  const dirty =
    normalizedId !== (profile?.name ?? "") ||
    label !== (profile?.label ?? "") ||
    description !== (profile?.description ?? "") ||
    mainInstruction !== (profile?.mainInstruction ?? "") ||
    portableMemory !== (profile?.portableMemory ?? true) ||
    exclusiveCapabilities !== (profile?.exclusiveCapabilities ?? false) ||
    Object.keys(changedSkillInstallRepos).length > 0 ||
    selectedSkills.size !== (profile?.skills.length ?? 0) ||
    (profile?.skills ?? []).some((name) => !selectedSkills.has(name));

  const requestClose = (next: boolean) => {
    if (!next && operationBusy) return;
    if (next || !dirty) {
      onOpenChange(next);
      return;
    }
    void confirm({
      title: t("digitalHumans.editor.discardTitle"),
      message: t("digitalHumans.editor.discardMessage"),
      confirmLabel: t("digitalHumans.editor.discard"),
      destructive: true,
    }).then((accepted) => {
      if (accepted) onOpenChange(false);
    });
  };

  const submit = (installRequirements = false) => {
    if (!canSave) return;
    const requirementTools = profile?.requires?.tools ?? [];
    const nextRequirements =
      nextSkillRequirements.length > 0 || requirementTools.length > 0
        ? { skills: nextSkillRequirements, tools: requirementTools }
        : undefined;
    onSave(
      {
        name: normalizedId,
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        // The runtime base belongs to CodeShell, not to the digital-human
        // authoring surface. Keep one predictable full-featured base while
        // preserving imported definition metadata that users cannot edit here.
        basePreset: "general",
        plugins: profile?.plugins ?? [],
        skills: [...selectedSkills].sort(),
        mcp: profile?.mcp ?? [],
        agents: profile?.agents ?? [],
        // Preserve authored multi-source/tool requirements. Older definitions
        // can now add one trusted GitHub source per missing Skill.
        ...(nextRequirements ? { requires: nextRequirements } : {}),
        ...(mainInstruction.trim() ? { mainInstruction: mainInstruction.trim() } : {}),
        portableMemory,
        exclusiveCapabilities,
        ...(profile?.version ? { version: profile.version } : {}),
      },
      { installRequirements },
    );
  };

  const sectionItems: Array<{
    id: EditorSection;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    title: string;
    description: string;
    complete: boolean;
  }> = [
    {
      id: "identity",
      Icon: UserRound,
      title: t("digitalHumans.editor.identity"),
      description: t("digitalHumans.editor.identityDescription"),
      complete: validId && Boolean(label.trim()),
    },
    {
      id: "prompt",
      Icon: Brain,
      title: t("digitalHumans.editor.systemPrompt"),
      description: t("digitalHumans.editor.systemPromptDescription"),
      complete: Boolean(mainInstruction.trim()),
    },
    {
      id: "skills",
      Icon: Puzzle,
      title: t("digitalHumans.editor.skills"),
      description: t("digitalHumans.editor.skillsDescription"),
      complete: selectedSkills.size > 0,
    },
    {
      id: "settings",
      Icon: SlidersHorizontal,
      title: t("digitalHumans.editor.settings"),
      description: t("digitalHumans.editor.settingsDescription"),
      complete: true,
    },
  ];
  const previewInitials = label.trim().slice(0, 2).toUpperCase() || "DH";

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="flex max-h-[90vh] max-w-4xl flex-col gap-0 overflow-hidden p-0"
        showClose={!operationBusy}
      >
        <DialogHeader className="border-b border-border/70 bg-muted/25 px-6 py-5 pr-12">
          <div className="flex items-start gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-sm font-semibold text-primary shadow-sm">
              {previewInitials}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-xl">
                {profile
                  ? t("digitalHumans.editor.titleEdit")
                  : t("digitalHumans.editor.titleCreate")}
              </DialogTitle>
              <DialogDescription className="mt-1.5 max-w-2xl leading-5">
                {t("digitalHumans.editor.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid min-h-0 flex-1 md:grid-cols-[210px_minmax(0,1fr)]">
            <nav
              className="border-b border-border/70 bg-muted/15 p-3 md:border-b-0 md:border-r md:p-4"
              aria-label={t("digitalHumans.editor.navigationLabel")}
            >
              <div className="grid grid-cols-4 gap-1 md:flex md:flex-col">
                {sectionItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "group flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                      section === item.id
                        ? "bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--cs-primary)/0.12)]"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    aria-current={section === item.id ? "step" : undefined}
                    onClick={() => setSection(item.id)}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background",
                        section === item.id && "border-primary/20 text-primary",
                      )}
                    >
                      <item.Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{item.title}</span>
                      <span className="mt-0.5 hidden truncate text-[10px] text-muted-foreground md:block">
                        {item.complete
                          ? t("digitalHumans.editor.sectionComplete")
                          : t("digitalHumans.editor.sectionPending")}
                      </span>
                    </span>
                    {item.complete ? (
                      <Check
                        size={13}
                        className="hidden shrink-0 text-status-ok md:block"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        size={13}
                        className="hidden shrink-0 opacity-40 md:block"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-4 hidden rounded-lg border border-border/70 bg-background/70 p-3 md:block">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("digitalHumans.editor.overview")}
                </p>
                <p className="mt-2 truncate text-sm font-medium">
                  {label.trim() || t("digitalHumans.editor.unnamed")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("digitalHumans.editor.selectedSkillsSummary", {
                    count: selectedSkills.size,
                  })}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {portableMemory
                    ? t("digitalHumans.editor.memoryOn")
                    : t("digitalHumans.editor.memoryOff")}
                </p>
              </div>
            </nav>

            <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
              {section === "identity" ? (
                <section className="mx-auto max-w-2xl space-y-5">
                  <EditorSectionHeader
                    Icon={UserRound}
                    title={t("digitalHumans.editor.identity")}
                    description={t("digitalHumans.editor.identityDescription")}
                  />
                  <div className="space-y-1.5">
                    <Label htmlFor="digital-human-label">{t("digitalHumans.editor.name")}</Label>
                    <Input
                      id="digital-human-label"
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder={t("digitalHumans.editor.namePlaceholder")}
                      maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.label}
                      autoFocus
                    />
                    <CharacterCount value={label} max={DIGITAL_HUMAN_PROFILE_LIMITS.label} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="digital-human-summary">
                      {t("digitalHumans.editor.summary")}
                    </Label>
                    <Textarea
                      id="digital-human-summary"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={t("digitalHumans.editor.summaryPlaceholder")}
                      rows={3}
                      maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.description}
                    />
                    <CharacterCount
                      value={description}
                      max={DIGITAL_HUMAN_PROFILE_LIMITS.description}
                    />
                  </div>
                  <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                    <Label htmlFor="digital-human-id">{t("digitalHumans.editor.id")}</Label>
                    <Input
                      id="digital-human-id"
                      value={id}
                      onChange={(event) => setId(event.target.value.toLocaleLowerCase())}
                      placeholder={t("digitalHumans.editor.idPlaceholder")}
                      disabled={Boolean(profile)}
                      maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.id}
                      className="mt-2 font-mono"
                    />
                    <p
                      className={cn(
                        "mt-2 text-xs leading-5 text-muted-foreground",
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
                </section>
              ) : null}

              {section === "prompt" ? (
                <section className="mx-auto max-w-3xl space-y-5">
                  <EditorSectionHeader
                    Icon={Brain}
                    title={t("digitalHumans.editor.systemPrompt")}
                    description={t("digitalHumans.editor.systemPromptDescription")}
                  />
                  <div className="rounded-xl border border-primary/15 bg-primary/5 p-3.5">
                    <p className="text-xs font-medium">
                      {t("digitalHumans.editor.systemPromptTipTitle")}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t("digitalHumans.editor.systemPromptTip")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="digital-human-instruction">
                      {t("digitalHumans.editor.systemPromptField")}
                    </Label>
                    <Textarea
                      id="digital-human-instruction"
                      value={mainInstruction}
                      onChange={(event) => setMainInstruction(event.target.value)}
                      placeholder={t("digitalHumans.editor.instructionPlaceholder")}
                      rows={17}
                      maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction}
                      className="min-h-80 resize-y font-mono text-[13px] leading-6"
                    />
                    <CharacterCount
                      value={mainInstruction}
                      max={DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction}
                    />
                  </div>
                </section>
              ) : null}

              {section === "skills" ? (
                <section className="mx-auto max-w-2xl space-y-5">
                  <EditorSectionHeader
                    Icon={Puzzle}
                    title={t("digitalHumans.editor.skills")}
                    description={t("digitalHumans.editor.skillsDescription")}
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <EditorMetric
                      value={installedSkillCount}
                      label={t("digitalHumans.editor.skillsInstalled")}
                    />
                    <EditorMetric
                      value={installedSkillCount - disabledSkillCount}
                      label={t("digitalHumans.editor.skillsEnabled")}
                    />
                    <EditorMetric
                      value={selectedSkills.size}
                      label={t("digitalHumans.editor.skillsConfigured")}
                    />
                  </div>

                  {missingSkills.length > 0 || hasCatchAllSkillRequirement ? (
                    <div className="space-y-3 rounded-xl border border-status-warn/35 bg-status-warn/5 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-status-warn/10 text-status-warn">
                            <CircleAlert size={16} aria-hidden="true" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {hasCatchAllSkillRequirement && missingSkills.length === 0
                                ? t("digitalHumans.editor.catchAllRequirementTitle")
                                : t("digitalHumans.editor.missingSkillsTitle", {
                                    count: missingSkills.length,
                                  })}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {!profile
                                ? t("digitalHumans.editor.missingSkillsSaveFirst")
                                : !projectPath
                                  ? t("digitalHumans.editor.missingSkillsPickProject")
                                  : hasCatchAllSkillRequirement
                                    ? t("digitalHumans.editor.catchAllRequirementDescription")
                                    : missingSkillsWithoutSource.length > 0
                                      ? t("digitalHumans.editor.missingSkillsNoSource")
                                      : t("digitalHumans.editor.missingSkillsReady")}
                            </p>
                          </div>
                        </div>
                        {hasCatchAllSkillRequirement ? (
                          <Button
                            type="button"
                            size="sm"
                            className="shrink-0"
                            disabled={!canInstallMissingSkills}
                            onClick={() => void installMissingSkills()}
                          >
                            {installingRequirements ? (
                              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Download className="size-3.5" aria-hidden="true" />
                            )}
                            {installingRequirements
                              ? t("digitalHumans.editor.installingMissingSkills")
                              : hasCatchAllSkillRequirement
                                ? t("digitalHumans.editor.checkAndInstallRequirements")
                                : t("digitalHumans.editor.installMissingSkills")}
                          </Button>
                        ) : null}
                      </div>
                      {missingSkillSourceRows.length > 0 && profile ? (
                        <div className="space-y-3 border-t border-status-warn/20 pt-3">
                          <Label className="text-xs">
                            {t("digitalHumans.editor.skillSourceLabel")}
                          </Label>
                          <div className="space-y-2">
                            {missingSkillSourceRows.map((row, index) => (
                              <div
                                key={row.name}
                                className="grid gap-1.5 sm:grid-cols-[minmax(8rem,0.42fr)_1fr] sm:items-center"
                              >
                                <span
                                  className="truncate font-mono text-xs text-foreground"
                                  title={row.name}
                                >
                                  {row.name}
                                </span>
                                <Input
                                  id={
                                    index === 0
                                      ? "digital-human-skill-repo"
                                      : `digital-human-skill-repo-${index}`
                                  }
                                  value={row.value}
                                  onChange={(event) =>
                                    setSkillInstallRepos((current) => ({
                                      ...current,
                                      [row.name]: event.target.value,
                                    }))
                                  }
                                  placeholder={t("digitalHumans.editor.skillSourcePlaceholder")}
                                  className="bg-background font-mono text-xs"
                                  aria-label={t("digitalHumans.editor.skillSourceRowLabel", {
                                    name: row.name,
                                  })}
                                  aria-invalid={!row.valid}
                                />
                              </div>
                            ))}
                          </div>
                          <p
                            className={cn(
                              "text-[11px] leading-4 text-muted-foreground",
                              (!skillInstallSourcesValid || requirementLimitExceeded) &&
                                "text-status-err",
                            )}
                          >
                            {!skillInstallSourcesValid
                              ? t("digitalHumans.editor.skillSourceInvalid")
                              : requirementLimitExceeded
                                ? t("digitalHumans.editor.skillSourceLimit", {
                                    limit: DIGITAL_HUMAN_PROFILE_LIMITS.requirementCount,
                                  })
                                : t("digitalHumans.editor.skillSourceHint")}
                          </p>
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              className="shrink-0"
                              data-testid="digital-human-save-install"
                              disabled={!canSaveAndInstall}
                              onClick={() => submit(true)}
                            >
                              {installing ? (
                                <LoaderCircle
                                  className="size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Download className="size-3.5" aria-hidden="true" />
                              )}
                              {installing
                                ? t("digitalHumans.editor.installingMissingSkills")
                                : t("digitalHumans.editor.saveAndInstall")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-primary/15 bg-primary/5 p-3.5">
                    <p className="text-xs font-medium">
                      {t("digitalHumans.editor.configuredSkillsTitle")}
                    </p>
                    {selectedSkills.size === 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {t("digitalHumans.editor.configuredSkillsEmpty")}
                      </p>
                    ) : (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {[...selectedSkills]
                          .sort((a, b) => a.localeCompare(b))
                          .map((name) => (
                            <Button
                              key={name}
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="h-7 max-w-full gap-1.5 px-2"
                              onClick={() => toggleSkill(name)}
                              aria-label={t("digitalHumans.editor.removeSkill", { name })}
                            >
                              <span className="truncate">{name}</span>
                              <X size={11} aria-hidden="true" />
                            </Button>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label>{t("digitalHumans.editor.skillLibrary")}</Label>
                      <div className="flex rounded-lg border border-border/70 bg-muted/20 p-0.5">
                        <Button
                          type="button"
                          size="sm"
                          variant={skillFilter === "all" ? "secondary" : "ghost"}
                          className="h-7 px-2.5"
                          onClick={() => setSkillFilter("all")}
                        >
                          {t("digitalHumans.editor.skillFilterAll")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={skillFilter === "selected" ? "secondary" : "ghost"}
                          className="h-7 px-2.5"
                          onClick={() => setSkillFilter("selected")}
                        >
                          {t("digitalHumans.editor.skillFilterSelected", {
                            count: selectedSkills.size,
                          })}
                        </Button>
                      </div>
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
                      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                        {t("digitalHumans.editor.noSkills")}
                      </div>
                    ) : (
                      <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                        {visibleSkills.map((skill) => {
                          const selected = selectedSkills.has(skill.name);
                          const missing = missingSkillNameSet.has(skill.name);
                          const projectCopyMissing =
                            missing &&
                            projectRequirementSkillNames.has(skill.name) &&
                            installedSkillsByName.has(skill.name);
                          const invalidName =
                            skill.name.length === 0 ||
                            skill.name.length > DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName;
                          const selectionBlocked =
                            !selected && (skillAdditionBlocked || invalidName);
                          return (
                            <Button
                              key={skill.name}
                              type="button"
                              variant="outline"
                              className={cn(
                                "h-auto min-h-16 items-start justify-start rounded-lg px-3 py-2.5 text-left",
                                selected && "border-primary/40 bg-primary/5",
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
                                  <Badge
                                    variant={
                                      missing || invalidName
                                        ? "warning"
                                        : skill.enabled === false
                                          ? "secondary"
                                          : "success"
                                    }
                                  >
                                    {invalidName
                                      ? t("digitalHumans.editor.skillNameTooLong", {
                                          limit: DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName,
                                        })
                                      : missing
                                        ? t(
                                            projectCopyMissing
                                              ? "digitalHumans.editor.skillProjectNotInstalled"
                                              : "digitalHumans.editor.skillNotInstalled",
                                          )
                                        : skill.enabled === false
                                          ? t("digitalHumans.editor.skillInstalledDisabled")
                                          : t("digitalHumans.editor.skillInstalled")}
                                  </Badge>
                                  {!missing && !invalidName ? (
                                    <Badge variant="secondary">
                                      {t(`digitalHumans.editor.source.${skill.source}`)}
                                    </Badge>
                                  ) : null}
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
                  </div>

                  {projectSkills.length > 0 ? (
                    <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium">
                          {t("digitalHumans.editor.projectSkillsTitle")}
                        </p>
                        <Badge variant="secondary">{projectSkills.length}</Badge>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t("digitalHumans.editor.projectSkillsDescription")}
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {projectSkills
                          .slice()
                          .sort((left, right) => left.name.localeCompare(right.name))
                          .slice(0, 8)
                          .map((skill) => (
                            <Badge key={skill.name} variant="secondary">
                              {skill.name}
                            </Badge>
                          ))}
                        {projectSkills.length > 8 ? (
                          <Badge variant="outline">
                            {t("digitalHumans.editor.projectSkillsMore", {
                              count: projectSkills.length - 8,
                            })}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {section === "settings" ? (
                <section className="mx-auto max-w-2xl space-y-5">
                  <EditorSectionHeader
                    Icon={SlidersHorizontal}
                    title={t("digitalHumans.editor.settings")}
                    description={t("digitalHumans.editor.settingsDescription")}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ToggleCard
                      id="digital-human-memory"
                      title={t("digitalHumans.editor.memory")}
                      description={t("digitalHumans.editor.memoryDescription")}
                      checked={portableMemory}
                      onCheckedChange={setPortableMemory}
                    />
                    <ToggleCard
                      id="digital-human-exclusive"
                      title={t("digitalHumans.editor.exclusive")}
                      description={t("digitalHumans.editor.exclusiveDescription")}
                      checked={exclusiveCapabilities}
                      onCheckedChange={setExclusiveCapabilities}
                    />
                  </div>

                  {profile?.requires &&
                  (profile.requires.skills.length > 0 || profile.requires.tools.length > 0) ? (
                    <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                      <p className="text-xs font-medium text-foreground">
                        {t("digitalHumans.editor.requiresTitle")}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                        {t("digitalHumans.editor.requiresDescription")}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {profile.requires.skills.map((requirement, index) => (
                          <li
                            key={`${requirement.repo}:${index}`}
                            className="font-mono text-[11px] text-foreground"
                          >
                            {requirement.repo}
                            {requirement.skills?.length
                              ? ` · ${t("digitalHumans.editor.requiresSkillCount", {
                                  count: requirement.skills.length,
                                })}`
                              : ""}
                          </li>
                        ))}
                        {profile.requires.tools.map((tool) => (
                          <li
                            key={tool.bin}
                            className="font-mono text-[11px] text-muted-foreground"
                          >
                            {tool.bin}
                            {tool.minVersion ? ` ≥ ${tool.minVersion}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>

          <DialogFooter className="border-t border-border/70 bg-background px-5 py-3.5 sm:items-center sm:justify-between sm:px-6">
            <p className="hidden text-xs text-muted-foreground sm:block">
              {dirty
                ? t("digitalHumans.editor.unsavedChanges")
                : t("digitalHumans.editor.allChangesSaved")}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                disabled={operationBusy}
                onClick={() => requestClose(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="solid" disabled={!canSave}>
                {operationBusy
                  ? t(
                      installing || installingRequirements
                        ? "digitalHumans.editor.installingMissingSkills"
                        : "digitalHumans.editor.saving",
                    )
                  : t("digitalHumans.editor.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditorSectionHeader({
  Icon,
  title,
  description,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/60 pb-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon size={16} aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function EditorMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/15 px-3 py-2.5">
      <p className="text-lg font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function ToggleCard({
  id,
  title,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-28 flex-col justify-between rounded-xl border p-4 transition-colors",
        checked ? "border-primary/30 bg-primary/5" : "border-border/70 bg-muted/15",
      )}
    >
      <div>
        <Label htmlFor={id}>{title}</Label>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="mt-3 flex justify-end">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
    </div>
  );
}
