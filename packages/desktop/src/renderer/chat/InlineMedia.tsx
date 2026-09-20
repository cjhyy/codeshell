import React, { useEffect, useRef, useState } from "react";
import { FileAudio, FileVideo, MoreHorizontal, RotateCcw } from "lucide-react";
import type { MediaPreviewResult } from "../../shared/media-preview";
import type { SessionUiAuthority } from "../sessionUiAuthority";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { OpenWithMenu } from "./OpenWithMenu";

interface Props {
  path: string;
  kind: "audio" | "video";
  cwd?: string | null;
  sessionId?: string | null;
  sessionMainRootId?: string | null;
  rootStatus?: SessionUiAuthority["rootStatus"];
  label?: string;
}

// Starting another chat player pauses the previous one, including players in
// tool cards. Keep this local to chat; browser/Panel playback is independent.
let playingMedia: HTMLMediaElement | null = null;

export function InlineMedia(props: Props) {
  // A moved Session must never briefly display a previous root's URL while an
  // effect catches up. Remount the lease owner on any authority/path change.
  const identity = JSON.stringify([
    props.sessionId,
    props.sessionMainRootId,
    props.rootStatus,
    props.cwd,
    props.path,
    props.kind,
  ]);
  return <MediaPlayer key={identity} {...props} />;
}

function MediaPlayer({ path, kind, cwd, sessionId, sessionMainRootId, rootStatus, label }: Props) {
  const { t } = useT();
  const containerRef = useRef<HTMLSpanElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<MediaPreviewResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const filename = path.replace(/\\/g, "/").split("/").pop() || path;
  const name = label?.trim() || preview?.name || filename;
  const authorityAvailable = Boolean(sessionId) && (rootStatus == null || rootStatus === "ok");

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !authorityAvailable || !sessionId) return;
    const bridge = window.codeshell;
    if (typeof bridge?.getMediaPreview !== "function") {
      setStatus("unavailable");
      return;
    }
    let disposed = false;
    let lease: string | null = null;
    const release = (url: string) => {
      void bridge.releaseMediaPreview(url).catch(() => undefined);
    };
    setPreview(null);
    setStatus("loading");
    void bridge
      .getMediaPreview({
        sessionId,
        path,
        ...(sessionMainRootId ? { rootId: sessionMainRootId } : {}),
      })
      .then((result) => {
        if (disposed) {
          if (result) release(result.url);
          return;
        }
        if (!result || result.kind !== kind) {
          if (result) release(result.url);
          setStatus("unavailable");
          return;
        }
        lease = result.url;
        setPreview(result);
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) setStatus("unavailable");
      });
    return () => {
      disposed = true;
      if (lease) release(lease);
    };
  }, [visible, authorityAvailable, sessionId, sessionMainRootId, path, kind, attempt]);

  // Callback refs are detached before effect cleanup; capture the actual node
  // when it mounts so a removed player cannot continue playing in the background.
  const attachMedia = React.useCallback((node: HTMLMediaElement | null) => {
    const previous = mediaRef.current;
    if (previous && previous !== node) {
      previous.pause?.();
      previous.removeAttribute("src");
      previous.load?.();
      if (playingMedia === previous) playingMedia = null;
    }
    mediaRef.current = node;
  }, []);

  const onPlay = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    if (playingMedia && playingMedia !== event.currentTarget) playingMedia.pause();
    playingMedia = event.currentTarget;
  };
  const Icon = kind === "audio" ? FileAudio : FileVideo;
  const unavailable = !authorityAvailable || status === "unavailable";
  const failed = unavailable || status === "error";

  return (
    <span
      ref={containerRef}
      className="my-2 inline-flex w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-muted/20 align-top"
      role="group"
      aria-label={t(kind === "audio" ? "msg.media.audio" : "msg.media.video", { name })}
      data-media-kind={kind}
    >
      <span className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
          {name}
        </span>
        {preview && authorityAvailable && (
          <OpenWithMenu path={path} cwd={cwd} align="end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              title={t("msg.tool.openWith")}
              aria-label={t("msg.tool.openWith")}
            >
              <MoreHorizontal size={14} />
            </Button>
          </OpenWithMenu>
        )}
      </span>
      {preview && !failed ? (
        kind === "audio" ? (
          <audio
            ref={attachMedia}
            className="block w-full min-w-0 px-2 pb-2"
            src={preview.url}
            controls
            preload="none"
            aria-label={name}
            onPlay={onPlay}
            onError={() => setStatus("error")}
          />
        ) : (
          <video
            ref={attachMedia}
            className="block aspect-video max-h-80 w-full bg-black object-contain"
            src={preview.url}
            controls
            playsInline
            preload="none"
            aria-label={name}
            onPlay={onPlay}
            onError={() => setStatus("error")}
          />
        )
      ) : (
        <span className="flex min-h-12 items-center justify-between gap-2 px-3 pb-2 text-xs text-muted-foreground">
          <span role="status">
            {unavailable
              ? t("msg.media.unavailable")
              : status === "error"
                ? t("msg.media.playbackFailed")
                : t("msg.media.loading")}
          </span>
          {failed && authorityAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw size={12} />
              {t("msg.media.retry")}
            </Button>
          )}
        </span>
      )}
    </span>
  );
}
