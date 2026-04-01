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
    .turfd-profile-inner {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .turfd-profile-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }
    .turfd-profile-switch {
      margin-top: 14px;
      font-family: 'M5x7', monospace;
      font-size: 17px;
      line-height: 1.45;
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .turfd-profile-switch button {
      background: none;
      border: none;
      color: var(--mm-ink, #f2f2f7);
      cursor: pointer;
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-decoration: underline;
      text-underline-offset: 3px;
      padding: 0;
      margin-left: 6px;
    }
    .turfd-profile-switch button:hover {
      opacity: 0.9;
    }
    .turfd-profile-switch button:focus-visible {
      outline: none;
      border-radius: 4px;
      box-shadow: 0 0 0 2px var(--mm-border-strong, rgba(255,255,255,0.16));
    }
    .mm-profile-feedback--ok {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: #5daf8c;
      min-height: 1.25em;
      margin-top: 10px;
    }
  `;
  document.head.appendChild(style);
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
    setFeedback("", "clear");

    root.replaceChildren();

    const title = document.createElement("p");
    title.className = "mm-panel-title";
    title.textContent = "Profile";
    root.appendChild(title);

    const inner = document.createElement("div");
    inner.className = "turfd-profile-inner";
    root.appendChild(inner);
    root.appendChild(feedback);

    if (!auth.isConfigured) {
      const p = document.createElement("p");
      p.className = "mm-note";
      p.textContent =
        "Playing as " +
        auth.getDisplayLabel() +
        ". Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable accounts and online room relay.";
      inner.appendChild(p);
      return;
    }

    const session = auth.getSession();
    if (session !== null) {
      const loading = document.createElement("p");
      loading.className = "mm-note";
      loading.textContent = "Loading profile…";
      inner.appendChild(loading);

      void auth.getProfile().then((prof) => {
        if (cleaned || gen !== renderGen) {
          return;
        }
        inner.replaceChildren();

        const uname = prof !== null ? prof.username : auth.getDisplayLabel();
        const signed = document.createElement("p");
        signed.className = "mm-note";
        signed.textContent = "Signed in as " + uname + ".";

        const nameInput = document.createElement("input");
        nameInput.id = "turfd-profile-username";
        nameInput.type = "text";
        nameInput.value = uname;
        nameInput.autocomplete = "username";
        const nameWrap = profileField("Username", nameInput);

        const actions = document.createElement("div");
        actions.className = "turfd-profile-actions";
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

        inner.appendChild(signed);
        inner.appendChild(nameWrap);
        inner.appendChild(actions);
      });
      return;
    }

    const muted = document.createElement("p");
    muted.className = "mm-note";
    muted.textContent =
      mode === "login"
        ? "Sign in with your Turf'd account."
        : "Create an account (check your email if confirmation is required).";
    inner.appendChild(muted);

    const emailInput = document.createElement("input");
    emailInput.id = "turfd-profile-email";
    emailInput.type = "email";
    emailInput.autocomplete = mode === "login" ? "email" : "username";
    const emailWrap = profileField("Email", emailInput);

    const passInput = document.createElement("input");
    passInput.id = "turfd-profile-password";
    passInput.type = "password";
    passInput.autocomplete =
      mode === "login" ? "current-password" : "new-password";
    const passWrap = profileField("Password", passInput);

    const actions = document.createElement("div");
    actions.className = "turfd-profile-actions";
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
    inner.appendChild(actions);

    const sw = document.createElement("div");
    sw.className = "turfd-profile-switch";
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
