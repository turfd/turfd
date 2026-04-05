/** Dev-only timings for chunk streaming / mesh sync (see plan: Y-axis lag diagnosis). */
const DEV = import.meta.env.DEV;

export function chunkPerfLog(
  label: string,
  ms: number,
  detail?: Record<string, unknown>,
): void {
  if (DEV) {
    console.debug(`[chunkPerf] ${label}`, `${ms.toFixed(2)}ms`, detail ?? "");
  }
}

export function chunkPerfNow(): number {
  return performance.now();
}
