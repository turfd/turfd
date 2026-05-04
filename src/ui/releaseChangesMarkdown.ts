/**
 * Full Markdown → HTML for trusted release notes (build-time git `[Changes]` only).
 * Uses `marked` (GFM) + `dompurify` before `innerHTML`; external links open in a new tab.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

import { normalizeReleaseTypography } from "../../scripts/releaseTypography";

export { normalizeReleaseTypography };

marked.setOptions({
  gfm: true,
  breaks: true,
});

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
