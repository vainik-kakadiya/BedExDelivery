export type ChangeListener = (tables: string[]) => void;

/**
 * In-process fan-out of database change notifications (DSH-07).
 * server.ts feeds it from `LISTEN bedex_changes`; SSE connections subscribe.
 * Bursts are coalesced so a bulk import produces one event, not hundreds.
 */
export class ChangeFeed {
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly debounceMs = 300) {}

  publish(table: string): void {
    this.pending.add(table);
    this.timer ??= setTimeout(() => this.flush(), this.debounceMs);
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private flush(): void {
    const tables = [...this.pending].sort();
    this.pending.clear();
    this.timer = null;
    for (const listener of this.listeners) {
      try {
        listener(tables);
      } catch {
        // A broken connection must not stop delivery to the others.
      }
    }
  }
}
