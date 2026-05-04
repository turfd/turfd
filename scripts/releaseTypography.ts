/**
 * Shared release-note typography normalization (Node + browser).
 * Replaces common Unicode punctuation with ASCII so bitmap fonts and Discord stay predictable.
 */

export function normalizeReleaseTypography(text: string): string {
  let s = text;
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replaceAll("\u201c", '"').replaceAll("\u201d", '"');
  s = s.replaceAll("\u2018", "'").replaceAll("\u2019", "'");
  s = s.replaceAll("\u201a", ",").replaceAll("\u201e", '"');
  s = s.replaceAll("\u2014", " - "); // em dash
  s = s.replaceAll("\u2013", "-"); // en dash
  s = s.replaceAll("\u2012", "-"); // figure dash
  s = s.replaceAll("\u2015", "-"); // horizontal bar
  s = s.replaceAll("\u2212", "-"); // minus
  s = s.replaceAll("\u2026", "...");
  s = s.replaceAll("\u22ef", "..."); // midline horizontal ellipsis
  s = s.replaceAll("\u2192", "->");
  s = s.replaceAll("\u2190", "<-");
  s = s.replaceAll("\u2194", "<->");
  s = s.replaceAll("\u21d2", "=>");
  s = s.replaceAll("\u21d4", "<=>");
  s = s.replaceAll("\u00d7", "x");
  s = s.replaceAll("\u00f7", "/");
  s = s.replaceAll("\u2022", "*"); // bullet
  s = s.replaceAll("\u2043", "-"); // hyphen bullet
  s = s.replaceAll("\u00b7", "."); // middle dot (e.g. "a · b" separators)
  s = s.replaceAll("\u2032", "'"); // prime
  s = s.replaceAll("\u2033", '"'); // double prime
  s = s.replaceAll("\u00ab", "<<").replaceAll("\u00bb", ">>");
  s = s.replaceAll("\u2039", "<").replaceAll("\u203a", ">");
  s = s.replaceAll("\u00a0", " ");
  s = s.replace(/[\u2000-\u200a]/gu, " "); // en/quad/em/hair spaces etc.
  s = s.replaceAll("\u202f", " "); // narrow no-break space
  s = s.replaceAll("\u200b", "").replaceAll("\ufeff", "");
  s = s.replaceAll("\u2011", "-"); // non-breaking hyphen
  s = s.replaceAll("\u02bc", "'"); // modifier letter apostrophe
  return s;
}
