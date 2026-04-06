/**
 * Unified keyboard + mouse; sole module that attaches to window/canvas for input.
 */
import type { Camera } from "../renderer/Camera";
import { type InputAction, type KeybindableAction } from "./bindings";
import { mergeStoredKeyBindings, snapshotKeyBindings } from "./keyBindingMerge";

const MOUSE_PLACE = 2;
const MOUSE_BREAK = 0;

/** After this hold duration (ms), canvas touch starts mining (LMB). */
const TOUCH_MINE_HOLD_MS = 200;
/** Release before this (ms) after a tap → synthetic place (RMB edge). */
const TOUCH_TAP_PLACE_MAX_MS = 280;
/** Movement from touch start (px) beyond this cancels tap-to-place. */
const TOUCH_TAP_SLOP_PX = 14;

/** True when the focused DOM node is typing-oriented (inventory search, chat field, etc.). */
function isEditableDocumentFocus(el: Element | null): boolean {
  if (el === null || !(el instanceof HTMLElement)) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return (
      t !== "button" &&
      t !== "submit" &&
      t !== "reset" &&
      t !== "checkbox" &&
      t !== "radio" &&
      t !== "file" &&
      t !== "range" &&
      t !== "color" &&
      t !== "hidden"
    );
  }
  return false;
}

export type InputManagerOptions = {
  /** When true, canvas touch uses tap=place / hold=break; pointer listeners attach. */
  touchGesturesEnabled?: boolean;
};

export class InputManager {
  readonly mouseWorldPos = { x: 0, y: 0 };

  /** Accumulated wheel deltaY since last {@link postUpdate} (read in Player.update). */
  wheelDelta = 0;

  /** When true (e.g. inventory overlay open), block world break/place input. */
  private worldInputBlocked = false;

  /** When true (chat input focused), block game actions; {@link InputAction.pause} still passes for Escape. */
  private chatOpen = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly downCodes = new Set<string>();
  private readonly justPressed = new Set<InputAction>();
  private readonly mouseDown = new Set<number>();
  private readonly mouseJustDown = new Set<number>();

  /** Effective keyboard codes per action (mouse still handles place/break). */
  private keyBindings: Record<KeybindableAction, readonly string[]> =
    snapshotKeyBindings(mergeStoredKeyBindings(undefined));

  private mouseClientX = 0;
  private mouseClientY = 0;

  private readonly touchGesturesEnabled: boolean;
  private canvasTouchActionPrev: string | null = null;

  /** Analog horizontal move from on-screen stick [-1, 1]. */
  private touchMoveAxis = 0;
  private touchJumpHeld = false;
  private touchJumpJust = false;

