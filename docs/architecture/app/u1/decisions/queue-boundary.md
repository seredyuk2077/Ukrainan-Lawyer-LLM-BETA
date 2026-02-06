# ADR: Queue Consumer Boundary U1→U2 (LEX-80 Spike)

## Context

[U1-F] Queue Enqueue ставить задачі. Хто їх споживає? Потрібно визначити межу між U1 (Gateway) і U2 (Classify).

## Контракт події

```ts
interface RunEvent {
  run_id: string;
  step: "U2";
  created_at: string;  // ISO
  trace_id?: string;
}
```

## Рішення: In-Memory Queue + Same-Process Consumer (Dev)

1. **InMemoryQueue** — масив + `setImmediate` для async dispatch
2. **Consumer** — placeholder/stub: при enqueue викликається `onEvent` callback
3. **Для dev**: достатньо логувати подію; U2 handler — заглушка (не реалізовувати повністю)
4. **Інтерфейс** `TaskQueue`:
   - `enqueue(event: RunEvent): Promise<void>`
   - Можливість підписатись `queue.on('event', handler)` для consumer loop

## Межа U1→U2

- U1 тільки **enqueue** — не викликає U2 напряму
- Consumer (майбутній U2 worker) читає з черги
- В dev: InMemoryQueue може синхронно викликати stub handler для тестів

## Майбутнє

- Azure Service Bus / Redis Queue — імплементація того ж інтерфейсу
- Окремий worker процес для prod
