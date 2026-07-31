export const DIGITAL_HUMAN_TEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DIGITAL_HUMAN_ID_RE = DIGITAL_HUMAN_TEAM_ID_RE;

export type DigitalHumanTeamMode = "auto" | "divide" | "compare";

export const DIGITAL_HUMAN_TEAM_NAME_LIMIT = 120;
export const DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT = 1_000;
export const DIGITAL_HUMAN_TEAM_MEMBER_MIN = 2;
export const DIGITAL_HUMAN_TEAM_MEMBER_MAX = 8;
export const DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT = 4_000;

/** Reusable project workflow that creates one independently bound Session per member. */
export interface DigitalHumanTeam {
  id: string;
  name: string;
  description?: string;
  members: string[];
  /**
   * @deprecated `auto`/`divide`/`compare` never reached any runtime logic — the
   * three modes produced identical Sessions. `playbook` replaces it: free text
   * beats a three-value enum for describing real collaboration. Kept so existing
   * team files still parse.
   */
  mode: DigitalHumanTeamMode;
  /**
   * Which member coordinates. Must be one of `members`. Omitted = no lead, every
   * member just gets the shared goal.
   *
   * The lead is a normal Session, not a new kind of agent: it receives the other
   * members' Session ids and drives them with the existing SendMessageToSession
   * tool. Orchestration lives in that Session's transcript — visible, and the
   * user can step in — rather than inside Pet.
   */
  lead?: string;
  /**
   * User-authored collaboration rules. A lead receives them as its orchestration
   * playbook; a leadless team sends them to every member as shared constraints.
   */
  playbook?: string;
  /**
   * Read-model metadata for a team supplied by a registered repo. It is never
   * persisted into a local team file; saving the team creates a user-owned
   * local override with the same id.
   */
  sourceRepo?: string;
  /**
   * Read-model metadata marking a locally saved team that shadows a repo team
   * with the same id. Deleting it restores the source version.
   */
  localOverride?: boolean;
}

const TEAM_MODES = new Set<DigitalHumanTeamMode>(["auto", "divide", "compare"]);

export function parseDigitalHumanTeam(input: unknown): DigitalHumanTeam {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("digital-human team must be an object");
  }
  const value = input as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : undefined;
  const mode = value.mode as DigitalHumanTeamMode;
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) throw new Error("invalid digital-human team id");
  if (!name || name.length > DIGITAL_HUMAN_TEAM_NAME_LIMIT) {
    throw new Error("invalid digital-human team name");
  }
  if (description !== undefined && description.length > DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT) {
    throw new Error("digital-human team description is too long");
  }
  if (!TEAM_MODES.has(mode)) throw new Error("invalid digital-human team mode");
  if (
    !Array.isArray(value.members) ||
    value.members.length < DIGITAL_HUMAN_TEAM_MEMBER_MIN ||
    value.members.length > DIGITAL_HUMAN_TEAM_MEMBER_MAX
  ) {
    throw new Error("digital-human team must contain 2 to 8 members");
  }
  const members = value.members.map((member) => (typeof member === "string" ? member.trim() : ""));
  if (
    members.some((member) => !DIGITAL_HUMAN_ID_RE.test(member)) ||
    new Set(members).size !== members.length
  ) {
    throw new Error("digital-human team members must be unique valid ids");
  }
  const lead = typeof value.lead === "string" ? value.lead.trim() : undefined;
  if (lead !== undefined && lead !== "" && !members.includes(lead)) {
    // A lead outside the roster could never be handed the members' Session ids.
    throw new Error("digital-human team lead must be one of its members");
  }
  const playbook = typeof value.playbook === "string" ? value.playbook.trim() : undefined;
  if (playbook !== undefined && playbook.length > DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT) {
    throw new Error("digital-human team playbook is too long");
  }
  return {
    id,
    name,
    ...(description ? { description } : {}),
    members,
    mode,
    ...(lead ? { lead } : {}),
    ...(playbook ? { playbook } : {}),
  };
}
