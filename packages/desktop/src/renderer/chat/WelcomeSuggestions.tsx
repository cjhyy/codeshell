import React from "react";
import { ArrowUpRight, FolderSearch, GitCompareArrows, ListChecks, Lightbulb } from "lucide-react";
import { useT } from "../i18n";

/** Starter prompts are editable drafts; selecting one never starts a run. */
export function WelcomeSuggestions({
  hasProject,
  disabled,
  onSelect,
}: {
  hasProject: boolean;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  const { t } = useT();
  const suggestions = [
    {
      Icon: hasProject ? FolderSearch : Lightbulb,
      title: t(hasProject ? "chat.starters.projectTitle" : "chat.starters.ideaTitle"),
      description: t(
        hasProject ? "chat.starters.projectDescription" : "chat.starters.ideaDescription",
      ),
      prompt: t(hasProject ? "chat.starters.projectPrompt" : "chat.starters.ideaPrompt"),
    },
    {
      Icon: ListChecks,
      title: t("chat.starters.planTitle"),
      description: t("chat.starters.planDescription"),
      prompt: t("chat.starters.planPrompt"),
    },
    {
      Icon: GitCompareArrows,
      title: t("chat.starters.compareTitle"),
      description: t("chat.starters.compareDescription"),
      prompt: t("chat.starters.comparePrompt"),
    },
  ];

  return (
    <div className="cs-welcome-suggestions" role="group" aria-label={t("chat.starters.label")}>
      {suggestions.map(({ Icon, title, description, prompt }) => (
        <button
          key={title}
          type="button"
          className="cs-welcome-suggestion group"
          disabled={disabled}
          onClick={() => onSelect(prompt)}
        >
          <span className="flex items-center justify-between gap-2">
            <Icon size={16} className="text-muted-foreground" aria-hidden="true" />
            <ArrowUpRight
              size={13}
              className="text-muted-foreground/60 group-hover:text-primary group-focus-visible:text-primary"
              aria-hidden="true"
            />
          </span>
          <span className="mt-3 block text-xs font-medium text-foreground">{title}</span>
          <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        </button>
      ))}
    </div>
  );
}
