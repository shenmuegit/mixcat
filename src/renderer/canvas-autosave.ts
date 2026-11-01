interface Save<T> { requestId: string; expectedRevision: number; value: T; }

// Keep an uncertain write intact so retries can use the store's durable receipt.
export class CanvasSaveQueue<T> {
  private saved: string;
  private signature: string;
  private pending?: Save<T>;
  private running?: Promise<boolean>;
  error: string | null = null;
  constructor(public revision: number, initial: T, private save: (request: Save<T>) => Promise<number>, private changed: () => void) {
    this.saved = this.signature = JSON.stringify(initial);
  }
  get dirty() { return !!this.pending || this.signature !== this.saved; }
  change(value: T) {
    const signature = JSON.stringify(value);
    if (signature === this.signature) return;
    this.signature = signature; this.changed();
  }
  flush(): Promise<boolean> {
    if (this.running) return this.running;
    this.error = null;
    this.running = this.drain().catch(error => { this.error = error instanceof Error ? error.message : String(error); return false; }).finally(() => { this.running = undefined; this.changed(); });
    return this.running;
  }
  private async drain() {
    while (this.dirty) {
      this.pending ??= { requestId: crypto.randomUUID(), expectedRevision: this.revision, value: JSON.parse(this.signature) };
      this.revision = await this.save(this.pending);
      this.saved = JSON.stringify(this.pending.value); this.pending = undefined;
      this.changed();
    }
    return true;
  }
}
