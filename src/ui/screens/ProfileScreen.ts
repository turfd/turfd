/** Account profile DOM: Supabase sign-in/up, username edit, or offline notice. */

import type { IAuthProvider } from "../../auth/IAuthProvider";
import { validateUsername } from "../../auth/profile";
import { DISCORD_ENTITLEMENT_REFRESH_MS } from "../../core/constants";
import {
  getDiscordEntitlement,
  startDiscordOauth,
  type DiscordEntitlementStatus,
} from "../../network/discordEntitlementApi";

const STYLES_ID = "stratum-profile-styles";

function injectStyles(): void {
  if (document.getElementById(STYLES_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = `
    .stratum-profile-inner {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .stratum-profile-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }
    .stratum-profile-switch {
      margin-top: 14px;
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(20px + var(--mm-m5-nudge, 4px)));
      line-height: 30px;
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .stratum-profile-switch button {
      background: none;
      border: none;
      color: var(--mm-ink, #f2f2f7);
      cursor: pointer;
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 16px);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-decoration: underline;
      text-underline-offset: 3px;
      padding: 0;
      margin-left: 6px;
    }
    .stratum-profile-switch button:hover {
      opacity: 0.9;
    }
    .stratum-profile-switch button:focus-visible {
      outline: none;
      border-radius: 4px;
      box-shadow: 0 0 0 2px var(--mm-border-strong, rgba(255,255,255,0.16));
    }
    .mm-profile-feedback--ok {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(19px + var(--mm-m5-nudge, 4px)));
      line-height: 28px;
      color: #5daf8c;
      min-height: 1.25em;
      margin-top: 10px;
    }
    .stratum-profile-discord-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .stratum-profile-username-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
    }
    .stratum-profile-username-input-wrap {
      flex: 1 1 0;
      min-width: 0;
    }
    .stratum-profile-username-row .stratum-profile-username-input-wrap input[type="text"] {
      width: 100%;
      box-sizing: border-box;
    }
    .stratum-profile-skel-shell {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-top: 2px;
      max-width: 28rem;
      align-items: stretch;
    }
    .stratum-profile-skel-shell[aria-busy="true"] {
      pointer-events: none;
    }
    .stratum-profile-skel-lines {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .stratum-profile-skel-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
  `;
  document.head.appendChild(style);
}

function profileLoggedInSkeleton(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "stratum-profile-skel-shell";
  shell.setAttribute("aria-busy", "true");
  shell.setAttribute("aria-label", "Loading profile");

  const lines = document.createElement("div");
  lines.className = "stratum-profile-skel-lines";
  const widths = ["min(340px, 94%)", "min(290px, 80%)", "min(230px, 64%)"];
  for (const w of widths) {
    const ln = document.createElement("div");
    ln.className = "mm-skel mm-skel-inline";
    ln.style.display = "block";
    ln.style.height = "16px";
    ln.style.width = w;
    lines.appendChild(ln);
  }

  const fieldSk = document.createElement("div");
  fieldSk.className = "mm-field";
  const fakeLabel = document.createElement("div");
  fakeLabel.className = "mm-skel mm-skel-inline";
  fakeLabel.style.width = "6.75rem";
  fakeLabel.style.height = "17px";
  fakeLabel.style.marginBottom = "8px";
  const fakeInput = document.createElement("div");
  fakeInput.className = "mm-skel";
  fakeInput.style.width = "100%";
  fakeInput.style.height = "52px";
  fakeInput.style.borderRadius = "10px";
  fieldSk.append(fakeLabel, fakeInput);

  const actions = document.createElement("div");
  actions.className = "stratum-profile-skel-actions";
  const b1 = document.createElement("div");
  b1.className = "mm-skel mm-skel-inline";
  b1.style.width = "9rem";
  b1.style.height = "46px";
  const b2 = document.createElement("div");
  b2.className = "mm-skel mm-skel-inline";
  b2.style.width = "7rem";
  b2.style.height = "46px";
  actions.append(b1, b2);

  shell.append(lines, fieldSk, actions);
  return shell;
}

function profileField(labelText: string, input: HTMLInputElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "mm-field";
  const lbl = document.createElement("label");
  lbl.htmlFor = input.id;
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  wrap.appendChild(input);
  return wrap;
}

/**
 * Mount profile UI into `container`. Returns dispose (unsubscribes auth listener).
 */
export function mountProfileScreen(
  container: HTMLElement,
  auth: IAuthProvider,
): () => void {
  injectStyles();

  const root = document.createElement("div");
  root.className = "mm-panel mm-profile-panel";

  let mode: "login" | "register" = "login";
  let cleaned = false;
  let renderGen = 0;
  let entitlementTimer: number | null = null;
  let discordEntitlement: DiscordEntitlementStatus | null = null;

  const feedback = document.createElement("div");
  feedback.setAttribute("aria-live", "polite");

  const setFeedback = (text: string, kind: "err" | "ok" | "clear"): void => {
    feedback.textContent = text;
    if (kind === "err") {
      feedback.className = "mm-feedback-error";
    } else if (kind === "ok") {
      feedback.className = "mm-profile-feedback--ok";
    } else {
      feedback.className = "mm-feedback-error";
      feedback.textContent = "";
    }
  };

  const render = (): void => {
    if (cleaned) {
      return;
    }
    renderGen += 1;
    const gen = renderGen;
    if (window.location.search.includes("discord_link=")) {
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get("discord_link");
      const tier = params.get("tier");
      if (outcome === "success") {
        const tierLabel =
          tier === "stratite" ? "Stratite" : tier === "gold" ? "Gold" : tier === "iron" ? "Iron" : "None";
        setFeedback(`Discord linked successfully. Tier: ${tierLabel}.`, "ok");
      } else if (outcome !== null) {
        setFeedback("Discord link failed. Try again.", "err");
      } else {
        setFeedback("", "clear");
      }
      params.delete("discord_link");
      params.delete("tier");
      const next = `${window.location.pathname}${params.toString() === "" ? "" : `?${params.toString()}`}${window.location.hash}`;
      window.history.replaceState(null, document.title, next);
    } else {
      setFeedback("", "clear");
    }

    root.replaceChildren();

    const title = document.createElement("p");
    title.className = "mm-panel-title";
    title.textContent = "Profile";
    root.appendChild(title);

    const inner = document.createElement("div");
    inner.className = "stratum-profile-inner";
    root.appendChild(inner);
    root.appendChild(feedback);

    if (!auth.isConfigured) {
      const p = document.createElement("p");
      p.className = "mm-note";
      p.textContent =
        "Playing as " +
        auth.getDisplayLabel() +
        ". You can't change this name until you sign in or create an account. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable accounts and online room relay.";
      inner.appendChild(p);
      return;
    }

    const session = auth.getSession();
    if (session !== null) {
      inner.appendChild(profileLoggedInSkeleton());

      void (async () => {
        await auth.ensureAuthHydrated();
        if (cleaned || gen !== renderGen) {
          return;
        }
        const prof = await auth.getProfile();
        if (cleaned || gen !== renderGen) {
          return;
        }
        inner.replaceChildren();

        const uname = prof !== null ? prof.username : auth.getDisplayLabel();
        const signed = document.createElement("p");
        signed.className = "mm-note";
        signed.textContent = "Signed in as " + uname + ".";

        if (auth.hasPasswordRecoveryPending()) {
          const recoveryTitle = document.createElement("p");
          recoveryTitle.className = "mm-note";
          recoveryTitle.textContent = "Set a new password for your account.";
          inner.appendChild(recoveryTitle);

          const newPassInput = document.createElement("input");
          newPassInput.id = "stratum-profile-password-new";
          newPassInput.type = "password";
          newPassInput.autocomplete = "new-password";
          const newPassWrap = profileField("Set password", newPassInput);

          const confirmPassInput = document.createElement("input");
          confirmPassInput.id = "stratum-profile-password-confirm";
          confirmPassInput.type = "password";
          confirmPassInput.autocomplete = "new-password";
          const confirmPassWrap = profileField("Retype password", confirmPassInput);

          const recoveryActions = document.createElement("div");
          recoveryActions.className = "stratum-profile-actions";
          const setPasswordBtn = document.createElement("button");
          setPasswordBtn.type = "button";
          setPasswordBtn.className = "mm-btn";
          setPasswordBtn.textContent = "Save new password";
          setPasswordBtn.addEventListener("click", () => {
            void (async () => {
              setFeedback("", "clear");
              const next = newPassInput.value;
              const confirm = confirmPassInput.value;
              if (next.length < 8) {
                setFeedback("Use at least 8 characters for your new password.", "err");
                return;
              }
              if (next !== confirm) {
                setFeedback("Passwords do not match.", "err");
                return;
              }
              const res = await auth.updatePassword(next);
              if (!res.ok) {
                setFeedback(res.error, "err");
                return;
              }
              setFeedback("Password updated. You can now sign in normally.", "ok");
              render();
            })();
          });
          recoveryActions.appendChild(setPasswordBtn);
          inner.appendChild(newPassWrap);
          inner.appendChild(confirmPassWrap);
          inner.appendChild(recoveryActions);
        }

        const nameInput = document.createElement("input");
        nameInput.id = "stratum-profile-username";
        nameInput.type = "text";
        nameInput.value = uname;
        nameInput.autocomplete = "username";
        const nameWrap = document.createElement("div");
        nameWrap.className = "mm-field";
        const nameLabel = document.createElement("label");
        nameLabel.htmlFor = nameInput.id;
        nameLabel.textContent = "Username";
        nameWrap.appendChild(nameLabel);
        const nameRow = document.createElement("div");
        nameRow.className = "stratum-profile-username-row";
        const nameInputWrap = document.createElement("div");
        nameInputWrap.className = "stratum-profile-username-input-wrap";
        nameInputWrap.appendChild(nameInput);
        nameRow.appendChild(nameInputWrap);
        nameWrap.appendChild(nameRow);

        const actions = document.createElement("div");
        actions.className = "stratum-profile-actions";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "mm-btn";
        saveBtn.textContent = "Save username";
        saveBtn.addEventListener("click", () => {
          void (async () => {
            setFeedback("", "clear");
            const next = nameInput.value;
            const localErr = validateUsername(next);
            if (localErr !== null) {
              setFeedback(localErr, "err");
              return;
            }
            const res = await auth.updateUsername(next);
            if (res.ok) {
              setFeedback("Username updated.", "ok");
              render();
            } else {
              setFeedback(res.error, "err");
            }
          })();
        });
        const outBtn = document.createElement("button");
        outBtn.type = "button";
        outBtn.className = "mm-btn mm-btn-subtle";
        outBtn.textContent = "Sign out";
        outBtn.addEventListener("click", () => {
          void auth.signOut().then(() => render());
        });
        actions.appendChild(saveBtn);
        actions.appendChild(outBtn);

        const supabase = auth.getSupabaseClient();

        const discordWrap = document.createElement("div");
        const discordTitle = document.createElement("p");
        discordTitle.className = "mm-note";
        discordTitle.textContent = "Discord rewards";
        const discordIdentityRow = document.createElement("div");
        discordIdentityRow.className = "stratum-profile-discord-row";
        const discordIdentity = document.createElement("p");
        discordIdentity.className = "mm-note";
        const discordTierStatus = document.createElement("p");
        discordTierStatus.className = "mm-note";
        const discordActions = document.createElement("div");
        discordActions.className = "stratum-profile-actions";
        const linkDiscordBtn = document.createElement("button");
        linkDiscordBtn.type = "button";
        linkDiscordBtn.className = "mm-btn";
        linkDiscordBtn.textContent = "Link Discord";
        const refreshDiscordBtn = document.createElement("button");
        refreshDiscordBtn.type = "button";
        refreshDiscordBtn.className = "mm-btn mm-btn-subtle";
        refreshDiscordBtn.textContent = "Refresh";
        const renderDiscordState = (): void => {
          if (discordEntitlement === null) {
            discordIdentity.textContent = "Checking Discord link…";
            discordTierStatus.textContent = "";
            linkDiscordBtn.style.display = "";
            refreshDiscordBtn.style.display = "none";
            discordIdentityRow.style.display = "";
            return;
          }
          if (!discordEntitlement.linked) {
            discordIdentity.textContent = "Not linked. Link Discord to unlock donor rewards.";
            discordTierStatus.textContent = "";
            linkDiscordBtn.style.display = "";
            refreshDiscordBtn.style.display = "none";
            discordIdentityRow.style.display = "";
            return;
          }
          const linkedName = discordEntitlement.username?.trim() ?? "";
          discordIdentity.textContent =
            linkedName === "" ? "Discord linked." : `Discord: ${linkedName}`;
          const tierLabel =
            discordEntitlement.tier === "stratite"
              ? "Stratite"
              : discordEntitlement.tier === "gold"
                ? "Gold"
                : discordEntitlement.tier === "iron"
                  ? "Iron"
                  : "None";
          const status = discordEntitlement.isDonator ? `${tierLabel} Donator` : "No donor role";
          const checkedAt = discordEntitlement.checkedAt;
          const checkedAtText =
            typeof checkedAt === "string" && checkedAt.trim() !== ""
              ? ` Last checked ${new Date(checkedAt).toLocaleString()}.`
              : "";
          const staleText = discordEntitlement.stale ? " Using cached status." : "";
          discordTierStatus.textContent = `Donation tier: ${status}.${checkedAtText}${staleText}`;
          linkDiscordBtn.style.display = "none";
          refreshDiscordBtn.style.display = "";
          discordIdentityRow.style.display = "";
        };
        renderDiscordState();

        linkDiscordBtn.addEventListener("click", () => {
          if (supabase === null) {
            setFeedback("Supabase is required to link Discord.", "err");
            return;
          }
          void (async () => {
            setFeedback("", "clear");
            const start = await startDiscordOauth(supabase, window.location.href);
            if (!start.ok) {
              setFeedback(start.error, "err");
              return;
            }
            window.location.href = start.authorizeUrl;
          })();
        });

        refreshDiscordBtn.addEventListener("click", () => {
          if (supabase === null) {
            return;
          }
          void (async () => {
            const res = await getDiscordEntitlement(supabase, true);
            if (!res.ok) {
              setFeedback(res.error, "err");
              return;
            }
            discordEntitlement = res.status;
            renderDiscordState();
          })();
        });
        discordWrap.appendChild(discordTitle);
        discordIdentityRow.appendChild(discordIdentity);
        discordIdentityRow.appendChild(refreshDiscordBtn);
        discordActions.appendChild(linkDiscordBtn);
        discordWrap.appendChild(discordIdentityRow);
        discordWrap.appendChild(discordTierStatus);
        discordWrap.appendChild(discordActions);

        inner.appendChild(signed);
        inner.appendChild(nameWrap);
        inner.appendChild(actions);
        inner.appendChild(discordWrap);

        if (supabase !== null) {
          if (entitlementTimer !== null) {
            window.clearInterval(entitlementTimer);
          }
          const refreshEntitlement = async (forceRefresh: boolean): Promise<void> => {
            const res = await getDiscordEntitlement(supabase, forceRefresh);
            if (!res.ok) {
              if (discordEntitlement === null) {
                setFeedback(res.error, "err");
              }
              return;
            }
            discordEntitlement = res.status;
            renderDiscordState();
          };
          void refreshEntitlement(false);
          entitlementTimer = window.setInterval(() => {
            void refreshEntitlement(false);
          }, DISCORD_ENTITLEMENT_REFRESH_MS);
        }
      })();
      return;
    }

    const guestTag = document.createElement("p");
    guestTag.className = "mm-note";
    guestTag.textContent =
      "Playing as " +
      auth.getDisplayLabel() +
      ". You can't change this name until you sign in or create an account.";
    inner.appendChild(guestTag);

    const muted = document.createElement("p");
    muted.className = "mm-note";
    muted.textContent =
      mode === "login"
        ? "Sign in with your Stratum account."
        : "Create an account (check your email if confirmation is required).";
    inner.appendChild(muted);

    const emailInput = document.createElement("input");
    emailInput.id = "stratum-profile-email";
    emailInput.type = "email";
    emailInput.autocomplete = mode === "login" ? "email" : "username";
    const emailWrap = profileField("Email", emailInput);

    const passInput = document.createElement("input");
    passInput.id = "stratum-profile-password";
    passInput.type = "password";
    passInput.autocomplete =
      mode === "login" ? "current-password" : "new-password";
    const passWrap = profileField("Password", passInput);

    const actions = document.createElement("div");
    actions.className = "stratum-profile-actions";
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "mm-btn";
    primary.textContent = mode === "login" ? "Sign in" : "Register";
    primary.addEventListener("click", () => {
      void (async () => {
        setFeedback("", "clear");
        const email = emailInput.value;
        const password = passInput.value;
        const res =
          mode === "login"
            ? await auth.signIn(email, password)
            : await auth.signUp(email, password);
        if (res.ok) {
          setFeedback(
            mode === "register"
              ? "Check your email to confirm, then sign in."
              : "Signed in.",
            "ok",
          );
          render();
        } else {
          setFeedback(res.error, "err");
        }
      })();
    });
    actions.appendChild(primary);
    inner.appendChild(emailWrap);
    inner.appendChild(passWrap);
    if (mode === "login") {
      const forgot = document.createElement("button");
      forgot.type = "button";
      forgot.className = "mm-btn mm-btn-subtle";
      forgot.textContent = "Forgot password?";
      forgot.addEventListener("click", () => {
        void (async () => {
          setFeedback("", "clear");
          const email = emailInput.value.trim();
          if (email === "") {
            setFeedback("Enter your email first.", "err");
            return;
          }
          const res = await auth.resetPasswordForEmail(email);
          if (res.ok) {
            setFeedback(
              "If that email exists, a reset link has been sent.",
              "ok",
            );
          } else {
            setFeedback(res.error, "err");
          }
        })();
      });
      actions.appendChild(forgot);
    }
    inner.appendChild(actions);

    const sw = document.createElement("div");
    sw.className = "stratum-profile-switch";
    sw.appendChild(document.createTextNode(mode === "login" ? "New here?" : "Already registered?"));
    const swBtn = document.createElement("button");
    swBtn.type = "button";
    swBtn.textContent = mode === "login" ? "Create account" : "Sign in instead";
    swBtn.addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      render();
    });
    sw.appendChild(swBtn);
    inner.appendChild(sw);

    queueMicrotask(() => emailInput.focus());
  };

  const unsub = auth.onAuthStateChange(() => {
    if (entitlementTimer !== null) {
      window.clearInterval(entitlementTimer);
      entitlementTimer = null;
    }
    discordEntitlement = null;
    render();
  });

  render();
  container.appendChild(root);

  return () => {
    cleaned = true;
    if (entitlementTimer !== null) {
      window.clearInterval(entitlementTimer);
      entitlementTimer = null;
    }
    unsub();
    root.remove();
  };
}
