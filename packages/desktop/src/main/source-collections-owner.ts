interface OwnedFrame {
  processId: number;
  routingId: number;
  isDestroyed(): boolean;
}
interface OwnedSender {
  mainFrame: OwnedFrame;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** The owner is captured once; a new frame can never inherit an outstanding picker/download. */
export function captureSourceCollectionOwner(input: {
  owner: { isDestroyed(): boolean };
  sender: OwnedSender;
  frame: OwnedFrame;
  isMainWindow(): boolean;
}) {
  const { owner, sender, frame } = input;
  const processId = frame.processId,
    routingId = frame.routingId;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("资料集窗口已关闭或导航。"));
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) abort();
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (
      owner.isDestroyed() ||
      sender.isDestroyed() ||
      !input.isMainWindow() ||
      sender.mainFrame !== frame ||
      frame.isDestroyed() ||
      frame.processId !== processId ||
      frame.routingId !== routingId
    )
      throw new Error("资料集窗口已失效，请重新打开设置。");
  };
  assertCurrent();
  sender.on("destroyed", abort);
  sender.on("render-process-gone", abort);
  sender.on("did-start-navigation", onNavigation);
  return {
    signal: controller.signal,
    assertCurrent,
    dispose() {
      sender.removeListener("destroyed", abort);
      sender.removeListener("render-process-gone", abort);
      sender.removeListener("did-start-navigation", onNavigation);
    },
  };
}
