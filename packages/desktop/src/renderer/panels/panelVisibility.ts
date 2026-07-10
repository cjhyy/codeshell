export function resolvePanelVisibility({
  hidden,
  keepActiveBodyLive,
  activeTab,
}: {
  hidden: boolean;
  keepActiveBodyLive: boolean;
  activeTab: boolean;
}): { lifecycleVisible: boolean; foregroundVisible: boolean } {
  return {
    lifecycleVisible: (!hidden || keepActiveBodyLive) && activeTab,
    foregroundVisible: !hidden && activeTab,
  };
}
