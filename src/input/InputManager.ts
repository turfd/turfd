/**
 * Unified keyboard + mouse; sole module that attaches to window/canvas for input.
 */
import type { Camera } from "../renderer/Camera";
import { type InputAction, type KeybindableAction } from "./bindings";
import { mergeStoredKeyBindings, snapshotKeyBindings } from "./keyBindingMerge";

const MOUSE_PLACE = 2;
const MOUSE_BREAK = 0;

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
    if (!this.mouseDown.has(e.button)) {
      this.mouseJustDown.add(e.button);
    }
    this.mouseDown.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
  };

  private readonly onBlur = (): void => {
    this.downCodes.clear();
    this.mouseDown.clear();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
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
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
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

  destroy(): void {
    this.worldInputBlocked = false;
    this.chatOpen = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("wheel", this.onWheel);
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
  }

  updateMouseWorldPos(camera: Camera): void {
    const rect = this.canvas.getBoundingClientRect();
    // Prefer clientWidth/clientHeight for CSS pixels; they stay stable across some fractional
    // rect reporting (zoom / DPR) and match the containing block the canvas is sized to.
    const cssW = Math.max(1, this.canvas.clientWidth || rect.width || 1);
    const cssH = Math.max(1, this.canvas.clientHeight || rect.height || 1);
    const scaleX = this.canvas.width / cssW;
    const scaleY = this.canvas.height / cssH;
    const cssX = this.mouseClientX - rect.left;
    const cssY = this.mouseClientY - rect.top;
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
