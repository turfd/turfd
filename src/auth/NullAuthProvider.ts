/** Offline guest auth: no Supabase; stable session display label from crypto. */

import type { AuthSession, IAuthProvider } from "./IAuthProvider";
import type { ProfileRecord } from "./profile";

function makeGuestLabel(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `Guest_${hex.toUpperCase()}`;
}

export class NullAuthProvider implements IAuthProvider {
  readonly isConfigured = false;

  private readonly guestLabel: string;

  constructor() {
    this.guestLabel = makeGuestLabel();
  }

  getSession(): AuthSession | null {
    return null;
  }

  getDisplayLabel(): string {
    return this.guestLabel;
  }

  signIn(): Promise<{ ok: true } | { ok: false; error: string }> {
    return Promise.resolve({
      ok: false,
      error: "Sign in requires Supabase (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).",
    });
  }

  signUp(): Promise<{ ok: true } | { ok: false; error: string }> {
    return Promise.resolve({
      ok: false,
      error: "Creating an account requires Supabase to be configured.",
    });
  }

  signOut(): Promise<void> {
    return Promise.resolve();
  }

  onAuthStateChange(_listener: () => void): () => void {
    return () => {};
  }

  getProfile(): Promise<ProfileRecord | null> {
    return Promise.resolve(null);
  }

  updateUsername(): Promise<{ ok: true } | { ok: false; error: string }> {
    return Promise.resolve({
      ok: false,
      error: "Username is only available when Supabase is configured.",
    });
  }

  getSupabaseClient(): null {
    return null;
  }
}
