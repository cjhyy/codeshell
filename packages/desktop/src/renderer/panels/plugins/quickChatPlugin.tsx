import type { ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import type { PluginLifecycleEvent } from "@cjhyy/code-shell-core/browser/plugin-runtime";
import {
  registerDesktopPanelPlugin,
  type DesktopPanelLifecycleContext,
  type DesktopPanelPluginHost,
} from "../DesktopPanelPlugin";
import type { PanelRenderContext } from "../PanelRegistry";

export const QUICK_CHAT_PANEL_PLUGIN_ID = "codeshell.panel.quick-chat";

export interface QuickChatPanelPluginService {
  ensure(context: DesktopPanelLifecycleContext): void | Promise<void>;
  release(context: DesktopPanelLifecycleContext): void | Promise<void>;
  render(context: PanelRenderContext): ReactNode;
}

function service(host: DesktopPanelPluginHost): QuickChatPanelPluginService | undefined {
  return host.getService(QUICK_CHAT_PANEL_PLUGIN_ID) as QuickChatPanelPluginService | undefined;
}

function panelContext(
  event: PluginLifecycleEvent<DesktopPanelLifecycleContext>,
): DesktopPanelLifecycleContext | undefined {
  return "panel" in event ? event.panel.context : undefined;
}

let installed = false;

/** QuickChat is the first built-in consumer of the same code-panel boundary. */
export function installQuickChatPanelPlugin(): void {
  if (installed) return;
  registerDesktopPanelPlugin({
    module: {
      id: QUICK_CHAT_PANEL_PLUGIN_ID,
      hooks: {
        panel_mount: ({ event, host }) => {
          const context = panelContext(event);
          if (context) return service(host)?.ensure(context);
        },
        panel_context_changed: ({ event, host }) => {
          const context = panelContext(event);
          if (context) return service(host)?.ensure(context);
        },
        panel_unmount: ({ event, host }) => {
          const context = panelContext(event);
          if (context) return service(host)?.release(context);
        },
      },
    },
    panel: {
      id: "quickChat",
      panelId: "quick-chat",
      title: { kind: "i18n", key: "panels.kinds.quickChat" },
      icon: MessageCircle,
      order: 60,
      render: (context, host) => (host ? service(host)?.render(context) : null),
    },
  });
  installed = true;
}
