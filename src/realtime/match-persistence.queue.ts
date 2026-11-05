/**
 * Runs async work strictly in order per key (match id), off the request path.
 * Different matches never wait for each other; one failing task never blocks
 * the next (tasks handle their own errors / retries).
 */
export class PerKeyQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  /** Resolves when everything queued so far (for [key], or all keys) has finished. */
  async flush(key?: string): Promise<void> {
    if (key) {
      await this.tails.get(key);
      return;
    }
    await Promise.all([...this.tails.values()]);
  }
}
