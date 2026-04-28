const MAX_SIGN_TEXT_CHARS = 640;

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tokenizeInline(input: string): string {
  let out = escapeHtml(input);
  out = out.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "<strong>$1</strong>");
  out = out.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "<em>$1</em>");
  out = out.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "<u>$1</u>");
  out = out.replace(/\[color=(#[0-9a-f]{3,8}|[a-z]+)\]([\s\S]*?)\[\/color\]/gi, (_m, color, text) => {
    const safeColor = String(color).toLowerCase();
    return `<span style="color:${safeColor}">${text}</span>`;
  });
  return out;
}

export function sanitizeSignMarkup(input: string): string {
  return input.slice(0, MAX_SIGN_TEXT_CHARS);
}

export function signMarkupToHtml(input: string): string {
  const safe = sanitizeSignMarkup(input);
  const lines = safe.split(/\r?\n/g).slice(0, 8);
  const rendered: string[] = [];
  for (const line of lines) {
    const centerMatch = line.match(/^\[center\]([\s\S]*?)\[\/center\]$/i);
    if (centerMatch !== null) {
      rendered.push(`<div style="text-align:center">${tokenizeInline(centerMatch[1] ?? "")}</div>`);
    } else {
      rendered.push(`<div>${tokenizeInline(line)}</div>`);
    }
  }
  return rendered.join("");
}

export function signMarkupToPlainText(input: string): string {
  return sanitizeSignMarkup(input)
    .replace(/\[(\/?)(b|i|u|center)\]/gi, "")
    .replace(/\[color=([^\]]+)\]/gi, "")
    .replace(/\[\/color\]/gi, "");
}
