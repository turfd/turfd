/** Supabase email/password auth and profiles table access. */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getOrCreateLocalGuestIdentity } from "./localGuestIdentity";
import type { AuthSession, IAuthProvider } from "./IAuthProvider";
import type { ProfileRecord } from "./profile";
import { validateUsername } from "./profile";

function hasRecoveryTypeInUrl(): boolean {
  const readType = (params: URLSearchParams): string | null => {
    const t = params.get("type");
    return t === null ? null : t.toLowerCase();
  };
  const fromSearch = readType(new URLSearchParams(window.location.search));
  if (fromSearch === "recovery") {
    return true;
  }
  const hashRaw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const fromHash = readType(new URLSearchParams(hashRaw));
  return fromHash === "recovery";
}

function mapAuthError(err: unknown): string {
  if (err !== null && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status === 429) {
      return "Too many attempts right now. Please wait a minute and try again.";
    }
  }
  if (err !== null && typeof err === "object" && "message" in err) {
    const m = (err as { message?: string }).message;
    if (typeof m === "string" && m.trim() !== "") {
      const lower = m.toLowerCase();
      if (lower.includes("too many") || lower.includes("rate limit") || lower.includes("security purposes")) {
        return "Too many attempts right now. Please wait a minute and try again.";
      }
      return m;
    }
  }
  return "Something went wrong. Please try again.";
}

export class SupabaseAuthProvider implements IAuthProvider {
  readonly isConfigured = true;

  private readonly client: SupabaseClient;
  private recoveryPending = hasRecoveryTypeInUrl();

  private session: AuthSession | null = null;

  private profileCache: ProfileRecord | null = null;

  private readonly listeners = new Set<() => void>();

  /** First `getSession` + {@link applyAuthSession}; awaited by {@link ensureAuthHydrated}. */
  private readonly initialSessionHydration: Promise<void>;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey);
    this.initialSessionHydration = this.client.auth
      .getSession()
      .then(({ data: { session } }) => this.applyAuthSession(session))
      .catch((err: unknown) => {
        console.warn("[SupabaseAuthProvider] getSession failed", err);
      });
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        this.recoveryPending = true;
      }
      void this.applyAuthSession(session);
    });
  }

  ensureAuthHydrated(): Promise<void> {
    return this.initialSessionHydration;
  }

  private notify(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  private async applyAuthSession(session: Session | null): Promise<void> {
    if (session?.user !== undefined) {
      this.session = {
        userId: session.user.id,
        email: session.user.email ?? null,
      };
      await this.refreshProfileCache();
    } else {
      this.session = null;
      this.profileCache = null;
    }
    this.notify();
  }

  private async refreshProfileCache(): Promise<void> {
    const uid = this.session?.userId;
    if (uid === undefined) {
      this.profileCache = null;
      return;
    }
    const { data, error } = await this.client
      .from("profiles")
      .select("id, username, skin_id")
      .eq("id", uid)
      .maybeSingle();
    if (error !== null || data === null) {
      this.profileCache = null;
      return;
    }
    const row = data as { id: string; username: string; skin_id?: string | null };
    this.profileCache = {
      id: row.id,
      username: row.username,
      skinId: row.skin_id ?? null,
    };
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  getDisplayLabel(): string {
    if (this.session === null) {
      return getOrCreateLocalGuestIdentity().displayName;
    }
    if (this.profileCache !== null) {
      return this.profileCache.username;
    }
    const em = this.session.email;
    if (em !== null && em.includes("@")) {
      return em.split("@")[0] ?? "Player";
    }
    return "Player";
  }

  async signIn(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { error } = await this.client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error !== null) {
      return { ok: false, error: mapAuthError(error) };
    }
    return { ok: true };
  }

  async signUp(
    email: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { error } = await this.client.auth.signUp({
      email: email.trim(),
      password,
    });
    if (error !== null) {
      return { ok: false, error: mapAuthError(error) };
    }
    return { ok: true };
  }

  async resetPasswordForEmail(
    email: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = email.trim();
    if (trimmed === "") {
      return { ok: false, error: "Enter your email first." };
    }
    const base = import.meta.env.BASE_URL ?? "/";
    const basePath = base.startsWith("/") ? base : `/${base}`;
    const redirectTo = new URL(basePath, window.location.origin).toString();
    const { error } = await this.client.auth.resetPasswordForEmail(trimmed, {
      redirectTo,
    });
    if (error !== null) {
      return { ok: false, error: mapAuthError(error) };
    }
    return { ok: true };
  }

  hasPasswordRecoveryPending(): boolean {
    return this.recoveryPending;
  }

  async updatePassword(
    nextPassword: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const pwd = nextPassword.trim();
    if (pwd === "") {
      return { ok: false, error: "Enter a new password first." };
    }
    const { error } = await this.client.auth.updateUser({ password: pwd });
    if (error !== null) {
      return { ok: false, error: mapAuthError(error) };
    }
    this.recoveryPending = false;
    const cleaned = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, document.title, cleaned);
    this.notify();
    return { ok: true };
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  onAuthStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getProfile(): Promise<ProfileRecord | null> {
    await this.refreshProfileCache();
    return this.profileCache;
  }

  async updateUsername(
    username: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const v = validateUsername(username);
    if (v !== null) {
      return { ok: false, error: v };
    }
    const uid = this.session?.userId;
    if (uid === undefined) {
      return { ok: false, error: "Not signed in." };
    }
    const { error } = await this.client
      .from("profiles")
      .update({ username: username.trim() })
      .eq("id", uid);
    if (error !== null) {
      const msg = mapAuthError(error);
      if (
        error.code === "23505" ||
        msg.toLowerCase().includes("unique") ||
        msg.toLowerCase().includes("duplicate")
      ) {
        return { ok: false, error: "That username is already taken." };
      }
      return { ok: false, error: msg };
    }
    await this.refreshProfileCache();
    this.notify();
    return { ok: true };
  }

  getSupabaseClient(): SupabaseClient {
    return this.client;
  }
}
