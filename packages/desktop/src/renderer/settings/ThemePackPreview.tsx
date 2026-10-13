import React from "react";
import type { ThemePack, ThemeSurfaceName, ThemeVars } from "../theme-packs";
import { resolveThemeSurface } from "../theme-appearance";

/** A miniature window uses the pack's own surfaces in each appearance mode. */
export function ThemePackPreview({ pack }: { pack: ThemePack }) {
  return (
    <span aria-hidden="true" className="block w-full" data-theme-preview={pack.id}>
      <PreviewMode pack={pack} mode="light" className="dark:hidden" />
      <PreviewMode pack={pack} mode="dark" className="hidden dark:block" />
    </span>
  );
}

function PreviewMode({
  pack,
  mode,
  className,
}: {
  pack: ThemePack;
  mode: "light" | "dark";
  className: string;
}) {
  const colors = pack.colors[mode];
  const basePalette: ThemeVars = {
    "--cs-background": mode === "light" ? "240 20% 99%" : "240 9% 5.5%",
    "--cs-muted": mode === "light" ? "240 6% 95.5%" : "240 4% 15%",
    "--cs-card": mode === "light" ? "0 0% 100%" : "240 7% 8.5%",
    ...colors,
  };
  const foreground = colors["--cs-foreground"] ?? (mode === "light" ? "240 6% 18%" : "0 0% 92%");
  const accent = colors["--cs-primary"] ?? pack.swatch;
  const surface = (name: ThemeSurfaceName) => {
    const resolved = resolveThemeSurface(pack, name, mode, basePalette);
    return {
      ...resolved,
      color: `hsl(${resolved.background} / ${resolved.backgroundOpacity})`,
    };
  };
  const windowSurface = surface("window");
  const frame = pack.frame?.[mode] ?? pack.frame?.light ?? colors["--cs-border"] ?? accent;
  const paint = (name: "window" | "sidebar" | "titlebar" | "chat" | "composer") => {
    const layer = surface(name);
    return layer.image ? (
      <img
        src={layer.image}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{
          objectFit: layer.fit,
          objectPosition: layer.position,
          opacity: layer.opacity,
        }}
      />
    ) : null;
  };
  return (
    <span className={className}>
      <span
        className="relative block h-28 overflow-hidden rounded-lg border"
        style={{
          backgroundColor: windowSurface.color,
          color: `hsl(${foreground})`,
          borderColor: `hsl(${frame})`,
          borderWidth: pack.frame?.width ? Math.min(pack.frame.width, 3) : 1,
        }}
      >
        {paint("window")}
        <span className="relative flex h-full flex-col">
          <span
            className="relative flex h-5 shrink-0 items-center gap-1 border-b border-current/10 px-2"
            style={{ backgroundColor: surface("titlebar").color }}
          >
            {paint("titlebar")}
            <span className="relative size-1 rounded-full bg-current/30" />
            <span className="relative size-1 rounded-full bg-current/20" />
            <span className="relative size-1 rounded-full bg-current/20" />
          </span>
          <span className="flex min-h-0 flex-1">
            <span
              className="relative flex w-12 shrink-0 flex-col gap-2 overflow-hidden border-r border-current/10 p-2"
              style={{ backgroundColor: surface("sidebar").color }}
            >
              {paint("sidebar")}
              <span
                className="relative h-1 w-6 rounded-full"
                style={{ backgroundColor: `hsl(${accent})` }}
              />
              <span className="relative h-1 w-5 rounded-full bg-current/20" />
              <span className="relative h-1 w-6 rounded-full bg-current/10" />
            </span>
            <span
              className="relative flex min-w-0 flex-1 flex-col justify-between overflow-hidden p-2.5"
              style={{ backgroundColor: surface("chat").color }}
            >
              {paint("chat")}
              <span className="relative block space-y-1.5">
                <span
                  className="ml-auto block h-3 w-10 rounded-md"
                  style={{ backgroundColor: `hsl(${accent} / 0.2)` }}
                />
                <span className="block h-1 w-3/5 rounded-full bg-current/20" />
                <span className="block h-1 w-2/5 rounded-full bg-current/10" />
              </span>
              <span
                className="relative block h-4 overflow-hidden rounded border border-current/15"
                style={{ backgroundColor: surface("composer").color }}
              >
                {paint("composer")}
                <span
                  className="absolute right-1 top-1 size-1.5 rounded-sm"
                  style={{ backgroundColor: `hsl(${accent})` }}
                />
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}
