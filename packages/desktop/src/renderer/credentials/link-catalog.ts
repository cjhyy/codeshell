/**
 * 三方集成市场目录(Link tab)。
 *
 * 目录数据保留在前端，用于渲染可发现的集成分类。只有带 oauthProfileId 的条目
 * 才能调用 main 进程中经过审计的 OAuth profile；其他条目作为 roadmap 可见项展示。
 *
 * 描述文案走 i18n(descKey),图标暂用单字母占位品牌标(brandText + brandColor),
 * 接入真实 logo 时把 brandText/brandColor 换成 iconUrl 即可。
 */
import type { TranslationKey } from "../i18n";

export interface LinkIntegration {
  /** 稳定 id,后续接后端时作为集成键 */
  id: string;
  /** 展示名(品牌专名,不翻译) */
  name: string;
  /** 一句话描述的 i18n key */
  descKey: TranslationKey;
  /** 占位品牌标的字母(真实 logo 接入前用) */
  brandText: string;
  /** 占位品牌标底色(Tailwind 类) */
  brandColor: string;
  /** Audited main-process OAuth profile. Missing means status-only/unsupported. */
  oauthProfileId?: string;
}

export interface LinkCategory {
  id: string;
  /** 分类标题的 i18n key */
  titleKey: TranslationKey;
  items: LinkIntegration[];
}

export const LINK_CATALOG: LinkCategory[] = [
  {
    id: "communication",
    titleKey: "ext.link.catCommunication",
    items: [
      {
        id: "circleback",
        name: "Circleback",
        descKey: "ext.link.descCircleback",
        brandText: "C",
        brandColor: "bg-orange-500",
      },
      {
        id: "fireflies",
        name: "Fireflies",
        descKey: "ext.link.descFireflies",
        brandText: "F",
        brandColor: "bg-fuchsia-600",
      },
      {
        id: "fyxer",
        name: "Fyxer",
        descKey: "ext.link.descFyxer",
        brandText: "F",
        brandColor: "bg-red-500",
      },
      {
        id: "granola",
        name: "Granola",
        descKey: "ext.link.descGranola",
        brandText: "G",
        brandColor: "bg-lime-600",
      },
      {
        id: "otter",
        name: "Otter.ai",
        descKey: "ext.link.descOtter",
        brandText: "O",
        brandColor: "bg-blue-600",
      },
    ],
  },
  {
    id: "design",
    titleKey: "ext.link.catDesign",
    items: [
      {
        id: "figma",
        name: "Figma",
        descKey: "ext.link.descFigma",
        brandText: "Fi",
        brandColor: "bg-violet-600",
      },
    ],
  },
];
