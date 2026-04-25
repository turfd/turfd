import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

function formatContextSnippet(source: string, offset: number): string {
  const start = Math.max(0, offset - 28);
  const end = Math.min(source.length, offset + 28);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Parse JSONC text (comments + trailing commas supported) and throw a readable error on failure.
 */
export function parseJsoncText<T = unknown>(text: string, sourceLabel = "JSON"): T {
  const errors: Parameters<typeof parseJsonc>[1] = [];
  const value = parseJsonc(text, errors);
  if (errors.length === 0) {
    return value as T;
  }
  const first = errors[0]!;
  const reason = printParseErrorCode(first.error);
  const context = formatContextSnippet(text, first.offset);
  throw new Error(`${sourceLabel} parse error (${reason}) near: "${context}"`);
}

/**
 * Read response text and parse as JSONC.
 */
export async function parseJsoncResponse<T = unknown>(
  res: Response,
  sourceLabel = "JSON response",
): Promise<T> {
  const text = await res.text();
  return parseJsoncText<T>(text, sourceLabel);
}
