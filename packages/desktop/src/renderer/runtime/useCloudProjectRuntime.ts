import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { CloudProjectRuntime, type CloudRuntimeSnapshot } from "./CloudProjectRuntime";

export type CloudProjectRuntimeView = CloudRuntimeSnapshot & {
  selectSession: (id: string) => void;
  newSession: () => void;
  setDraft: (update: string | ((previous: string) => string)) => void;
  setModel: (model: string) => void;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  approve: (id: string, approved: boolean, answer?: string, reason?: string) => Promise<void>;
  addFiles: (files: File[]) => Promise<void>;
  removeUpload: (id: string) => void;
  refresh: () => Promise<void>;
  reconnect: () => Promise<void>;
  start: () => Promise<void>;
};
const emptySubscribe = () => () => undefined;
const emptySnapshot = () => null;

/** Per-binding memory survives switching projects/local mode without touching local chats. */
export function useCloudProjectRuntime(
  binding: CloudProjectBinding | null,
): CloudProjectRuntimeView | null {
  const controllers = useRef(new Map<string, CloudProjectRuntime>());
  let controller: CloudProjectRuntime | null = null;
  if (binding) {
    controller = controllers.current.get(binding.id) ?? null;
    if (!controller) {
      controller = new CloudProjectRuntime(binding, window.codeshell.cloudEnvironment);
      controllers.current.set(binding.id, controller);
    }
  }
  const state = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? emptySnapshot,
    controller?.getSnapshot ?? emptySnapshot,
  );
  useEffect(() => {
    if (!controller) return;
    void controller.connect();
    return () => controller.disconnect();
  }, [controller]);
  useEffect(() => {
    const cache = controllers.current;
    return () => {
      for (const runtime of cache.values()) runtime.disconnect();
    };
  }, []);
  return controller && state
    ? {
        ...state,
        selectSession: controller.selectSession,
        newSession: controller.newSession,
        setDraft: controller.setDraft,
        setModel: controller.setModel,
        send: controller.send,
        stop: controller.stop,
        approve: controller.approve,
        addFiles: controller.addFiles,
        removeUpload: controller.removeUpload,
        refresh: controller.refresh,
        reconnect: controller.reconnect,
        start: controller.start,
      }
    : null;
}
