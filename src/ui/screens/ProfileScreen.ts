/** Account profile DOM: Supabase sign-in/up, username edit, or offline notice. */

import type { IAuthProvider } from "../../auth/IAuthProvider";
import { validateUsername } from "../../auth/profile";

const STYLES_ID = "turfd-profile-styles";

function injectStyles(): void {
  if (document.getElementById(STYLES_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = `
    .turfd-profile {
      max-width: 28rem;
      margin: 0 auto;
      padding: 0.5rem 0 1.5rem;
      font-family: 'M5x7', 'Courier New', monospace;
      font-size: 16px;
      line-height: 1.45;
      color: var(--mm-ink, #f2f2f7);
    }
    .turfd-profile h2 {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0 0 1rem;
    }
    .turfd-profile-field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      margin-bottom: 0.85rem;
    }
    .turfd-profile-field label {
      font-size: 13px;
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .turfd-profile-field input {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.1));
      background: var(--mm-surface-deep, rgba(36,36,38,0.9));
      color: var(--mm-ink, #f2f2f7);
      font-family: inherit;
      font-size: 16px;
      box-sizing: border-box;
    }
    .turfd-profile-field input:focus {
      outline: 2px solid rgba(100, 180, 255, 0.45);
      outline-offset: 1px;
    }
    .turfd-profile-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .turfd-profile-actions button {
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid var(--mm-border-strong, rgba(255,255,255,0.16));
      cursor: pointer;
    }
    .turfd-profile-btn {
      background: rgba(80, 140, 255, 0.35);
      color: var(--mm-ink, #f2f2f7);
    }
    .turfd-profile-btn-subtle {
      background: transparent;
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .turfd-profile-feedback {
      min-height: 1.25em;
      margin-top: 0.5rem;
      font-size: 14px;
      color: var(--mm-danger, #ff453a);
    }
    .turfd-profile-feedback.ok {
      color: #6ee7b7;
    }
    .turfd-profile-muted {
      color: var(--mm-ink-soft, #8e8e93);
      font-size: 14px;
      margin-bottom: 1rem;
    }
    .turfd-profile-switch {
      margin-top: 0.75rem;
      font-size: 13px;
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .turfd-profile-switch button {
      background: none;
      border: none;
      color: #7eb6ff;
      cursor: pointer;
      font: inherit;
      text-decoration: underline;
      padding: 0;
    }
  `;
  document.head.appendChild(style);
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
  root.className = "turfd-profile mm-panel";

  let mode: "login" | "register" = "login";
  let cleaned = false;

  const feedback = document.createElement("div");
  feedback.className = "turfd-profile-feedback";
  feedback.setAttribute("aria-live", "polite");

  const render = (): void => {
    if (cleaned) {
      return;
    }
    feedback.textContent = "";
    feedback.classList.remove("ok");
    root.replaceChildren();

    const title = document.createElement("h2");
    title.textContent = "Profile";
    root.appendChild(title);

    if (!auth.isConfigured) {
      const p = document.createElement("p");
      p.className = "turfd-profile-muted";
      p.textContent =
        "Playing as " +
        auth.getDisplayLabel() +
        ". Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable accounts and online room relay.";
      root.appendChild(p);
      root.appendChild(feedback);
      return;
    }

    const session = auth.getSession();
    if (session !== null) {
      void auth.getProfile().then((prof) => {
        if (cleaned) {
          return;
        }
        const uname =
          prof !== null ? prof.username : auth.getDisplayLabel();
        const signed = document.createElement("p");
        signed.className = "turfd-profile-muted";
        signed.textContent = "Signed in as " + uname + ".";
        root.appendChild(signed);

        const nameWrap = document.createElement("div");
        nameWrap.className = "turfd-profile-field";
        const nameLabel = document.createElement("label");
        nameLabel.htmlFor = "turfd-profile-username";
        nameLabel.textContent = "Username";
        const nameInput = document.createElement("input");
        nameInput.id = "turfd-profile-username";
        nameInput.type = "text";
        nameInput.value = uname;
        nameInput.autocomplete = "username";
        nameWrap.appendChild(nameLabel);
        nameWrap.appendChild(nameInput);

        const actions = document.createElement("div");
        actions.className = "turfd-profile-actions";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "turfd-profile-btn";
        saveBtn.textContent = "Save username";
        saveBtn.addEventListener("click", () => {
          void (async () => {
            feedback.textContent = "";
            feedback.classList.remove("ok");
            const next = nameInput.value;
            const localErr = validateUsername(next);
            if (localErr !== null) {
              feedback.textContent = localErr;
              return;
            }
            const res = await auth.updateUsername(next);
            if (res.ok) {
              feedback.classList.add("ok");
              feedback.textContent = "Username updated.";
              render();
            } else {
              feedback.textContent = res.error;
            }
          })();
        });
        const outBtn = document.createElement("button");
        outBtn.type = "button";
        outBtn.className = "turfd-profile-btn-subtle";
        outBtn.textContent = "Sign out";
        outBtn.addEventListener("click", () => {
          void auth.signOut().then(() => render());
        });
        actions.appendChild(saveBtn);
        actions.appendChild(outBtn);
        root.appendChild(nameWrap);
        root.appendChild(actions);
        root.appendChild(feedback);
      });
      return;
    }

    {
      const muted = document.createElement("p");
      muted.className = "turfd-profile-muted";
      muted.textContent =
        mode === "login"
          ? "Sign in with your Turf'd account."
          : "Create an account (check your email if confirmation is required).";
      root.appendChild(muted);

      const emailWrap = document.createElement("div");
      emailWrap.className = "turfd-profile-field";
      const emailLabel = document.createElement("label");
      emailLabel.htmlFor = "turfd-profile-email";
      emailLabel.textContent = "Email";
      const emailInput = document.createElement("input");
      emailInput.id = "turfd-profile-email";
      emailInput.type = "email";
      emailInput.autocomplete =
        mode === "login" ? "email" : "username";
      emailWrap.appendChild(emailLabel);
      emailWrap.appendChild(emailInput);

      const passWrap = document.createElement("div");
      passWrap.className = "turfd-profile-field";
      const passLabel = document.createElement("label");
      passLabel.htmlFor = "turfd-profile-password";
      passLabel.textContent = "Password";
      const passInput = document.createElement("input");
      passInput.id = "turfd-profile-password";
      passInput.type = "password";
      passInput.autocomplete =
        mode === "login" ? "current-password" : "new-password";
      passWrap.appendChild(passLabel);
      passWrap.appendChild(passInput);

      const actions = document.createElement("div");
      actions.className = "turfd-profile-actions";
      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = "turfd-profile-btn";
      primary.textContent = mode === "login" ? "Sign in" : "Register";
      primary.addEventListener("click", () => {
        void (async () => {
          feedback.textContent = "";
          const email = emailInput.value;
          const password = passInput.value;
          const res =
            mode === "login"
              ? await auth.signIn(email, password)
              : await auth.signUp(email, password);
          if (res.ok) {
            feedback.classList.add("ok");
            feedback.textContent =
              mode === "register"
                ? "Check your email to confirm, then sign in."
                : "Signed in.";
            render();
          } else {
            feedback.textContent = res.error;
          }
        })();
      });
      actions.appendChild(primary);
      root.appendChild(emailWrap);
      root.appendChild(passWrap);
      root.appendChild(actions);

      const sw = document.createElement("div");
      sw.className = "turfd-profile-switch";
      const swBtn = document.createElement("button");
      swBtn.type = "button";
      swBtn.textContent =
        mode === "login" ? "Need an account? Register" : "Have an account? Sign in";
      swBtn.addEventListener("click", () => {
        mode = mode === "login" ? "register" : "login";
        render();
      });
      sw.appendChild(swBtn);
      root.appendChild(sw);
      root.appendChild(feedback);
      queueMicrotask(() => emailInput.focus());
    }
  };

  const unsub = auth.onAuthStateChange(() => {
    render();
  });

  render();
  container.appendChild(root);

  return () => {
    cleaned = true;
    unsub();
    root.remove();
  };
}
