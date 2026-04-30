/**
 * Full Markdown → HTML for trusted release notes (build-time git `[Changes]` only).
 * Uses `marked` (GFM) + `dompurify` before `innerHTML`; external links open in a new tab.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Replace common Unicode punctuation with ASCII so bitmap fonts (M5x7 / BoldPixels)
 * do not fall back to system serif/sans for missing glyphs.
 */
export function normalizeReleaseTypography(text: string): string {
  let s = text;
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

/** Walk text nodes so entities / marked output cannot leave stray Unicode in the DOM. */
function normalizeTypographyTextNodes(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n !== null) {
    const text = n.nodeValue;
    if (text !== null && text.length > 0) {
      const next = normalizeReleaseTypography(text);
      if (next !== text) {
        n.nodeValue = next;
      }
    }
    n = walker.nextNode();
  }
}

/** Clears `parent` and appends rendered nodes. */
export function mountReleaseChangesMarkdown(parent: HTMLElement, md: string): void {
  parent.replaceChildren();
  const trimmed = normalizeReleaseTypography(md.trim());
  if (trimmed.length === 0) {
    const p = document.createElement("p");
    p.className = "mm-release-changes-empty";
    p.textContent = "No detailed changes listed.";
    parent.appendChild(p);
    return;
  }

  const raw = marked.parse(trimmed, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["input"],
    ADD_ATTR: ["type", "checked", "disabled", "class"],
  });

  const wrap = document.createElement("div");
  wrap.className = "mm-release-changes-md";
  wrap.innerHTML = clean;
  normalizeTypographyTextNodes(wrap);

  for (const el of wrap.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = el.getAttribute("href");
    if (href !== null && /^https?:\/\//i.test(href)) {
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    }
  }

  parent.appendChild(wrap);
}
