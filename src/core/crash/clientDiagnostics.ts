/**
 * Runtime diagnostics for crash/error reports (browser APIs only).
 */

export type ClientDiagnosticsSnapshot = {
  viewportCss: string;
  screenCss: string;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  maxTouchPoints: number;
  languages: string;
  timeZone: string;
  onLine: boolean;
  webglVendor: string;
  webglRenderer: string;
  storageUsedMb: number | null;
  storageQuotaMb: number | null;
};

function readWebGLStrings(): { vendor: string; renderer: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2", { powerPreference: "low-power" });
    const gl1 = gl2 ?? canvas.getContext("webgl", { powerPreference: "low-power" });
    const gl = gl2 ?? gl1;
    if (gl === null) {
      return { vendor: "no context", renderer: "no context" };
    }
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    let vendor: string;
    let renderer: string;
    if (ext !== null) {
      vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? "");
      renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    } else {
      vendor = String(gl.getParameter(gl.VENDOR) ?? "");
      renderer = String(gl.getParameter(gl.RENDERER) ?? "");
    }
    return {
      vendor: vendor.trim() || "unknown",
      renderer: renderer.trim() || "unknown",
    };
  } catch {
    return { vendor: "error", renderer: "error" };
  }
}

function readDeviceMemoryGb(): number | null {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gb = nav.deviceMemory;
  if (typeof gb === "number" && Number.isFinite(gb) && gb > 0) {
    return gb;
  }
  return null;
}

function readLanguages(): string {
  const langs = navigator.languages;
  if (langs !== undefined && langs.length > 0) {
    return langs.slice(0, 6).join(", ");
  }
  return navigator.language || "unknown";
}

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

export async function collectClientDiagnostics(): Promise<ClientDiagnosticsSnapshot> {
  const { vendor, renderer } = readWebGLStrings();
  let storageUsedMb: number | null = null;
  let storageQuotaMb: number | null = null;
  try {
    if (navigator.storage?.estimate !== undefined) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === "number" && Number.isFinite(est.usage)) {
        storageUsedMb = Math.round((est.usage / (1024 * 1024)) * 10) / 10;
      }
      if (typeof est.quota === "number" && Number.isFinite(est.quota)) {
        storageQuotaMb = Math.round((est.quota / (1024 * 1024)) * 10) / 10;
      }
    }
  } catch {
    /* ignore */
  }

  const cores = navigator.hardwareConcurrency;
  return {
    viewportCss: `${window.innerWidth}x${window.innerHeight}`,
    screenCss: `${screen.width}x${screen.height}`,
    devicePixelRatio: window.devicePixelRatio ?? 1,
    hardwareConcurrency: typeof cores === "number" && cores > 0 ? cores : null,
    deviceMemoryGb: readDeviceMemoryGb(),
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    languages: readLanguages(),
    timeZone: readTimeZone(),
    onLine: navigator.onLine,
    webglVendor: vendor,
    webglRenderer: renderer,
    storageUsedMb,
    storageQuotaMb,
  };
}
