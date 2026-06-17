import React from "react";
import { ExternalLink, FolderOpen, Code2, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import {
  openDefault,
  revealInFolder,
  openInEditor,
  type OpenTarget,
} from "./openWith";

interface Props extends OpenTarget {
  /**
   * Custom trigger. When given it's wrapped with `asChild` so e.g. a file card
   * becomes the menu trigger. Omit to get a default "⋯" icon button.
   */
  children?: React.ReactNode;
  align?: "start" | "end" | "center";
}

/**
 * Reusable "open with" menu for any file reference — system default / reveal in
 * folder / open in editor. Shared by file cards, diffs, panels, and assistant
 * file links so the open behavior is implemented once (TODO 2.2/2.3).
 */
export function OpenWithMenu({ path, cwd, children, align = "start" }: Props) {
  const target: OpenTarget = { path, cwd };
  const toast = useToast();
  const { t } = useT();
  // These file actions can fail in main (e.g. the path was deleted/renamed
  // since the message referenced it). Surface a toast so the action never
  // silently no-ops.
  const run = (label: string, action: () => Promise<unknown>): void => {
    void action().catch((e) =>
      toast({
        message: t("chat.openWith.actionFailed", {
          label,
          message: e instanceof Error ? e.message : String(e),
        }),
        variant: "error",
      }),
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children ?? (
          <Button size="icon" variant="ghost" title={t("chat.openWith.trigger")} aria-label={t("chat.openWith.trigger")}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onSelect={() => run(t("chat.openWith.actionOpen"), () => openDefault(target))}>
          <ExternalLink className="mr-2 h-3.5 w-3.5" /> {t("chat.openWith.openDefault")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(t("chat.openWith.actionEditor"), () => openInEditor(target))}>
          <Code2 className="mr-2 h-3.5 w-3.5" /> {t("chat.openWith.openInEditor")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run(t("chat.openWith.actionReveal"), () => revealInFolder(target))}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" /> {t("chat.openWith.revealInFolder")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
