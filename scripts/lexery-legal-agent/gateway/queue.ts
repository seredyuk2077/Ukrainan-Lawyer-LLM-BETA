/**
 * U1 Queue — InMemoryQueue (LEX-73, LEX-80)
 */
import type { RunEvent } from './types.js';

export interface TaskQueue {
  enqueue(event: RunEvent): Promise<void>;
}

type EventHandler = (event: RunEvent) => void | Promise<void>;

export class InMemoryQueue implements TaskQueue {
  private handlers: EventHandler[] = [];

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async enqueue(event: RunEvent): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(event);
      } catch (err) {
        console.error('[InMemoryQueue] handler error:', err);
      }
    }
  }
}
