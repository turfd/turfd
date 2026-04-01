/** Generic acquire/release pool for short-lived objects in hot paths (particles, temp structs). */

export class ObjectPool<T> {
  private readonly _free: T[] = [];

  constructor(
    private readonly _factory: () => T,
    private readonly _reset: (item: T) => void,
    initialSize = 0,
  ) {
    for (let i = 0; i < initialSize; i++) {
      this._free.push(this._factory());
    }
  }

  acquire(): T {
    const item = this._free.pop();
    return item ?? this._factory();
  }

  release(item: T): void {
    this._reset(item);
    this._free.push(item);
  }
}
