/** Injectable auth + profile contract; Supabase or offline guest implementation. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileRecord } from "./profile";

export interface AuthSession {
  readonly userId: string;
  readonly email: string | null;
}

export interface IAuthProvider {
  /** True when Supabase URL and anon key are configured (may still be signed out). */
  readonly isConfigured: boolean;

  getSession(): AuthSession | null;

  /**
   * Resolves after the first persisted-session restore attempt has finished
   * (Supabase) or immediately (offline guest). Call before relying on
   * {@link getSession} for world entry (skins, account id, display name).
   */
  ensureAuthHydrated(): Promise<void>;

  /** Guest label or signed-in username for HUD-style display. */
  getDisplayLabel(): string;

  signIn(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;

  signUp(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;

  signOut(): Promise<void>;

  /** Called when session or profile-relevant state may have changed. */
  onAuthStateChange(listener: () => void): () => void;

  getProfile(): Promise<ProfileRecord | null>;

  updateUsername(
    username: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;

  /**
   * Underlying Supabase client for room relay; null when not configured.
   * Callers must not expose the anon key beyond RPC/table usage intended by RLS.
   */
  getSupabaseClient(): SupabaseClient | null;
}
