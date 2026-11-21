/** The workbench port advertises each supported read separately. Add a fixed
 * business method here and register its parser/implementation in the Host. */
export interface DesktopBusinessReads {
  "models/catalog": {
    params: Record<string, never>;
    result: ReturnType<typeof import("@cjhyy/code-shell-core/internal").getMergedCatalog>;
  };
  "models/catalogOrigins": {
    params: Record<string, never>;
    result: ReturnType<typeof import("@cjhyy/code-shell-core/internal").catalogEntryOrigins>;
  };
}
