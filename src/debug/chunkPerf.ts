/** Dev-only timings for chunk streaming / mesh sync (see plan: Y-axis lag diagnosis). */
const DEV = import.meta.env.DEV;

export function chunkPerfLog(
  label: string,
  ms: number,
  detail?: Record<string, unknown>,
): void {
  // Keep call sites intact while disabling noisy perf console output.
  void label;
  void ms;
  void detail;
  void DEV;
}

export function chunkPerfNow(): number {
  return performance.now();
}
