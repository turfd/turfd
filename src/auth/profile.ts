/** Profile row shape and username validation shared by UI and Supabase layer. */

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../core/constants";

export interface ProfileRecord {
  readonly id: string;
  readonly username: string;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export function validateUsername(raw: string): string | null {
  const t = raw.trim();
  if (t.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (t.length > USERNAME_MAX_LENGTH) {
    return `Username must be at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_PATTERN.test(t)) {
    return "Username may only use letters, digits, and underscores.";
  }
  return null;
}
