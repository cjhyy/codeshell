import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PetApi, PetOpenSessionRequest } from "../../preload/types";
import type { PanelBucketState } from "../app/appUtils";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { nextOpenCliSessionNonce } from "../cc-room/openCliSession";
import type { useT } from "../i18n/I18nProvider";
import type { useToast } from "../ui/ToastProvider";
import type { ViewState } from "../view";
import { openPetTarget } from "./petNavigation";

interface Params {
  api: PetApi;
  activeBucketRef: RefObject<string>;
  updatePanelBucket(bucket: string, update: (state: PanelBucketState) => PanelBucketState): void;
  setView: Dispatch<SetStateAction<ViewState>>;
  isNarrowWindow: boolean;
  markViewedPetCompletions(sessionId?: string): void;
  openDiskSession(session: DiskSessionMeta): Promise<void>;
  toast: ReturnType<typeof useToast>;
  t: ReturnType<typeof useT>["t"];
}

/** Shared original-session route for Mimi and Task Center, including observed external CLIs. */
export function createPetTargetNavigator({
  api,
  activeBucketRef,
  updatePanelBucket,
  setView,
  isNarrowWindow,
  markViewedPetCompletions,
  openDiskSession,
  toast,
  t,
}: Params) {
  return async (request: PetOpenSessionRequest): Promise<boolean> => {
    if (request.external) {
      const { cli, cwd, sessionId } = request.external;
      if ((cli !== "claude" && cli !== "codex") || !cwd.trim() || !sessionId.trim()) {
        toast({ message: t("pet.navigation.externalUnavailable"), variant: "error" });
        return false;
      }
      const nonce = nextOpenCliSessionNonce();
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        openCliSession: {
          nonce,
          externalSessionId: sessionId,
          cliKind: cli === "claude" ? "claude-code" : "codex",
          cwd,
        },
        requestNonce: state.requestNonce + 1,
        requestKind: "ccRoom",
      }));
      setView((current) => ({
        ...current,
        viewMode: "chat",
        sidebarCollapsed: isNarrowWindow ? current.sidebarCollapsed : false,
      }));
      markViewedPetCompletions(request.agentSessionId);
      return true;
    }
    return openPetTarget(api, request, {
      select: async (target) => {
        await openDiskSession({
          id: target.uiSessionId,
          engineSessionId: target.engineSessionId,
          cwd: target.projectPath ?? "",
          title: target.title,
          updatedAt: target.updatedAt,
          origin: target.origin,
        });
        markViewedPetCompletions(request.agentSessionId);
      },
      onStale: () => toast({ message: t("pet.navigation.stale"), variant: "default" }),
      onNotFound: () => toast({ message: t("pet.navigation.notFound"), variant: "error" }),
    });
  };
}
