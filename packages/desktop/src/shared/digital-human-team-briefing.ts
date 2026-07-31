/**
 * 团队开场简报。
 *
 * 召唤团队此前只是「批量建 Session」：每个成员互不知情，拿不到队友的 Session id，
 * 于是 `SendMessageToSession` 工具形同不存在——团队实际只省了几次点击。
 *
 * 简报补上这一环：成员建好后把「目标 + 队友是谁 + 各自 Session id + 协作规则」
 * 写成第一条消息。编排由团长的 LLM 读 playbook 自己完成，代码不做调度——真实协作
 * 远多于三种固定模式，而团长手里已经有队友 id 和现成的消息工具。
 */
import type { DigitalHumanTeam } from "./digital-human-team.js";

export interface TeamMemberSlot {
  profileName: string;
  /** Engine/UI Session id. Empty when the Session could not be created. */
  sessionId: string;
  /** Human-facing digital-human label. */
  label: string;
}

export interface TeamBriefing {
  sessionId: string;
  text: string;
}

/**
 * 为每个成员生成开场简报。只有拿到 Session id 的成员会出现在结果与名册里——
 * 给团长一个联系不上的队友，只会让它对着不存在的 id 发消息。
 */
export function buildTeamBriefings(
  team: DigitalHumanTeam,
  roster: readonly TeamMemberSlot[],
  goal: string | undefined,
): TeamBriefing[] {
  const reachable = roster.filter((slot) => slot.sessionId);
  if (reachable.length === 0) return [];

  const trimmedGoal = goal?.trim();
  const goalLine = trimmedGoal ? `本次目标：${trimmedGoal}` : undefined;
  const leadSlot = team.lead ? reachable.find((slot) => slot.profileName === team.lead) : undefined;

  return reachable.map((slot) => {
    const isLead = leadSlot?.sessionId === slot.sessionId;
    const lines: string[] = [];

    if (isLead) {
      lines.push(`你是「${team.name}」的团长，负责分派任务并汇总结果。`);
    } else if (leadSlot) {
      lines.push(
        `你是「${team.name}」的成员（${slot.label}）。团长是 ${leadSlot.label}，` +
          `Session id \`${leadSlot.sessionId}\`。`,
      );
    } else {
      lines.push(`你是「${team.name}」的成员（${slot.label}）。本团队没有团长，各成员并行推进。`);
    }

    if (goalLine) lines.push(goalLine);

    // The lead needs the roster to drive it; a member needs it to know the shape
    // of the team without being told to coordinate.
    const others = reachable.filter((other) => other.sessionId !== slot.sessionId);
    if (others.length > 0 && (isLead || !leadSlot)) {
      lines.push(
        ["团队成员：", ...others.map((o) => `- ${o.label} — Session id \`${o.sessionId}\``)].join(
          "\n",
        ),
      );
    }

    if (team.playbook && (isLead || !leadSlot)) {
      lines.push(
        `${isLead ? "协作规则" : "共同工作规则"}（由用户设定，请遵循）：\n${team.playbook}`,
      );
    }

    if (isLead) {
      lines.push(
        "用 `SendMessageToSession` 把子任务发给对应成员；等他们回报后再推进下一步。" +
          "不要自己代做成员的工作。",
      );
    } else if (leadSlot) {
      lines.push("完成后用 `SendMessageToSession` 把结果回报给团长。");
    }

    return { sessionId: slot.sessionId, text: lines.join("\n\n") };
  });
}
