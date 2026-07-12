import React from "react";
import { X } from "lucide-react";
import { useT } from "../i18n";

export const PET_OVERVIEW_MIN_WIDTH = 520;
export const PET_OVERVIEW_DEFAULT_WIDTH = 760;
export const PET_OVERVIEW_MAX_VIEWPORT_FRACTION = 0.72;
export const PET_OVERVIEW_WIDTH_STORAGE_KEY = "codeshell.pet.overviewWidth";

export function clampPetOverviewWidth(width: number, viewportWidth: number): number {
  const fallback = Number.isFinite(width) ? width : PET_OVERVIEW_DEFAULT_WIDTH;
  const maximum = Math.max(
    PET_OVERVIEW_MIN_WIDTH,
    Math.round(viewportWidth * PET_OVERVIEW_MAX_VIEWPORT_FRACTION),
  );
  return Math.min(maximum, Math.max(PET_OVERVIEW_MIN_WIDTH, fallback));
}

export function usePetOverviewWidth(): {
  width: number;
  beginResize: (startX: number) => void;
} {
  const [width, setWidth] = React.useState(() => {
    const saved = Number(globalThis.localStorage?.getItem(PET_OVERVIEW_WIDTH_STORAGE_KEY));
    const viewport = typeof window === "undefined" ? 1_440 : window.innerWidth;
    return clampPetOverviewWidth(saved > 0 ? saved : PET_OVERVIEW_DEFAULT_WIDTH, viewport);
  });
  const widthRef = React.useRef(width);
  const cleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    widthRef.current = width;
  }, [width]);
  React.useEffect(() => () => cleanupRef.current?.(), []);

  const beginResize = React.useCallback((startX: number) => {
    cleanupRef.current?.();
    const startWidth = widthRef.current;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    let disposed = false;
    const onMove = (event: MouseEvent): void => {
      const next = clampPetOverviewWidth(startWidth + (event.clientX - startX), window.innerWidth);
      widthRef.current = next;
      setWidth(next);
    };
    const cleanup = (persist: boolean): void => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onAbort);
      window.removeEventListener("pointercancel", onAbort);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      cleanupRef.current = null;
      if (persist) {
        globalThis.localStorage?.setItem(PET_OVERVIEW_WIDTH_STORAGE_KEY, String(widthRef.current));
      }
    };
    const onUp = (): void => cleanup(true);
    const onAbort = (): void => cleanup(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onAbort);
    window.addEventListener("pointercancel", onAbort);
    cleanupRef.current = () => cleanup(false);
  }, []);

  return { width, beginResize };
}

export interface PetOverviewPanelProps {
  width: number;
  onClose: () => void;
  onResizeStart?: (startX: number) => void;
  children?: React.ReactNode;
}

export function PetOverviewPanel({
  width,
  onClose,
  onResizeStart,
  children,
}: PetOverviewPanelProps) {
  const { t } = useT();
  return (
    <aside
      data-pet-overview="sidecar"
      role="complementary"
      aria-label={t("pet.overview.regionLabel")}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background shadow-sm"
      style={{ width }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("pet.overview.resize")}
        className="absolute right-0 top-0 z-20 h-full w-1 translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        onMouseDown={(event) => {
          event.preventDefault();
          onResizeStart?.(event.clientX);
        }}
      />
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <h1 tabIndex={-1} className="text-sm font-semibold outline-none">
          {t("pet.overview.title")}
        </h1>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("pet.overview.close")}
          title={t("pet.overview.close")}
        >
          <X size={16} />
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden min-[1180px]:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
        {children}
      </div>
    </aside>
  );
}
