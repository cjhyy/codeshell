import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { NEW_TAB, NEW_TAB_TITLE } from "../browser/types";
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
   * Electron webview partition for storage/session isolation. Passed per chat
   * session so one session's browsing (cookies, logged-in state, the live page)
   * doesn't bleed into another's — sessions each got the same global
   * `persist:browser` before, so switching sessions showed the prior session's
   * page. Defaults to the shared partition for the popout / legacy callers.
   */
  partition?: string;
  /** UI session bucket that owns this browser panel. Undefined for legacy/popout. */
  bucket?: string;
  /** Engine session id that should route automation to this bucket. */
  engineSessionId?: string | null;
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
    setActiveId,
    patchTab,
    closeTab,
    openInNewTab,
    navigate,
  } = useBrowserTabs(initialUrl, openUrl, bucket);

  // Idle-eviction: true once the panel has been hidden past IDLE_EVICT_MS. While
  // evicted the <webview> is unmounted (its renderer process freed); becoming
  // visible again clears this and remounts WebviewHost, reloading the tab url.
  const evicted = useIdleEvict(visible);

  // Element-picking ("圈选").
  const { selecting, picked, setPicked, startPicking } = useElementPicking(
    viewRef,
    active.url,
    activeId,
  );

  // Which marker is open for editing (anchor id), if any. Pure UI state — the
  // markers themselves are derived from the `anchors` prop (single source).
  const [editingMarker, setEditingMarker] = useState<string | null>(null);
  const [addressMenu, setAddressMenu] = useState<{ x: number; y: number } | null>(null);

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

  useEffect(() => setAddressMenu(null), [activeId, active.url]);

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

  const copyCurrentAddress = useCallback(async (): Promise<void> => {
    if (active.url === NEW_TAB) return;
    const copied = await copyText(active.url);
    toast({
      message: t(copied ? "panels.browser.addressCopied" : "panels.browser.copyAddressFailed"),
      variant: copied ? "success" : "error",
    });
  }, [active.url, t, toast]);

  // Shared echo engine: edit-time outline + dom-ready replay + miss reporting.
  const { selectorMissFor } = useMarkerEcho(viewRef, visibleMarkers, editingMarker);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
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
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
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
        <Input
          value={active.draft}
          onChange={(e) => patchTab(activeId, { draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(active.draft);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) return;
            setAddressMenu({ x: e.clientX, y: e.clientY });
          }}
          onMouseDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && isExternalHttpUrl(active.url)) e.preventDefault();
          }}
          onClick={(e) => {
            if (!e.metaKey && !e.ctrlKey) return;
            if (!isExternalHttpUrl(active.url)) return;
            e.preventDefault();
            void openExternally(active.url);
          }}
          placeholder={t("panels.browser.addressPlaceholder")}
          className="h-8 flex-1"
        />
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
        <IconBtn
          onClick={() => void openExternally(active.url)}
          label={t("panels.browser.openExternal")}
        >
          <ExternalLink className="h-4 w-4" />
        </IconBtn>
      </div>

      {selecting && (
        <div className="shrink-0 border-b border-border bg-primary/10 px-3 py-1 text-xs text-foreground">
          {t("panels.browser.pickHint")}
        </div>
      )}

      {/* Content: webview or the new-tab landing (localhost bookmarks). The
          element-pick comment box + saved markers float over the page. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {evicted ? (
          // Hidden past the idle window: the guest process was reclaimed. This
          // placeholder renders only while off-screen, so the user never sees
          // it — becoming visible clears `evicted` and remounts the webview,
          // which reloads `active.url` from its frozen src.
          <div className="flex min-h-0 flex-1 items-center justify-center" aria-hidden />
        ) : active.url === NEW_TAB ? (
          <NewTabLanding onOpen={navigate} />
        ) : (
          <WebviewHost
            // key per tab: one <webview> is mounted at a time, so without a
            // per-tab key React would reuse a single guest across tabs and
            // their navigation histories (canGoBack/Forward) would bleed
            // together. Keying by tab gives each its own guest + history — and
            // freezes the per-tab initial src (see WebviewHost) so the guest's
            // own redirects don't re-drive `src` into an ERR_ABORTED race.
            key={activeId}
            ref={viewRef}
            initialUrl={active.url}
            partition={partition}
            bucket={bucket}
            engineSessionId={engineSessionId}
          />
        )}

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

      {addressMenu && (
        <ContextMenu
          x={addressMenu.x}
          y={addressMenu.y}
          onClose={() => setAddressMenu(null)}
          items={[
            {
              label: t("panels.browser.copyAddress"),
              disabled: active.url === NEW_TAB,
              onClick: () => void copyCurrentAddress(),
            },
            {
              label: t("panels.browser.openAddressExternally"),
              disabled: !isExternalHttpUrl(active.url),
              onClick: () => void openExternally(active.url),
            },
          ]}
        />
      )}
    </div>
  );
}
