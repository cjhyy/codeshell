import type {
  ProfilePluginExportSelection,
  ProfilePluginExportSnapshot,
} from "@cjhyy/code-shell-core/internal";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";

export type { ProfilePluginExportSelection, ProfilePluginExportSnapshot };
export type ProfilePluginExportPreview = ProfilePluginExportSnapshot & { reviewToken: string };
export interface ProfilePluginExportApi {
  previewProfilePluginExport(
    name: string,
    target: RendererConfigurationTarget,
    selection: ProfilePluginExportSelection,
  ): Promise<ProfilePluginExportPreview>;
  cancelProfilePluginExport(reviewToken: string): Promise<void>;
  commitProfilePluginExport(
    reviewToken: string,
    target: RendererConfigurationTarget,
    acceptLosses: boolean,
  ): Promise<{ canceled: true } | { canceled: false; directoryName: string }>;
}
