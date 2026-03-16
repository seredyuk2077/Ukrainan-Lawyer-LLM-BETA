/**
 * U1 Queue — InMemoryQueue (LEX-73, LEX-80)
 * Async buffered: enqueue returns immediately after accepting event; handlers run in background.
 * API 202 Accepted is not blocked by consumer execution.
 */
import type { RunEvent } from './types.js';

export interface TaskQueue {
  enqueue(event: RunEvent): Promise<void>;
  shutdown?(): Promise<void>;
}

type EventHandler = (event: RunEvent) => void | Promise<void>;

export class InMemoryQueue implements TaskQueue {
  private handlers: EventHandler[] = [];
  private buffer: RunEvent[] = [];
  private drainScheduled = false;

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Enqueue: append to buffer and return immediately. Handlers are invoked asynchronously. */
  async enqueue(event: RunEvent): Promise<void> {
    this.buffer.push(event);
    this.scheduleDrain();
  }

  async shutdown(): Promise<void> {
    this.handlers = [];
    this.buffer = [];
    this.drainScheduled = false;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.handlers.length === 0 || this.buffer.length === 0) return;
    this.drainScheduled = true;
    setImmediate(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0 && this.handlers.length > 0) {
      const event = this.buffer.shift()!;
      for (const h of this.handlers) {
        try {
          await h(event);
        } catch (err) {
          console.error('[InMemoryQueue] handler error:', err);
        }
      }
    }
    this.drainScheduled = false;
  }
}
