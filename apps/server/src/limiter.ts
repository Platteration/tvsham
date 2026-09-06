/** A minimal FIFO semaphore: at most `limit` tasks run at once, the rest wait their turn. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
