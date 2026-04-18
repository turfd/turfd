import { stratumCoreTextureAssetUrl } from "../../core/textureManifest";

type StartupIntroArgs = {
  mount: HTMLElement;
  menuRoot: HTMLElement;
  menuLogoEl: HTMLImageElement;
};

const INTRO_IMAGE_RELATIVE_PATH =
  "assets/mods/resource_packs/stratum-core/textures/GUI/intro.webp";

const INTRO_Z_INDEX = 30;
let introImageWarmPromise: Promise<void> | null = null;
const INTRO_ACTIVE_CLASS = "stratum-startup-intro-active";

function waitMs(ms: number, dismissed: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    }),
    dismissed,
  ]);
}

function waitAnimation(animation: Animation, dismissed: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      animation.addEventListener("finish", () => resolve(), { once: true });
      animation.addEventListener("cancel", () => resolve(), { once: true });
    }),
    dismissed,
  ]);
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function warmIntroImage(url: string): Promise<void> {
  if (introImageWarmPromise !== null) {
    return introImageWarmPromise;
  }
  introImageWarmPromise = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    const done = (): void => {
      resolve();
    };
    if (img.complete) {
      void img.decode().catch(() => {}).finally(done);
      return;
    }
    img.addEventListener(
      "load",
      () => {
        void img.decode().catch(() => {}).finally(done);
      },
      { once: true },
    );
    img.addEventListener("error", done, { once: true });
  });
  return introImageWarmPromise;
}

