/**
 * Web Audio wrapper: lazy AudioContext, master / music / SFX gain chain.
 * Block SFX buffers load from resource pack `sound_manifest.json` (see `loadSoundManifest.ts`).
 */

import { unixRandom01 } from "../core/unixRandom";

/** World pixels: listener = local player ears/feet; source = where the sound originates. */
export type SfxWorldSpace = {
  listenerX: number;
  listenerY: number;
  sourceX: number;
  sourceY: number;
  /** Falloff distance in world px; default 960 (matches remote player SFX). */
  maxDistPx?: number;
};

export type SfxOptions = {
  volume?: number;
  pitchVariance?: number;
  /** When set, volume scales with distance and stereo pan follows horizontal offset. */
  world?: SfxWorldSpace;
};

/** Default max distance for spatial SFX (beyond this, sound is silent). */
export const DEFAULT_SFX_WORLD_MAX_DIST_PX = 960;

/** Horizontal offset in world px that maps to full stereo pan. */
const SFX_PAN_REF_PX = 420;

function clamp01(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

/** Index in [0, variantCount) for {@link unixRandom01} × count (guards FP edge cases). */
function sfxVariantIndex(variantCount: number): number {
  if (variantCount <= 1) {
    return 0;
  }
  const i = Math.floor(unixRandom01() * variantCount);
  return Math.min(variantCount - 1, Math.max(0, i));
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  /** Current OST / music one-shot buffer source (see {@link playMusicBuffer}). */
  private musicSource: AudioBufferSourceNode | null = null;
  /** Looping ambience through {@link sfxGain} (e.g. legacy single-layer rain). */
  private sfxAmbientSource: AudioBufferSourceNode | null = null;
  private sfxAmbientGain: GainNode | null = null;
  private sfxAmbientUserVol = 0.25;
  /** Two looping rain layers (random variants); mutually exclusive with {@link sfxAmbientSource} for rain. */
  private readonly sfxRainSlots: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
  private sfxRainUserVol = 0.24;
  /** Master gain for rain layers (outdoor exposure × SFX volume); fades via {@link setSfxRainExposure}. */
  private sfxRainBus: GainNode | null = null;
  private sfxRainExposure = 0;
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Base buffer name (e.g. `jump_grass`) → variant count when loaded from a path array; `playSfx` picks at random. */
  private readonly sfxVariantCount = new Map<string, number>();
  private masterVol = 1;
  private musicVol = 1;
  private sfxVol = 1;

  constructor() {
    // AudioContext is created on first playSfx/loadSfx (browser policy).
  }

  /** Call from a user gesture so suspended contexts can play OST before any SFX. */
  primeAudioFromUserGesture(): void {
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => {});
  }

  /** Suspend the context (e.g. page entering bfcache) so playback stops without tearing down nodes. */
  suspendContext(): void {
    if (this.ctx !== null && this.ctx.state === "running") {
      void this.ctx.suspend().catch(() => {});
    }
  }

  /** Resume after {@link suspendContext} (e.g. bfcache restore). */
  resumeContext(): void {
    if (this.ctx !== null && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
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
    if (this.sfxAmbientGain !== null) {
      this.sfxAmbientGain.gain.value = this.sfxAmbientUserVol * this.sfxVol;
    }
    const layerEach = this.sfxRainUserVol * 0.5;
    for (const { gain } of this.sfxRainSlots) {
      gain.gain.value = layerEach;
    }
    this.applySfxRainBusGain();
  }

  /**
   * Outdoor / fade factor for rain ambience [0, 1]. Layer buffers keep playing while this ramps (smooth in/out).
   */
  setSfxRainExposure(exposure: number): void {
    let e = exposure;
    if (e < 0) {
      e = 0;
    } else if (e > 1) {
      e = 1;
    }
    this.sfxRainExposure = e;
    this.applySfxRainBusGain();
  }

  private applySfxRainBusGain(): void {
    if (this.sfxRainBus !== null) {
      this.sfxRainBus.gain.value = this.sfxRainExposure * this.sfxVol;
    }
  }

  /**
   * Loop an SFX buffer (must be preloaded). Uses {@link sfxGain}.
   * Stops {@link stopSfxRainDualAmbient} if active.
   */
  startSfxAmbientLoop(bufferName: string, volume = 0.26): void {
    this.stopSfxRainDualAmbient();
    this.stopSfxAmbientLoopInner();
    const buf = this.buffers.get(bufferName);
    if (buf === undefined) {
      return;
    }
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => {});
    const out = this.sfxGain;
    if (out === null) {
      return;
    }
    this.sfxAmbientUserVol = volume;
    const g = ctx.createGain();
    g.gain.value = volume * this.sfxVol;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(g);
    g.connect(out);
    src.start(0);
    this.sfxAmbientSource = src;
    this.sfxAmbientGain = g;
  }

  /**
   * Two random rain loops at half nominal gain each (headroom). Call {@link refreshSfxRainDualAmbient} on a timer for new picks.
   */
  startSfxRainDualAmbient(baseName: string, volume = 0.24): void {
    this.stopSfxRainDualAmbient();
    this.stopSfxAmbientLoopInner();
    this.sfxRainUserVol = volume;
    this.ensureRainDualPlaying(baseName);
  }

  refreshSfxRainDualAmbient(baseName: string, volume = 0.24): void {
    if (this.sfxRainSlots.length === 0) {
      return;
    }
    this.sfxRainUserVol = volume;
    this.disposeSfxRainSlots();
    this.ensureRainDualPlaying(baseName);
  }

  stopSfxRainDualAmbient(): void {
    this.disposeSfxRainSlots();
    if (this.sfxRainBus !== null) {
      try {
        this.sfxRainBus.disconnect();
      } catch {
        /* */
      }
      this.sfxRainBus = null;
    }
  }

  stopSfxAmbientLoop(): void {
    this.stopSfxRainDualAmbient();
    this.stopSfxAmbientLoopInner();
  }

  private stopSfxAmbientLoopInner(): void {
    if (this.sfxAmbientSource !== null) {
      try {
        this.sfxAmbientSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.sfxAmbientSource.disconnect();
      } catch {
        /* */
      }
      this.sfxAmbientSource = null;
    }
    if (this.sfxAmbientGain !== null) {
      try {
        this.sfxAmbientGain.disconnect();
      } catch {
        /* */
      }
      this.sfxAmbientGain = null;
    }
  }

  private disposeSfxRainSlots(): void {
    for (const { src, gain } of this.sfxRainSlots) {
      try {
        src.stop();
      } catch {
        /* */
      }
      try {
        src.disconnect();
      } catch {
        /* */
      }
      try {
        gain.disconnect();
      } catch {
        /* */
      }
    }
    this.sfxRainSlots.length = 0;
  }

  private pickTwoRainVariantIndices(variantCount: number): [number, number] {
    if (variantCount <= 1) {
      return [0, 0];
    }
    const a = sfxVariantIndex(variantCount);
    let b = sfxVariantIndex(variantCount);
    let guard = 0;
    while (b === a && guard++ < 8) {
      b = sfxVariantIndex(variantCount);
    }
    if (b === a) {
      b = (a + 1) % variantCount;
    }
    return [a, b];
  }

  private ensureRainDualPlaying(baseName: string): void {
    const variants = this.sfxVariantCount.get(baseName);
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => {});
    const out = this.sfxGain;
    if (out === null) {
      return;
    }

    if (this.sfxRainBus === null) {
      const bus = ctx.createGain();
      bus.gain.value = this.sfxRainExposure * this.sfxVol;
      bus.connect(out);
      this.sfxRainBus = bus;
    }

    const busIn = this.sfxRainBus;
    const layerEach = this.sfxRainUserVol * 0.5;

    const startLoop = (bufferName: string): void => {
      const buf = this.buffers.get(bufferName);
      if (buf === undefined) {
        return;
      }
      const g = ctx.createGain();
      g.gain.value = layerEach;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.detune.value = (unixRandom01() * 2 - 1) * 6;
      src.connect(g);
      g.connect(busIn);
      src.start(0);
      this.sfxRainSlots.push({ src, gain: g });
    };

    if (variants !== undefined && variants > 0) {
      const [i0, i1] = this.pickTwoRainVariantIndices(variants);
      startLoop(`${baseName}_${i0}`);
      startLoop(`${baseName}_${i1}`);
      return;
    }

    if (this.buffers.get(baseName) !== undefined) {
      startLoop(baseName);
      startLoop(baseName);
    }
  }

  /**
   * Register that `baseName` was loaded as `baseName_0` … `baseName_{count-1}` (see sound manifest arrays).
   */
  registerSfxVariantGroup(baseName: string, count: number): void {
    if (count < 1) {
      return;
    }
    this.sfxVariantCount.set(baseName, count);
  }

  playSfx(name: string, options?: SfxOptions): void {
    const variants = this.sfxVariantCount.get(name);
    if (variants !== undefined && variants > 0) {
      const i = sfxVariantIndex(variants);
      name = `${name}_${i}`;
    }
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
    let gain = options?.volume ?? 1;
    const w = options?.world;
    if (w !== undefined) {
      const maxD = w.maxDistPx ?? DEFAULT_SFX_WORLD_MAX_DIST_PX;
      const dist = Math.hypot(w.sourceX - w.listenerX, w.sourceY - w.listenerY);
      if (dist >= maxD) {
        return;
      }
      gain *= Math.max(0, 1 - dist / maxD);
    }
    playGain.gain.value = gain;
    src.connect(playGain);
    if (w !== undefined) {
      const dx = w.sourceX - w.listenerX;
      const pan = Math.max(-1, Math.min(1, dx / SFX_PAN_REF_PX));
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      playGain.connect(panner);
      panner.connect(sfx);
    } else {
      playGain.connect(sfx);
    }
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

  /**
   * Decode a full track for OST playback (not registered in the SFX buffer map).
   * @returns `null` on fetch/decode failure.
   */
  async decodeAudioFromUrl(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`decodeAudioFromUrl failed: ${url} (${res.status})`);
        return null;
      }
      const arr = await res.arrayBuffer();
      const ctx = this.ensureContext();
      return await ctx.decodeAudioData(arr.slice(0));
    } catch {
      console.warn(`decodeAudioFromUrl failed: ${url}`);
      return null;
    }
  }

  /**
   * Play one decoded buffer through the music gain. Stops any current music source.
   * @param onEnded Called when the buffer finishes (not when {@link stopMusic} runs).
   */
  playMusicBuffer(buffer: AudioBuffer, onEnded?: () => void): void {
    this.stopMusic();
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => {});
    const g = this.musicGain;
    if (g === null) {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(g);
    const srcRef = src;
    src.onended = () => {
      if (this.musicSource !== srcRef) {
        return;
      }
      this.musicSource = null;
      onEnded?.();
    };
    this.musicSource = src;
    src.start(0);
  }

  stopMusic(): void {
    if (this.musicSource !== null) {
      try {
        this.musicSource.onended = null;
        this.musicSource.stop();
      } catch {
        /* already stopped */
      }
      this.musicSource = null;
    }
  }

  /**
   * Ramp {@link musicGain} to silence, stop the current music source, then restore gain to {@link musicVol}.
   */
  fadeOutAndStopMusic(durationSec: number): Promise<void> {
    if (durationSec <= 0) {
      this.stopMusic();
      return Promise.resolve();
    }
    const ctx = this.ctx;
    const g = this.musicGain;
    if (ctx === null || g === null) {
      this.stopMusic();
      return Promise.resolve();
    }
    void ctx.resume().catch(() => {});
    const param = g.gain;
    const now = ctx.currentTime;
    const startVal = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(startVal, now);
    const endT = now + durationSec;
    param.linearRampToValueAtTime(0, endT);

    const waitMs = durationSec * 1000 + 100;
    return new Promise((resolve) => {
      window.setTimeout(() => {
        this.stopMusic();
        const t = this.ctx?.currentTime ?? 0;
        param.cancelScheduledValues(t);
        param.value = this.musicVol;
        resolve();
      }, waitMs);
    });
  }

  destroy(): void {
    this.stopMusic();
    this.stopSfxRainDualAmbient();
    this.stopSfxAmbientLoopInner();
    this.buffers.clear();
    this.sfxVariantCount.clear();
    if (this.ctx !== null) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
      this.musicGain = null;
      this.sfxGain = null;
    }
  }
}
