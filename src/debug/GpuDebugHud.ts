/**
 * In-game F3 overlay: frame time, approx WebGL draw calls when hooked, and static GL limits / GPU strings when a GL context exists.
 * Draw counts wrap only the main Pixi GL context; composite passes share the same context.
 */
import type { RenderPipeline } from "../renderer/RenderPipeline";
import { VIEW_DISTANCE_CHUNKS } from "../core/constants";
import { getVideoPrefs } from "../ui/settings/videoPrefs";

type GlLike = WebGLRenderingContext | WebGL2RenderingContext;

type HookState = {
  gl: GlLike;
  restore: () => void;
};

let hook: HookState | null = null;
let drawsThisFrame = 0;

function resetDrawCounter(): void {
  drawsThisFrame = 0;
}

function readDrawCount(): number {
  return drawsThisFrame;
}

function uninstallGlHooks(): void {
  if (hook === null) {
    return;
  }
  hook.restore();
  hook = null;
}

function installGlHooks(gl: GlLike): void {
  if (hook?.gl === gl) {
    return;
  }
  uninstallGlHooks();
  const originals: Array<{ key: string; fn: unknown }> = [];
  const wrap = (key: string): void => {
    const orig = (gl as unknown as Record<string, unknown>)[key];
    if (typeof orig !== "function") {
      return;
    }
    originals.push({ key, fn: orig });
    (gl as unknown as Record<string, unknown>)[key] = function (
      this: GlLike,
      ...args: unknown[]
    ) {
      drawsThisFrame += 1;
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  wrap("drawArrays");
  wrap("drawElements");
  wrap("drawArraysInstanced");
  wrap("drawElementsInstanced");
  if (typeof (gl as WebGL2RenderingContext).drawRangeElements === "function") {
    wrap("drawRangeElements");
  }
  hook = {
    gl,
    restore: () => {
      for (const { key, fn } of originals) {
        (gl as unknown as Record<string, unknown>)[key] = fn;
      }
    },
  };
}

function readGpuStrings(gl: GlLike): { vendor: string; renderer: string } {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (ext !== null) {
    return {
      vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)),
      renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)),
    };
  }
  return {
    vendor: String(gl.getParameter(gl.VENDOR)),
    renderer: String(gl.getParameter(gl.RENDERER)),
  };
}

