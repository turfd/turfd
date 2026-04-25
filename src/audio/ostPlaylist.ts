/**
 * Random OST playback with silence between tracks (menu vs in-game playlists).
 * Paths come from `music_manifest.json` in the resource pack root.
 */

import { z } from "zod";
import { unixRandom01 } from "../core/unixRandom";
import type { AudioEngine } from "./AudioEngine";
import { parseJsoncResponse } from "../core/jsonc";

export const MUSIC_MANIFEST_FILENAME = "music_manifest.json";

const musicManifestSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    /** Paths relative to resource pack root (e.g. `OST/menu/theme.ogg`). */
    menu: z.array(z.string().min(1)),
    game: z.array(z.string().min(1)),
    gap_seconds_min: z.number().positive().optional(),
    gap_seconds_max: z.number().positive().optional(),
  })
  .strict();

export type MusicManifestJson = z.infer<typeof musicManifestSchema>;

function joinPackUrl(packBaseUrl: string, relativePath: string): string {
  const base = packBaseUrl.endsWith("/") ? packBaseUrl : `${packBaseUrl}/`;
  const rel = relativePath.replace(/^\//, "");
  return `${base}${rel}`;
}

function randomGapSec(min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return min + unixRandom01() * (max - min);
}

/**
 * Picks a random URL from the list, avoiding the same file twice in a row when possible.
 */
function pickTrackUrl(urls: readonly string[], lastUrl: string | null): string {
  if (urls.length === 0) {
    throw new Error("pickTrackUrl: empty list");
  }
  if (urls.length === 1) {
    return urls[0]!;
  }
  let pick = urls[Math.floor(unixRandom01() * urls.length)]!;
  let guard = 0;
  while (pick === lastUrl && guard < 12) {
    pick = urls[Math.floor(unixRandom01() * urls.length)]!;
    guard += 1;
  }
  return pick;
}

export class OstPlaylistController {
  private readonly audio: AudioEngine;
  private readonly packBaseUrl: string;
  private menuUrls: string[] = [];
  private gameUrls: string[] = [];
  private gapMin = 18;
  private gapMax = 48;
  private mode: "menu" | "game" | null = null;
  private lastUrl: string | null = null;
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Bumped on every {@link setMode}; stale async {@link playOneTrack} work aborts before starting audio. */
  private playToken = 0;
  /** Prevents overlapping {@link playOneTrack} (e.g. duplicate immediate {@link scheduleNext}). */
  private playOneTrackInFlight = false;

  constructor(audio: AudioEngine, packBaseUrl: string) {
    this.audio = audio;
    this.packBaseUrl = packBaseUrl;
  }

  async loadManifest(): Promise<void> {
    const url = joinPackUrl(this.packBaseUrl, MUSIC_MANIFEST_FILENAME);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`OstPlaylistController: no manifest ${url} (${res.status})`);
        return;
      }
      const raw: unknown = await parseJsoncResponse(res, url);
      const m = musicManifestSchema.parse(raw);
      this.menuUrls = [...m.menu];
      this.gameUrls = [...m.game];
      const gmin = m.gap_seconds_min ?? 18;
      const gmax = m.gap_seconds_max ?? 48;
      this.gapMin = Math.min(gmin, gmax);
      this.gapMax = Math.max(gmin, gmax);
    } catch (e) {
      console.warn("OstPlaylistController: failed to parse music manifest", e);
    }
  }

  /**
   * Decode all tracks for a playlist in the background so the first bar can start without fetch/decode wait.
   * Safe to call multiple times (skips already-cached paths).
   */
  preloadMode(mode: "menu" | "game"): void {
    const urls = mode === "menu" ? this.menuUrls : this.gameUrls;
    for (const rel of urls) {
      if (this.bufferCache.has(rel)) {
        continue;
      }
      const fullUrl = joinPackUrl(this.packBaseUrl, rel);
      void this.audio
        .decodeAudioFromUrl(fullUrl)
        .then((buf) => {
          if (buf !== null) {
            this.bufferCache.set(rel, buf);
          }
        })
        .catch((e: unknown) => {
          console.warn("OstPlaylistController: decode failed", fullUrl, e);
        });
    }
  }

  /** Stop playback and timers; safe to call multiple times. */
  destroy(): void {
    this.stopped = true;
    this.clearGapTimer();
    this.audio.stopMusic();
    this.mode = null;
  }

  /**
   * Cancel gap timers and playlist mode without stopping the current buffer.
   * Use before a gain fade so the menu track can play through loading, then fade out cleanly.
   */
  stopAdvancingPlaylist(): void {
    if (this.stopped) {
      return;
    }
    this.playToken += 1;
    this.clearGapTimer();
    this.mode = null;
  }

  /**
   * Switch playlist. `null` stops music (e.g. loading screen). Starts first track after `initialDelaySec`.
   */
  setMode(mode: "menu" | "game" | null, initialDelaySec = 0): void {
    if (this.stopped) {
      return;
    }
    this.playToken += 1;
    this.clearGapTimer();
    this.audio.stopMusic();
    this.mode = mode;
    const urls = this.currentUrls();
    if (mode === null || urls.length === 0) {
      return;
    }
    this.scheduleNext(initialDelaySec);
  }

  private currentUrls(): string[] {
    return this.mode === "menu" ? this.menuUrls : this.gameUrls;
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private scheduleNext(delaySec: number): void {
    this.clearGapTimer();
    if (delaySec <= 0) {
      if (this.stopped || this.mode === null) {
        return;
      }
      void this.playOneTrack();
      return;
    }
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.stopped || this.mode === null) {
        return;
      }
      void this.playOneTrack();
    }, delaySec * 1000);
  }

  private async playOneTrack(): Promise<void> {
    if (this.playOneTrackInFlight) {
      return;
    }
    this.playOneTrackInFlight = true;
    const token = this.playToken;
    try {
      if (this.stopped || this.mode === null || token !== this.playToken) {
        return;
      }
      const urls = this.currentUrls();
      if (urls.length === 0) {
        return;
      }
      const rel = pickTrackUrl(urls, this.lastUrl);
      this.lastUrl = rel;
      const fullUrl = joinPackUrl(this.packBaseUrl, rel);
      let buf: AudioBuffer | undefined = this.bufferCache.get(rel);
      if (buf === undefined) {
        const decoded = await this.audio.decodeAudioFromUrl(fullUrl);
        if (decoded === null) {
          if (token === this.playToken && !this.stopped && this.mode !== null) {
            this.scheduleNext(randomGapSec(this.gapMin, this.gapMax));
          }
          return;
        }
        buf = decoded;
        this.bufferCache.set(rel, buf);
      }
      if (this.stopped || this.mode === null || token !== this.playToken) {
        return;
      }
      this.audio.playMusicBuffer(buf, () => {
        if (this.stopped || this.mode === null || token !== this.playToken) {
          return;
        }
        this.scheduleNext(randomGapSec(this.gapMin, this.gapMax));
      });
    } finally {
      this.playOneTrackInFlight = false;
    }
  }
}
