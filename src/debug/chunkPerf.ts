/** Dev-only timings for chunk streaming / mesh sync (see plan: Y-axis lag diagnosis). */
const DEV = import.meta.env.DEV;

export function chunkPerfLog(
  label: string,
  ms: number,
  detail?: Record<string, unknown>,
): void {
  if (!DEV) {
    return;
  }
  if (detail === undefined) {
    console.debug(`[chunk-perf] ${label}: ${ms.toFixed(1)}ms`);
  } else {
    console.debug(`[chunk-perf] ${label}: ${ms.toFixed(1)}ms`, detail);
  }
}

export function chunkPerfNow(): number {
  return performance.now();
}
