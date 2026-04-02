/** Remote networked player: velocity extrapolation between network samples. */

const MAX_EXTRAPOLATION_SEC = 0.35;
/** If predicted position vs new authority differs by more than this, trust the packet (snap). */
const SNAP_ERROR_PX = 56;

export class RemotePlayer {
  x: number;
  y: number;
  facingRight: boolean;

  private authX: number;
  private authY: number;
  private vx: number;
  private vy: number;
  private recvMs: number;

  constructor(
    x: number,
    y: number,
    facingRight: boolean,
    vx: number,
    vy: number,
  ) {
    const now = performance.now();
    this.authX = x;
    this.authY = y;
    this.vx = vx;
    this.vy = vy;
    this.recvMs = now;
    this.x = x;
    this.y = y;
    this.facingRight = facingRight;
  }

  /** Authoritative sample for host → joiner snapshots and relays. */
  getNetworkSample(): {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facingRight: boolean;
  } {
    return {
      x: this.authX,
      y: this.authY,
      vx: this.vx,
      vy: this.vy,
      facingRight: this.facingRight,
    };
  }

  setTarget(x: number, y: number, vx: number, vy: number, facingRight: boolean): void {
    const now = performance.now();
    const prevElapsed = Math.min((now - this.recvMs) / 1000, MAX_EXTRAPOLATION_SEC);
    const predX = this.authX + this.vx * prevElapsed;
    const predY = this.authY + this.vy * prevElapsed;
    const err = Math.hypot(x - predX, y - predY);

    this.authX = x;
    this.authY = y;
    this.vx = vx;
    this.vy = vy;
    this.recvMs = now;
    this.facingRight = facingRight;

    if (err > SNAP_ERROR_PX) {
      this.x = x;
      this.y = y;
    }
  }

  /** Extrapolate from last authoritative sample using broadcast velocity. */
  update(_dt: number): void {
    const now = performance.now();
    const elapsed = Math.min((now - this.recvMs) / 1000, MAX_EXTRAPOLATION_SEC);
    this.x = this.authX + this.vx * elapsed;
    this.y = this.authY + this.vy * elapsed;
  }
}
