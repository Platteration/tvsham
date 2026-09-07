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
      // The slot is handed straight over on release, so a waiter arrives already
      // counted and does not increment again.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      // Releasing the count before waking a waiter would let a request arriving
      // in between take the same slot, pushing both past the limit.
      if (next) next();
      else this.active--;
    }
  }
}
