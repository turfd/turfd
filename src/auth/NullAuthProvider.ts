/** Offline guest auth: no Supabase; persistent local gamertag + UUID. */

import { getOrCreateLocalGuestIdentity } from "./localGuestIdentity";
import type { AuthSession, IAuthProvider } from "./IAuthProvider";
import type { ProfileRecord } from "./profile";

export class NullAuthProvider implements IAuthProvider {
  readonly isConfigured = false;

  getSession(): AuthSession | null {
    return null;
  }

  ensureAuthHydrated(): Promise<void> {
    return Promise.resolve();
  }

  getDisplayLabel(): string {
    return getOrCreateLocalGuestIdentity().displayName;
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

  resetPasswordForEmail(): Promise<{ ok: true } | { ok: false; error: string }> {
    return Promise.resolve({
      ok: false,
      error: "Password reset requires Supabase to be configured.",
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
