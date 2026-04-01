/** Construct Supabase or null guest auth from Vite env. */

import type { IAuthProvider } from "./IAuthProvider";
import { NullAuthProvider } from "./NullAuthProvider";
import { SupabaseAuthProvider } from "./SupabaseAuthProvider";

export function createAuthProvider(): IAuthProvider {
  const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  if (url !== "" && key !== "") {
    return new SupabaseAuthProvider(url, key);
  }
  return new NullAuthProvider();
}
