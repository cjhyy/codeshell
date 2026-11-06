import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  MapPin,
  Plus,
  X,
  MousePointerSquareDashed,
  PictureInPicture2,
  ShieldCheck,
  PlugZap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useT } from "../i18n/I18nProvider";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import type { Anchor } from "../chat/anchors";
import {
  browserMarkersFrom,
  visibleMarkersOn,
  groupMarkersByPage,
  urlsMatch,
  useMarkerEcho,
} from "../browser/markerEcho";
import { NEW_TAB, NEW_TAB_TITLE, type Tab, type WebviewElement } from "../browser/types";
import { WebviewHost } from "../browser/WebviewHost";
import { FloatingAt, IconBtn } from "../browser/ui";
import { MarkerDot } from "../browser/markers";
import { NewTabLanding } from "../browser/NewTabLanding";
import { useBrowserTabs } from "../browser/useBrowserTabs";
import { useElementPicking } from "../browser/useElementPicking";
import { useIdleEvict } from "../browser/useIdleEvict";
import { isExternalHttpUrl } from "../browser/externalUrl";
import { ContextMenu } from "../ui/ContextMenu";
import { copyText } from "../lib/clipboard";
import { useToast } from "../ui/ToastProvider";
import type { ChromeBrowserRuntimeStatus } from "../../preload/types";
import { useBrowserSessionTarget } from "../browser/useBrowserSessionTarget";

interface Props {
  /** Workspace root — reserved for future "open file in browser" wiring. */
  cwd: string | null;
  /** Initial URL to open (used by the popout window). */
  initialUrl?: string;
  /**
   * URL a clicked chat link asked to open, threaded as a prop (nonce re-fires
   * on re-click). Prop-driven, NOT a window event the panel subscribes to, so
   * it works even when the panel was CLOSED at click time: App opens the panel,
   * this component mounts, and the effect below navigates to the pending URL.
   */
  openUrl?: { url: string; nonce: number };
  /**
   * The active session's browser anchors — the SINGLE source the page dots /
   * highlights echo (圈选统一架构). Main-window panel: App passes its bucketed
   * state; popout: the hub broadcast. No local marker state exists anymore.
   */
  anchors?: Anchor[];
  /**
   * Where a comment anchor goes. Defaults to the in-window composer (via the
   * add-anchor event). The popout window overrides this to send over IPC to the
   * parent window's composer. Return value unused.
   */
  onAnchor?: (a: Omit<Anchor, "id">) => string | void;
  /** Remove an anchor by id — routed to the owner (App / via IPC for popouts). */
  onRemoveAnchor?: (anchorId: string) => void;
  /** Update an anchor's comment by id — routed like onRemoveAnchor. */
  onUpdateAnchor?: (anchorId: string, comment: string) => void;
  /** Whether to show the "弹出独立窗口" button (hidden inside the popout itself). */
  showPopout?: boolean;
  /**
   * Whether this panel is actually on-screen (dock open AND its tab active).
   * The dock keeps the panel MOUNTED while closed so the <webview> survives a
   * quick close→reopen; but a webview that's been off-screen for a while is
   * just a stranded renderer process eating memory. When `visible` stays false
   * past IDLE_EVICT_MS we unmount the guest (freeing the process) and reload
   * its url on the next show — same trade as Chrome's tab discarding. Defaults
   * to true (popout window / older callers are always considered visible).
   */
  visible?: boolean;
  /**
   * Electron storage partition for the selected browser login profile. Project
   * sessions share login state while retaining their own tabs. Defaults to the
   * global partition for popout / legacy callers.
   */
  partition?: string;
  /** UI session bucket that owns this browser panel. Undefined for legacy/popout. */
  bucket?: string;
  /** Engine session id that should route automation to this bucket. */
  engineSessionId?: string | null;
}

interface BrowserAddressRuntime {
  openExternal: (url: string) => Promise<void>;
  copyText: (value: string) => Promise<boolean>;
  toast: ReturnType<typeof useToast>;
}

interface BrowserAddressFieldProps {
  url: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onNavigate: (url: string) => void;
  /** Side-effect seam used by focused component tests; production uses Electron/clipboard/toast. */
  runtime?: BrowserAddressRuntime;
}

