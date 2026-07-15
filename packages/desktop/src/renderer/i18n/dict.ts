/**
 * UI translation dictionary (中文 / English) — assembled from per-area
 * namespace files under `./ns`.
 *
 * The **zh** tree is the source of truth — its shape drives the
 * `TranslationKey` type, so every key is statically checked at the call site
 * (`t("...")`). The `en` tree is a *partial* mirror: missing English entries
 * fall back to zh at runtime (see `translate.ts`), so you can add zh keys
 * first and translate later without breaking the build.
 *
 * --- How to add keys ---
 * Each namespace file in `./ns/<area>.ts` exports `{ zh, en } as const` with a
 * single distinct top-level key (e.g. `chat`, `panels`, `settingsAdvanced`).
 * Because every area owns its own top-level key there are NO collisions, so
 * `messages` is just a shallow spread of all namespaces — parallel work can add
 * new namespace files without touching `dict.ts` or each other.
 *
 * To add a new area:
 * 1. Create `./ns/<area>.ts` exporting `export const <area> = { zh: {...}, en: {...} } as const`
 *    using a unique top-level namespace key.
 * 2. Import it here and add it to both the `zh` and `en` spreads below.
 * 3. Use it: `const { t } = useT(); t("<area>.someKey")`.
 *    Interpolate `{name}`-style placeholders: `t("greeting.hello", { name: "Ada" })`.
 */

import { core } from "./ns/core";
import { chat } from "./ns/chat";
import { messagesNs } from "./ns/messages";
import { panels } from "./ns/panels";
import { settingsNs } from "./ns/settings";
import { extensions } from "./ns/extensions";
import { automation } from "./ns/automation";
import { misc } from "./ns/misc";
import { mobile } from "@cjhyy/code-shell-web";
import { pet } from "./ns/pet";
import { digitalHumans } from "./ns/digital-humans";

export const messages = {
  zh: {
    ...core.zh,
    ...chat.zh,
    ...messagesNs.zh,
    ...panels.zh,
    ...settingsNs.zh,
    ...extensions.zh,
    ...automation.zh,
    ...misc.zh,
    ...mobile.zh,
    ...pet.zh,
    ...digitalHumans.zh,
  },
  en: {
    ...core.en,
    ...chat.en,
    ...messagesNs.en,
    ...panels.en,
    ...settingsNs.en,
    ...extensions.en,
    ...automation.en,
    ...misc.en,
    ...mobile.en,
    ...pet.en,
    ...digitalHumans.en,
  },
} as const;

/**
 * Recursively flattens the nested zh tree into dotted key paths,
 * e.g. `{ common: { cancel: string } }` → `"common.cancel"`.
 */
type Dict = Record<string, unknown>;
type DottedKeys<T extends Dict, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Dict ? DottedKeys<T[K], `${Prefix}${K}.`> : `${Prefix}${K}`;
}[keyof T & string];

/** Type-safe union of every translation key, derived from the zh tree. */
export type TranslationKey = DottedKeys<typeof messages.zh>;

export type Messages = typeof messages;
