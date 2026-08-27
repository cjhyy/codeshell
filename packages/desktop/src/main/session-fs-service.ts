import { fileExists, readDirectory, readFile } from "./fs-service.js";
import { requireSessionFileRootForUi } from "./session-workspace-service.js";

export async function readSessionDirectoryForUi(sessionId: string, rootId: string, dir?: string) {
  const root = await requireSessionFileRootForUi(sessionId, rootId);
  return readDirectory(root, typeof dir === "string" && dir ? dir : root);
}

export async function readSessionFileForUi(sessionId: string, rootId: string, path: string) {
  if (typeof path !== "string" || !path) throw new Error("fsSession:readFile requires path");
  const root = await requireSessionFileRootForUi(sessionId, rootId);
  return readFile(root, path);
}

export async function sessionFileExistsForUi(
  sessionId: string,
  rootId: string,
  path: string,
): Promise<boolean> {
  if (typeof path !== "string" || !path) return false;
  try {
    const root = await requireSessionFileRootForUi(sessionId, rootId);
    return await fileExists(root, path);
  } catch {
    return false;
  }
}
