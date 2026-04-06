/**
 * On-screen move stick + jump for touch UI mode (landscape-first).
 */
import type { InputManager } from "../input/InputManager";

const STICK_DEAD = 0.12;

export class MobileTouchControls {
  private readonly root: HTMLDivElement;
  private readonly unsub: () => void;

  constructor(mount: HTMLElement, input: InputManager) {
    const root = document.createElement("div");
    root.className = "mobile-touch-controls";
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = [
      "position:absolute",
      "inset:0",
      "z-index:50",
      "pointer-events:none",
      "overflow:visible",
    ].join(";");

    const stickArea = document.createElement("div");
    stickArea.className = "mobile-touch-controls__stick-area";
    stickArea.style.cssText = [
      "position:absolute",
      "left:max(12px, env(safe-area-inset-left, 0px))",
      "bottom:max(88px, calc(env(safe-area-inset-bottom, 0px) + 72px))",
      "width:clamp(100px, 24vmin, 150px)",
      "height:clamp(100px, 24vmin, 150px)",
      "border-radius:50%",
      "background:rgba(0,0,0,0.22)",
      "border:1px solid rgba(255,255,255,0.14)",
      "pointer-events:auto",
      "touch-action:none",
    ].join(";");

    const stickKnob = document.createElement("div");
    stickKnob.className = "mobile-touch-controls__stick-knob";
    stickKnob.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "width:38%",
      "height:38%",
      "margin-left:-19%",
      "margin-top:-19%",
      "border-radius:50%",
      "background:rgba(255,255,255,0.35)",
      "border:1px solid rgba(255,255,255,0.25)",
      "pointer-events:none",
    ].join(";");

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "mobile-touch-controls__jump";
    jumpBtn.setAttribute("aria-label", "Jump");
    jumpBtn.textContent = "⬆";
    jumpBtn.style.cssText = [
      "position:absolute",
      "right:max(12px, env(safe-area-inset-right, 0px))",
      "bottom:max(88px, calc(env(safe-area-inset-bottom, 0px) + 72px))",
      "width:clamp(48px, 12vmin, 68px)",
      "height:clamp(48px, 12vmin, 68px)",
      "padding:0",
      "border-radius:14px",
      "font-size:clamp(22px, 6vmin, 32px)",
      "line-height:1",
      "color:#fff",
      "background:rgba(0,0,0,0.28)",
      "border:1px solid rgba(255,255,255,0.2)",
      "pointer-events:auto",
      "touch-action:none",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ].join(";");

    stickArea.appendChild(stickKnob);
    root.appendChild(stickArea);
    root.appendChild(jumpBtn);
    mount.appendChild(root);

    this.root = root;

    let stickPointerId: number | null = null;
    let stickCx = 0;
    let stickCy = 0;
    let stickR = 1;

    const syncStickMetrics = (): void => {
      const r = stickArea.getBoundingClientRect();
      stickCx = r.left + r.width * 0.5;
      stickCy = r.top + r.height * 0.5;
      stickR = Math.max(16, r.width * 0.42);
    };

    const applyStick = (clientX: number, clientY: number): void => {
      syncStickMetrics();
      let dx = (clientX - stickCx) / stickR;
      let dy = (clientY - stickCy) / stickR;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      stickKnob.style.left = `${50 + dx * 42}%`;
      stickKnob.style.top = `${50 + dy * 42}%`;
      const ax = Math.abs(dx) < STICK_DEAD ? 0 : dx;
      input.setTouchMoveAxis(ax);
    };

    const clearStick = (): void => {
      stickKnob.style.left = "50%";
      stickKnob.style.top = "50%";
      input.setTouchMoveAxis(0);
    };

    const onStickDown = (e: PointerEvent): void => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      stickPointerId = e.pointerId;
      try {
        stickArea.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      applyStick(e.clientX, e.clientY);
    };

    const onStickMove = (e: PointerEvent): void => {
      if (stickPointerId !== e.pointerId) {
        return;
      }
      e.preventDefault();
      applyStick(e.clientX, e.clientY);
    };

    const onStickUp = (e: PointerEvent): void => {
      if (stickPointerId !== e.pointerId) {
        return;
      }
      e.preventDefault();
      stickPointerId = null;
      try {
        stickArea.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      clearStick();
    };

    const onJumpDown = (e: PointerEvent): void => {
      e.preventDefault();
      input.setTouchJumpDown(true);
    };

    const onJumpUp = (e: PointerEvent): void => {
      e.preventDefault();
      input.setTouchJumpDown(false);
    };

    stickArea.addEventListener("pointerdown", onStickDown, { passive: false });
    stickArea.addEventListener("pointermove", onStickMove, { passive: false });
    stickArea.addEventListener("pointerup", onStickUp, { passive: false });
    stickArea.addEventListener("pointercancel", onStickUp, { passive: false });

    jumpBtn.addEventListener("pointerdown", onJumpDown, { passive: false });
    jumpBtn.addEventListener("pointerup", onJumpUp, { passive: false });
    jumpBtn.addEventListener("pointercancel", onJumpUp, { passive: false });

    this.unsub = (): void => {
      stickArea.removeEventListener("pointerdown", onStickDown);
      stickArea.removeEventListener("pointermove", onStickMove);
      stickArea.removeEventListener("pointerup", onStickUp);
      stickArea.removeEventListener("pointercancel", onStickUp);
      jumpBtn.removeEventListener("pointerdown", onJumpDown);
      jumpBtn.removeEventListener("pointerup", onJumpUp);
      jumpBtn.removeEventListener("pointercancel", onJumpUp);
      clearStick();
      input.setTouchJumpDown(false);
    };
  }

  destroy(): void {
    this.unsub();
    this.root.remove();
  }
}
