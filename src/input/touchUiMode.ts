/**
 * Whether to enable on-canvas touch gestures (tap place / hold mine) and
 * {@link MobileTouchControls}. Uses media queries plus {@link Navigator.maxTouchPoints}
 * so devices that report `pointer: fine` (common on tablets) still get touch handling.
 */
export function isTouchUiMode(): boolean {
  if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) {
    return true;
  }
  if (typeof matchMedia === "undefined") {
    return false;
  }
  try {
    return (
      matchMedia("(pointer: coarse)").matches ||
      matchMedia("(hover: none)").matches
    );
  } catch {
    return false;
  }
}
