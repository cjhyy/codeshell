import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
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
  type Owner = { id: number; frame: WebFrameMain; processId: number; routingId: number };
  const frames = new WeakMap<WebContents, Owner>();
  const generations = new Map<number, object>();
  const owner = (event: IpcMainInvokeEvent): Owner => {
    const frame = event.senderFrame;
    if (
      event.sender.isDestroyed() ||
      !frame ||
      frame !== event.sender.mainFrame ||
      frame.isDestroyed() ||
      !isMainWindow(event.sender)
    )
      throw new Error("memory promotion requires the Desktop main window");
    let current = frames.get(event.sender);
    if (
      current &&
      (current.frame !== frame ||
        current.processId !== frame.processId ||
        current.routingId !== frame.routingId)
    ) {
      reviews.clearOwner(event.sender.id);
      generations.delete(event.sender.id);
      current = undefined;
    }
    if (!current) {
      current = {
        id: event.sender.id,
        frame,
        processId: frame.processId,
        routingId: frame.routingId,
      };
      frames.set(event.sender, current);
    }
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      const id = event.sender.id;
      const invalidate = () => {
        reviews.clearOwner(id);
        generations.delete(id);
        frames.delete(event.sender);
      };
      event.sender.once("destroyed", invalidate);
      event.sender.on("render-process-gone", invalidate);
      event.sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) invalidate();
      });
    }
    return current;
  };
  const assertOwner = (event: IpcMainInvokeEvent, expected: Owner): void => {
    if (owner(event) !== expected) throw new Error("memory review window changed");
  };
  ipcMain.handle("memory:previewProfilePromotion", async (event, value: unknown) => {
    const binding = owner(event);
    const id = binding.id;
    const input = parseMemoryPromotionPreview(value);
    const generation = {};
    generations.set(id, generation);
    reviews.clearOwner(id);
    const cwd = await requireProjectPath(input.cwd);
    assertOwner(event, binding);
    if (generations.get(id) !== generation) throw new Error("memory review was superseded");
    return reviews.preview(id, { ...input, cwd });
  });
  ipcMain.handle("memory:commitProfilePromotion", async (event, value: unknown) => {
    const binding = owner(event);
    const id = binding.id;
    const input = parseMemoryPromotionCommit(value);
    const generation = generations.get(id);
    try {
      const cwd = await requireProjectPath(input.cwd);
      assertOwner(event, binding);
      return reviews.commit(id, { ...input, cwd });
    } catch (error) {
      // Revoked project authority also invalidates its pending review.
      if (frames.get(event.sender) === binding && generations.get(id) === generation)
        reviews.clearOwner(id);
      throw error;
    }
  });
}
