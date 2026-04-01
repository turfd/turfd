/** Supabase email/password auth and profiles table access. */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthSession, IAuthProvider } from "./IAuthProvider";
import type { ProfileRecord } from "./profile";
import { validateUsername } from "./profile";

function mapAuthError(err: unknown): string {
  if (err !== null && typeof err === "object" && "message" in err) {
    const m = (err as { message?: string }).message;
    if (typeof m === "string" && m.trim() !== "") {
      return m;
    }
  }
  return "Something went wrong. Please try again.";
}

export class SupabaseAuthProvider implements IAuthProvider {
  readonly isConfigured = true;

  private readonly client: SupabaseClient;

  private session: AuthSession | null = null;

  private profileCache: ProfileRecord | null = null;

  private readonly listeners = new Set<() => void>();

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey);
    void this.client.auth.getSession().then(({ data: { session } }) => {
      void this.applyAuthSession(session);
    });
    this.client.auth.onAuthStateChange((_event, session) => {
      void this.applyAuthSession(session);
    });
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
      .select("id, username")
      .eq("id", uid)
      .maybeSingle();
    if (error !== null || data === null) {
      this.profileCache = null;
      return;
    }
    const row = data as { id: string; username: string };
    this.profileCache = { id: row.id, username: row.username };
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  getDisplayLabel(): string {
    if (this.session === null) {
      return "Not signed in";
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
