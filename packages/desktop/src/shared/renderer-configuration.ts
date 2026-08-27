/**
 * Opaque renderer request for project-scoped configuration.
 *
 * Paths and root ids are deliberately absent. Main resolves a project to its
 * current primary and a Session to its persisted main-root binding.
 */
export type RendererConfigurationTarget =
  | { projectId: string }
  | { sessionId: string }
  | { noRepo: true };
