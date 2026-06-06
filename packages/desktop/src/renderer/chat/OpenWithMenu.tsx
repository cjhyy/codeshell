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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children ?? (
          <Button size="icon" variant="ghost" title="打开方式" aria-label="打开方式">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onSelect={() => void openDefault(target)}>
          <ExternalLink className="mr-2 h-3.5 w-3.5" /> 用系统默认应用打开
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openInEditor(target)}>
          <Code2 className="mr-2 h-3.5 w-3.5" /> 用编辑器打开
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void revealInFolder(target)}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" /> 在文件夹中显示
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
