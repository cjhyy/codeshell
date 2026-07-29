import { describe, expect, test } from "bun:test";
import { buildTeamBriefings } from "./digital-human-team-briefing.js";
import type { DigitalHumanTeam } from "./digital-human-team.js";

const team: DigitalHumanTeam = {
  id: "video-squad",
  name: "视频小队",
  members: ["video-director", "video-engineer", "video-doctor"],
  mode: "divide",
  lead: "video-director",
  playbook: "导演先出分镜，发给工程师渲染；出片后交医生验收。",
};

const roster = [
  { profileName: "video-director", sessionId: "s-dir", label: "短片导演" },
  { profileName: "video-engineer", sessionId: "s-eng", label: "视频工程师" },
  { profileName: "video-doctor", sessionId: "s-doc", label: "成片医生" },
];

describe("buildTeamBriefings", () => {
  test("gives the lead every teammate's Session id plus the playbook", () => {
    const briefings = buildTeamBriefings(team, roster, "做一条介绍视频");
    const lead = briefings.find((b) => b.sessionId === "s-dir");
    expect(lead).toBeDefined();
    // Without the ids the lead cannot use SendMessageToSession at all — that is
    // the whole reason teams did nothing before.
    expect(lead!.text).toContain("s-eng");
    expect(lead!.text).toContain("s-doc");
    expect(lead!.text).toContain("视频工程师");
    expect(lead!.text).toContain("导演先出分镜");
    expect(lead!.text).toContain("做一条介绍视频");
    // The lead must not be told to report to itself.
    expect(lead!.text).not.toContain("s-dir");
  });

  test("tells each member who the lead is and how to report back", () => {
    const briefings = buildTeamBriefings(team, roster, "做一条介绍视频");
    const member = briefings.find((b) => b.sessionId === "s-eng");
    expect(member!.text).toContain("短片导演");
    expect(member!.text).toContain("s-dir");
    expect(member!.text).toContain("SendMessageToSession");
    // Members get the goal, but not the playbook — coordination is the lead's job.
    expect(member!.text).toContain("做一条介绍视频");
    expect(member!.text).not.toContain("导演先出分镜");
  });

  test("a leaderless team gives everyone the goal and the full roster", () => {
    const briefings = buildTeamBriefings(
      { ...team, lead: undefined, playbook: undefined },
      roster,
      "各自调研",
    );
    expect(briefings).toHaveLength(3);
    for (const briefing of briefings) {
      expect(briefing.text).toContain("各自调研");
      expect(briefing.text).toContain("视频小队");
    }
  });

  test("no goal still produces a usable briefing", () => {
    const briefings = buildTeamBriefings(team, roster, undefined);
    expect(briefings.length).toBeGreaterThan(0);
    // Placeholder text would be worse than simply omitting the goal line.
    expect(briefings[0].text).not.toContain("undefined");
  });

  test("a member with no Session id is skipped rather than briefed blindly", () => {
    const partial = [
      { profileName: "video-director", sessionId: "s-dir", label: "短片导演" },
      { profileName: "video-engineer", sessionId: "", label: "视频工程师" },
    ];
    const briefings = buildTeamBriefings(team, partial, "目标");
    expect(briefings.map((b) => b.sessionId)).toEqual(["s-dir"]);
    // The lead's roster must not advertise a teammate it cannot actually reach.
    expect(briefings[0].text).not.toContain("视频工程师");
  });

  test("returns nothing when the roster is empty", () => {
    expect(buildTeamBriefings(team, [], "目标")).toEqual([]);
  });
});
