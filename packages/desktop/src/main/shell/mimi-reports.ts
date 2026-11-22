import { AgentBridge } from "../agent-bridge.js";
import { broadcastPetChatTranscriptUpdated, PET_CHAT_EVENT_CHANNEL } from "../pet/pet-ipc.js";
import { completePetHostActionReceipt } from "../pet/pet-host-action-completion.js";
import type { PetHostActionExecution } from "../pet/pet-dispatch-service.js";
import { PetWorkDelegationHost } from "../pet/pet-work-delegation-host.js";
import { type PetNoticeWiring } from "../pet/pet-notice-wiring.js";
import { recordPetDelegationClosureBestEffort } from "../pet/pet-delegation-closure.js";
import { createExternalRuntimeHostSubmission } from "../external-runtime-host-submission.js";
import { createPetRuntimeControlWorker } from "../pet/pet-runtime-control-worker.js";
import { dlog } from "../desktop-logger.js";
import type {
  MimiShellOptions,
  NativeMimiHost,
  MimiTurnStores,
  MimiSegments,
  MimiReportEndpoints,
} from "./mimi-shell-types.js";
export function connectMimiTasks({
  longTaskStore,
  bridge,
  imExternalSubmissions,
  options,
  petWorkDelegationHost,
  notices,
  reports,
  segments,
}: {
  longTaskStore: NativeMimiHost["mimiTasks"];
  bridge: AgentBridge;
  imExternalSubmissions: Pick<ReturnType<typeof createExternalRuntimeHostSubmission>, "isExternal">;
  options: Pick<MimiShellOptions, "externalRuntime">;
  petWorkDelegationHost: PetWorkDelegationHost;
  notices: PetNoticeWiring;
  reports: MimiReportEndpoints;
  segments: MimiSegments;
}) {
  return longTaskStore.configure({
    worker: createPetRuntimeControlWorker({
      worker: bridge,
      isExternal: imExternalSubmissions.isExternal,
      service: () => options.externalRuntime.service,
    }),
    launcher: petWorkDelegationHost,
    onDelegationStarted: (task) => notices.armDelegationRule(task),
    onTaskClosed: async (task) => {
      let message: string | undefined;
      let continued = false;
      let closureHostActions: PetHostActionExecution[] | undefined;
      try {
        if (reports.dispatcher) {
          const report = await reports.dispatcher.reportLongTaskClosure(task);
          message = report.text;
          continued = report.continued;
          closureHostActions = report.hostActions;
          // The closure manager runs outside the renderer-initiated chat IPC.
          // Its stream is owner-window scoped, so other open Mimi surfaces can
          // miss the final assistant reply even though it is durable on disk.
          // Invalidate every window after agent/run settles; each renderer
          // rehydrates the canonical transcript and naturally deduplicates a
          // reply it already received through the live stream.
          broadcastPetChatTranscriptUpdated(reports.windows(), {
            taskId: task.id,
          });
        }
      } catch (error) {
        // The notice router still templates a result from the task's facts
        // when Mimi cannot compose one (for example while the worker restarts).
        dlog("main", "pet.longTask.reply.failed", { error: String(error), taskId: task.id });
      }

      // A successful continuation is an internal manager hand-off. Otherwise
      // the closure's GatewayReply is a DRAFT (text + validated files/button):
      // the router delivers it as the one owner-facing message for the chain.
      if (continued) return;
      const enriched =
        message === undefined
          ? undefined
          : await reports.render(message, closureHostActions, {
              attachmentKinds: task.completionTarget?.replyAttachmentKinds,
            });
      // The closure manager's final assistant text is only an internal
      // acknowledgement after GatewayReply; show the routed body instead.
      const draftAccepted = closureHostActions?.some(
        (execution) => execution.kind === "gatewayReply" && execution.ok,
      );
      if (draftAccepted && enriched && task.completionTarget && reports.receipts) {
        await completePetHostActionReceipt({
          recorder: reports.receipts,
          input: {
            petSessionId: await reports.dispatcher!.getSessionId(),
            clientMessageId: task.originClientMessageId,
            receiptId: `${task.id}:${task.attempt}:${task.status}`,
            executions: closureHostActions ?? [],
            authoritativeMessage: enriched.text,
            replaceAssistant: true,
            deliveryChannel: task.completionTarget.channel,
          },
          publish: (receiptEvent) => {
            for (const window of reports.windows()) {
              if (!window.isDestroyed())
                window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
            }
          },
        }).catch((error) =>
          dlog("main", "pet.longTask.gatewayReceipt.failed", {
            taskId: task.id,
            error: String(error),
          }),
        );
      }
      await notices.notifyTaskClosed(task, {
        ...(enriched ? { text: enriched.text } : {}),
        ...(enriched && (enriched.button || enriched.attachments.length > 0)
          ? {
              media: {
                ...(enriched.button ? { button: enriched.button } : {}),
                ...(enriched.attachments.length > 0 ? { attachments: enriched.attachments } : {}),
              },
            }
          : {}),
      });
    },
    onTaskWorkMemory: async (task) => {
      const recorded = await recordPetDelegationClosureBestEffort(
        segments.controller,
        {
          dedupeKey: `${task.id}:${task.attempt}:${task.status}`,
          objective: task.objective,
          outcome: task.status === "completed" ? "completed" : "failed",
          ...(task.workspacePath ? { workspace: task.workspacePath } : {}),
          sessionRef: task.sessionId,
        },
        (error) =>
          dlog("main", "pet.longTask.memory.failed", { taskId: task.id, error: String(error) }),
      );
      if (!recorded) throw new Error("Pet work-memory distillation remains pending");
    },
    onBackgroundError: (operation, error) => {
      dlog("main", `pet.longTask.${operation}.failed`, { error: String(error) });
    },
  });
}

