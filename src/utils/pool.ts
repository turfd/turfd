/** Generic acquire/release pool for short-lived objects in hot paths (particles, temp structs). */

export class ObjectPool<T> {
  private readonly _free: T[] = [];
  private _activeCount = 0;
  private readonly _maxSize: number;

  constructor(
    private readonly _factory: () => T,
    private readonly _reset: (item: T) => void,
    initialSize = 0,
    maxSize = Infinity,
  ) {
    this._maxSize = maxSize;
    for (let i = 0; i < initialSize; i++) {
      this._free.push(this._factory());
    }
  }

  acquire(): T {
    this._activeCount += 1;
    const item = this._free.pop();
    return item ?? this._factory();
  }

  release(item: T): void {
    this._activeCount = Math.max(0, this._activeCount - 1);
    this._reset(item);
    if (this._free.length < this._maxSize) {
      this._free.push(item);
    }
  }

  getPoolStats(): { active: number; free: number } {
    return { active: this._activeCount, free: this._free.length };
  }
}
