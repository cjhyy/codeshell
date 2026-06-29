import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "../i18n/I18nProvider";
import { pageAttribution, type BrowserMarker } from "./markerEcho";
import { useRectPopoverStyle } from "./ui";

/** A numbered dot at an element's rect; hover shows the comment, click edits. */
export function MarkerDot({
  index,
  marker,
  editing,
  selectorMissed,
  onOpen,
  onDelete,
  onUpdateComment,
}: {
  index: number;
  marker: BrowserMarker;
  editing: boolean;
  /** The echo engine couldn't re-find the element by selector — show the
   *  pick-time rect as an overlay box instead of (silently) nothing. */
  selectorMissed: boolean;
  onOpen: () => void;
  onDelete: () => void;
  /** Save an edited comment (absent → comment is read-only). */
  onUpdateComment?: (comment: string) => void;
}) {
  const { rect } = marker.echo;
  return (
    <>
      <Button
        type="button"
        onClick={onOpen}
        title={marker.anchor.comment}
        size="icon"
        className="group absolute z-30 h-5 w-5 rounded-full text-[10px] font-semibold shadow ring-2 ring-background"
        style={{ top: Math.max(2, rect.y - 8), left: Math.max(2, rect.x - 8) }}
      >
        {index}
      </Button>
      {editing && selectorMissed && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-20 rounded-sm border-2 border-primary/80"
          style={{ top: rect.y, left: rect.x, width: rect.width, height: rect.height }}
        />
      )}
      {editing && (
        <MarkerEditCard
          marker={marker}
          selectorMissed={selectorMissed}
          onClose={onOpen}
          onDelete={onDelete}
          onUpdateComment={onUpdateComment}
        />
      )}
    </>
  );
}

/**
 * The editable popover card for a saved marker. Lives in its own component so
 * the collision-aware positioning hook runs unconditionally (the card is
 * mounted only while editing).
 */
function MarkerEditCard({
  marker,
  selectorMissed,
  onClose,
  onDelete,
  onUpdateComment,
}: {
  marker: BrowserMarker;
  selectorMissed: boolean;
  onClose: () => void;
  onDelete: () => void;
  onUpdateComment?: (comment: string) => void;
}) {
  const { t } = useT();
  // Editable comment draft — seeded on open (and re-seeded when the comment
  // changes underneath us, e.g. edited in another window).
  const [draft, setDraft] = useState(marker.anchor.comment);
  useEffect(() => {
    setDraft(marker.anchor.comment);
  }, [marker.anchor.comment]);
  const dirty = draft !== marker.anchor.comment;
  const ref = useRef<HTMLDivElement>(null);
  const style = useRectPopoverStyle(marker.echo.rect, ref);
  return (
    <div
      ref={ref}
      className="absolute z-40 w-72 max-w-[90%] rounded-md border border-border bg-card p-2 shadow-lg"
      style={style}
    >
      <div className="mb-1 truncate text-xs font-medium text-muted-foreground">{marker.anchor.label}</div>
      <div className="mb-1 truncate text-[11px] text-muted-foreground/80">
        {marker.echo.pageTitle ? `${marker.echo.pageTitle} · ` : ""}
        {pageAttribution(marker.echo)}
      </div>
      {selectorMissed && (
        <div className="mb-1 text-[11px] text-status-warn">
          {t("panels.browser.selectorMissed")}
        </div>
      )}
      {onUpdateComment ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("panels.browser.commentPlaceholder")}
          className="mb-2 min-h-14 resize-y text-xs"
        />
      ) : (
        <div className="mb-2 whitespace-pre-wrap break-words text-xs text-foreground">
          {marker.anchor.comment}
        </div>
      )}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-status-err"
          onClick={onDelete}
        >
          {t("panels.common.delete")}
        </Button>
        {onUpdateComment && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!dirty}
            onClick={() => onUpdateComment(draft)}
          >
            {t("panels.common.save")}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClose}>
          {t("panels.common.close")}
        </Button>
      </div>
    </div>
  );
}
