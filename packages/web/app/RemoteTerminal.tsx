import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { MobileTerminalInfo } from "@cjhyy/code-shell-core";
import {
  ctrlSequence,
  type RemoteTerminalChannel,
  type TerminalServerEvent,
} from "../src/hooks/remoteTerminalChannel.js";
import "./remote-terminal.css";

interface Props {
  channel: RemoteTerminalChannel;
  /** New terminals start in this project's root (Desktop home when absent). */
  projectId?: string;
}

/** Keys a phone keyboard lacks but terminal programs like Claude Code need. */
const KEYS: Array<{ label: string; data: string | ((appCursor: boolean) => string) }> = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "⇧Tab", data: "\x1b[Z" },
  { label: "↑", data: (app) => (app ? "\x1bOA" : "\x1b[A") },
  { label: "↓", data: (app) => (app ? "\x1bOB" : "\x1b[B") },
  { label: "←", data: (app) => (app ? "\x1bOD" : "\x1b[D") },
  { label: "→", data: (app) => (app ? "\x1bOC" : "\x1b[C") },
  { label: "^C", data: "\x03" },
];

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function darkTheme(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function terminalLabel(info: MobileTerminalInfo): string {
  return `${info.title} · ${info.origin === "remote" ? "远程开的" : "桌面"} · ${info.pid}`;
}

/**
 * The SAME shell a Desktop terminal tab shows: output is mirrored to every
 * viewer, and whoever typed last decides the terminal size.
 */
export function RemoteTerminal({ channel, projectId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const selectedRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<string | undefined>(undefined);
  const ctrlRef = useRef(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [terminals, setTerminals] = useState<MobileTerminalInfo[]>([]);
  const [selected, setSelected] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [message, setMessage] = useState("");

  const open = useCallback(
    (terminalId?: string) => {
      const term = termRef.current;
      if (!term) return;
      const previous = selectedRef.current;
      if (previous && previous !== terminalId) {
        channel.send({ type: "terminal.detach", terminalId: previous });
      }
      const requestId = newRequestId();
      pendingRef.current = requestId;
      setMessage("");
      channel.send({
        type: "terminal.open",
        requestId,
        ...(terminalId ? { terminalId } : projectId ? { projectId } : {}),
        cols: term.cols,
        rows: term.rows,
      });
    },
    [channel, projectId],
  );
  const openRef = useRef(open);
  openRef.current = open;

  const send = useCallback(
    (data: string) => {
      const terminalId = selectedRef.current;
      if (terminalId) channel.send({ type: "terminal.input", terminalId, data });
    },
    [channel],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const dark = darkTheme();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: window.matchMedia?.("(max-width: 720px)").matches ? 12 : 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      theme: dark
        ? { background: "#09090b", foreground: "#e4e4e7", cursor: "#e4e4e7" }
        : { background: "#ffffff", foreground: "#18181b", cursor: "#18181b" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    // xterm answers terminal queries through onData while parsing output; see
    // TerminalPanel on Desktop. Replayed queries are stale; live answers are
    // tagged so only the most recently active client's answer reaches the shell.
    let parsing = 0;
    let replaying = 0;
    const write = (data: string, replay = false) => {
      parsing++;
      if (replay) replaying++;
      term.write(data, () => {
        parsing--;
        if (replay) replaying--;
      });
    };
    const offInput = term.onData((data) => {
      const terminalId = selectedRef.current;
      if (replaying > 0 || !terminalId) return;
      if (parsing > 0) {
        channel.send({ type: "terminal.input", terminalId, data, reply: true });
        return;
      }
      if (ctrlRef.current) {
        ctrlRef.current = false;
        setCtrl(false);
        data = ctrlSequence(data);
      }
      send(data);
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const terminalId = selectedRef.current;
        if (terminalId) {
          channel.send({ type: "terminal.resize", terminalId, cols: term.cols, rows: term.rows });
        }
      }, 80);
    });
    observer.observe(host);

    const onEvent = (event: TerminalServerEvent) => {
      switch (event.type) {
        case "terminal.list.ok": {
          setEnabled(event.enabled);
          setTerminals(event.terminals);
          if (!event.enabled) {
            selectedRef.current = undefined;
            setSelected(undefined);
            return;
          }
          // Land on the newest running terminal so "open the page" ≈ "see my shell".
          if (!selectedRef.current && !pendingRef.current && event.terminals.length) {
            openRef.current(event.terminals[event.terminals.length - 1].id);
          }
          return;
        }
        case "terminal.opened":
          if (event.requestId !== pendingRef.current) return;
          pendingRef.current = undefined;
          selectedRef.current = event.terminal.id;
          setSelected(event.terminal.id);
          setEnded(false);
          term.reset();
          write(event.replay, true);
          term.focus();
          channel.send({ type: "terminal.list" });
          return;
        case "terminal.data":
          if (event.terminalId === selectedRef.current) write(event.data);
          return;
        case "terminal.exit":
          if (event.terminalId !== selectedRef.current) return;
          term.write(`\r\n\x1b[2m[进程已退出 (code ${event.exitCode})]\x1b[0m\r\n`);
          setEnded(true);
          channel.send({ type: "terminal.list" });
          return;
        case "terminal.error":
          if (event.requestId && event.requestId === pendingRef.current) {
            pendingRef.current = undefined;
          } else if (event.terminalId !== selectedRef.current) {
            return;
          }
          if (event.code === "disabled") setEnabled(false);
          setMessage(event.message);
          return;
      }
    };
    const offEvents = channel.subscribe(onEvent);
    const resync = () => {
      pendingRef.current = undefined;
      channel.send({ type: "terminal.list" });
      // A new socket lost the attachment; reattaching replays the scrollback.
      if (selectedRef.current) openRef.current(selectedRef.current);
    };
    const offReconnect = channel.onReconnect(resync);
    if (channel.online) channel.send({ type: "terminal.list" });

    return () => {
      offEvents();
      offReconnect();
      observer.disconnect();
      clearTimeout(resizeTimer);
      offInput.dispose();
      if (selectedRef.current) {
        channel.send({ type: "terminal.detach", terminalId: selectedRef.current });
      }
      selectedRef.current = undefined;
      pendingRef.current = undefined;
      termRef.current = null;
      term.dispose();
    };
  }, [channel, send]);

  const pressKey = (key: (typeof KEYS)[number]) => {
    const term = termRef.current;
    const data =
      typeof key.data === "string"
        ? key.data
        : key.data(term?.modes.applicationCursorKeysMode === true);
    send(data);
    term?.focus();
  };

  const kill = () => {
    const terminalId = selectedRef.current;
    if (!terminalId || !window.confirm("结束这个终端？桌面上的同一个终端也会一起关闭。")) return;
    channel.send({ type: "terminal.kill", terminalId });
  };

  return (
    <section className="remote-terminal" aria-label="终端">
      <header className="remote-terminal-bar">
        <select
          aria-label="选择终端"
          value={selected ?? ""}
          disabled={!enabled || terminals.length === 0}
          onChange={(event) => event.target.value && open(event.target.value)}
        >
          {selected && !terminals.some((item) => item.id === selected) ? (
            <option value={selected}>已结束的终端</option>
          ) : null}
          {terminals.length === 0 ? <option value="">没有正在运行的终端</option> : null}
          {terminals.map((item) => (
            <option key={item.id} value={item.id}>
              {terminalLabel(item)}
            </option>
          ))}
        </select>
        <button type="button" disabled={!enabled} onClick={() => open()}>
          新建终端
        </button>
        {enabled ? (
          <button type="button" className="ghost" disabled={!selected || ended} onClick={kill}>
            结束
          </button>
        ) : null}
      </header>
      {enabled === false ? (
        <p className="remote-terminal-note">
          桌面端还没有开启远程终端。在电脑上打开 设置 → 手机遥控 → 允许远程终端 后再试。
        </p>
      ) : message ? (
        <p className="remote-terminal-note">{message}</p>
      ) : null}
      <div ref={hostRef} className="remote-terminal-screen" hidden={enabled === false} />
      <div
        className="remote-terminal-keys"
        role="toolbar"
        aria-label="快捷键"
        hidden={enabled === false}
      >
        <button
          type="button"
          className={ctrl ? "active" : undefined}
          aria-pressed={ctrl}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            ctrlRef.current = !ctrlRef.current;
            setCtrl(ctrlRef.current);
            termRef.current?.focus();
          }}
        >
          Ctrl
        </button>
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            disabled={!selected || ended}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => pressKey(key)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </section>
  );
}