export async function runMainMenuStartupIntro({
  mount,
  menuRoot,
  menuLogoEl,
}: StartupIntroArgs): Promise<void> {
  performance.mark("startup-intro:start");
  // Apply hidden state synchronously to prevent one-frame menu flashes.
  mount.classList.add(INTRO_ACTIVE_CLASS);
  menuRoot.inert = true;
  menuRoot.style.opacity = "0";
  menuRoot.style.pointerEvents = "none";
  menuLogoEl.style.opacity = "0";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const base = import.meta.env.BASE_URL ?? "/";
  const introImageUrl = `${base}${INTRO_IMAGE_RELATIVE_PATH}`;

  // Tracks all running animations so we can finish them immediately on skip.
  const activeAnimations: Animation[] = [];
  function track(anim: Animation): Animation {
    activeAnimations.push(anim);
    return anim;
  }

  // Dismiss resolves when the user clicks or presses Escape, skipping the rest.
  let dismissResolve!: () => void;
  const dismissed = new Promise<void>((resolve) => {
    dismissResolve = resolve;
  });

  function dismiss(): void {
    dismissResolve();
    for (const anim of activeAnimations) {
      try {
        anim.finish();
      } catch {
        // ignore — some animations may already be finished
      }
    }
  }

  const overlay = document.createElement("div");
  overlay.className = "stratum-startup-intro-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    `z-index:${INTRO_Z_INDEX}`,
    "pointer-events:auto",
    "overflow:hidden",
    "background:transparent",
    "cursor:pointer",
  ].join(";");

  overlay.addEventListener("click", dismiss, { once: true });

  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dismiss();
  };
  document.addEventListener("keydown", escHandler);

  const introMover = document.createElement("div");
  introMover.style.cssText = [
    "position:absolute",
    "inset:0",
    "transform:translate3d(0, 0, 0)",
    "will-change:transform",
    "backface-visibility:hidden",
    "pointer-events:none",
  ].join(";");
  overlay.appendChild(introMover);

  const introImageLayer = document.createElement("img");
  introImageLayer.src = introImageUrl;
  introImageLayer.alt = "";
  introImageLayer.decoding = "async";
  introImageLayer.loading = "eager";
  introImageLayer.setAttribute("fetchpriority", "high");
  introImageLayer.style.cssText = [
    "position:absolute",
    "left:50%",
    "top:0",
    "transform:translateX(-50%)",
    "transform-origin:top center",
    "opacity:1",
    "will-change:transform, opacity",
  ].join(";");
  introMover.appendChild(introImageLayer);

  const presents = document.createElement("div");
  presents.textContent = "Stratum Studios Presents...";
  presents.style.cssText = [
    "position:absolute",
    "left:50%",
    "top:50%",
    "transform:translate(-50%, -50%)",
    "font-family:'BoldPixels','Courier New',monospace",
    "font-size:clamp(18px, 2.3vw, 28px)",
    "letter-spacing:0.06em",
    "text-transform:uppercase",
    "color:rgba(255,255,255,0.92)",
    "text-shadow:0 2px 0 rgba(0,0,0,0.45), 0 6px 18px rgba(0,0,0,0.34), 0 0 26px rgba(0,0,0,0.26)",
    "opacity:1",
    "pointer-events:none",
    "white-space:nowrap",
  ].join(";");
  introMover.appendChild(presents);

  const blackout = document.createElement("div");
  blackout.style.cssText = [
    "position:absolute",
    "inset:0",
    "background:#000",
    "opacity:1",
    "will-change:opacity",
    "pointer-events:none",
  ].join(";");
  overlay.appendChild(blackout);

  const logo = document.createElement("img");
  logo.src = stratumCoreTextureAssetUrl("logo.png");
  logo.alt = "Stratum";
  logo.decoding = "async";
  logo.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:50%",
    "transform:translate(-50%, -50%)",
    "width:min(62vw, 760px)",
    "max-width:90vw",
    "height:auto",
    "opacity:0",
    "image-rendering:pixelated",
    "image-rendering:crisp-edges",
    "will-change:transform, left, top, width, opacity",
    "pointer-events:none",
  ].join(";");
  overlay.appendChild(logo);

  const skipBtn = document.createElement("div");
  skipBtn.textContent = "Skip";
  skipBtn.style.cssText = [
    "position:fixed",
    "bottom:20px",
    "right:24px",
    "font-family:'BoldPixels','Courier New',monospace",
    "font-size:13px",
    "letter-spacing:0.08em",
    "text-transform:uppercase",
    "color:rgba(255,255,255,0.5)",
    "cursor:pointer",
    "padding:6px 10px",
    "border:1px solid rgba(255,255,255,0.18)",
    "border-radius:3px",
    "user-select:none",
    "transition:color 0.15s,border-color 0.15s",
    "z-index:1",
  ].join(";");
  skipBtn.addEventListener("mouseenter", () => {
    skipBtn.style.color = "rgba(255,255,255,0.9)";
    skipBtn.style.borderColor = "rgba(255,255,255,0.5)";
  });
  skipBtn.addEventListener("mouseleave", () => {
    skipBtn.style.color = "rgba(255,255,255,0.5)";
    skipBtn.style.borderColor = "rgba(255,255,255,0.18)";
  });
  overlay.appendChild(skipBtn);

  const anchorParent = mount.ownerDocument?.body ?? document.body;
  anchorParent.appendChild(overlay);
  const removeBootOverlay = (): void => {
    document.getElementById("stratum-startup-boot")?.remove();
  };

  try {
    await Promise.race([
      Promise.all([
        warmIntroImage(introImageUrl),
        introImageLayer.decode().catch(() => {}),
        logo.decode().catch(() => {}),
      ]),
      dismissed,
    ]);
    performance.mark("startup-intro:assets-ready");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const naturalW = Math.max(1, introImageLayer.naturalWidth || vw);
    const naturalH = Math.max(1, introImageLayer.naturalHeight || vh);
    const coverScale = Math.max(vw / naturalW, vh / naturalH);
    const renderW = Math.round(naturalW * coverScale);
    const renderH = Math.round(naturalH * coverScale);
    const startY = 0;
    const endY = Math.min(0, vh - renderH);

    introImageLayer.style.width = `${renderW}px`;
    introImageLayer.style.height = `${renderH}px`;
    introImageLayer.style.left = "50%";
    introImageLayer.style.transform = "translateX(-50%)";
    introMover.style.transform = `translate3d(0, ${startY}px, 0)`;
    // Let style/layout + texture upload settle before first motion keyframe.
    await nextFrame();
    await nextFrame();

    removeBootOverlay();

    if (reduceMotion || endY === startY) {
      blackout.style.opacity = "0";
      introMover.style.transform = `translate3d(0, ${endY}px, 0)`;
      logo.style.opacity = "1";
      await waitMs(120, dismissed);
    } else {
      const introReveal = track(
        blackout.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 700,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
      await waitAnimation(introReveal, dismissed);
      performance.mark("startup-intro:reveal-finished");

      const bgSlide = track(
        introMover.animate(
          [
            { transform: "translate3d(0, 0, 0)" },
            { transform: `translate3d(0, ${endY}px, 0)` },
          ],
          {
            duration: 4200,
            easing: "cubic-bezier(0.37, 0, 0.2, 1)",
            fill: "forwards",
          },
        ),
      );
      await waitAnimation(bgSlide, dismissed);
      performance.mark("startup-intro:slide-finished");

      const logoInAnim = track(
        logo.animate(
          [
            { opacity: 0, transform: "translate(-50%, -50%) scale(0.9)" },
            { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
          ],
          { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
        ),
      );
      await waitAnimation(logoInAnim, dismissed);
      await waitMs(220, dismissed);

      const fadeBgAnim = track(
        introImageLayer.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 620,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
      await waitAnimation(fadeBgAnim, dismissed);
    }

    // Background image is gone before logo travel starts; keep blackout off so
    // the logo move happens over the visible menu/background.
    blackout.style.opacity = "0";
    introImageLayer.style.opacity = "0";

    // Hold on centered logo over the live menu background so the brand can breathe.
    await waitMs(reduceMotion ? 120 : 1500, dismissed);

    const logoRect = logo.getBoundingClientRect();
    const targetRect = menuLogoEl.getBoundingClientRect();

    // Reveal menu UI while logo travels into its final slot.
    menuRoot.style.opacity = "1";
    const menuReveal = track(
      menuRoot.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reduceMotion ? 120 : 420,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      }),
    );

    logo.style.left = `${logoRect.left + logoRect.width / 2}px`;
    logo.style.top = `${logoRect.top + logoRect.height / 2}px`;
    logo.style.width = `${logoRect.width}px`;
    logo.style.transform = "translate(-50%, -50%)";

    const logoToMenu = track(
      logo.animate(
        [
          {
            left: `${logoRect.left + logoRect.width / 2}px`,
            top: `${logoRect.top + logoRect.height / 2}px`,
            width: `${logoRect.width}px`,
            opacity: 1,
          },
          {
            left: `${targetRect.left + targetRect.width / 2}px`,
            top: `${targetRect.top + targetRect.height / 2}px`,
            width: `${targetRect.width}px`,
            opacity: 1,
          },
        ],
        {
          duration: reduceMotion ? 140 : 900,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      ),
    );
    await Promise.race([
      Promise.all([waitAnimation(menuReveal, dismissed), waitAnimation(logoToMenu, dismissed)]),
      dismissed,
    ]);
    performance.mark("startup-intro:handoff-finished");

    menuLogoEl.style.opacity = "1";
  } finally {
    document.removeEventListener("keydown", escHandler);
    removeBootOverlay();
    mount.classList.remove(INTRO_ACTIVE_CLASS);
    menuRoot.inert = false;
    menuRoot.style.opacity = "1";
    menuRoot.style.pointerEvents = "";
    menuLogoEl.style.opacity = "1";
    overlay.remove();
    performance.mark("startup-intro:end");
    performance.measure("startup-intro-total", "startup-intro:start", "startup-intro:end");
  }
}
