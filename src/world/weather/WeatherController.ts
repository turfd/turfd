/**
 * Host/offline authoritative rain: duration cap, rare natural storms, lightning cadence.
 */
import { unixRandom01 } from "../../core/unixRandom";

/** Max rain duration (seconds) for commands and natural weather. */
export const RAIN_MAX_DURATION_SEC = 300;

/** Extra countdown speed for wheat, saplings, and grass-spread while raining. */
export const RAIN_GROWTH_MUL = 1.4;

const MIN_CLEAR_BEFORE_ROLL_SEC = 240;
const NATURAL_CHECK_INTERVAL_SEC = 30;
const NATURAL_START_CHANCE = 0.06;
const NATURAL_DURATION_MIN_SEC = 90;
const LIGHTNING_MIN_GAP_SEC = 8;
const LIGHTNING_MAX_GAP_SEC = 25;

export class WeatherController {
  private rainRemainingSec = 0;
  /** Seconds spent clear (resets when rain starts). */
  private clearWeatherSec = 0;
  /** Accumulator for periodic natural-rain rolls while clear. */
  private naturalCheckAccum = 0;
  private lightningGapSec = 99999;

  getRainRemainingSec(): number {
    return this.rainRemainingSec;
  }

  isRaining(): boolean {
    return this.rainRemainingSec > 0;
  }

  /** Full storm (capped). */
  setRainFullDuration(): void {
    this.rainRemainingSec = RAIN_MAX_DURATION_SEC;
    this.clearWeatherSec = 0;
    this.naturalCheckAccum = 0;
    this.scheduleNextLightningGap();
  }

  /** Natural or partial duration, capped at {@link RAIN_MAX_DURATION_SEC}. */
  startRain(seconds: number): void {
    const s = Math.min(RAIN_MAX_DURATION_SEC, Math.max(0, seconds));
    if (s <= 0) {
      return;
    }
    this.rainRemainingSec = s;
    this.clearWeatherSec = 0;
    this.naturalCheckAccum = 0;
    this.scheduleNextLightningGap();
  }

  clear(): void {
    this.rainRemainingSec = 0;
    this.lightningGapSec = 99999;
  }

  /** Restore from save / metadata (solo or host). Capped to {@link RAIN_MAX_DURATION_SEC}. */
  restoreFromSave(seconds: number): void {
    const s = Math.min(RAIN_MAX_DURATION_SEC, Math.max(0, seconds));
    this.rainRemainingSec = s;
    if (s > 0) {
      this.clearWeatherSec = 0;
      this.naturalCheckAccum = 0;
      this.scheduleNextLightningGap();
    } else {
      this.lightningGapSec = 99999;
      this.clearWeatherSec = 0;
      this.naturalCheckAccum = 0;
    }
  }

  /**
   * Advance rain timer, natural starts, and lightning. Host / offline only.
   */
  tickAuthority(dt: number): {
    lightningStrike: boolean;
    rainJustStarted: boolean;
    rainJustEnded: boolean;
  } {
    let lightningStrike = false;
    let rainJustStarted = false;
    let rainJustEnded = false;

    if (this.rainRemainingSec > 0) {
      this.rainRemainingSec -= dt;
      this.clearWeatherSec = 0;
      this.naturalCheckAccum = 0;
      if (this.rainRemainingSec <= 0) {
        this.rainRemainingSec = 0;
        rainJustEnded = true;
        this.lightningGapSec = 99999;
      } else {
        this.lightningGapSec -= dt;
        if (this.lightningGapSec <= 0) {
          lightningStrike = true;
          this.scheduleNextLightningGap();
        }
      }
    } else {
      this.clearWeatherSec += dt;
      if (this.clearWeatherSec >= MIN_CLEAR_BEFORE_ROLL_SEC) {
        this.naturalCheckAccum += dt;
        if (this.naturalCheckAccum >= NATURAL_CHECK_INTERVAL_SEC) {
          this.naturalCheckAccum = 0;
          if (unixRandom01() < NATURAL_START_CHANCE) {
            const span = RAIN_MAX_DURATION_SEC - NATURAL_DURATION_MIN_SEC;
            const dur =
              NATURAL_DURATION_MIN_SEC + unixRandom01() * Math.max(0, span);
            this.startRain(dur);
            rainJustStarted = true;
          }
        }
      }
    }

    return { lightningStrike, rainJustStarted, rainJustEnded };
  }

  private scheduleNextLightningGap(): void {
    this.lightningGapSec =
      LIGHTNING_MIN_GAP_SEC +
      unixRandom01() * (LIGHTNING_MAX_GAP_SEC - LIGHTNING_MIN_GAP_SEC);
  }
}
