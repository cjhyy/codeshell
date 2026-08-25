import type { GitPanelAppSourceInput } from "../../preload/types";

export const OFFICIAL_PANEL_APP_REPOSITORY = "https://github.com/cjhyy/codeshell-panel-apps.git";

export const recommendedPanelApps = [
  {
    id: "video-download",
    subdir: "apps/video-download",
    i18nKey: "videoDownload",
    icon: "download",
  },
  {
    id: "design-studio",
    subdir: "apps/design-studio",
    i18nKey: "designStudio",
    icon: "palette",
  },
  {
    id: "job-hunt-hq",
    subdir: "apps/job-hunt-hq",
    i18nKey: "jobHunt",
    icon: "briefcase",
  },
  {
    id: "quant-lab",
    subdir: "apps/quant-lab",
    i18nKey: "quantLab",
    icon: "chart",
  },
] as const;

export type RecommendedPanelApp = (typeof recommendedPanelApps)[number];

export function recommendedPanelSource(
  recommendation: Pick<RecommendedPanelApp, "subdir">,
): GitPanelAppSourceInput {
  return {
    kind: "git",
    url: OFFICIAL_PANEL_APP_REPOSITORY,
    ref: "main",
    subdir: recommendation.subdir,
  };
}