/**
 * BrowserPanel's address interaction boundary. It deliberately reads actions
 * from the committed `url`, while typing only mutates `draft`.
 */
export function BrowserAddressField({
  url,
  draft,
  onDraftChange,
  onNavigate,
  runtime,
}: BrowserAddressFieldProps) {
  const { t } = useT();
  const contextToast = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const toast = runtime?.toast ?? contextToast;

  useEffect(() => setMenu(null), [url]);

  const openExternally = useCallback(async (): Promise<void> => {
    if (!isExternalHttpUrl(url)) return;
    try {
      await (runtime?.openExternal ?? window.codeshell.openExternal)(url);
    } catch {
      toast({ message: t("panels.browser.openExternalFailed"), variant: "error" });
    }
  }, [runtime, t, toast, url]);

  const copyCurrentAddress = useCallback(async (): Promise<void> => {
    if (url === NEW_TAB) return;
    const copied = await (runtime?.copyText ?? copyText)(url);
    toast({
      message: t(copied ? "panels.browser.addressCopied" : "panels.browser.copyAddressFailed"),
      variant: copied ? "success" : "error",
    });
  }, [runtime, t, toast, url]);

  return (
    <>
      <Input
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onNavigate(draft);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) return;
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onMouseDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && isExternalHttpUrl(url)) e.preventDefault();
        }}
        onClick={(e) => {
          if (!e.metaKey && !e.ctrlKey) return;
          if (!isExternalHttpUrl(url)) return;
          e.preventDefault();
          void openExternally();
        }}
        placeholder={t("panels.browser.addressPlaceholder")}
        className="h-8 min-w-0 flex-1"
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t("panels.browser.copyAddress"),
              disabled: url === NEW_TAB,
              onClick: () => void copyCurrentAddress(),
            },
            {
              label: t("panels.browser.openAddressExternally"),
              disabled: !isExternalHttpUrl(url),
              onClick: () => void openExternally(),
            },
          ]}
        />
      )}
    </>
  );
}

/**
 * Built-in browser, modeled on Codex: Electron <webview> (own process +
 * persistent partition) with a self-drawn address bar, tabs, and a
 * localhost bookmark list discovered by port-probing common dev ports.
 */
