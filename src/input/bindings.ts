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

export const DEFAULT_KEY_BINDINGS: Readonly<
  Record<Exclude<InputAction, "place" | "break">, readonly string[]>
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
