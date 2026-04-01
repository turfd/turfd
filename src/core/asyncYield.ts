/** Yields so the browser can paint / process input (used to spread chunk I/O + gen). */
export function yieldToNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
