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
      className="mimi-page-shell relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <h1 className="sr-only">{t("pet.overview.title")}</h1>
      <div className="mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 min-[1100px]:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.85fr)] min-[1100px]:overflow-hidden min-[1440px]:gap-5 min-[1440px]:p-5">
        {children}
      </div>
    </section>
  );
}
