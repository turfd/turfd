/**
 * Simple authoritative weather state (rain timer + occasional lightning).
 *
 * Note: This is intentionally small and self-contained because other systems
 * (audio/particles/lighting) only need `isRaining()` + a remaining-seconds sync.
 */
export const WEATHER_RAIN_FULL_DURATION_SEC = 6 * 60;
/** Multiplier applied to crop growth while raining (see BlockInteractions). */
export const RAIN_GROWTH_MUL = 1.35;

export type WeatherAuthorityTickResult = {
  /** True for the tick a lightning strike is triggered. */
  lightningStrike: boolean;
  /** True for the tick rain transitions from off → on. */
  rainJustStarted: boolean;
  /** True for the tick rain transitions from on → off. */
  rainJustEnded: boolean;
};

function clampFinite(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}

export class WeatherController {
  private rainRemainingSec = 0;
  private lightningCooldownSec = 0;

  isRaining(): boolean {
    return this.rainRemainingSec > 0;
  }

  getRainRemainingSec(): number {
    return this.rainRemainingSec;
  }

  /** Host/solo: set rain to a full-duration burst. */
  setRainFullDuration(): void {
    this.rainRemainingSec = WEATHER_RAIN_FULL_DURATION_SEC;
  }

  /** Host/solo: clear rain immediately. */
  clear(): void {
    this.rainRemainingSec = 0;
    this.lightningCooldownSec = 0;
  }

  /** Host/solo: restore persisted rain remaining seconds (older saves may omit). */
  restoreFromSave(rainRemainingSec: number): void {
    this.rainRemainingSec = clampFinite(rainRemainingSec, 0, WEATHER_RAIN_FULL_DURATION_SEC);
  }

  /**
   * Host/solo: advance weather state.
   * - Rain counts down.
   * - Lightning can strike while raining with a small chance, gated by cooldown.
   */
  tickAuthority(dtSec: number): WeatherAuthorityTickResult {
    const dt = Math.max(0, dtSec);
    if (!Number.isFinite(dt) || dt <= 0) {
      return { lightningStrike: false, rainJustStarted: false, rainJustEnded: false };
    }

    const wasRaining = this.isRaining();
    if (this.rainRemainingSec > 0) {
      this.rainRemainingSec = Math.max(0, this.rainRemainingSec - dt);
    }
    const nowRaining = this.isRaining();

    this.lightningCooldownSec = Math.max(0, this.lightningCooldownSec - dt);
    let lightningStrike = false;
    if (nowRaining && this.lightningCooldownSec <= 0) {
      // Roughly one strike every ~20–60s while raining (average tuned by chance + cooldown).
      const strikeChancePerSec = 1 / 55;
      if (Math.random() < strikeChancePerSec * dt) {
        lightningStrike = true;
        this.lightningCooldownSec = 18 + Math.random() * 22;
      }
    }

    return {
      lightningStrike,
      rainJustStarted: !wasRaining && nowRaining,
      rainJustEnded: wasRaining && !nowRaining,
    };
  }
}

