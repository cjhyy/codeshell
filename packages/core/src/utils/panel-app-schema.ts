import { z } from "zod";

export const PANEL_APP_MANIFEST_FILE = ".codeshell-panel/panel.json";

/** Package references are identities, never caller-selected filesystem paths. */
export const PanelAppPackagePinSchema = z
  .object({
    version: z.string().min(1).max(80),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * When this project selected the package. A pin holds the project only until
     * the next global install or update of the app; pins without it are superseded.
     */
    pinnedAt: z.string().datetime().optional(),
  })
  .strict();
export const PanelAppPackagePinsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  PanelAppPackagePinSchema,
);
export type PanelAppPackagePin = z.infer<typeof PanelAppPackagePinSchema>;
