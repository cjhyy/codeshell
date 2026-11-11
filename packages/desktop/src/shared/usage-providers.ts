/** Public discovery metadata. Credentials and local executable paths stay in Main. */
export interface UsageProviderDescriptor {
  id: string;
  displayName: string;
  source: "cli" | "model-connection";
  connectionCount?: number;
  quota: { supported: false } | { supported: true; queryCost: "none" | "minimal-usage" };
}
