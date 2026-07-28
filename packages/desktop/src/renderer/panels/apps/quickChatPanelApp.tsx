import type { ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import type { PanelAppLifecycleEvent } from "@cjhyy/code-shell-core/browser/panel-app-runtime";
import {
  registerDesktopBuiltinPanelApp,
  type DesktopPanelAppLifecycleContext,
  type DesktopBuiltinPanelAppHost,
} from "../DesktopBuiltinPanelApp";
import type { PanelRenderContext } from "../PanelRegistry";

export const QUICK_CHAT_PANEL_APP_ID = "codeshell.panel-app.quick-chat";

export interface QuickChatPanelAppService {
  ensure(context: DesktopPanelAppLifecycleContext): void | Promise<void>;
  release(context: DesktopPanelAppLifecycleContext): void | Promise<void>;
  render(context: PanelRenderContext): ReactNode;
}

function service(host: DesktopBuiltinPanelAppHost): QuickChatPanelAppService | undefined {
  return host.getService(QUICK_CHAT_PANEL_APP_ID) as QuickChatPanelAppService | undefined;
}

function panelContext(
  event: PanelAppLifecycleEvent<DesktopPanelAppLifecycleContext>,
): DesktopPanelAppLifecycleContext | undefined {
  return "panel" in event ? event.panel.context : undefined;
}

let installed = false;

/** QuickChat is a trusted built-in Panel App, separate from Agent Plugins. */
export function installQuickChatPanelApp(): void {
  if (installed) return;
  registerDesktopBuiltinPanelApp({
    module: {
      id: QUICK_CHAT_PANEL_APP_ID,
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
