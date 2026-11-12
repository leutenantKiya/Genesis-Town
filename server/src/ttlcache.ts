// Tiny read-through caches for public GET routes. Values are the untranslated JSON bodies; send() localizes per response.

/** Keyed cache with a time-to-live. Concurrent misses share one computation; clear() also drops results still being computed. */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  private gen = 0;
  private ttlMs: number; private now: () => number; private max: number;
  constructor(ttlMs: number, now: () => number = Date.now, max = 200) { this.ttlMs = ttlMs; this.now = now; this.max = max; }

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const gen = this.gen;
    const value = compute();
    const entry = { at: this.now(), value };
    this.entries.set(key, entry);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    // a clear() while computing means the answer may already be stale: the caller gets it, nobody else does
    void value.then(() => { if (gen !== this.gen && this.entries.get(key) === entry) this.entries.delete(key); }, () => {});
    return value;
  }

  clear() { this.gen++; this.entries.clear(); }
  get size() { return this.entries.size; }
}

/** Permanent cache with a size cap; the oldest entry goes first. */
export class BoundedCache<T> {
  private m = new Map<string, T>();
  private max: number;
  constructor(max = 500) { this.max = max; }
  get(key: string): T | undefined { return this.m.get(key); }
  set(key: string, v: T) {
    this.m.delete(key);
    this.m.set(key, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  get size() { return this.m.size; }
}
