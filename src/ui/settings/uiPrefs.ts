/** localStorage-backed UI preferences (simple boolean toggles). */

const PREF_SKIP_INTRO = "stratum_skip_intro";

export function getSkipIntro(): boolean {
  return localStorage.getItem(PREF_SKIP_INTRO) === "1";
}

export function setSkipIntro(skip: boolean): void {
  if (skip) {
    localStorage.setItem(PREF_SKIP_INTRO, "1");
  } else {
    localStorage.removeItem(PREF_SKIP_INTRO);
  }
}
