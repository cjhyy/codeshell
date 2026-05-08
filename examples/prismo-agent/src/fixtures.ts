/**
 * Prismo fixture data — stand-in for what the Prismo backend will eventually provide.
 *
 * Shape mirrors the planned Prismo API responses (project / messages / input
 * sources / artifacts) so the tools and product code can stay unchanged when
 * the real Prismo HTTP client replaces these in Phase 2.
 */

export interface PrismoProjectFixture {
  id: string;
  title: string;
  description: string;
  ownerId: string;
  phase: "ideation" | "requirements" | "prd_generation" | "flowchart" | "revision";
}

export interface PrismoMessageFixture {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  phase: PrismoProjectFixture["phase"];
  createdAt: string;
}

export interface PrismoInputSourceFixture {
  id: string;
  kind: "note" | "file" | "sketch" | "data";
  title: string;
  content: string;
}

export interface PrismoArtifactFixture {
  id: string;
  kind: "prd" | "flowchart" | "prototype";
  title: string;
  content: string;
  version: number;
}

export interface PrismoFixtureBundle {
  project: PrismoProjectFixture;
  messages: PrismoMessageFixture[];
  inputSources: PrismoInputSourceFixture[];
  artifacts: PrismoArtifactFixture[];
}

export const FIXTURE_BUNDLE: PrismoFixtureBundle = {
  project: {
    id: "proj_demo_01",
    title: "EduFlow — 中小学家长作业陪伴助手",
    description:
      "面向小学 3~6 年级家长的辅导陪伴 App，重点解决家长不会辅导、孩子写作业拖拉的问题。",
    ownerId: "user_demo",
    phase: "prd_generation",
  },

  messages: [
    {
      id: "msg_01",
      role: "user",
      content:
        "我想做一个家长陪写作业的 App，主要面向小学 3-6 年级，希望帮助家长辅导孩子。",
      phase: "ideation",
      createdAt: "2026-05-01T10:00:00Z",
    },
    {
      id: "msg_02",
      role: "assistant",
      content:
        "好的，我先做几个澄清：1) 主要场景是家长不会题目还是孩子拖延？2) 希望 AI 直接给答案还是引导孩子自己想？3) 是否要有进度追踪给老师？",
      phase: "ideation",
      createdAt: "2026-05-01T10:01:00Z",
    },
    {
      id: "msg_03",
      role: "user",
      content:
        "1) 拖延为主，2) 一定不能直接给答案，要引导，3) 暂时不给老师，只给家长看每日进度。",
      phase: "requirements",
      createdAt: "2026-05-01T10:03:00Z",
    },
    {
      id: "msg_04",
      role: "user",
      content:
        "核心功能我希望有：拍题识别、引导式答疑、番茄钟专注、家长每日进度看板。",
      phase: "requirements",
      createdAt: "2026-05-01T10:05:00Z",
    },
    {
      id: "msg_05",
      role: "user",
      content: "请基于现有信息生成一份正式 PRD，并补一张主流程图。",
      phase: "prd_generation",
      createdAt: "2026-05-01T10:07:00Z",
    },
  ],

  inputSources: [
    {
      id: "src_01",
      kind: "note",
      title: "调研笔记 — 家长访谈摘要",
      content:
        "10 位家长访谈结论：87% 家长每周辅导超 5 小时；最大痛点是孩子磨蹭；70% 担心 AI 直接给答案误导孩子；愿意付费区间 30~50 元/月。",
    },
    {
      id: "src_02",
      kind: "data",
      title: "竞品功能对比表（节选）",
      content:
        "作业帮：拍照搜题，直接给答案；小猿：搜题 + 视频讲解；夸克：通用搜索。差距点：缺少“引导式不直接给答案”的产品；缺少家长侧专注辅助。",
    },
  ],

  artifacts: [
    {
      id: "artifact_seed_prd",
      kind: "prd",
      title: "EduFlow PRD（v1，占位）",
      version: 1,
      content:
        "# EduFlow PRD\n\n_占位草稿，等待 agent 重写_\n\n- 概述：待补\n- 目标用户：待补\n- 功能：待补\n",
    },
  ],
};

/**
 * Lightweight in-memory store that the fake tools mutate.
 * Phase 2 will replace this with real Prismo API calls.
 */
export interface DraftArtifactRecord {
  id: string;
  kind: "prd" | "flowchart" | "prototype";
  title: string;
  content: string;
  status: "draft" | "approved";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class FixtureRunStore {
  private drafts = new Map<string, DraftArtifactRecord>();
  private events: Array<{ type: string; payload: unknown; at: string }> = [];

  saveDraft(record: Omit<DraftArtifactRecord, "createdAt">): DraftArtifactRecord {
    const stored: DraftArtifactRecord = {
      ...record,
      createdAt: new Date().toISOString(),
    };
    this.drafts.set(stored.id, stored);
    this.appendEvent("artifact_draft_created", {
      artifactId: stored.id,
      kind: stored.kind,
      title: stored.title,
    });
    return stored;
  }

  listDrafts(): DraftArtifactRecord[] {
    return [...this.drafts.values()];
  }

  getDraft(id: string): DraftArtifactRecord | undefined {
    return this.drafts.get(id);
  }

  appendEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload, at: new Date().toISOString() });
  }

  snapshotEvents(): Array<{ type: string; payload: unknown; at: string }> {
    return [...this.events];
  }
}
