import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";
import type { ChatState } from "../lib/streamReducer.js";

type Pending = {
  legacy?: boolean;
  unavailable?: string;
  kind?: "extend" | "clear" | "resume";
  id: string;
  sessionId: string;
  epoch: number;
  goalId?: string;
  revision?: number;
};

/** Versioned Goal controls share the selected conversation's ownership, never a chat input. */
export function useRemoteGoalControls(options: {
  sessionId?: string;
  epoch: number;
  selection(): { sessionId?: string; epoch: number };
  loading: boolean;
  blocked: boolean;
  chat: ChatState;
  send(event: MobileClientEvent): boolean;
  publish(event: unknown, expected: { goalId?: string; revision?: number }): void;
  notice(message: string): void;
}) {
  const current = useRef(options);
  current.current = options;
  const [supported, setSupported] = useState(false);
  const [connection, setConnection] = useState(0);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const read = useRef<Pending | undefined>(undefined);
  const action = useRef<Pending | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const capture = (): Pending | undefined => {
    const o = current.current;
    const selected = o.selection();
    return selected.sessionId
      ? {
          id: `goal-${++sequence.current}`,
          sessionId: selected.sessionId,
          epoch: selected.epoch,
          goalId: o.chat.goalId,
          revision: o.chat.goalRevision,
        }
      : undefined;
  };
  const owns = (pending: Pending) => {
    const selected = current.current.selection();
    return pending.sessionId === selected.sessionId && pending.epoch === selected.epoch;
  };
  const sameGoal = (pending: Pending) =>
    pending.goalId === current.current.chat.goalId &&
    pending.revision === current.current.chat.goalRevision;
  const refresh = useCallback(() => {
    const pending = capture();
    if (!pending) return;
    read.current = pending;
    current.current.send({ type: "goal.get", sessionId: pending.sessionId, requestId: pending.id });
  }, []);
  useEffect(() => {
    action.current = undefined;
    read.current = undefined;
    clearTimeout(timer.current);
    setBusy(false);
    return () => clearTimeout(timer.current);
  }, [options.sessionId, options.epoch]);
  useEffect(() => {
    read.current = undefined;
    const pending = action.current;
    if (pending) {
      action.current = undefined;
      clearTimeout(timer.current);
      setBusy(false);
      if (owns(pending))
        current.current.notice(
          "目标操作结果未确认，主机可能仍在处理；正在刷新状态，请确认后再操作。",
        );
    }
  }, [connection]);
  useEffect(() => {
    if (supported && !options.loading && !options.blocked) refresh();
  }, [
    supported,
    connection,
    options.sessionId,
    options.epoch,
    options.loading,
    options.blocked,
    refresh,
  ]);

  const handle = useCallback((event: MobileServerEvent) => {
    if (event.type === "auth.ok" || event.type === "pair.ok") {
      setSupported(event.capabilities?.goalControls === 1);
      setConnection((value) => value + 1);
      return false;
    }
    if (
      event.type !== "goal.state" &&
      event.type !== "goal.updated" &&
      event.type !== "goal.cleared" &&
      event.type !== "goal.extended"
    )
      return false;
    const pending = event.type === "goal.state" ? read.current : action.current;
    const matchesAction =
      pending?.kind === "extend"
        ? event.type === "goal.extended"
        : pending?.kind === "clear"
          ? event.type === "goal.cleared"
          : pending?.kind === "resume"
            ? event.type === "goal.updated"
            : event.type === "goal.state";
    if (
      pending?.legacy &&
      matchesAction &&
      owns(pending) &&
      event.sessionId === pending.sessionId &&
      !event.requestId &&
      (event.type === "goal.extended" || event.type === "goal.cleared")
    ) {
      action.current = undefined;
      clearTimeout(timer.current);
      setBusy(false);
      if (!event.ok) current.current.notice(event.message || "目标操作失败");
      return true;
    }
    if (
      !pending ||
      !matchesAction ||
      !owns(pending) ||
      event.sessionId !== pending.sessionId ||
      event.requestId !== pending.id
    ) {
      // Legacy hosts cannot correlate success, but their failure still needs a visible explanation.
      if (!event.requestId && event.sessionId === current.current.sessionId && !event.ok)
        current.current.notice(event.message || "目标操作失败");
      return true;
    }
    if (event.type === "goal.state") {
      // Failed/lost reads keep stale revisions fenced; an explicit click can
      // request another snapshot without resending the mutation.
      if (event.ok) read.current = undefined;
      else if (event.unsupported)
        pending.unavailable = event.message || "当前会话不支持目标操作，请在所属主机中操作。";
    } else {
      action.current = undefined;
      clearTimeout(timer.current);
      setBusy(false);
    }
    if (!event.ok) {
      if (event.type !== "goal.state" || !event.unsupported)
        current.current.notice(event.message || "目标操作失败");
      // CAS refusal and timeout both require authoritative state, never a
      // replay of the mutation using the captured, potentially stale revision.
      if (event.type !== "goal.state" && !pending.legacy) refresh();
      return true;
    }
    if (event.type === "goal.extended") return true;
    if (!sameGoal(pending)) return true; // A newer stream/control already owns this banner.
    if (event.type === "goal.cleared" || !event.goal) {
      if (event.type !== "goal.cleared" || event.cleared)
        current.current.publish(
          { type: "goal_cleared", goalId: pending.goalId, revision: pending.revision },
          pending,
        );
    } else current.current.publish({ type: "goal_set", ...event.goal }, pending);
    return true;
  }, []);

  const control = useCallback(
    (sessionId: string, clear: boolean) => {
      const o = current.current;
      const selection = o.selection();
      if (
        sessionId !== selection.sessionId ||
        selection.epoch !== o.epoch ||
        o.blocked ||
        action.current
      )
        return;
      if (supported && read.current) {
        const unavailable = read.current.unavailable;
        refresh();
        o.notice(unavailable || "正在刷新目标状态，请确认后再操作。");
        return;
      }
      if (o.loading) {
        o.notice("目标状态尚未就绪，请稍后重试。");
        return;
      }
      const extend = !clear && o.chat.run === "running" && !o.chat.goalPaused;
      if (!clear && !extend && !supported) {
        o.notice("当前主机不支持恢复目标，请升级主机后重试。");
        return;
      }
      if (!extend && (supported || !clear) && (!o.chat.goalId || !o.chat.goalRevision)) {
        o.notice("目标状态尚未就绪，请刷新后重试。");
        return;
      }
      const pending = capture()!;
      pending.kind = extend ? "extend" : clear ? "clear" : "resume";
      pending.legacy = !supported;
      action.current = pending;
      setBusy(true);
      const expected =
        pending.goalId && pending.revision
          ? { expectedGoalId: pending.goalId, expectedRevision: pending.revision }
          : {};
      const sent = o.send(
        extend
          ? { type: "goal.extend", sessionId, requestId: pending.id, addTurns: 100 }
          : clear
            ? {
                type: "goal.clear",
                sessionId,
                requestId: pending.id,
                ...(supported ? expected : {}),
              }
            : {
                type: "goal.update",
                sessionId,
                requestId: pending.id,
                paused: false,
                expectedGoalId: pending.goalId!,
                expectedRevision: pending.revision!,
              },
      );
      const fail = () => {
        if (action.current !== pending) return;
        action.current = undefined;
        setBusy(false);
        if (owns(pending)) {
          current.current.notice(
            "目标操作结果未确认，主机可能仍在处理；正在刷新状态，请确认后再操作。",
          );
          if (!pending.legacy) refresh();
        }
      };
      if (!sent) fail();
      else timer.current = setTimeout(fail, 12_000);
    },
    [supported],
  );
  return {
    handle,
    busy,
    continueGoal: (id: string) => control(id, false),
    clearGoal: (id: string) => control(id, true),
  };
}
