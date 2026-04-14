import {
  AUDIO_REVERB_CAVE_DRY_OPEN,
  AUDIO_REVERB_CAVE_DRY_TIGHT,
  AUDIO_REVERB_CAVE_OPENNESS_RAMP_SEC,
  AUDIO_REVERB_CAVE_WET_OPEN,
  AUDIO_REVERB_CAVE_WET_TIGHT,
  AUDIO_REVERB_ENCLOSED_DRY_OPEN,
  AUDIO_REVERB_ENCLOSED_DRY_TIGHT,
  AUDIO_REVERB_ENCLOSED_WET_OPEN,
  AUDIO_REVERB_ENCLOSED_WET_TIGHT,
  AUDIO_REVERB_ENV_CROSSFADE_SEC,
  AUDIO_REVERB_SURFACE_DRY,
  AUDIO_REVERB_SURFACE_WET,
  AUDIO_REVERB_UNDERGROUND_DRY,
  AUDIO_REVERB_UNDERGROUND_WET,
} from "../core/constants";
import type { AudioEnvironment, AudioEnvironmentProbe } from "./EnvironmentDetector";

/** Paths under `public/`; prefixed with Vite `import.meta.env.BASE_URL` (see `vite.config.ts` `base`). */
function irAssetUrl(file: string): string {
  const base = import.meta.env.BASE_URL;
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}audio/ir/${file}`;
}

type ConvolverIrKey = "surface" | "underground" | "cave";

const IR_FILES: Record<ConvolverIrKey, string> = {
  surface: "surface.wav",
  underground: "underground.wav",
  cave: "cave.wav",
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function convolverIrKey(env: AudioEnvironment): ConvolverIrKey | "none" {
  switch (env) {
    case "surface":
      return "surface";
    case "underground":
      return "underground";
    case "cave":
      return "cave";
    case "enclosed":
      return "underground";
    case "none":
      return "none";
  }
}

function dryWetForProbe(probe: AudioEnvironmentProbe): { dry: number; wet: number } {
  const t = probe.openness01;
  switch (probe.env) {
    case "surface":
      return { dry: AUDIO_REVERB_SURFACE_DRY, wet: AUDIO_REVERB_SURFACE_WET };
    case "underground":
      return {
        dry: AUDIO_REVERB_UNDERGROUND_DRY,
        wet: AUDIO_REVERB_UNDERGROUND_WET,
      };
    case "enclosed":
      return {
        dry: lerp(AUDIO_REVERB_ENCLOSED_DRY_TIGHT, AUDIO_REVERB_ENCLOSED_DRY_OPEN, t),
        wet: lerp(AUDIO_REVERB_ENCLOSED_WET_TIGHT, AUDIO_REVERB_ENCLOSED_WET_OPEN, t),
      };
    case "cave":
      return {
        dry: lerp(AUDIO_REVERB_CAVE_DRY_TIGHT, AUDIO_REVERB_CAVE_DRY_OPEN, t),
        wet: lerp(AUDIO_REVERB_CAVE_WET_TIGHT, AUDIO_REVERB_CAVE_WET_OPEN, t),
      };
    case "none":
      return { dry: 1, wet: 0 };
  }
}

export class ReverbEngine {
  private readonly ctx: AudioContext;
  private readonly inputBus: GainNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly mergeGain: GainNode;
  private readonly buffers: Partial<Record<ConvolverIrKey, AudioBuffer>> = {};
  private lastConvolverKey: ConvolverIrKey | "none" = "none";
  private lastProbe: AudioEnvironmentProbe | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.inputBus = ctx.createGain();
    this.inputBus.gain.value = 1;
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.mergeGain = ctx.createGain();
    this.inputBus.connect(this.dryGain);
    this.inputBus.connect(this.wetGain);
    this.wetGain.connect(this.convolver);
    this.dryGain.connect(this.mergeGain);
    this.convolver.connect(this.mergeGain);
    this.dryGain.gain.value = 1;
    this.wetGain.gain.value = 0;
  }

  getInputNode(): AudioNode {
    return this.inputBus;
  }

  getOutputNode(): AudioNode {
    return this.mergeGain;
  }

  async loadIRs(): Promise<void> {
    const entries = Object.entries(IR_FILES) as [ConvolverIrKey, string][];
    for (const [env, file] of entries) {
      const url = irAssetUrl(file);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`ReverbEngine: failed to load IR ${url} (${res.status})`);
          continue;
        }
        const arr = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arr.slice(0));
        this.buffers[env] = buf;
      } catch {
        console.warn(`ReverbEngine: failed to load IR ${url}`);
      }
    }
  }

  setEnvironment(probe: AudioEnvironmentProbe): void {
    const now = this.ctx.currentTime;
    const { dry, wet } = dryWetForProbe(probe);
    const env = probe.env;

    const prev = this.lastProbe;
    const onlyOpennessRamp =
      prev !== null &&
      prev.env === probe.env &&
      (probe.env === "cave" || probe.env === "enclosed") &&
      Math.abs(probe.openness01 - prev.openness01) > 0.02;

    const rampSec = onlyOpennessRamp
      ? AUDIO_REVERB_CAVE_OPENNESS_RAMP_SEC
      : AUDIO_REVERB_ENV_CROSSFADE_SEC;

    const rampEnd = now + rampSec;

    const ck = convolverIrKey(env);
    if (ck !== "none") {
      const buf = this.buffers[ck];
      if (buf === undefined) {
        this.applyDryWetAt(now, rampEnd, 1, 0);
        this.lastProbe = probe;
        return;
      }
      if (this.lastConvolverKey !== ck) {
        this.convolver.buffer = buf;
        this.lastConvolverKey = ck;
      }
    } else {
      this.lastConvolverKey = "none";
    }

    this.applyDryWetAt(now, rampEnd, dry, wet);
    this.lastProbe = {
      env: probe.env,
      openness01: probe.openness01,
    };
  }

  private applyDryWetAt(
    now: number,
    rampEnd: number,
    dry: number,
    wet: number,
  ): void {
    const d = this.dryGain.gain;
    const w = this.wetGain.gain;
    d.cancelScheduledValues(now);
    w.cancelScheduledValues(now);
    d.setValueAtTime(d.value, now);
    w.setValueAtTime(w.value, now);
    d.linearRampToValueAtTime(dry, rampEnd);
    w.linearRampToValueAtTime(wet, rampEnd);
  }

  dispose(): void {
    try {
      this.inputBus.disconnect();
    } catch {
      /* */
    }
    try {
      this.dryGain.disconnect();
    } catch {
      /* */
    }
    try {
      this.wetGain.disconnect();
    } catch {
      /* */
    }
    try {
      this.convolver.disconnect();
    } catch {
      /* */
    }
    try {
      this.mergeGain.disconnect();
    } catch {
      /* */
    }
  }
}
