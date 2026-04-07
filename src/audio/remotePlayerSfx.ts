/**
 * Footstep and jump SFX for remote players using local world + interpolated pose (no extra network messages).
 */
import type { AudioEngine } from "./AudioEngine";
import { getJumpSound, getStepSound } from "./blockSounds";
import type { BlockMaterial } from "../core/blockDefinition";
import { STEP_INTERVAL } from "../core/constants";
import type { RemotePlayer } from "../world/entities/RemotePlayer";
import { getFeetSupportBlock } from "../world/footstepSurface";
import type { World } from "../world/World";

import { DEFAULT_SFX_WORLD_MAX_DIST_PX } from "./AudioEngine";

const REMOTE_STEP_VEL_THRESHOLD = 10;
const REMOTE_GROUND_VY_ABS_MAX = 180;
const REMOTE_JUMP_PREV_VY_MIN = -280;
const REMOTE_JUMP_CUR_VY_MAX = -420;
/** Wire `vy` matches local player: positive = falling. Landing = was falling fast, now near-ground vy. */
const REMOTE_LAND_PREV_VY_MIN = 240;

export class RemotePlayerMovementSfx {
  private readonly stepAccum = new Map<string, number>();
  private readonly lastVy = new Map<string, number>();
  private readonly lastGroundMat = new Map<string, BlockMaterial>();

  /**
   * @param localListenerX Local player feet world X (for distance attenuation).
   * @param localListenerY Local player feet world Y.
   */
  tick(
    dtSec: number,
    nowMs: number,
    world: World,
    remotes: ReadonlyMap<string, RemotePlayer>,
    audio: AudioEngine,
    localListenerX: number,
    localListenerY: number,
    airBlockId: number,
  ): void {
    for (const id of this.stepAccum.keys()) {
      if (!remotes.has(id)) {
        this.stepAccum.delete(id);
        this.lastVy.delete(id);
        this.lastGroundMat.delete(id);
      }
    }

    for (const [peerId, rp] of remotes) {
      const pose = rp.getDisplayPose(nowMs);
      const dist = Math.hypot(pose.x - localListenerX, pose.y - localListenerY);
      if (dist > DEFAULT_SFX_WORLD_MAX_DIST_PX) {
        this.stepAccum.set(peerId, 0);
        this.lastVy.set(peerId, pose.vy);
        continue;
      }

      const blockBelow = getFeetSupportBlock(world, pose.x, pose.y);
      if (Math.abs(pose.vy) < REMOTE_GROUND_VY_ABS_MAX) {
        if (blockBelow.id !== airBlockId) {
          this.lastGroundMat.set(peerId, blockBelow.material);
        }
      }

      const prevVy = this.lastVy.get(peerId) ?? 0;
      if (
        prevVy > REMOTE_LAND_PREV_VY_MIN &&
        Math.abs(pose.vy) < REMOTE_GROUND_VY_ABS_MAX &&
        !blockBelow.water &&
        blockBelow.id !== airBlockId
      ) {
        audio.playSfx(getJumpSound(blockBelow.material), {
          volume: 0.4,
          pitchVariance: 48,
          world: {
            listenerX: localListenerX,
            listenerY: localListenerY,
            sourceX: pose.x,
            sourceY: pose.y,
            maxDistPx: DEFAULT_SFX_WORLD_MAX_DIST_PX,
          },
        });
      } else if (
        prevVy > REMOTE_JUMP_PREV_VY_MIN &&
        pose.vy < REMOTE_JUMP_CUR_VY_MAX
      ) {
        const mat = this.lastGroundMat.get(peerId) ?? blockBelow.material;
        audio.playSfx(getJumpSound(mat), {
          volume: 0.45,
          pitchVariance: 50,
          world: {
            listenerX: localListenerX,
            listenerY: localListenerY,
            sourceX: pose.x,
            sourceY: pose.y,
            maxDistPx: DEFAULT_SFX_WORLD_MAX_DIST_PX,
          },
        });
      }
      this.lastVy.set(peerId, pose.vy);

      if (Math.abs(pose.vy) >= REMOTE_GROUND_VY_ABS_MAX) {
        this.stepAccum.set(peerId, 0);
        continue;
      }
      if (Math.abs(pose.vx) <= REMOTE_STEP_VEL_THRESHOLD) {
        this.stepAccum.set(peerId, 0);
        continue;
      }
      if (blockBelow.water || blockBelow.id === airBlockId) {
        this.stepAccum.set(peerId, 0);
        continue;
      }

      let acc = (this.stepAccum.get(peerId) ?? 0) + dtSec;
      if (acc >= STEP_INTERVAL) {
        acc = 0;
        audio.playSfx(getStepSound(blockBelow.material), {
          volume: 0.35,
          pitchVariance: 80,
          world: {
            listenerX: localListenerX,
            listenerY: localListenerY,
            sourceX: pose.x,
            sourceY: pose.y,
            maxDistPx: DEFAULT_SFX_WORLD_MAX_DIST_PX,
          },
        });
      }
      this.stepAccum.set(peerId, acc);
    }
  }
}