function readStaticGlBlock(gl: GlLike): string {
  const lines: string[] = [];
  const gpu = readGpuStrings(gl);
  lines.push(`VENDOR  ${gpu.vendor}`);
  lines.push(`RENDER  ${gpu.renderer}`);
  lines.push(`GL      ${gl.getParameter(gl.VERSION)}`);
  lines.push(`SL      ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);
  lines.push(
    `MAX_TEX ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}  MAX_VP ${gl.getParameter(gl.MAX_VIEWPORT_DIMS)}`,
  );
  const extAniso = gl.getExtension("EXT_texture_filter_anisotropic");
  if (extAniso) {
    const max = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    lines.push(`ANISO   max ${max}`);
  }
  return lines.join("\n");
}

export class GpuDebugHud {
  private root: HTMLDivElement | null = null;
  private pre: HTMLPreElement | null = null;
  private open = false;
  private fpsEma = 0;
  private staticGl: string | null = null;

  init(mount: HTMLElement): void {
    if (this.root !== null) {
      return;
    }
    const root = document.createElement("div");
    root.id = "stratum-gpu-debug-hud";
    root.style.cssText = [
      "display:none",
      "position:fixed",
      "left:10px",
      "top:10px",
      "z-index:15000",
      "max-width:min(520px,calc(100vw - 24px))",
      "max-height:calc(100vh - 24px)",
      "overflow:auto",
      "box-sizing:border-box",
      "padding:10px 12px",
      "border-radius:10px",
      "border:1px solid rgba(255,255,255,0.18)",
      "background:rgba(12,12,18,0.92)",
      "color:#e8e8ef",
      "font:13px/1.45 ui-monospace,Menlo,Consolas,monospace",
      "pointer-events:none",
      "text-align:left",
      "white-space:pre-wrap",
      "word-break:break-word",
    ].join(";");
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:0;white-space:pre-wrap;font:inherit;";
    pre.textContent = "F3 — GPU debug";
    root.appendChild(pre);
    mount.appendChild(root);
    this.root = root;
    this.pre = pre;
  }

  /** Toggle overlay; installs draw hooks when opening with a WebGL context. */
  setOpen(next: boolean, pipeline: RenderPipeline | null): void {
    if (this.root === null || this.pre === null) {
      return;
    }
    if (next === this.open) {
      return;
    }
    this.open = next;
    this.root.style.display = next ? "block" : "none";
    if (next) {
      const gl = pipeline?.getWebGLContext() ?? null;
      if (gl !== null) {
        if (this.staticGl === null) {
          try {
            this.staticGl = readStaticGlBlock(gl);
          } catch {
            this.staticGl = "(failed to read GL parameters)";
          }
        }
        installGlHooks(gl);
      } else {
        this.staticGl =
          this.staticGl ??
          "No WebGL context on this renderer (Canvas2D, WebGPU, or unsupported). Draw-call counts from GL hooks are unavailable; use Chrome Performance with GPU for WebGPU.";
      }
      this.pre.textContent = this.buildText(pipeline, 0, 0, 0, "(warming up…)");
    } else {
      uninstallGlHooks();
      this.staticGl = null;
    }
  }

  toggle(pipeline: RenderPipeline | null): void {
    this.setOpen(!this.open, pipeline);
  }

  /** Call at the start of each frame before `RenderPipeline.render` while the HUD is open. */
  beginFrame(): void {
    if (!this.open) {
      return;
    }
    resetDrawCounter();
  }

  /**
   * Call after `RenderPipeline.render` with the same `dtSec` used for the game render tick.
   */
  sync(pipeline: RenderPipeline | null, dtSec: number): void {
    if (!this.open || this.pre === null) {
      return;
    }
    const draws = readDrawCount();
    const frameMs = dtSec > 0 ? dtSec * 1000 : 0;
    const instFps = dtSec > 0 ? 1 / dtSec : 0;
    this.fpsEma =
      this.fpsEma <= 0 ? instFps : this.fpsEma + (instFps - this.fpsEma) * 0.08;
    this.pre.textContent = this.buildText(
      pipeline,
      frameMs,
      this.fpsEma,
      draws,
      this.staticGl ?? "",
    );
  }

  private buildText(
    pipeline: RenderPipeline | null,
    frameMs: number,
    fpsEma: number,
    draws: number,
    staticBlock: string,
  ): string {
    const lines: string[] = [];
    lines.push("F3 GPU / frame debug (toggle with F3)");
    lines.push("");
    lines.push(
      `frame ${frameMs.toFixed(2)} ms   ~${fpsEma.toFixed(1)} fps (EMA)   draws ${draws}`,
    );
    if (pipeline !== null) {
      try {
        const app = pipeline.pixiApp;
        const r = app.renderer;
        const name = String((r as unknown as { name?: string }).name ?? r.constructor?.name ?? "?");
        const res = r.resolution;
        const logicalW = Math.max(1, Math.round(r.width));
        const logicalH = Math.max(1, Math.round(r.height));
        const cvs = app.canvas;
        const bufW = Math.max(1, cvs.width);
        const bufH = Math.max(1, cvs.height);
        const vp = getVideoPrefs();
        const api = pipeline.getGraphicsBackend() ?? "webgl";
        lines.push(
          `renderer ${name}   pixiRes ${res.toFixed(2)}   logical ${logicalW}×${logicalH}   canvas buf ${bufW}×${bufH}`,
        );
        lines.push(
          `video prefs  internalRT ${Math.round(vp.renderScale * 100)}%   bloom ${vp.bloomEnabled ? "on" : "off"}   viewDist ${VIEW_DISTANCE_CHUNKS} ch (fixed)   lighting balanced (fixed)   api ${api}`,
        );
      } catch {
        lines.push("renderer (unavailable)");
      }
    }
    lines.push("");
    lines.push(staticBlock);
    lines.push("");
    const gl = pipeline?.getWebGLContext() ?? null;
    lines.push(
      gl !== null
        ? "Draw count = WebGL draw* calls this frame (hooked). Use browser performance tools for deeper GPU work."
        : "Draw count unavailable (WebGPU / no GL context). Use Chrome Performance with GPU for GPU work.",
    );
    return lines.join("\n");
  }

  destroy(): void {
    uninstallGlHooks();
    this.root?.remove();
    this.root = null;
    this.pre = null;
    this.open = false;
    this.staticGl = null;
    this.fpsEma = 0;
  }
}
