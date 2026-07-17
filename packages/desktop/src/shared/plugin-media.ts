export interface PluginMediaAvailability {
  composerIcon: boolean;
  logo: boolean;
  logoDark: boolean;
  screenshotCount: number;
}

/** Bounded image payloads; author paths never cross the main/renderer boundary. */
export interface PluginMediaDto {
  composerIconDataUrl?: string;
  logoDataUrl?: string;
  logoDarkDataUrl?: string;
  screenshotDataUrls: string[];
}
