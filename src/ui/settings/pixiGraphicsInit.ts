import { Application, RendererType, type ApplicationOptions } from "pixi.js";

export type PixiApplicationInitBase = Pick<
  Partial<ApplicationOptions>,
  | "autoStart"
  | "antialias"
  | "backgroundAlpha"
  | "resolution"
  | "autoDensity"
  | "powerPreference"
> & { resizeTo: HTMLElement };

export type PixiGraphicsBackend = "webgpu" | "webgl";

/** Options for {@link createApplicationWithGraphicsPreference}. */
export type PixiGraphicsInitOptions = {
  /**
   * When true, skip WebGPU and use WebGL only.
   * Used for {@link MenuBackground}: Pixi v8’s WebGPU `GpuMeshAdapter.destroy()` calls
   * `shader.destroy(true)` on a **globally cached** mesh `GpuProgram`. If a menu WebGPU
   * app is torn down while the game’s WebGPU app is already alive, that destroys the
   * shared program and the game’s mesh pass crashes (`gpuLayout` null).
   */
  forceWebGl?: boolean;
};

function hasWebGpuApi(): boolean {
  return typeof navigator !== "undefined" && navigator.gpu !== undefined;
}

/**
 * Creates the Pixi app with **WebGPU** when `navigator.gpu` exists, otherwise **WebGL**.
 * Custom filters must supply both `gpuProgram` (WGSL) and `glProgram` (GLSL) — see
 * {@link CompositePass}, {@link TonemapFilter}, {@link createSlimeGelAlphaFilter}.
 * If WebGPU init fails, falls back to WebGL.
 */
export async function createApplicationWithGraphicsPreference(
  base: PixiApplicationInitBase,
  options?: PixiGraphicsInitOptions,
): Promise<{ app: Application; backend: PixiGraphicsBackend }> {
  if (!options?.forceWebGl && hasWebGpuApi()) {
    try {
      const app = new Application();
      await app.init({
        ...base,
        preference: "webgpu",
      });
      if (app.renderer.type === RendererType.WEBGPU) {
        return { app, backend: "webgpu" };
      }
    } catch {
      // Fall through to WebGL.
    }
  }

  const app = new Application();
  await app.init({
    ...base,
    preference: "webgl",
  });
  return { app, backend: "webgl" };
}