  private touchWorldPointerId: number | null = null;
  private touchWorldStartX = 0;
  private touchWorldStartY = 0;
  private touchWorldStartTime = 0;
  private touchWorldMining = false;
  private touchWorldSlopExceeded = false;
  private touchMineHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private touchWorldHasPointerCapture = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space" || e.code === "Tab") {
      e.preventDefault();
    }
    if (e.repeat) {
      return;
    }
    this.downCodes.add(e.code);
    this.edgeForCode(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.downCodes.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    // Some mobile browsers "touch → mouse events" without pointer/touch events.
    // Update aim position on down so tap/hold targets the touched block.
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
    if (!this.mouseDown.has(e.button)) {
      this.mouseJustDown.add(e.button);
    }
    this.mouseDown.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseClientX = e.clientX;
    this.mouseClientY = e.clientY;
    this.mouseDown.delete(e.button);
  };

  private readonly onBlur = (): void => {
    this.downCodes.clear();
    this.mouseDown.clear();
    this.clearTouchWorldGesture();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  private readonly onPointerDown = (e: Event): void => {
    const ev = e as PointerEvent;
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (ev.pointerType !== "touch" && ev.pointerType !== "pen") {
      return;
    }
    // `target` can differ from the canvas on some browsers; listener is on the canvas.
    if (ev.currentTarget !== this.canvas) {
      return;
    }
    if (!this.canProcessWorldPointer()) {
      return;
    }
    ev.preventDefault();
    try {
      // Keep receiving move/up even if finger drifts off-canvas.
      this.canvas.setPointerCapture(ev.pointerId);
      this.touchWorldHasPointerCapture = true;
    } catch {
      this.touchWorldHasPointerCapture = false;
    }
    this.clearTouchMineTimer();
    this.touchWorldPointerId = ev.pointerId;
    this.touchWorldStartX = ev.clientX;
    this.touchWorldStartY = ev.clientY;
    this.touchWorldStartTime = performance.now();
    this.touchWorldMining = false;
    this.touchWorldSlopExceeded = false;
    this.mouseClientX = ev.clientX;
    this.mouseClientY = ev.clientY;

    const pid = ev.pointerId;
    this.touchMineHoldTimer = setTimeout(() => {
      this.touchMineHoldTimer = null;
      if (this.touchWorldPointerId !== pid) {
        return;
      }
      if (!this.canProcessWorldPointer()) {
        return;
      }
      this.touchWorldMining = true;
      this.mouseDown.add(MOUSE_BREAK);
    }, TOUCH_MINE_HOLD_MS);
  };

  private readonly onPointerMove = (e: Event): void => {
    const ev = e as PointerEvent;
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (this.touchWorldPointerId !== ev.pointerId) {
      return;
    }
    ev.preventDefault();
    this.mouseClientX = ev.clientX;
    this.mouseClientY = ev.clientY;
    const dx = ev.clientX - this.touchWorldStartX;
    const dy = ev.clientY - this.touchWorldStartY;
    if (dx * dx + dy * dy > TOUCH_TAP_SLOP_PX * TOUCH_TAP_SLOP_PX) {
      this.touchWorldSlopExceeded = true;
    }
  };

  private readonly onPointerUpOrCancel = (e: Event): void => {
    const ev = e as PointerEvent;
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (this.touchWorldPointerId !== ev.pointerId) {
      return;
    }
    ev.preventDefault();
    this.mouseClientX = ev.clientX;
    this.mouseClientY = ev.clientY;

    const elapsed = performance.now() - this.touchWorldStartTime;
    this.clearTouchMineTimer();

    if (this.touchWorldMining) {
      this.mouseDown.delete(MOUSE_BREAK);
      this.touchWorldMining = false;
    } else if (
      this.canProcessWorldPointer() &&
      elapsed < TOUCH_TAP_PLACE_MAX_MS &&
      !this.touchWorldSlopExceeded
    ) {
      this.mouseJustDown.add(MOUSE_PLACE);
    }

    this.touchWorldPointerId = null;
    if (this.touchWorldHasPointerCapture) {
      try {
        this.canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      this.touchWorldHasPointerCapture = false;
    }
  };

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (e.currentTarget !== this.canvas) {
      return;
    }
    if (!this.canProcessWorldPointer()) {
      return;
    }
    if (this.touchWorldPointerId !== null) {
      return;
    }
    const t = e.changedTouches.item(0);
    if (!t) {
      return;
    }
    e.preventDefault();
    this.clearTouchMineTimer();
    this.touchWorldPointerId = t.identifier;
    this.touchWorldStartX = t.clientX;
    this.touchWorldStartY = t.clientY;
    this.touchWorldStartTime = performance.now();
    this.touchWorldMining = false;
    this.touchWorldSlopExceeded = false;
    this.mouseClientX = t.clientX;
    this.mouseClientY = t.clientY;

    const tid = t.identifier;
    this.touchMineHoldTimer = setTimeout(() => {
      this.touchMineHoldTimer = null;
      if (this.touchWorldPointerId !== tid) {
        return;
      }
      if (!this.canProcessWorldPointer()) {
        return;
      }
      this.touchWorldMining = true;
      this.mouseDown.add(MOUSE_BREAK);
    }, TOUCH_MINE_HOLD_MS);
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (this.touchWorldPointerId === null) {
      return;
    }
    const tid = this.touchWorldPointerId;
    let t: Touch | null = null;
    for (let i = 0; i < e.changedTouches.length; i += 1) {
      const ct = e.changedTouches.item(i);
      if (ct && ct.identifier === tid) {
        t = ct;
        break;
      }
    }
    if (!t) {
      return;
    }
    e.preventDefault();
    this.mouseClientX = t.clientX;
    this.mouseClientY = t.clientY;
    const dx = t.clientX - this.touchWorldStartX;
    const dy = t.clientY - this.touchWorldStartY;
    if (dx * dx + dy * dy > TOUCH_TAP_SLOP_PX * TOUCH_TAP_SLOP_PX) {
      this.touchWorldSlopExceeded = true;
    }
  };

  private readonly onTouchEndOrCancel = (e: TouchEvent): void => {
    if (!this.touchGesturesEnabled) {
      return;
    }
    if (this.touchWorldPointerId === null) {
      return;
    }
    const tid = this.touchWorldPointerId;
    let t: Touch | null = null;
    for (let i = 0; i < e.changedTouches.length; i += 1) {
      const ct = e.changedTouches.item(i);
      if (ct && ct.identifier === tid) {
        t = ct;
        break;
      }
    }
    if (!t) {
      return;
    }
    e.preventDefault();
    this.mouseClientX = t.clientX;
    this.mouseClientY = t.clientY;

    const elapsed = performance.now() - this.touchWorldStartTime;
    this.clearTouchMineTimer();

    if (this.touchWorldMining) {
      this.mouseDown.delete(MOUSE_BREAK);
      this.touchWorldMining = false;
    } else if (
      this.canProcessWorldPointer() &&
      elapsed < TOUCH_TAP_PLACE_MAX_MS &&
      !this.touchWorldSlopExceeded
    ) {
      this.mouseJustDown.add(MOUSE_PLACE);
    }

    this.touchWorldPointerId = null;
  };

  private clearTouchMineTimer(): void {
    if (this.touchMineHoldTimer !== null) {
      clearTimeout(this.touchMineHoldTimer);
      this.touchMineHoldTimer = null;
    }
  }

  private clearTouchWorldGesture(): void {
    this.clearTouchMineTimer();
    if (this.touchWorldMining) {
      this.mouseDown.delete(MOUSE_BREAK);
    }
    this.touchWorldMining = false;
    this.touchWorldPointerId = null;
  }

  private canProcessWorldPointer(): boolean {
    if (this.chatOpen) {
      return false;
    }
    if (this.worldInputBlocked) {
      return false;
    }
    return true;
  }

  constructor(
    canvas: HTMLCanvasElement,
    storedOverrides?: Partial<Record<KeybindableAction, readonly string[]>>,
    options?: InputManagerOptions,
  ) {
    this.canvas = canvas;
    this.keyBindings = snapshotKeyBindings(
      mergeStoredKeyBindings(storedOverrides),
    );
    this.touchGesturesEnabled = options?.touchGesturesEnabled ?? false;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("blur", this.onBlur);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    if (this.touchGesturesEnabled) {
      this.canvasTouchActionPrev = canvas.style.touchAction;
      canvas.style.touchAction = "none";
      const opts: AddEventListenerOptions = { passive: false };
      canvas.addEventListener("pointerdown", this.onPointerDown, opts);
      canvas.addEventListener("pointermove", this.onPointerMove, opts);
      canvas.addEventListener("pointerup", this.onPointerUpOrCancel, opts);
      canvas.addEventListener("pointercancel", this.onPointerUpOrCancel, opts);
      canvas.addEventListener("touchstart", this.onTouchStart, opts);
      canvas.addEventListener("touchmove", this.onTouchMove, opts);
      canvas.addEventListener("touchend", this.onTouchEndOrCancel, opts);
      canvas.addEventListener("touchcancel", this.onTouchEndOrCancel, opts);
    }
  }

  setWorldInputBlocked(blocked: boolean): void {
    this.worldInputBlocked = blocked;
  }

  /** Suspend movement, hotbar, inventory, etc. while chat is open; Escape still registers as pause. */
  setChatOpen(open: boolean): void {
    this.chatOpen = open;
  }

  isWorldInputBlocked(): boolean {
    return this.worldInputBlocked;
  }

  /** While a blocked UI (inventory, pause, etc.) is up and a text field is focused, suppress chat/inventory hotkeys. */
  private uiTypingSuppressesOverlayHotkeys(): boolean {
    return this.worldInputBlocked && isEditableDocumentFocus(document.activeElement);
  }

  /**
   * RMB pressed this frame, ignoring {@link setWorldInputBlocked} (still false while chat open).
   * Used to open chest / crafting table while the inventory overlay has world input blocked.
   */
  isJustPressedPlaceIgnoreWorldBlock(): boolean {
    if (this.chatOpen) {
      return false;
    }
    return this.mouseJustDown.has(MOUSE_PLACE);
  }

  /**
   * Replace keyboard bindings (e.g. from settings). Does not affect mouse
   * break/place.
   */
  setKeyBindings(
    next: Record<KeybindableAction, readonly string[]>,
  ): void {
    this.keyBindings = snapshotKeyBindings(
      mergeStoredKeyBindings(next as Partial<Record<KeybindableAction, readonly string[]>>),
    );
  }

  /** On-screen move stick: [-1, 1] horizontal. */
  setTouchMoveAxis(x: number): void {
    const v = Number.isFinite(x) ? x : 0;
    this.touchMoveAxis = Math.max(-1, Math.min(1, v));
  }

  /** On-screen jump button. */
  setTouchJumpDown(down: boolean): void {
    if (down) {
      if (!this.touchJumpHeld) {
        this.touchJumpJust = true;
      }
      this.touchJumpHeld = true;
    } else {
      this.touchJumpHeld = false;
    }
  }

  /**
   * Keyboard left/right (-1, 0, 1) plus analog stick, clamped. Blocked when chat/inventory/pause
   * would block movement keys.
   */
  getCombinedHorizontalMoveAxis(): number {
    if (this.chatOpen || this.worldInputBlocked) {
      return 0;
    }
    let k = 0;
    for (const code of this.keyBindings.left) {
      if (this.downCodes.has(code)) {
        k -= 1;
      }
    }
    for (const code of this.keyBindings.right) {
      if (this.downCodes.has(code)) {
        k += 1;
      }
    }
    return Math.max(-1, Math.min(1, k + this.touchMoveAxis));
  }

  destroy(): void {
    this.worldInputBlocked = false;
    this.chatOpen = false;
    this.clearTouchWorldGesture();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("wheel", this.onWheel);
    if (this.touchGesturesEnabled) {
      const opts: AddEventListenerOptions = { passive: false };
      this.canvas.removeEventListener("pointerdown", this.onPointerDown, opts);
      this.canvas.removeEventListener("pointermove", this.onPointerMove, opts);
      this.canvas.removeEventListener("pointerup", this.onPointerUpOrCancel, opts);
      this.canvas.removeEventListener("pointercancel", this.onPointerUpOrCancel, opts);
      this.canvas.removeEventListener("touchstart", this.onTouchStart, opts);
      this.canvas.removeEventListener("touchmove", this.onTouchMove, opts);
      this.canvas.removeEventListener("touchend", this.onTouchEndOrCancel, opts);
      this.canvas.removeEventListener("touchcancel", this.onTouchEndOrCancel, opts);
      if (this.canvasTouchActionPrev !== null) {
        this.canvas.style.touchAction = this.canvasTouchActionPrev;
      } else {
        this.canvas.style.removeProperty("touch-action");
      }
    }
  }

  isDown(action: InputAction): boolean {
    if (this.chatOpen && action !== "pause") {
      return false;
    }
    if (
      this.worldInputBlocked &&
      action !== "inventory" &&
      action !== "pause" &&
      action !== "chat"
    ) {
      return false;
    }
    if (
      this.uiTypingSuppressesOverlayHotkeys() &&
      (action === "inventory" || action === "chat")
    ) {
      return false;
    }
    if (action === "place") {
      return this.mouseDown.has(MOUSE_PLACE);
    }
    if (action === "break") {
      return this.mouseDown.has(MOUSE_BREAK);
    }
    if (action === "jump" && this.touchJumpHeld) {
      return true;
    }
    const keys = this.keyBindings[action as KeybindableAction];
    if (!keys) {
      return false;
    }
    for (const code of keys) {
      if (this.downCodes.has(code)) {
        return true;
      }
    }
    return false;
  }

  isJustPressed(action: InputAction): boolean {
    if (this.chatOpen && action !== "pause") {
      return false;
    }
    if (
      this.worldInputBlocked &&
      action !== "inventory" &&
      action !== "pause" &&
      action !== "chat"
    ) {
      return false;
    }
    if (
      this.uiTypingSuppressesOverlayHotkeys() &&
      (action === "inventory" || action === "chat")
    ) {
      return false;
    }
    if (action === "place") {
      return this.mouseJustDown.has(MOUSE_PLACE);
    }
    if (action === "break") {
      return this.mouseJustDown.has(MOUSE_BREAK);
    }
    if (action === "jump" && this.touchJumpJust) {
      return true;
    }
    return this.justPressed.has(action);
  }

  mouseButton(btn: 0 | 1 | 2): boolean {
    return this.mouseDown.has(btn);
  }

  /** Call once per fixed tick after all systems have read input. */
  postUpdate(): void {
    this.justPressed.clear();
    this.mouseJustDown.clear();
    this.wheelDelta = 0;
    this.touchJumpJust = false;
  }

  updateMouseWorldPos(camera: Camera): void {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const sx = (this.mouseClientX - rect.left) * scaleX;
    const sy = (this.mouseClientY - rect.top) * scaleY;
    const w = camera.screenToWorld(sx, sy);
    this.mouseWorldPos.x = w.x;
    this.mouseWorldPos.y = w.y;
  }

  private edgeForCode(code: string): void {
    for (const action of Object.keys(this.keyBindings) as KeybindableAction[]) {
      const keys = this.keyBindings[action];
      if (keys.includes(code)) {
        this.justPressed.add(action as InputAction);
      }
    }
  }
}
