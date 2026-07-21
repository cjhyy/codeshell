import React from "react";
import { useT } from "../i18n";

export interface PetPageProps {
  children?: React.ReactNode;
}

/**
 * A first-class application page. Navigation owns whether this tree exists;
 * unlike the former overview overlay it never hides an already-mounted chat
 * surface underneath itself.
 */
export function PetPage({ children }: PetPageProps) {
  const { t } = useT();
  return (
    <section
      data-pet-page="standalone"
      aria-label={t("pet.overview.regionLabel")}
      className="mimi-page-shell @container/pet-page relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <h1 className="sr-only">{t("pet.overview.title")}</h1>
      {/* In the single-column layout the work pane keeps its natural height and
          the chat/composer consumes the remainder. Long-task growth therefore
          shrinks chat first; page scrolling begins only after chat reaches its
          360px minimum. The regular wide layout remains two fixed-height panes. */}
      <div className="mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 grid-cols-1 grid-rows-[auto_minmax(360px,1fr)] gap-4 overflow-y-auto p-4 @min-[1100px]/pet-page:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] @min-[1100px]/pet-page:grid-rows-1 @min-[1100px]/pet-page:overflow-hidden @min-[1440px]/pet-page:gap-5 @min-[1440px]/pet-page:p-5">
        {children}
      </div>
    </section>
  );
}
