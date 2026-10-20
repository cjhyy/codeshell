/** Keep discovery and resource publication ordered for each project's package selection. */
export class PanelAppDiscoveryQueue {
  private readonly pending = new Map<string, Promise<unknown>>();

  async read<T>(projectPath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(projectPath) ?? Promise.resolve();
    // A failed reader must not poison subsequent requests for this project.
    const request = previous.catch(() => {}).then(work);
    this.pending.set(projectPath, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(projectPath) === request) this.pending.delete(projectPath);
    }
  }
}
