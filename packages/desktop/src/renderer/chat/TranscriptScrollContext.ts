import { createContext, useContext } from "react";

export type AnchoredLayoutChange = (anchor: HTMLElement, change: () => void) => void;

/** Each transcript owns its reading position, including nested and side chats. */
export const TranscriptScrollContext = createContext<AnchoredLayoutChange | null>(null);

const changeWithoutScroll: AnchoredLayoutChange = (_anchor, change) => change();

export function useAnchoredLayoutChange(): AnchoredLayoutChange {
  return useContext(TranscriptScrollContext) ?? changeWithoutScroll;
}
