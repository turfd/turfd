/**
 * Default keyboard codes per logical action. Mouse buttons handled in InputManager.
 */
export type InputAction =
  | "left"
  | "right"
  | "jump"
  | "sprint"
  | "place"
  | "break"
  | "hotbar1"
  | "hotbar2"
  | "hotbar3"
  | "hotbar4"
  | "hotbar5"
  | "hotbar6"
  | "hotbar7"
  | "hotbar8"
  | "hotbar9"
  | "hotbar0"
  | "inventory"
  | "pause"
  | "toggleBackgroundMode"
  | "chat"
  | "dropItem"
  /** Hard-bound to F3; not user-rebindable (see {@link InputManager}). */
  | "toggleGpuDebug"
  /** Hard-bound to F3+1; toggles profiler chart mode. */
  | "toggleGpuDebugProfiler"
  /** Hard-bound to F3+2; toggles FPS/TPS chart mode. */
  | "toggleGpuDebugPerfGraphs"
  /** Hard-bound to F3+3; toggles bandwidth/ping chart mode. */
  | "toggleGpuDebugNetGraphs"
  /** Hard-bound to F3+F6; cycles debug profile presets. */
  | "cycleGpuDebugProfile";

/** Keyboard-only actions (mouse handles place/break). */
export type KeybindableAction = Exclude<
  InputAction,
  | "place"
  | "break"
  | "toggleGpuDebug"
  | "toggleGpuDebugProfiler"
  | "toggleGpuDebugPerfGraphs"
  | "toggleGpuDebugNetGraphs"
  | "cycleGpuDebugProfile"
>;

export const KEYBINDABLE_ACTION_ORDER: readonly KeybindableAction[] = [
  "left",
  "right",
  "jump",
  "sprint",
  "hotbar1",
  "hotbar2",
  "hotbar3",
  "hotbar4",
  "hotbar5",
  "hotbar6",
  "hotbar7",
  "hotbar8",
  "hotbar9",
  "hotbar0",
  "inventory",
  "pause",
  "toggleBackgroundMode",
  "chat",
  "dropItem",
] as const;

export const KEYBINDABLE_LABELS: Record<KeybindableAction, string> = {
  left: "Move left",
  right: "Move right",
  jump: "Jump / swim up",
  sprint: "Sprint",
  hotbar1: "Hotbar 1",
  hotbar2: "Hotbar 2",
  hotbar3: "Hotbar 3",
  hotbar4: "Hotbar 4",
  hotbar5: "Hotbar 5",
  hotbar6: "Hotbar 6",
  hotbar7: "Hotbar 7",
  hotbar8: "Hotbar 8",
  hotbar9: "Hotbar 9",
  hotbar0: "Hotbar 10",
  inventory: "Inventory",
  pause: "Pause / close",
  toggleBackgroundMode: "Toggle back-wall edit",
  chat: "Chat",
  dropItem: "Drop item",
};

/** Pretty label for a `KeyboardEvent.code` value. */
export function formatKeyCode(code: string): string {
  const named: Record<string, string> = {
    Space: "Space",
    Escape: "Esc",
    Tab: "Tab",
    ShiftLeft: "Shift",
    ShiftRight: "Shift",
    ControlLeft: "Ctrl",
    ControlRight: "Ctrl",
    AltLeft: "Alt",
    AltRight: "Alt",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    IntlBackslash: "\\",
  };
  const n = named[code];
  if (n !== undefined) {
    return n;
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Digit")) {
    return code.slice(5);
  }
  if (code.startsWith("Numpad")) {
    return code.replace("Numpad", "Num ");
  }
  if (code.startsWith("Arrow")) {
    return code.slice(5);
  }
  return code;
}

/** Glyph in `kenney_input_keyboard_&_mouse` for a `KeyboardEvent.code` (null when unsupported). */
export function keyCodeToInputPromptGlyph(code: string): string | null {
  const single = code.match(/^Key([A-Z])$/);
  if (single !== null) {
    const ch = single[1]!.toLowerCase();
    const letterGlyphs: Record<string, number> = {
      a: 0xe015,
      b: 0xe036,
      c: 0xe046,
      d: 0xe056,
      e: 0xe05a,
      f: 0xe066,
      g: 0xe082,
      h: 0xe084,
      i: 0xe088,
      j: 0xe08c,
      k: 0xe08e,
      l: 0xe090,
      m: 0xe092,
      n: 0xe096,
      o: 0xe09e,
      p: 0xe0a3,
      q: 0xe0af,
      r: 0xe0b5,
      s: 0xe0b9,
      t: 0xe0c9,
      u: 0xe0d3,
      v: 0xe0d5,
      w: 0xe0d7,
      x: 0xe0db,
      y: 0xe0dd,
      z: 0xe0df,
    };
    const cp = letterGlyphs[ch];
    return cp === undefined ? null : String.fromCodePoint(cp);
  }

  const digit = code.match(/^Digit([0-9])$/);
  if (digit !== null) {
    const cpByDigit: Record<string, number> = {
      "0": 0xe001,
      "1": 0xe003,
      "2": 0xe005,
      "3": 0xe007,
      "4": 0xe009,
      "5": 0xe00b,
      "6": 0xe00d,
      "7": 0xe00f,
      "8": 0xe011,
      "9": 0xe013,
    };
    return String.fromCodePoint(cpByDigit[digit[1]!]!);
  }

  const named: Record<string, number> = {
    ArrowUp: 0xe023,
    ArrowDown: 0xe01d,
    ArrowLeft: 0xe01f,
    ArrowRight: 0xe021,
    Tab: 0xe0cc,
    Escape: 0xe062,
    Enter: 0xe05e,
    NumpadEnter: 0xe09a,
    Space: 0xe0c6,
    ShiftLeft: 0xe0be,
    ShiftRight: 0xe0be,
    ControlLeft: 0xe054,
    ControlRight: 0xe054,
    AltLeft: 0xe017,
    AltRight: 0xe017,
    Backspace: 0xe038,
    Delete: 0xe058,
    Home: 0xe086,
    End: 0xe05c,
    PageUp: 0xe0a7,
    PageDown: 0xe0a5,
    Insert: 0xe08a,
  };
  const cp = named[code];
  return cp === undefined ? null : String.fromCodePoint(cp);
}

export const DEFAULT_KEY_BINDINGS: Readonly<
  Record<KeybindableAction, readonly string[]>
> = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  jump: ["Space", "ArrowUp", "KeyW"],
  sprint: ["ShiftLeft"],
  hotbar1: ["Digit1"],
  hotbar2: ["Digit2"],
  hotbar3: ["Digit3"],
  hotbar4: ["Digit4"],
  hotbar5: ["Digit5"],
  hotbar6: ["Digit6"],
  hotbar7: ["Digit7"],
  hotbar8: ["Digit8"],
  hotbar9: ["Digit9"],
  hotbar0: ["Digit0"],
  inventory: ["KeyE"],
  pause: ["Escape"],
  toggleBackgroundMode: ["Tab"],
  chat: ["KeyT"],
  dropItem: ["KeyQ"],
};
