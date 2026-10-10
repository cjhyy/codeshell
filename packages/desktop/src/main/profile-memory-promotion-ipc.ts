import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  ProfileMemoryPromotionReviews,
  parseMemoryPromotionCommit,
  parseMemoryPromotionPreview,
} from "./profile-memory-promotion-service.js";

export function registerProfileMemoryPromotionIpc(
  ipcMain: Pick<IpcMain, "handle">,
  isMainWindow: (sender: WebContents) => boolean,
  requireProjectPath: (cwd: unknown) => Promise<string>,
): void {
  const reviews = new ProfileMemoryPromotionReviews();
  const observed = new WeakSet<WebContents>();
  const frames = new WeakMap<WebContents, unknown>();
  const generations = new Map<number, number>();
  const owner = (event: IpcMainInvokeEvent): number => {
    if (
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !isMainWindow(event.sender)
    )
      throw new Error("memory promotion requires the Desktop main window");
    if (frames.has(event.sender) && frames.get(event.sender) !== event.senderFrame) {
      reviews.clearOwner(event.sender.id);
      generations.delete(event.sender.id);
    }
    frames.set(event.sender, event.senderFrame);
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      const id = event.sender.id;
      event.sender.once("destroyed", () => {
        reviews.clearOwner(id);
        generations.delete(id);
      });
    }
    return event.sender.id;
  };
  ipcMain.handle("memory:previewProfilePromotion", async (event, value: unknown) => {
    const id = owner(event);
    const input = parseMemoryPromotionPreview(value);
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    reviews.clearOwner(id);
    const cwd = await requireProjectPath(input.cwd);
    owner(event);
    if (generations.get(id) !== generation) throw new Error("memory review was superseded");
    return reviews.preview(id, { ...input, cwd });
  });
  ipcMain.handle("memory:commitProfilePromotion", async (event, value: unknown) => {
    const id = owner(event);
    const input = parseMemoryPromotionCommit(value);
    try {
      const cwd = await requireProjectPath(input.cwd);
      owner(event);
      return reviews.commit(id, { ...input, cwd });
    } catch (error) {
      // Revoked project authority also invalidates its pending review.
      reviews.clearOwner(id);
      throw error;
    }
  });
}
