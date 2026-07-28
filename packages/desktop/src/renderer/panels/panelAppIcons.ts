import {
  Activity,
  BarChart3,
  FileText,
  Globe,
  Image,
  LayoutDashboard,
  LineChart,
  Palette,
  PanelTop,
  PieChart,
  Table2,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { PanelAppIconName } from "../../shared/panel-apps";

const PANEL_APP_ICON_MAP = {
  panel: PanelTop,
  activity: Activity,
  "bar-chart-3": BarChart3,
  chart: BarChart3,
  "file-text": FileText,
  globe: Globe,
  image: Image,
  "layout-dashboard": LayoutDashboard,
  "line-chart": LineChart,
  palette: Palette,
  "pie-chart": PieChart,
  table: Table2,
  terminal: Terminal,
} as const satisfies Record<PanelAppIconName, LucideIcon>;

export function resolvePanelAppIcon(name: string): LucideIcon {
  return (PANEL_APP_ICON_MAP as Record<string, LucideIcon>)[name] ?? PanelTop;
}
