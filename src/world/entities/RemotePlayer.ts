/** Remote networked player: interpolated position only, no local input. */

export class RemotePlayer {
  x: number;
  y: number;
  facingRight: boolean;

  targetX: number;
  targetY: number;
  targetFacingRight: boolean;

  constructor(x: number, y: number, facingRight: boolean) {
    this.x = x;
    this.y = y;
    this.facingRight = facingRight;
    this.targetX = x;
    this.targetY = y;
    this.targetFacingRight = facingRight;
  }

  setTarget(x: number, y: number, facingRight: boolean): void {
    this.targetX = x;
    this.targetY = y;
    this.targetFacingRight = facingRight;
  }

  /** Basic linear interpolation toward the last received target. */
  update(dt: number): void {
    // Smoothing factor scaled by dt to keep behaviour consistent across frame rates.
    const factor = Math.min(1, dt * 10);
    this.x += (this.targetX - this.x) * factor;
    this.y += (this.targetY - this.y) * factor;
    // Snap facing once close enough to avoid jitter.
    if (Math.abs(this.targetX - this.x) < 1) {
      this.facingRight = this.targetFacingRight;
    }
  }
}

