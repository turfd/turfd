import {
  AUDIO_FULL_VOLUME_RADIUS,
  AUDIO_MUFFLE_FAR_HZ,
  AUDIO_MUFFLE_LOWPASS_Q,
  AUDIO_MUFFLE_NEAR_HZ,
  AUDIO_SILENCE_RADIUS,
  AUDIO_SFX_PAN_REF_PX,
  BLOCK_SIZE,
} from "../core/constants";
import type { World } from "../world/World";
import { countOccludingBlocksOnSegment, occlusionAttenuation } from "./soundOcclusion";

export type SoundPlayOptions = {
  /** World X of the source (pixels). */
  sourceX: number;
  /** World Y of the source (pixels). */
  sourceY: number;
  buffer: AudioBuffer;
  loop?: boolean;
  /** Base volume multiplier, default 1.0 */
  volume?: number;
  /** When set, no voice is created if source is farther than this (world pixels). */
  maxDistPx?: number;
  /** Detune in cents applied to the buffer source. */
  detuneCents?: number;
  /** When set, solid blocks between listener and source add extra muffling. */
  world?: World;
};

export type PlayingSound = {
  id: number;
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  filterNode: BiquadFilterNode;
  pannerNode: StereoPannerNode;
  sourceX: number;
  sourceY: number;
  baseVolume: number;
  world: World | null;
  stop(): void;
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

/** Distance attenuation and lowpass cutoff from separation in blocks. */
function spatialCurve(distBlocks: number): { gain: number; cutoffHz: number } {
  if (distBlocks <= AUDIO_FULL_VOLUME_RADIUS) {
    return { gain: 1, cutoffHz: AUDIO_MUFFLE_NEAR_HZ };
  }
  if (distBlocks >= AUDIO_SILENCE_RADIUS) {
    return { gain: 0, cutoffHz: AUDIO_MUFFLE_FAR_HZ };
  }
  const span = AUDIO_SILENCE_RADIUS - AUDIO_FULL_VOLUME_RADIUS;
  const u = clamp01((distBlocks - AUDIO_FULL_VOLUME_RADIUS) / span);
  const gain = 1 - u * u;
  const cutoffHz =
    AUDIO_MUFFLE_NEAR_HZ +
    (AUDIO_MUFFLE_FAR_HZ - AUDIO_MUFFLE_NEAR_HZ) * u;
  return { gain, cutoffHz };
}

export class SpatialAudioMixer {
  private readonly ctx: AudioContext;
  private readonly busOut: GainNode;
  private readonly active: PlayingSound[] = [];
  private nextId = 1;
  private listenerX = 0;
  private listenerY = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.busOut = ctx.createGain();
    this.busOut.gain.value = 1;
  }

  getOutputNode(): AudioNode {
    return this.busOut;
  }

  setMasterVolume(v: number): void {
    this.busOut.gain.value = clamp01(v);
  }

  updateListenerPosition(listenerX: number, listenerY: number): void {
    this.listenerX = listenerX;
    this.listenerY = listenerY;
    for (const voice of this.active) {
      this.applyVoice(voice);
    }
  }

  play(options: SoundPlayOptions): PlayingSound | null {
    const maxD = options.maxDistPx;
    if (maxD !== undefined) {
      const distPx = Math.hypot(
        options.sourceX - this.listenerX,
        options.sourceY - this.listenerY,
      );
      if (distPx >= maxD) {
        return null;
      }
    }

    const distBlocks =
      Math.hypot(
        options.sourceX - this.listenerX,
        options.sourceY - this.listenerY,
      ) / BLOCK_SIZE;
    if (distBlocks >= AUDIO_SILENCE_RADIUS) {
      return null;
    }

    const baseVol = options.volume ?? 1;
    const { gain: distGain, cutoffHz } = spatialCurve(distBlocks);
    const dx = options.sourceX - this.listenerX;
    const pan = Math.max(-1, Math.min(1, dx / AUDIO_SFX_PAN_REF_PX));

    const world = options.world ?? null;
    const walls =
      world !== null
        ? countOccludingBlocksOnSegment(
            world,
            this.listenerX,
            this.listenerY,
            options.sourceX,
            options.sourceY,
          )
        : 0;
    const { gainMult: occGain, frequencyMult: occFreq } =
      occlusionAttenuation(walls);

    const src = this.ctx.createBufferSource();
    src.buffer = options.buffer;
    if (options.loop === true) {
      src.loop = true;
    }
    if (options.detuneCents !== undefined) {
      src.detune.value = options.detuneCents;
    }

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoffHz * occFreq;
    filter.Q.value = AUDIO_MUFFLE_LOWPASS_Q;

    const gain = this.ctx.createGain();
    gain.gain.value = distGain * baseVol * occGain;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.busOut);

    const id = this.nextId++;
    const voice: PlayingSound = {
      id,
      source: src,
      gainNode: gain,
      filterNode: filter,
      pannerNode: panner,
      sourceX: options.sourceX,
      sourceY: options.sourceY,
      baseVolume: baseVol,
      world,
      stop: () => {
        this.removeVoice(voice);
      },
    };

    const onEnded = (): void => {
      src.onended = null;
      this.removeVoice(voice);
    };
    src.onended = onEnded;

    this.active.push(voice);
    src.start(0);
    return voice;
  }

  stopAll(): void {
    const copy = [...this.active];
    for (const v of copy) {
      v.stop();
    }
  }

  private applyVoice(voice: PlayingSound): void {
    const distBlocks =
      Math.hypot(
        voice.sourceX - this.listenerX,
        voice.sourceY - this.listenerY,
      ) / BLOCK_SIZE;
    const { gain: distGain, cutoffHz } = spatialCurve(distBlocks);
    const walls =
      voice.world !== null
        ? countOccludingBlocksOnSegment(
            voice.world,
            this.listenerX,
            this.listenerY,
            voice.sourceX,
            voice.sourceY,
          )
        : 0;
    const { gainMult: occGain, frequencyMult: occFreq } =
      occlusionAttenuation(walls);
    voice.gainNode.gain.value = distGain * voice.baseVolume * occGain;
    voice.filterNode.frequency.value = cutoffHz * occFreq;
    const dx = voice.sourceX - this.listenerX;
    voice.pannerNode.pan.value = Math.max(
      -1,
      Math.min(1, dx / AUDIO_SFX_PAN_REF_PX),
    );
  }

  private removeVoice(voice: PlayingSound): void {
    const i = this.active.indexOf(voice);
    if (i < 0) {
      return;
    }
    this.active.splice(i, 1);
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      voice.source.disconnect();
    } catch {
      /* */
    }
    try {
      voice.filterNode.disconnect();
    } catch {
      /* */
    }
    try {
      voice.gainNode.disconnect();
    } catch {
      /* */
    }
    try {
      voice.pannerNode.disconnect();
    } catch {
      /* */
    }
    voice.source.onended = null;
  }

  dispose(): void {
    this.stopAll();
    try {
      this.busOut.disconnect();
    } catch {
      /* */
    }
  }
}
