/**
 * Web Audio wrapper: lazy AudioContext, master / music / SFX gain chain.
 * Phase 1: no SFX assets loaded; playSfx no-ops until mod audio (Phase 3).
 */

import { unixRandom01 } from "../core/unixRandom";

export type SfxOptions = {
  volume?: number;
  pitchVariance?: number;
};

function clamp01(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private masterVol = 1;
  private musicVol = 1;
  private sfxVol = 1;

  constructor() {
    // AudioContext is created on first playSfx/loadSfx (browser policy).
  }

  private ensureContext(): AudioContext {
    if (this.ctx === null) {
      const Ctx =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx === undefined) {
        throw new Error("Web Audio API not available");
      }
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.musicGain.connect(this.masterGain);
      this.sfxGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
      this.applyGainNodes();
    }
    return this.ctx;
  }

  private applyGainNodes(): void {
    if (this.masterGain === null || this.musicGain === null || this.sfxGain === null) {
      return;
    }
    this.masterGain.gain.value = this.masterVol;
    this.musicGain.gain.value = this.musicVol;
    this.sfxGain.gain.value = this.sfxVol;
  }

  setMasterVolume(v: number): void {
    this.masterVol = clamp01(v);
    if (this.masterGain !== null) {
      this.masterGain.gain.value = this.masterVol;
    }
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v);
    if (this.musicGain !== null) {
      this.musicGain.gain.value = this.musicVol;
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp01(v);
    if (this.sfxGain !== null) {
      this.sfxGain.gain.value = this.sfxVol;
    }
  }

  playSfx(name: string, options?: SfxOptions): void {
    const buf = this.buffers.get(name);
    if (buf === undefined) {
      // Phase 3: SFX files are not bundled yet; no-op without console spam.
      return;
    }
    const ctx = this.ensureContext();
    const sfx = this.sfxGain;
    if (sfx === null) {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const variance = options?.pitchVariance ?? 0;
    src.detune.value = (unixRandom01() * 2 - 1) * variance;
    const playGain = ctx.createGain();
    playGain.gain.value = options?.volume ?? 1;
    src.connect(playGain);
    playGain.connect(sfx);
    src.start();
  }

  async loadSfx(name: string, url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`loadSfx failed: ${url} (${res.status})`);
        return;
      }
      const arr = await res.arrayBuffer();
      const ctx = this.ensureContext();
      const buf = await ctx.decodeAudioData(arr.slice(0));
      this.buffers.set(name, buf);
    } catch {
      console.warn(`loadSfx failed: ${url}`);
    }
  }

  playMusic(_url: string): void {
    console.log("[AudioEngine] playMusic (stub — Phase 3)");
  }

  stopMusic(): void {
    console.log("[AudioEngine] stopMusic (stub — Phase 3)");
  }

  destroy(): void {
    this.buffers.clear();
    if (this.ctx !== null) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
      this.musicGain = null;
      this.sfxGain = null;
    }
  }
}
