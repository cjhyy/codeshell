import type { OpenDialogOptions } from "electron";
import type { ThemeImportKind } from "../shared/theme-packs.js";

/** File and directory picking stay separate for native dialogs on every platform. */
export function themeImportDialogOptions(input?: unknown): OpenDialogOptions {
  if (input !== undefined && input !== "zip" && input !== "directory") {
    throw new Error("themes:pickAndPreview requires zip or directory");
  }
  const kind: ThemeImportKind = input ?? "zip";
  return kind === "directory"
    ? { title: "选择已解压的主题包目录", properties: ["openDirectory"] }
    : {
        title: "选择主题包 ZIP 文件",
        properties: ["openFile"],
        filters: [{ name: "主题包 ZIP", extensions: ["zip"] }],
      };
}
