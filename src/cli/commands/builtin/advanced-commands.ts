/**
 * Advanced slash commands — /vim, /voice, /bridge, /plugins, /lsp
 */

import type { SlashCommand } from "../registry.js";

export const advancedCommands: SlashCommand[] = [
  {
    name: "/vim",
    group: "advanced",
    description: "Toggle vim keybinding mode",
    execute: (_arg, ctx) => {
      // Vim mode state is managed by the App component
      // This just toggles a flag that the UI reads
      ctx.addStatus("Vim mode toggle — implement in App.tsx with VimState.");
    },
  },

  {
    name: "/voice",
    group: "advanced",
    description: "Toggle voice mode (STT/TTS)",
    execute: async (_arg, ctx) => {
      const { isVoiceEnabled, enableVoice, disableVoice } = await import("../../../voice/index.js");
      if (isVoiceEnabled()) {
        disableVoice();
        ctx.addStatus("Voice mode disabled.");
      } else {
        enableVoice();
        ctx.addStatus("Voice mode enabled. TTS will speak assistant responses.");
      }
    },
  },

  {
    name: "/bridge",
    group: "advanced",
    description: "Connect to a remote code-shell instance via SSH",
    usage: "/bridge <host> [--user <user>] [--port <port>]",
    execute: async (arg, ctx) => {
      if (!arg) {
        ctx.addStatus("Usage: /bridge <host> [--user user] [--port port]");
        return;
      }

      const parts = arg.split(/\s+/);
      const host = parts[0];
      let user: string | undefined;
      let port: number | undefined;

      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--user" && parts[i + 1]) user = parts[++i];
        if (parts[i] === "--port" && parts[i + 1]) port = parseInt(parts[++i], 10);
      }

      ctx.addStatus(`Connecting to ${user ? `${user}@` : ""}${host}${port ? `:${port}` : ""}...`);

      try {
        const { RemoteBridge } = await import("../../../remote/bridge.js");
        const bridge = new RemoteBridge({ host, user, port });
        await bridge.connect();
        ctx.addStatus(`Connected to ${host}. Use /bridge-disconnect to close.`);
      } catch (err) {
        ctx.addStatus(`Connection failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/plugins",
    group: "advanced",
    description: "List and manage plugins",
    usage: "/plugins [enable|disable <name>]",
    execute: async (arg, ctx) => {
      const { PluginLoader } = await import("../../../plugins/loader.js");
      const loader = new PluginLoader();
      const plugins = loader.scan(ctx.cwd);

      if (!arg) {
        if (plugins.length === 0) {
          ctx.addStatus("No plugins found. Add plugins to ~/.code-shell/plugins/ or .code-shell/plugins/");
          return;
        }
        const lines = plugins.map((p) => {
          const status = p.enabled ? "✓" : "✗";
          const err = p.error ? ` (error: ${p.error})` : "";
          return `  ${status} ${p.manifest.name} v${p.manifest.version} — ${p.manifest.description}${err}`;
        });
        ctx.addStatus("Plugins:\n" + lines.join("\n"));
        return;
      }

      const parts = arg.split(/\s+/);
      const action = parts[0];
      const name = parts[1];

      if ((action === "enable" || action === "disable") && name) {
        const ok = loader.setEnabled(name, action === "enable");
        if (ok) {
          ctx.addStatus(`Plugin "${name}" ${action}d.`);
        } else {
          ctx.addStatus(`Plugin "${name}" not found.`);
        }
      } else {
        ctx.addStatus("Usage: /plugins [enable|disable <name>]");
      }
    },
  },

  {
    name: "/lsp",
    group: "advanced",
    description: "Manage LSP language servers",
    usage: "/lsp [status|start <server>|stop]",
    execute: async (arg, ctx) => {
      const { getLSPManager, initializeLSPManager } = await import("../../../lsp/manager.js");

      let manager = getLSPManager();
      if (!manager) {
        manager = initializeLSPManager(ctx.cwd);
      }

      if (!arg || arg === "status") {
        const servers = manager.listServers();
        const lines = servers.map((s) => {
          const icon = s.state === "ready" ? "✓" : s.state === "error" ? "✗" : "○";
          const err = s.error ? ` — ${s.error}` : "";
          return `  ${icon} ${s.name} (${s.language}): ${s.state}${err}`;
        });
        ctx.addStatus("LSP Servers:\n" + lines.join("\n"));
        return;
      }

      if (arg === "stop") {
        await manager.shutdownAll();
        ctx.addStatus("All LSP servers stopped.");
        return;
      }

      if (arg.startsWith("start ")) {
        const serverName = arg.slice(6).trim();
        const client = await manager.getClient(serverName);
        if (client) {
          ctx.addStatus(`LSP server "${serverName}" is ready.`);
        } else {
          ctx.addStatus(`Failed to start LSP server "${serverName}".`);
        }
        return;
      }

      ctx.addStatus("Usage: /lsp [status|start <server>|stop]");
    },
  },

  {
    name: "/swarm",
    group: "advanced",
    description: "Decompose task into parallel sub-agents",
    usage: "/swarm <task description>",
    execute: async (arg, ctx) => {
      if (!arg) {
        ctx.addStatus("Usage: /swarm <task description>");
        return;
      }

      ctx.setIsRunning(true);
      try {
        const prompt =
          `Decompose the following task into 2-4 independent sub-tasks that can be worked on in parallel. ` +
          `For each sub-task, use the Agent tool with a clear, complete description. ` +
          `Use isolation: "worktree" if the sub-tasks modify different files.\n\n` +
          `Task: ${arg}`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Swarm failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },
];
