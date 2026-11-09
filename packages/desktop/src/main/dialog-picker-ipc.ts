import { dialog, ipcMain } from "electron";
import { basename, extname } from "node:path";

/** Native file/directory pickers for skills, plugins, Panel Apps and the git binary. */
export function registerDialogPickerIpc() {
  ipcMain.handle(
    "dialog:pickSkillDir",
    async (): Promise<{ path: string; name: string } | null> => {
      const res = await dialog.showOpenDialog({
        title: "选择 Skill 文件夹",
        properties: ["openDirectory"],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const selected = res.filePaths[0];
      return { path: selected, name: basename(selected) };
    },
  );

  ipcMain.handle(
    "dialog:pickPluginSource",
    async (
      _e,
      kind: "dir" | "zip",
    ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null> => {
      const res =
        kind === "zip"
          ? await dialog.showOpenDialog({
              title: "选择插件压缩包",
              properties: ["openFile"],
              filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
            })
          : await dialog.showOpenDialog({
              title: "选择插件文件夹",
              properties: ["openDirectory"],
            });
      if (res.canceled || res.filePaths.length === 0) return null;
      const selected = res.filePaths[0];
      // For a zip, strip the ".zip" extension so the derived name matches the
      // installed plugin name (e.g. "mimi-video-0.2.0.zip" → "mimi-video-0.2.0").
      // The picker name is only a hint for the UI's same-name pre-check; core
      // still derives the authoritative name from the plugin manifest at install.
      const name = kind === "zip" ? basename(selected, extname(selected)) : basename(selected);
      return { kind, path: selected, name };
    },
  );

  ipcMain.handle(
    "dialog:pickPanelAppSource",
    async (
      _e,
      kind: "dir" | "zip",
    ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null> => {
      const result =
        kind === "zip"
          ? await dialog.showOpenDialog({
              title: "选择 Panel App 压缩包",
              properties: ["openFile"],
              filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
            })
          : await dialog.showOpenDialog({
              title: "选择 Panel App 文件夹",
              properties: ["openDirectory"],
            });
      if (result.canceled || result.filePaths.length === 0) return null;
      const selected = result.filePaths[0];
      const name = kind === "zip" ? basename(selected, extname(selected)) : basename(selected);
      return { kind, path: selected, name };
    },
  );

  ipcMain.handle("dialog:pickGitBinary", async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: "选择 git 可执行文件",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [
              { name: "可执行文件", extensions: ["exe"] },
              { name: "所有文件", extensions: ["*"] },
            ]
          : [{ name: "所有文件", extensions: ["*"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
}
