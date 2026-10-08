import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "../i18n";
import { DIGITAL_HUMAN_PROFILE_LIMITS } from "./types";
import {
  validateDigitalHumanRequirements,
  type DigitalHumanRequirements,
  type RequirementError,
} from "./requirementsEditor";

export function DigitalHumanRequirementsEditor({
  value,
  disabled,
  onChange,
}: {
  value: DigitalHumanRequirements;
  disabled: boolean;
  onChange: (value: DigitalHumanRequirements) => void;
}) {
  const { t } = useT();
  const validation = validateDigitalHumanRequirements(value);
  const limits = DIGITAL_HUMAN_PROFILE_LIMITS;
  const updateSkill = (index: number, patch: Partial<DigitalHumanRequirements["skills"][number]>) =>
    onChange({
      ...value,
      skills: value.skills.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    });
  const updateTool = (index: number, patch: Partial<DigitalHumanRequirements["tools"][number]>) =>
    onChange({
      ...value,
      tools: value.tools.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    });
  const errorMessage = (error: RequirementError | null) =>
    error ? (
      <p role="alert" className="text-xs text-status-err">
        {t(`digitalHumans.editor.requirementError.${error}`)}
      </p>
    ) : null;

  return (
    <fieldset disabled={disabled} className="space-y-5 rounded-xl border border-border/70 p-4">
      <div>
        <p className="text-sm font-medium">{t("digitalHumans.editor.requiresTitle")}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("digitalHumans.editor.requiresDescription")}
        </p>
      </div>
      {validation.countExceeded ? (
        <p role="alert" className="text-xs text-status-err">
          {t("digitalHumans.editor.requirementLimit", { limit: limits.requirementCount })}
        </p>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{t("digitalHumans.editor.skillRequirements")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="requirement-add-repository"
            disabled={disabled || value.skills.length >= limits.requirementCount}
            onClick={() =>
              onChange({
                ...value,
                skills: [
                  ...value.skills,
                  { source: "github", repo: "", scope: "project", fullDepth: false },
                ],
              })
            }
          >
            <Plus size={13} aria-hidden="true" />
            {t("digitalHumans.editor.addSkillRequirement")}
          </Button>
        </div>
        {value.skills.map((requirement, index) => {
          const rowId = `requirement-repository-${index}`;
          const allSkills = !requirement.skills?.length;
          return (
            <div
              key={index}
              className="space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3"
            >
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor={rowId}>{t("digitalHumans.editor.skillSourceLabel")}</Label>
                  <Input
                    id={rowId}
                    value={requirement.repo}
                    placeholder="owner/repo"
                    className="font-mono text-xs"
                    aria-invalid={validation.skills[index] === "repository"}
                    onChange={(event) => updateSkill(index, { repo: event.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  data-testid={`requirement-remove-repository-${index}`}
                  aria-label={t("digitalHumans.editor.removeSkillRequirement", {
                    index: index + 1,
                  })}
                  onClick={() =>
                    onChange({ ...value, skills: value.skills.filter((_, row) => row !== index) })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`${rowId}-all`} className="text-xs">
                  {t("digitalHumans.editor.requirementAllSkills")}
                </Label>
                <Switch
                  id={`${rowId}-all`}
                  checked={allSkills}
                  onCheckedChange={(checked) =>
                    updateSkill(index, { skills: checked ? undefined : [""] })
                  }
                />
              </div>
              {!allSkills ? (
                <div className="space-y-2">
                  {requirement.skills!.map((name, skillIndex) => (
                    <div key={skillIndex} className="flex items-center gap-2">
                      <Input
                        id={`${rowId}-skill-${skillIndex}`}
                        value={name}
                        maxLength={limits.capabilityName}
                        className="font-mono text-xs"
                        placeholder={t("digitalHumans.editor.requirementSkillName")}
                        aria-label={t("digitalHumans.editor.requirementSkillName")}
                        aria-invalid={validation.skills[index] === "skillNames"}
                        onChange={(event) =>
                          updateSkill(index, {
                            skills: requirement.skills!.map((skill, row) =>
                              row === skillIndex ? event.target.value : skill,
                            ),
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={t("digitalHumans.editor.removeRequirementSkill", { name })}
                        onClick={() =>
                          updateSkill(index, {
                            skills:
                              requirement.skills!.length === 1
                                ? [""]
                                : requirement.skills!.filter((_, row) => row !== skillIndex),
                          })
                        }
                      >
                        <X size={13} aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`${rowId}-add-skill`}
                    disabled={disabled || requirement.skills!.length >= limits.capabilityCount}
                    onClick={() => updateSkill(index, { skills: [...requirement.skills!, ""] })}
                  >
                    <Plus size={13} aria-hidden="true" />
                    {t("digitalHumans.editor.addRequirementSkill")}
                  </Button>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`${rowId}-depth`} className="text-xs">
                  {t("digitalHumans.editor.requirementFullDepth")}
                </Label>
                <Switch
                  id={`${rowId}-depth`}
                  checked={requirement.fullDepth}
                  onCheckedChange={(fullDepth) => updateSkill(index, { fullDepth })}
                />
              </div>
              {errorMessage(validation.skills[index])}
            </div>
          );
        })}
      </div>
      <div className="space-y-3 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{t("digitalHumans.editor.toolRequirements")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="requirement-add-tool"
            disabled={disabled || value.tools.length >= limits.requirementCount}
            onClick={() => onChange({ ...value, tools: [...value.tools, { bin: "" }] })}
          >
            <Plus size={13} aria-hidden="true" />
            {t("digitalHumans.editor.addToolRequirement")}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("digitalHumans.editor.toolRequirementsHint")}
        </p>
        {value.tools.map((tool, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`requirement-tool-${index}`}>
                  {t("digitalHumans.editor.toolBinary")}
                </Label>
                <Input
                  id={`requirement-tool-${index}`}
                  value={tool.bin}
                  maxLength={limits.capabilityName}
                  placeholder="ffmpeg"
                  className="font-mono text-xs"
                  aria-invalid={validation.tools[index] === "binary"}
                  onChange={(event) => updateTool(index, { bin: event.target.value })}
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-testid={`requirement-remove-tool-${index}`}
                aria-label={t("digitalHumans.editor.removeToolRequirement", { index: index + 1 })}
                onClick={() =>
                  onChange({ ...value, tools: value.tools.filter((_, row) => row !== index) })
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`requirement-tool-version-${index}`}>
                {t("digitalHumans.editor.toolVersion")}
              </Label>
              <Input
                id={`requirement-tool-version-${index}`}
                value={tool.minVersion ?? ""}
                placeholder="22.1.0"
                className="font-mono text-xs"
                aria-invalid={validation.tools[index] === "version"}
                onChange={(event) =>
                  updateTool(index, { minVersion: event.target.value || undefined })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`requirement-tool-hint-${index}`}>
                {t("digitalHumans.editor.toolHint")}
              </Label>
              <Input
                id={`requirement-tool-hint-${index}`}
                value={tool.hint ?? ""}
                maxLength={limits.capabilityName}
                aria-invalid={validation.tools[index] === "hint"}
                onChange={(event) => updateTool(index, { hint: event.target.value || undefined })}
              />
            </div>
            {errorMessage(validation.tools[index])}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
