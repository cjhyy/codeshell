/** Child browser bindings owned by one AgentBridge worker lifecycle. */
export class ChildBrowserWorkerLifetime {
  private readonly releases = new Map<string, () => void>();

  register(bindingKey: string, release: () => void): void {
    // Duplicate lifecycle notifications must not replace the original owner.
    if (!this.releases.has(bindingKey)) this.releases.set(bindingKey, release);
  }

  release(bindingKey: string): void {
    const release = this.releases.get(bindingKey);
    this.releases.delete(bindingKey);
    if (release) this.cleanup(release);
  }

  /** The same bridge may register a fresh set after its worker restarts. */
  close(): void {
    const releases = [...this.releases.values()];
    // Clear first: cleanup may re-enter release/close or start a new lifecycle.
    this.releases.clear();
    for (const release of releases) this.cleanup(release);
  }

  private cleanup(release: () => void): void {
    try {
      release();
    } catch {
      // A target already closing must not prevent the remaining children or
      // the worker's other exit handlers from being cleaned up.
    }
  }
}
