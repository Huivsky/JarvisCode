/** Рассылка событий всем открытым окнам интерфейса (WebSocket) и внутренним подписчикам (трей). */
type Sink = (data: string) => void;
type Tap = (event: Record<string, unknown>) => void;

export class Bus {
  private sinks = new Set<Sink>();
  private taps = new Set<Tap>();
  add(s: Sink) {
    this.sinks.add(s);
    return () => this.sinks.delete(s);
  }
  tap(t: Tap) {
    this.taps.add(t);
    return () => this.taps.delete(t);
  }
  get size() {
    return this.sinks.size;
  }
  emit(event: Record<string, unknown>) {
    for (const t of this.taps) {
      try {
        t(event);
      } catch {}
    }
    if (!this.sinks.size) return;
    const data = JSON.stringify(event);
    for (const s of this.sinks) {
      try {
        s(data);
      } catch {}
    }
  }
}