export function BrowserPanel({
  initialUrl,
  openUrl,
  anchors,
  onAnchor,
  onRemoveAnchor,
  onUpdateAnchor,
  showPopout = true,
  visible = true,
  partition,
  bucket,
  engineSessionId,
}: Props) {
  const { t } = useT();
  const toast = useToast();
  const emitAnchor = onAnchor ?? addAnchor;

  const {
    tabs,
    activeId,
    active,
    nav,
    viewRef,
    tabViewRef,
    setActiveId,
    patchTab,
    closeTab,
    openInNewTab,
    navigate,
  } = useBrowserTabs(initialUrl, openUrl, bucket);

  const showingNewTab = active.url === NEW_TAB;

  // Element-picking ("圈选").
  const { selecting, picked, setPicked, startPicking } = useElementPicking(
    viewRef,
    active.url,
    activeId,
  );

  // Which marker is open for editing (anchor id), if any. Pure UI state — the
  // markers themselves are derived from the `anchors` prop (single source).
  const [editingMarker, setEditingMarker] = useState<string | null>(null);
  const {
    status: handoff,
    busy: handoffBusy,
    error: handoffError,
    unavailable: handoffUnavailable,
    select: selectRuntimeTarget,
    revoke: revokeRuntimeTarget,
  } = useBrowserSessionTarget(engineSessionId, bucket, partition);
  const [readyGuests, setReadyGuests] = useState<Record<string, number>>({});
  const chromeScope = useMemo(
    () => ({ engineSessionId, bucket, partition }),
    [engineSessionId, bucket, partition],
  );
  const currentChromeScope = useRef<typeof chromeScope | null>(chromeScope);
  currentChromeScope.current = chromeScope;
  const [chromeState, setChromeState] = useState<{
    scope: typeof chromeScope;
    status: ChromeBrowserRuntimeStatus;
  }>({
    scope: chromeScope,
    status: { sessionId: engineSessionId ?? "", connected: false },
  });
  const chromeRuntime =
    chromeState.scope === chromeScope
      ? chromeState.status
      : { sessionId: engineSessionId ?? "", connected: false };
  const [chromePending, setChromePending] = useState<typeof chromeScope | null>(null);
  const chromeBusy = chromePending === chromeScope;
  const [chromeExtensionPath, setChromeExtensionPath] = useState<string | undefined>();

  const handleGuestDomReady = useCallback((id: string, guestId: number) => {
    setReadyGuests((previous) =>
      previous[id] === guestId ? previous : { ...previous, [id]: guestId },
    );
  }, []);
  const handleGuestUnavailable = useCallback((id: string) => {
    setReadyGuests((previous) => {
      if (!(id in previous)) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);
  const activeGuestId = readyGuests[activeId];
  const activeGuestReady = activeGuestId !== undefined && !showingNewTab;
  const currentTabSelected =
    handoff.granted &&
    handoff.guestId === activeGuestId &&
    handoff.expiresAt === undefined &&
    !handoffUnavailable;

  useEffect(() => {
    let cancelled = false;
    currentChromeScope.current = chromeScope;
    if (!engineSessionId) {
      setChromeState({ scope: chromeScope, status: { sessionId: "", connected: false } });
      return;
    }
    const refresh = () => {
      void window.codeshell
        .getChromeBrowserRuntimeStatus(engineSessionId)
        .then((chrome) => {
          if (!cancelled && chrome.sessionId === engineSessionId)
            setChromeState({ scope: chromeScope, status: chrome });
        })
        .catch(() => {
          if (!cancelled)
            setChromeState({
              scope: chromeScope,
              status: { sessionId: engineSessionId, connected: false },
            });
        });
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      if (currentChromeScope.current === chromeScope) currentChromeScope.current = null;
      clearInterval(timer);
    };
  }, [engineSessionId, chromeScope]);

  const toggleChromeRuntime = useCallback(async (): Promise<void> => {
    if (!engineSessionId || chromeBusy) return;
    setChromePending(chromeScope);
    try {
      if (chromeRuntime.granted || chromeRuntime.pairing) {
        const status = await window.codeshell.revokeChromeBrowserRuntime(engineSessionId);
        if (currentChromeScope.current !== chromeScope) return;
        setChromeState({ scope: chromeScope, status });
        toast({ message: t("panels.browser.chromeRevoked"), variant: "success" });
        return;
      }
      const [status, installation] = await Promise.all([
        window.codeshell.beginChromeBrowserRuntimePairing({ sessionId: engineSessionId }),
        window.codeshell.getChromeBrowserRuntimeInstallation(),
      ]);
      if (currentChromeScope.current !== chromeScope) return;
      setChromeState({ scope: chromeScope, status });
      setChromeExtensionPath(installation.extensionPath);
      toast({
        message: t("panels.browser.chromePairingStarted", {
          code: status.pairing?.code ?? "—",
        }),
        variant: "success",
      });
    } catch (error) {
      if (currentChromeScope.current !== chromeScope) return;
      toast({
        message: `${t("panels.browser.chromeFailed")}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        variant: "error",
      });
    } finally {
      setChromePending((pending) => (pending === chromeScope ? null : pending));
    }
  }, [
    chromeScope,
    chromeBusy,
    chromeRuntime.granted,
    chromeRuntime.pairing,
    engineSessionId,
    t,
    toast,
  ]);

  const markers = useMemo(() => browserMarkersFrom(anchors ?? []), [anchors]);
  // Markers belong to a page; hide them when not on that URL.
  const visibleMarkers = useMemo(
    () => visibleMarkersOn(markers, active.url),
    [markers, active.url],
  );

  // The edited anchor can disappear underneath us (removed in the composer /
  // another window, or cleared on send) — drop the editing state with it.
  useEffect(() => {
    if (editingMarker && !markers.some((m) => m.anchor.id === editingMarker)) {
      setEditingMarker(null);
    }
  }, [editingMarker, markers]);

  const openExternally = useCallback(
    async (url: string): Promise<void> => {
      if (!isExternalHttpUrl(url)) return;
      try {
        await window.codeshell.openExternal(url);
      } catch {
        toast({ message: t("panels.browser.openExternalFailed"), variant: "error" });
      }
    },
    [t, toast],
  );

  // Shared echo engine: edit-time outline + dom-ready replay + miss reporting.
  const { selectorMissFor } = useMarkerEcho(viewRef, visibleMarkers, editingMarker);

  return (
    <div className="@container/browser-panel flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        {/* Tabs scroll horizontally when they overflow; the + button stays
            pinned (shrink-0) so it's always reachable. Each tab is shrink-0 so
            they keep their width instead of squishing into unreadable slivers. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex w-[180px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${
                tab.id === activeId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-1 p-0 hover:bg-transparent"
                onClick={() => setActiveId(tab.id)}
              >
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {tab.title === NEW_TAB_TITLE ? t("panels.browser.newTab") : tab.title}
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={() => closeTab(tab.id)}
                aria-label={t("panels.common.closeTab")}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => openInNewTab(NEW_TAB)}
          aria-label={t("panels.browser.newTab")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Address bar */}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <IconBtn
          disabled={!nav.canGoBack}
          onClick={() => viewRef.current?.goBack()}
          label={t("panels.browser.back")}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          disabled={!nav.canGoForward}
          onClick={() => viewRef.current?.goForward()}
          label={t("panels.browser.forward")}
        >
          <ArrowRight className="h-4 w-4" />
        </IconBtn>
        <IconBtn onClick={() => viewRef.current?.reload()} label={t("panels.browser.refresh")}>
          <RotateCw className={`h-4 w-4 ${nav.loading ? "animate-spin" : ""}`} />
        </IconBtn>
        <BrowserAddressField
          url={active.url}
          draft={active.draft}
          onDraftChange={(draft) => patchTab(activeId, { draft })}
          onNavigate={navigate}
        />
        <div className="flex min-w-0 items-center gap-1 @max-[560px]/browser-panel:w-full @max-[560px]/browser-panel:justify-end">
          <IconBtn
            onClick={() => void startPicking()}
            disabled={active.url === NEW_TAB || selecting}
            label={selecting ? t("panels.browser.picking") : t("panels.browser.pickElement")}
            active={selecting}
          >
            <MousePointerSquareDashed className="h-4 w-4" />
          </IconBtn>
          {markers.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="relative h-8 gap-1 px-1.5 text-muted-foreground"
                  title={t("panels.browser.markers", {
                    total: markers.length,
                    visible: visibleMarkers.length,
                  })}
                >
                  <MapPin className="h-4 w-4" />
                  <span className="text-xs tabular-nums">{markers.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
                {groupMarkersByPage(markers).map((group, gi) => (
                  <React.Fragment key={group.url}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                      {group.title}
                      {urlsMatch(group.url, active.url) ? t("panels.browser.onThisPage") : ""}
                    </DropdownMenuLabel>
                    {group.markers.map((m) => (
                      <DropdownMenuItem
                        key={m.anchor.id}
                        onSelect={() => {
                          // Same page: just open the marker. Another page:
                          // navigate there first — the echo engine re-highlights
                          // after dom-ready, and the dot appears once
                          // active.url matches.
                          if (!urlsMatch(group.url, active.url)) navigate(group.url);
                          setEditingMarker(m.anchor.id);
                        }}
                      >
                        <span className="truncate">
                          <span className="font-medium">{m.anchor.label}</span>
                          {m.anchor.comment ? ` · ${m.anchor.comment}` : ""}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {showPopout && (
            <IconBtn
              onClick={() =>
                void window.codeshell.openBrowserPopout(
                  active.url === NEW_TAB ? undefined : active.url,
                )
              }
              label={t("panels.browser.popout")}
            >
              <PictureInPicture2 className="h-4 w-4" />
            </IconBtn>
          )}
          {engineSessionId && (
            <Button
              type="button"
              variant={currentTabSelected ? "secondary" : "outline"}
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2 text-xs"
              onClick={() => {
                if (activeGuestReady) void selectRuntimeTarget(activeGuestId);
              }}
              disabled={!activeGuestReady || handoffBusy || currentTabSelected}
              title={t("panels.browser.handoffSelectionHint")}
              aria-label={t(
                currentTabSelected
                  ? "panels.browser.handoffSelected"
                  : "panels.browser.grantRuntimeHandoff",
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t(
                currentTabSelected
                  ? "panels.browser.handoffSelected"
                  : "panels.browser.grantRuntimeHandoff",
              )}
            </Button>
          )}
          {engineSessionId && (
            <IconBtn
              onClick={() => void toggleChromeRuntime()}
              disabled={chromeBusy}
              label={t(
                chromeRuntime.granted || chromeRuntime.pairing
                  ? "panels.browser.revokeChromeRuntime"
                  : "panels.browser.connectChromeRuntime",
              )}
              active={Boolean(chromeRuntime.granted || chromeRuntime.pairing)}
            >
              <PlugZap className="h-4 w-4" />
            </IconBtn>
          )}
          <IconBtn
            onClick={() => void openExternally(active.url)}
            label={t("panels.browser.openExternal")}
          >
            <ExternalLink className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>

      {handoff.granted && (
        <div className="flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={handoff.url}>
            {handoffUnavailable
              ? t("panels.browser.handoffUnavailable")
              : t("panels.browser.handoffActive", { title: handoff.title || handoff.url || "" })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={handoffBusy}
            onClick={() => void revokeRuntimeTarget()}
          >
            {t("panels.browser.revokeRuntimeHandoff")}
          </Button>
        </div>
      )}

      {handoffError && (
        <div
          role="alert"
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive"
        >
          {t("panels.browser.handoffFailed")}: {handoffError}
        </div>
      )}

      {chromeRuntime.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground"
        >
          {t("panels.browser.chromeFailed")}: {chromeRuntime.error}
        </div>
      )}

      {(chromeRuntime.pairing || chromeRuntime.granted) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs text-foreground">
          <span>
            {chromeRuntime.granted
              ? t("panels.browser.chromeActive", { title: chromeRuntime.granted.title || "Chrome" })
              : t("panels.browser.chromePairing", { code: chromeRuntime.pairing?.code ?? "—" })}
          </span>
          <div className="flex items-center gap-1">
            {chromeRuntime.pairing && chromeExtensionPath && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => void window.codeshell.revealInFinder(chromeExtensionPath)}
              >
                {t("panels.browser.openChromeExtensionFolder")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={chromeBusy}
              onClick={() => void toggleChromeRuntime()}
            >
              {t("panels.browser.revokeChromeRuntime")}
            </Button>
          </div>
        </div>
      )}

      {selecting && (
        <div className="shrink-0 border-b border-border bg-primary/10 px-3 py-1 text-xs text-foreground">
          {t("panels.browser.pickHint")}
        </div>
      )}

      {/* Content: webview or the new-tab landing (localhost bookmarks). The
          element-pick comment box + saved markers float over the page. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {showingNewTab && <NewTabLanding onOpen={navigate} />}
        {tabs
          .filter((tab) => tab.url !== NEW_TAB)
          .map((tab) => (
            <BrowserTabGuest
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              visible={visible && tab.id === activeId}
              keepAlive={handoff.granted && handoff.guestId === readyGuests[tab.id]}
              viewRef={tabViewRef(tab.id)}
              partition={partition}
              bucket={bucket}
              engineSessionId={engineSessionId}
              onDomReady={handleGuestDomReady}
              onUnavailable={handleGuestUnavailable}
            />
          ))}

        {/* Load-failure overlay. The <webview> renders blank on a failed load,
            so we cover it with our own message + retry rather than leave the user
            staring at a white panel (refused localhost dev server, DNS miss…). */}
        {active.url !== NEW_TAB && active.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
            <Globe className="h-10 w-10 text-muted-foreground/50" />
            <div className="text-sm font-medium text-foreground">
              {t("panels.browser.cannotAccess")}
            </div>
            <div className="max-w-md break-all text-xs text-muted-foreground">
              {active.error.url}
            </div>
            <div className="text-xs text-muted-foreground">
              {/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(active.error.url)
                ? t("panels.browser.localhostDown")
                : t("panels.browser.connectionFailed")}
              <span className="ml-1 opacity-60">
                ({active.error.desc || t("panels.browser.errorCode", { code: active.error.code })})
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const view = viewRef.current;
                  const target = active.error?.url ?? active.url;
                  patchTab(activeId, { error: undefined });
                  if (view) void view.loadURL(target).catch(() => undefined);
                }}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" /> {t("panels.common.retry")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void openExternally(active.error?.url ?? active.url)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />{" "}
                {t("panels.browser.openWithSystemBrowser")}
              </Button>
            </div>
          </div>
        )}

        {/* Saved comment dots over the page (derived from the anchors prop —
            every browser surface shows the same set). Click to edit/delete. */}
        {visibleMarkers.map((m, i) => (
          <MarkerDot
            key={m.anchor.id}
            index={i + 1}
            marker={m}
            editing={editingMarker === m.anchor.id}
            selectorMissed={selectorMissFor === m.anchor.id}
            onOpen={() => setEditingMarker(editingMarker === m.anchor.id ? null : m.anchor.id)}
            onDelete={() => {
              onRemoveAnchor?.(m.anchor.id);
              setEditingMarker(null);
            }}
            onUpdateComment={onUpdateAnchor ? (c) => onUpdateAnchor(m.anchor.id, c) : undefined}
          />
        ))}

        {/* Floating comment box for a freshly-picked element, near its rect. */}
        {picked && (
          <FloatingAt rect={picked.rect}>
            <CommentBox
              title={`${picked.tag}${picked.id ? "#" + picked.id : ""}`}
              onCancel={() => setPicked(null)}
              onSubmit={(comment) => {
                const label = picked.id
                  ? `${picked.tag}#${picked.id}`
                  : picked.labelHint || picked.selector.split(" > ").pop() || picked.tag;
                // Single source of truth: emit the anchor WITH its echo payload;
                // the dot appears when the anchor flows back via the anchors
                // prop (App state / hub broadcast) — no local marker copy.
                emitAnchor({
                  kind: "browser",
                  label,
                  locator: {
                    网址: picked.url,
                    选择器: picked.selector,
                    元素: picked.tag + (picked.className ? ` .${picked.className}` : ""),
                    ...(picked.text ? { 文本: picked.text } : {}),
                    尺寸: `${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`,
                  },
                  comment,
                  browser: {
                    url: picked.url,
                    pageTitle:
                      picked.pageTitle ??
                      (active.title !== NEW_TAB_TITLE ? active.title : undefined),
                    selector: picked.selector,
                    rect: picked.rect,
                  },
                });
                setPicked(null);
              }}
            />
          </FloatingAt>
        )}
      </div>
    </div>
  );
}

/** Keep unsent forms and history through quick tab switches; reclaim an idle
 * tab's renderer using the same five-minute policy as a hidden browser panel. */
function BrowserTabGuest({
  tab,
  active,
  visible,
  keepAlive,
  viewRef,
  partition,
  bucket,
  engineSessionId,
  onDomReady,
  onUnavailable,
}: {
  tab: Tab;
  active: boolean;
  visible: boolean;
  keepAlive: boolean;
  viewRef: React.RefCallback<WebviewElement>;
  partition?: string;
  bucket?: string;
  engineSessionId?: string | null;
  onDomReady: (id: string, guestId: number) => void;
  onUnavailable: (id: string) => void;
}) {
  const evicted = useIdleEvict(visible || keepAlive);
  const guestPartition = partition ?? "persist:browser";
  const guestView = useRef<WebviewElement | null>(null);
  const attachView = useCallback(
    (view: WebviewElement | null) => {
      guestView.current = view;
      viewRef(view);
    },
    [viewRef],
  );
  const ready = useCallback(() => {
    try {
      const guestId = guestView.current?.getWebContentsId?.();
      if (Number.isSafeInteger(guestId) && guestId && guestId > 0) onDomReady(tab.id, guestId);
    } catch {
      onUnavailable(tab.id);
    }
  }, [onDomReady, onUnavailable, tab.id]);
  useEffect(() => {
    // A replacement guest must earn its own dom-ready before browser handoff.
    onUnavailable(tab.id);
    return () => onUnavailable(tab.id);
  }, [guestPartition, onUnavailable, tab.id]);
  useEffect(() => {
    if (evicted) onUnavailable(tab.id);
  }, [evicted, onUnavailable, tab.id]);
  return (
    <div className="absolute inset-0" hidden={!active} aria-hidden={!active || undefined}>
      {!evicted && (
        <WebviewHost
          key={guestPartition}
          ref={attachView}
          initialUrl={tab.url}
          partition={partition}
          bucket={bucket}
          engineSessionId={engineSessionId}
          onDomReady={ready}
          active={active}
        />
      )}
    </div>
  );
}
