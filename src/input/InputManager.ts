/**
 * Unified keyboard + mouse; sole module that attaches to window/canvas for input.
 */
import type { Camera } from "../renderer/Camera";
import { type InputAction, type KeybindableAction } from "./bindings";
import { mergeStoredKeyBindings, snapshotKeyBindings } from "./keyBindingMerge";

const MOUSE_PLACE = 2;
const MOUSE_BREAK = 0;
const MOUSE_PICK = 1;

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

function isBrowserShortcutKey(code: string): boolean {
  switch (code) {
    case "KeyA":
    case "KeyD":
    case "KeyE":
    case "KeyF":
    case "KeyG":
    case "KeyH":
    case "KeyI":
    case "KeyJ":
    case "KeyL":
    case "KeyN":
    case "KeyO":
    case "KeyP":
    case "KeyR":
    case "KeyS":
    case "KeyT":
    case "KeyU":
    case "KeyW":
    case "Equal":
    case "Minus":
    case "Digit0":
    case "BracketLeft":
    case "BracketRight":
    case "Tab":
    case "Slash":
    case "F5":
      return true;
    default:
      return false;
  }
}

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
  /**
   * When true, suppress world "break" while LMB remains held.
   * Used so clicking an entity to melee doesn't also start mining the block behind it.
   */
  private suppressBreakWhileHeld = false;

  /** Effective keyboard codes per action (mouse still handles place/break). */
  private keyBindings: Record<KeybindableAction, readonly string[]> =
    snapshotKeyBindings(mergeStoredKeyBindings(undefined));

  private mouseClientX = 0;
  private mouseClientY = 0;
  private canvasRectLeft = 0;
  private canvasRectTop = 0;
  private canvasCssW = 1;
  private canvasCssH = 1;
  private canvasMetricsDirty = true;
  private canvasResizeObserver: ResizeObserver | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const editableFocus = isEditableDocumentFocus(document.activeElement);
    const gameplayInputActive = !this.worldInputBlocked && !this.chatOpen;
    if (
      gameplayInputActive &&
      !editableFocus &&
      (e.ctrlKey || e.metaKey) &&
      isBrowserShortcutKey(e.code)
    ) {
      // Keep browser shortcuts from stealing focus / closing tabs while in-game.
      e.preventDefault();
    }
    if (
      (e.code === "Space" || e.code === "Tab") &&
      !editableFocus
    ) {
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

  private readonly onCanvasMetricsInvalidated = (): void => {
    this.canvasMetricsDirty = true;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === MOUSE_PICK && e.target === this.canvas) {
      e.preventDefault();
    }
    if (!this.mouseDown.has(e.button)) {
      this.mouseJustDown.add(e.button);
    }
    this.mouseDown.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
    if (e.button === MOUSE_BREAK) {
      this.suppressBreakWhileHeld = false;
    }
  };

  private readonly onBlur = (): void => {
    this.downCodes.clear();
    this.mouseDown.clear();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === MOUSE_PICK) {
      e.preventDefault();
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  private readonly updateCanvasMetrics = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.canvasRectLeft = rect.left;
    this.canvasRectTop = rect.top;
    /**
     * Prefer `getBoundingClientRect()` over `clientWidth/Height` because rect includes
     * CSS transforms/zoom; using client metrics can skew pointer ↔ canvas mapping
     * (commonly on HiDPI laptops / browser zoom / transformed mounts).
     */
    this.canvasCssW = Math.max(1, rect.width || this.canvas.clientWidth || 1);
    this.canvasCssH = Math.max(1, rect.height || this.canvas.clientHeight || 1);
    this.canvasMetricsDirty = false;
  };

  constructor(
    canvas: HTMLCanvasElement,
    storedOverrides?: Partial<Record<KeybindableAction, readonly string[]>>,
  ) {
    this.canvas = canvas;
    this.keyBindings = snapshotKeyBindings(
      mergeStoredKeyBindings(storedOverrides),
    );
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onCanvasMetricsInvalidated);
    window.addEventListener("scroll", this.onCanvasMetricsInvalidated, true);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("auxclick", this.onAuxClick);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    if (typeof ResizeObserver !== "undefined") {
      this.canvasResizeObserver = new ResizeObserver(this.onCanvasMetricsInvalidated);
      this.canvasResizeObserver.observe(canvas);
    }
    this.updateCanvasMetrics();
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

  getKeyBindingsForAction(action: KeybindableAction): readonly string[] {
    return this.keyBindings[action] ?? [];
  }

  destroy(): void {
    this.worldInputBlocked = false;
    this.chatOpen = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onCanvasMetricsInvalidated);
    window.removeEventListener("scroll", this.onCanvasMetricsInvalidated, true);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("auxclick", this.onAuxClick);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = null;
  }

  isDown(action: InputAction): boolean {
    if (this.chatOpen && action !== "pause") {
      return false;
    }
    if (
      this.worldInputBlocked &&
      action !== "inventory" &&
      action !== "pause" &&
      action !== "chat" &&
      action !== "dropItem"
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
      if (this.suppressBreakWhileHeld && this.mouseDown.has(MOUSE_BREAK)) {
        return false;
      }
      return this.mouseDown.has(MOUSE_BREAK);
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
      action !== "chat" &&
      action !== "dropItem"
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
      if (this.suppressBreakWhileHeld) {
        return false;
      }
      return this.mouseJustDown.has(MOUSE_BREAK);
    }
    return this.justPressed.has(action);
  }

  mouseButton(btn: 0 | 1 | 2): boolean {
    return this.mouseDown.has(btn);
  }

  mouseButtonJustPressed(btn: 0 | 1 | 2): boolean {
    if (this.chatOpen) {
      return false;
    }
    return this.mouseJustDown.has(btn);
  }

  /** Raw keyboard code state (e.g. `ControlLeft`) for mode-specific controls. */
  isKeyCodeDown(code: string): boolean {
    if (this.chatOpen) {
      return false;
    }
    return this.downCodes.has(code);
  }

  /** Call once per fixed tick after all systems have read input. */
  postUpdate(): void {
    this.justPressed.clear();
    this.mouseJustDown.clear();
    this.wheelDelta = 0;
    // If LMB is no longer held, clear suppression (covers missed mouseup events).
    if (!this.mouseDown.has(MOUSE_BREAK)) {
      this.suppressBreakWhileHeld = false;
    }
  }

  /**
   * Suppress world mining ("break") until LMB is released.
   * Safe to call even if the mouse isn't down.
   */
  suppressBreakUntilMouseUp(): void {
    this.suppressBreakWhileHeld = true;
    // Prevent this frame from also registering as "just pressed break".
    this.mouseJustDown.delete(MOUSE_BREAK);
  }

  /**
   * Suppress world "place" for the current frame.
   * Useful when RMB is repurposed for tools that should not also place blocks.
   */
  suppressPlaceThisFrame(): void {
    this.mouseJustDown.delete(MOUSE_PLACE);
  }

  updateMouseWorldPos(camera: Camera): void {
    if (this.canvasMetricsDirty) {
      this.updateCanvasMetrics();
    }
    const scaleX = this.canvas.width / this.canvasCssW;
    const scaleY = this.canvas.height / this.canvasCssH;
    const cssX = this.mouseClientX - this.canvasRectLeft;
    const cssY = this.mouseClientY - this.canvasRectTop;
    const sx = cssX * scaleX;
    const sy = cssY * scaleY;
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
