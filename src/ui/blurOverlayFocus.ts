/**
 * Before setting `aria-hidden="true"` on a dialog/overlay, blur any focused
 * descendant so assistive tech does not see "hidden" ancestors containing focus
 * (browser warning: blocked aria-hidden on focused element).
 */
export function blurFocusContainedBy(container: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && container.contains(active)) {
    active.blur();
  }
}
