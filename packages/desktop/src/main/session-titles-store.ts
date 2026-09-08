/** Desktop adapter for the shared host-side session title registry. */
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { createSessionTitlesStore } from "@cjhyy/code-shell-server/storage";

const defaultFile = () => join(codeShellHome(), "desktop", "session-titles.json");
let store = createSessionTitlesStore(defaultFile());

/** Test-only isolation hook. */
export function __setSessionTitlesFileForTest(next: string | null): void {
  store = createSessionTitlesStore(next ?? defaultFile());
}
export const listTitles = () => store.listTitles();
export const setTitle = (id: string, title: string) => store.setTitle(id, title);
