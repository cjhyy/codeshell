import type {
  ProfileMemoryPromotionReview,
  ProfileMemoryPromotionResult,
  PreviewProfileMemoryPromotionInput,
  CommitProfileMemoryPromotionInput,
} from "../shared/profile-memory-promotion.js";
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import {
  parseMemoryPromotionCommit,
  parseMemoryPromotionPreview,
} from "./profile-memory-promotion-service.js";

export function registerProfileMemoryPromotionIpc(
  ipcMain: Pick<IpcMain, "handle">,
  isMainWindow: (sender: WebContents) => boolean,
  requireProjectPath: (cwd: unknown) => Promise<string>,
  reviews: {
    documentSignal(event: IpcMainInvokeEvent): AbortSignal;
    preview(
      owner: number,
      value: PreviewProfileMemoryPromotionInput,
      signal: AbortSignal,
    ): Promise<ProfileMemoryPromotionReview>;
    commit(
      owner: number,
      value: CommitProfileMemoryPromotionInput,
      signal: AbortSignal,
    ): Promise<ProfileMemoryPromotionResult>;
    clearOwner(owner: number): void;
  },
): void {
  let nextOwnerId = 0;
  const observed = new WeakSet<WebContents>();
  type Owner = { id: number; frame: WebFrameMain; processId: number; routingId: number };
  const frames = new WeakMap<WebContents, Owner>();
  const generations = new Map<
    number,
    { owner: number; controller: AbortController; committing: boolean }
  >();
  const clear = (id: number) => {
    const generation = generations.get(id);
    if (!generation) return;
    generation.controller.abort();
    generations.delete(id);
    reviews.clearOwner(generation.owner);
  };
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
      clear(current.id);
      current = undefined;
    }
    if (!current) {
      current = {
        id: ++nextOwnerId,
        frame,
        processId: frame.processId,
        routingId: frame.routingId,
      };
      frames.set(event.sender, current);
    }
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      const invalidate = () => {
        const binding = frames.get(event.sender);
        if (binding) clear(binding.id);
        frames.delete(event.sender);
      };
      event.sender.once("destroyed", invalidate);
      event.sender.on("render-process-gone", invalidate);
      event.sender.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) invalidate();
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
    const document = reviews.documentSignal(event);
    const input = parseMemoryPromotionPreview(value);
    clear(id);
    const generation = {
      owner: ++nextOwnerId,
      controller: new AbortController(),
      committing: false,
    };
    generations.set(id, generation);
    const cwd = await requireProjectPath(input.cwd);
    assertOwner(event, binding);
    if (generations.get(id) !== generation) throw new Error("memory review was superseded");
    return reviews.preview(
      generation.owner,
      { ...input, cwd },
      AbortSignal.any([document, generation.controller.signal]),
    );
  });
  ipcMain.handle("memory:commitProfilePromotion", async (event, value: unknown) => {
    const binding = owner(event);
    const id = binding.id;
    const document = reviews.documentSignal(event);
    const input = parseMemoryPromotionCommit(value);
    const generation = generations.get(id);
    if (generation?.committing) throw new Error("memory promotion review already in progress");
    if (generation) generation.committing = true;
    try {
      const cwd = await requireProjectPath(input.cwd);
      assertOwner(event, binding);
      if (!generation || generation !== generations.get(id))
        throw new Error("memory promotion review expired");
      return await reviews.commit(
        generation.owner,
        { ...input, cwd },
        AbortSignal.any([document, generation.controller.signal]),
      );
    } finally {
      // A reviewed token is single use, including failed commits.
      if (frames.get(event.sender) === binding && generations.get(id) === generation) clear(id);
    }
  });
}
