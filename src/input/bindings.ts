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
  | "dropItem";

/** Keyboard-only actions (mouse handles place/break). */
export type KeybindableAction = Exclude<InputAction, "place" | "break">;

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
