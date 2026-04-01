/**
 * Unified keyboard + mouse; sole module that attaches to window/canvas for input.
 */
import type { Camera } from "../renderer/Camera";
import {
  DEFAULT_KEY_BINDINGS,
  type InputAction,
} from "./bindings";

const MOUSE_PLACE = 2;
const MOUSE_BREAK = 0;

export class InputManager {
  readonly mouseWorldPos = { x: 0, y: 0 };

  /** Accumulated wheel deltaY since last {@link postUpdate} (read in Player.update). */
  wheelDelta = 0;

  /** When true (e.g. inventory overlay open), block world break/place input. */
  private worldInputBlocked = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly downCodes = new Set<string>();
  private readonly justPressed = new Set<InputAction>();
  private readonly mouseDown = new Set<number>();
  private readonly mouseJustDown = new Set<number>();

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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

  isWorldInputBlocked(): boolean {
    return this.worldInputBlocked;
  }

  destroy(): void {
    this.worldInputBlocked = false;
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
    if (
      this.worldInputBlocked &&
      action !== "inventory" &&
      action !== "pause"
    ) {
      return false;
    }
    if (action === "place") {
      return this.mouseDown.has(MOUSE_PLACE);
    }
    if (action === "break") {
      return this.mouseDown.has(MOUSE_BREAK);
    }
    const keys = DEFAULT_KEY_BINDINGS[action as keyof typeof DEFAULT_KEY_BINDINGS];
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
    if (
      this.worldInputBlocked &&
      action !== "inventory" &&
      action !== "pause"
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
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const sx = (this.mouseClientX - rect.left) * scaleX;
    const sy = (this.mouseClientY - rect.top) * scaleY;
    const w = camera.screenToWorld(sx, sy);
    this.mouseWorldPos.x = w.x;
    this.mouseWorldPos.y = w.y;
  }

  private edgeForCode(code: string): void {
    for (const [action, keys] of Object.entries(DEFAULT_KEY_BINDINGS) as [
      keyof typeof DEFAULT_KEY_BINDINGS,
      readonly string[],
    ][]) {
      if (keys.includes(code)) {
        this.justPressed.add(action as InputAction);
      }
    }
  }
}