export function subscribeMimiReports({
  bridge,
  longTaskStore,
  reports,
  turnStores,
  notices,
}: {
  bridge: AgentBridge;
  longTaskStore: NativeMimiHost["mimiTasks"];
  reports: MimiReportEndpoints;
  turnStores: MimiTurnStores;
  notices: PetNoticeWiring;
}) {
  const processingPetReports = new Set<string>();
  const deliveredPetReports = turnStores.reports;
  return bridge.subscribePetReports(async (event) => {
    if (processingPetReports.has(event.reportId)) return;
    processingPetReports.add(event.reportId);
    try {
      if (await deliveredPetReports.has(event.reportId)) return;
      const task = await longTaskStore.activeForSession(event.sessionId);
      if (!reports.dispatcher) throw new Error("Mimi dispatch service is unavailable");
      const report = await reports.dispatcher.reportSessionMessage(
        {
          sourceSessionId: event.sessionId,
          reportId: event.reportId,
          message: event.message,
          ...(event.attachmentPaths ? { attachmentPaths: event.attachmentPaths } : {}),
          ...(event.deliveryRequest ? { deliveryRequest: event.deliveryRequest } : {}),
        },
        task,
      );
      if (!event.deliveryRequest) {
        // Mimi's draft for an IM-started task's origin; the delivery plan
        // names everyone else, and the router sends (quiet hours, caps, digest).
        const enriched = report.routedToOrigin
          ? await reports.render(report.text, report.hostActions, {
              attachmentKinds: task?.completionTarget?.replyAttachmentKinds,
            })
          : undefined;
        await notices.notifySessionReport({
          sessionId: event.sessionId,
          reportId: event.reportId,
          message: event.message,
          ...(task ? { task } : {}),
          ...(enriched ? { composed: enriched } : {}),
        });
      } else if (report.hostActions?.length && reports.receipts) {
        const enriched = await reports.render(report.text, report.hostActions, {
          attachmentKinds: [],
        });
        await completePetHostActionReceipt({
          recorder: reports.receipts,
          input: {
            petSessionId: await reports.dispatcher.getSessionId(),
            clientMessageId: `pet-report:${event.reportId}`,
            executions: report.hostActions,
            authoritativeMessage: enriched.text,
            replaceAssistant: true,
          },
          publish: (receiptEvent) => {
            for (const window of reports.windows()) {
              if (!window.isDestroyed()) {
                window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
              }
            }
          },
        });
      }
      await deliveredPetReports.mark(event.reportId);
      dlog("main", "pet.report.delivered_to_mimi", {
        reportId: event.reportId,
        sourceSessionId: event.sessionId,
        routedToOrigin: report.routedToOrigin,
        ...(task ? { taskId: task.id } : {}),
        attachmentCount: event.attachmentPaths?.length ?? 0,
        ...(event.deliveryRequest ? { deliveryChannel: event.deliveryRequest.channel } : {}),
      });
    } catch (error) {
      dlog("main", "pet.report.failed", {
        reportId: event.reportId,
        sessionId: event.sessionId,
        error: String(error),
      });
      throw error;
    } finally {
      processingPetReports.delete(event.reportId);
    }
  });
}
