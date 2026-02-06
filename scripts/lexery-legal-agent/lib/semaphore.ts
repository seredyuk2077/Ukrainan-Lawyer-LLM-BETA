/**
 * Simple semaphore for limiting concurrency (U2 worker / LLM calls).
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(limit: number) {
    this.permits = Math.max(1, limit);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
    this.permits -= 1;
  }

  release(): void {
    this.permits += 1;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.waitQueue.length;
  }
}
