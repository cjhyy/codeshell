// Separate worker entry: Server is bundled into Desktop, rather than required
// as a production package at runtime. Core's extension registry stays external.
export { createLinkProviderModule } from "@cjhyy/code-shell-server/links";
