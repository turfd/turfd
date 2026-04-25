export type PerfReportExportResult = {
  outputPath: string;
};

function stampForFilename(now: Date): string {
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function buildPerfReportFilename(now: Date = new Date()): string {
  return `turfd-performance-report-${stampForFilename(now)}.json`;
}

export async function exportPerfReportJson(
  filename: string,
  report: unknown,
): Promise<PerfReportExportResult> {
  const serialized = JSON.stringify(report, null, 2);
  const bytes = new TextEncoder().encode(serialized);
  const nav = navigator as Navigator & {
    saveFile?: (filename: string, mimeType: string, bytes: Uint8Array) => Promise<string>;
  };
  if (typeof nav.saveFile === "function") {
    const outputPath = await nav.saveFile(filename, "application/json", bytes);
    return { outputPath };
  }
  const blob = new Blob([bytes], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { outputPath: `Downloads/${filename}` };
}
