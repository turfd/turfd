/**
 * In-game chat: peek log (auto-fade), compose mode (T), command hints, tab completion.
 */
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import { resolveRosterPeer } from "../network/ChatHostController";

const CMD_HINTS: Record<string, string> = {
  kick: "/kick <player> — Remove a player from the game",
  ban: "/ban <player> — Ban by name and account (when signed in)",
  unban: "/unban <player|uuid> — Remove a ban",
  mute: "/mute <player> — Mute a player",
  unmute: "/unmute <player|uuid> — Unmute a player",
  ping: "/ping — Round-trip time to the host (when connected)",
  give: "/give @s <item> [count] — Give items (host / OP); /give <player> <item> [count]",
  op: "/op <player> — Grant operator (host only)",
  deop: "/deop <player|uuid> — Revoke operator (host only)",
};

const CMD_ORDER = [
  "ban",
  "deop",
  "give",
  "kick",
  "mute",
  "op",
  "ping",
  "unban",
  "unmute",
] as const;

const MAX_LOG_LINES = 120;
const BASE_URL = import.meta.env.BASE_URL;

/** How long the message log stays fully visible after activity before fading. */
const LOG_PEEK_HOLD_MS = 5500;
const LOG_FADE_MS = 480;

const CHAT_LOG_VISIBILITY_KEY = "stratum.chatLogVisibility";

export type ChatLogVisibilityMode = "auto" | "always" | "hidden";

const MODE_ORDER: ChatLogVisibilityMode[] = ["auto", "always", "hidden"];

const MODE_TOOLTIPS: Record<ChatLogVisibilityMode, string> = {
  always:
    "Always on — the message log stays visible and does not fade. Click to change how chat appears.",
  hidden:
    "Quiet — new messages stay hidden until you open chat (T). Click to change how chat appears.",
  auto:
    "Peek — new messages appear briefly, then fade out. Click to change how chat appears.",
};

function loadChatLogVisibility(): ChatLogVisibilityMode {
  try {
    const raw = localStorage.getItem(CHAT_LOG_VISIBILITY_KEY);
    if (raw === "always" || raw === "hidden" || raw === "auto") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "auto";
}

function saveChatLogVisibility(mode: ChatLogVisibilityMode): void {
  try {
    localStorage.setItem(CHAT_LOG_VISIBILITY_KEY, mode);
  } catch {
    /* ignore */
  }
}

function svgEyeAlways(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="7.5" ry="4.8"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>`;
}

function svgEyeHidden(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="7.5" ry="4.8"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M5 5l14 14"/></svg>`;
}

function svgEyeAuto(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.2 5.3L20 3.5M20.8 9.2h2.5M18.5 12.8l2.1 2.1M18.2 18.7L20 20.5"/><ellipse cx="11" cy="12" rx="7.2" ry="4.6"/><circle cx="11" cy="12" r="2" fill="currentColor" stroke="none"/></svg>`;
}

function motionReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  );
}

function injectChatChromeStyles(): void {
  if (document.getElementById("stratum-chat-chrome")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "stratum-chat-chrome";
  style.textContent = `
    #stratum-chat-root .stratum-chat-vis-btn {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(28,28,30,0.45);
      color: rgba(242,242,247,0.88);
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    #stratum-chat-root .stratum-chat-vis-btn:hover {
      background: rgba(44,44,46,0.65);
      border-color: rgba(255,255,255,0.16);
      color: #fff;
    }
    #stratum-chat-root .stratum-chat-vis-wrap {
      position: relative;
      display: flex;
      justify-content: flex-end;
      margin-bottom: 6px;
      min-height: 0;
      max-height: 44px;
      overflow: visible;
      opacity: 1;
      transition: opacity 0.2s ease, max-height 0.2s ease, margin 0.2s ease;
    }
    #stratum-chat-root .stratum-chat-vis-wrap.stratum-chat-vis-wrap--idle {
      opacity: 0;
      max-height: 0;
      margin-bottom: 0;
      pointer-events: none;
      overflow: hidden;
    }
    #stratum-chat-root .stratum-chat-tooltip {
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      max-width: min(280px, 86vw);
      padding: 10px 12px;
      border-radius: 10px;
      font-family: system-ui, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.45;
      color: #f2f2f7;
      background: rgba(22,22,24,0.94);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transform: translateY(4px);
      transition: opacity 0.12s ease, visibility 0.12s ease, transform 0.12s ease;
      z-index: 5;
    }
    #stratum-chat-root .stratum-chat-tooltip.stratum-chat-tooltip--open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
  `;
  document.head.appendChild(style);
}

function injectFontFaces(): void {
  if (document.getElementById("stratum-chat-fonts")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "stratum-chat-fonts";
  style.textContent = `
    @font-face {
      font-family: 'M5x7';
      src: url('${BASE_URL}assets/fonts/m5x7.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'BoldPixels';
      src: url('${BASE_URL}assets/fonts/BoldPixels.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
  `;
  document.head.appendChild(style);
}

export class ChatOverlay {
  private root: HTMLDivElement | null = null;
  private panelEl: HTMLDivElement | null = null;
  private visibilityRowEl: HTMLDivElement | null = null;
  private visibilityBtnEl: HTMLButtonElement | null = null;
  private logEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private hintEl: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private visibilityMode: ChatLogVisibilityMode = loadChatLogVisibility();
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while T-chat is open (typing). */
  private composeOpen = false;
  private readonly lines: { kind: "player" | "system"; text: string; label?: string }[] =
    [];
  private localDisplayName = "Player";
  private readonly roster = new Map<string, { displayName: string; accountId: string }>();
  private cmdTabPool: string[] = [];
  private cmdTabIdx = 0;
  private cmdTabKey = "";
  private nameTabPool: string[] = [];
  private nameTabIdx = 0;
  private nameTabKey = "";
  private escWindowHandler: ((e: KeyboardEvent) => void) | null = null;
  private logFadeTimer: ReturnType<typeof setTimeout> | null = null;
  private logExpandedCss = "";

  init(mount: HTMLElement, bus: EventBus): void {
    injectFontFaces();
    injectChatChromeStyles();

    const fadeCss = motionReduced() ? "opacity 0.05s linear" : `opacity ${LOG_FADE_MS}ms ease`;

    const root = document.createElement("div");
    root.id = "stratum-chat-root";
    root.style.cssText = [
      "position:absolute",
      "inset:0",
      "pointer-events:none",
      "z-index:950",
      "display:flex",
      "flex-direction:column",
      "justify-content:flex-end",
      /* Match hotbar stack bottom (1.1rem in inventory.css) + hearts + name + bar + gaps */
      "padding:0 10px calc(1.1rem + 8rem)",
      "box-sizing:border-box",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "pointer-events:none",
      "max-width:min(960px,96vw)",
      "width:100%",
      "align-self:flex-start",
      "transition:max-width 0.22s ease",
    ].join(";");

    const visWrap = document.createElement("div");
    visWrap.className = "stratum-chat-vis-wrap stratum-chat-vis-wrap--idle";

    const visBtn = document.createElement("button");
    visBtn.type = "button";
    visBtn.className = "stratum-chat-vis-btn";
    visBtn.setAttribute("aria-label", "Chat visibility");

    const tooltip = document.createElement("div");
    tooltip.className = "stratum-chat-tooltip";
    tooltip.setAttribute("role", "tooltip");

    visWrap.appendChild(tooltip);
    visWrap.appendChild(visBtn);

    const log = document.createElement("div");
    log.style.cssText = [
      "max-height:min(48vh,340px)",
      "min-height:72px",
      "overflow-y:auto",
      "margin-bottom:8px",
      "padding:12px 14px",
      "border-radius:14px",
      "background:rgba(36,36,38,0.42)",
      "border:1px solid rgba(255,255,255,0.07)",
      "backdrop-filter:blur(8px)",
      "-webkit-backdrop-filter:blur(8px)",
      "font-family:'M5x7',monospace",
      "font-size:22px",
      "line-height:1.38",
      "color:#f2f2f7",
      "text-shadow:0 1px 3px rgba(0,0,0,0.55)",
      "display:block",
      "opacity:0",
      "visibility:hidden",
      `transition:${fadeCss}`,
      "box-shadow:0 3px 14px rgba(0,0,0,0.22)",
    ].join(";");
    this.logExpandedCss = log.style.cssText;

    const hint = document.createElement("div");
    hint.style.cssText = [
      "min-height:1.2em",
      "margin-bottom:6px",
      "padding:0 4px",
      "font-family:'M5x7',monospace",
      "font-size:18px",
      "color:#aeaeb2",
      "text-shadow:0 1px 2px rgba(0,0,0,0.5)",
      "display:none",
    ].join(";");

    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = [
      "pointer-events:auto",
      "display:none",
      "border-radius:12px",
      "border:1px solid rgba(255,255,255,0.09)",
      "background:rgba(44,44,46,0.52)",
      "backdrop-filter:blur(8px)",
      "-webkit-backdrop-filter:blur(8px)",
    ].join(";");

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:13px 16px",
      "border:none",
      "outline:none",
      "background:transparent",
      "font-family:'M5x7',monospace",
      "font-size:20px",
      "color:#f2f2f7",
    ].join(";");

    inputWrap.appendChild(input);
    panel.appendChild(visWrap);
    panel.appendChild(log);
    panel.appendChild(hint);
    panel.appendChild(inputWrap);
    root.appendChild(panel);
    mount.appendChild(root);

    this.root = root;
    this.panelEl = panel;
    this.visibilityRowEl = visWrap;
    this.visibilityBtnEl = visBtn;
    this.logEl = log;
    this.hintEl = hint;
    this.inputEl = input;
    this.composeOpen = false;

    const showTooltip = (): void => {
      if (this.tooltipHideTimer !== null) {
        clearTimeout(this.tooltipHideTimer);
        this.tooltipHideTimer = null;
      }
      tooltip.textContent = MODE_TOOLTIPS[this.visibilityMode];
      tooltip.classList.add("stratum-chat-tooltip--open");
    };
    const hideTooltipDelayed = (): void => {
      this.tooltipHideTimer = setTimeout(() => {
        this.tooltipHideTimer = null;
        tooltip.classList.remove("stratum-chat-tooltip--open");
      }, 120);
    };

    visBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const i = MODE_ORDER.indexOf(this.visibilityMode);
      const next = MODE_ORDER[(i + 1) % MODE_ORDER.length]!;
      this.visibilityMode = next;
      saveChatLogVisibility(next);
      this.updateVisibilityButtonFace();
      tooltip.textContent = MODE_TOOLTIPS[next];
      if (this.tooltipHideTimer !== null) {
        clearTimeout(this.tooltipHideTimer);
      }
      showTooltip();
      this.tooltipHideTimer = setTimeout(() => {
        this.tooltipHideTimer = null;
        tooltip.classList.remove("stratum-chat-tooltip--open");
      }, 2400);
      this.applyLogVisibility();
    });
    visBtn.addEventListener("pointerenter", showTooltip);
    visBtn.addEventListener("pointerleave", hideTooltipDelayed);
    visBtn.addEventListener("focus", showTooltip);
    visBtn.addEventListener("blur", hideTooltipDelayed);

    this.updateVisibilityButtonFace();

    const onInput = (): void => {
      this.cmdTabKey = "";
      this.nameTabKey = "";
      this.updateHint();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!this.composeOpen) {
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        this.applyTabCompletion();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const t = input.value;
        input.value = "";
        this.updateHint();
        if (t.trim() !== "") {
          bus.emit({ type: "game:chat-submit", text: t } satisfies GameEvent);
        }
        bus.emit({ type: "ui:chat-set-open", open: false } satisfies GameEvent);
        return;
      }
    };

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown, true);

    this.unsubs.push(
      bus.on("ui:chat-set-open", (e) => {
        this.setComposeOpen(e.open, bus);
      }),
    );
    this.unsubs.push(
      bus.on("ui:chat-line", (e) => {
        this.pushLine(e.kind, e.text, e.senderLabel);
      }),
    );
    this.unsubs.push(
      bus.on("net:error", (e) => {
        this.pushLine("system", e.message);
      }),
    );
    this.unsubs.push(
      bus.on("game:worldLoaded", () => {
        this.flushLog();
        this.applyLogVisibility();
      }),
    );
    this.unsubs.push(
      bus.on("net:session-player", (e) => {
        this.roster.set(e.peerId, {
          displayName: e.displayName,
          accountId: e.accountId,
        });
      }),
    );
    this.unsubs.push(
      bus.on("net:peer-left", (e) => {
        this.roster.delete(e.peerId);
      }),
    );

    this.applyLogVisibility();
  }

  setLocalDisplayName(name: string): void {
    this.localDisplayName = name.trim() !== "" ? name : "Player";
  }

  private clearLogFadeTimer(): void {
    if (this.logFadeTimer !== null) {
      clearTimeout(this.logFadeTimer);
      this.logFadeTimer = null;
    }
  }

  private expandLogLayout(): void {
    const log = this.logEl;
    if (log === null) {
      return;
    }
    log.style.cssText = this.logExpandedCss;
  }

  private collapseLogLayout(): void {
    const log = this.logEl;
    if (log === null) {
      return;
    }
    const fadeCss = motionReduced()
      ? "opacity 0.05s linear"
      : `opacity ${LOG_FADE_MS}ms ease`;
    log.style.cssText = [
      "max-height:0",
      "min-height:0",
      "overflow:hidden",
      "margin-bottom:0",
      "padding:0",
      "border:none",
      "border-radius:14px",
      "opacity:0",
      "visibility:hidden",
      `transition:${fadeCss}`,
    ].join(";");
  }

  private updateVisibilityButtonFace(): void {
    const btn = this.visibilityBtnEl;
    if (btn === null) {
      return;
    }
    let svg = svgEyeAuto();
    let label = "Chat visibility: peek (messages fade)";
    if (this.visibilityMode === "always") {
      svg = svgEyeAlways();
      label = "Chat visibility: always show";
    } else if (this.visibilityMode === "hidden") {
      svg = svgEyeHidden();
      label = "Chat visibility: hidden until you open chat";
    }
    btn.innerHTML = svg;
    btn.setAttribute("aria-label", label);
  }

  private updateVisibilityRowActive(): void {
    const row = this.visibilityRowEl;
    if (row === null) {
      return;
    }
    const active = this.composeOpen;
    row.classList.toggle("stratum-chat-vis-wrap--idle", !active);
  }

  /** Apply visibility mode, peek timers, and log layout. */
  private applyLogVisibility(): void {
    const log = this.logEl;
    if (log === null) {
      return;
    }
    this.clearLogFadeTimer();
    const mode = this.visibilityMode;

    if (mode === "always") {
      if (this.composeOpen || this.lines.length > 0) {
        this.expandLogLayout();
        log.style.opacity = "1";
        log.style.visibility = "visible";
      } else {
        this.collapseLogLayout();
      }
      this.updateVisibilityRowActive();
      return;
    }

    if (mode === "hidden") {
      if (this.composeOpen) {
        this.expandLogLayout();
        log.style.opacity = "1";
        log.style.visibility = "visible";
      } else {
        this.collapseLogLayout();
      }
      this.updateVisibilityRowActive();
      return;
    }

    // auto
    if (this.composeOpen) {
      this.expandLogLayout();
      log.style.opacity = "1";
      log.style.visibility = "visible";
      this.updateVisibilityRowActive();
      return;
    }
    if (this.lines.length === 0) {
      this.collapseLogLayout();
      this.updateVisibilityRowActive();
      return;
    }

    this.expandLogLayout();
    log.style.visibility = "visible";
    log.style.opacity = "1";
    const hold = motionReduced() ? 8000 : LOG_PEEK_HOLD_MS;
    this.logFadeTimer = setTimeout(() => {
      this.logFadeTimer = null;
      if (this.composeOpen || this.visibilityMode !== "auto") {
        return;
      }
      log.style.opacity = "0";
      const fadeMs = motionReduced() ? 60 : LOG_FADE_MS + 40;
      window.setTimeout(() => {
        if (this.composeOpen || this.logEl !== log || this.visibilityMode !== "auto") {
          return;
        }
        if (log.style.opacity === "0") {
          this.collapseLogLayout();
          this.updateVisibilityRowActive();
        }
      }, fadeMs);
    }, hold);
    this.updateVisibilityRowActive();
  }

  private setComposeOpen(next: boolean, bus: EventBus): void {
    if (this.composeOpen === next) {
      return;
    }
    this.composeOpen = next;
    const log = this.logEl;
    const wrap = this.inputEl?.parentElement as HTMLDivElement | null;
    const input = this.inputEl;
    const hint = this.hintEl;
    const panel = this.panelEl;
    if (log === null || wrap === null || input === null || hint === null || panel === null) {
      return;
    }
    if (next) {
      const esc = (e: KeyboardEvent): void => {
        if (e.key !== "Escape") {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        bus.emit({ type: "ui:chat-set-open", open: false } satisfies GameEvent);
      };
      this.escWindowHandler = esc;
      window.addEventListener("keydown", esc, true);
      wrap.style.display = "block";
      hint.style.display = "block";
      this.root!.style.pointerEvents = "auto";
      panel.style.maxWidth = "min(1480px,calc(100% - 8px))";
      panel.style.width = "calc(100% - 8px)";
      panel.style.alignSelf = "stretch";
      bus.emit({ type: "ui:chat-compose", open: true } satisfies GameEvent);
      this.flushLog();
      this.applyLogVisibility();
      this.updateHint();
      queueMicrotask(() => {
        input.focus();
      });
    } else {
      if (this.escWindowHandler !== null) {
        window.removeEventListener("keydown", this.escWindowHandler, true);
        this.escWindowHandler = null;
      }
      wrap.style.display = "none";
      hint.style.display = "none";
      this.root!.style.pointerEvents = "none";
      panel.style.maxWidth = "min(960px,96vw)";
      panel.style.width = "100%";
      panel.style.alignSelf = "flex-start";
      bus.emit({ type: "ui:chat-compose", open: false } satisfies GameEvent);
      input.blur();
      bus.emit({ type: "game:chat-closed" } satisfies GameEvent);
      this.flushLog();
      this.applyLogVisibility();
    }
  }

  private pushLine(
    kind: "player" | "system",
    text: string,
    senderLabel?: string,
  ): void {
    this.lines.push({
      kind,
      text,
      label: senderLabel,
    });
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    }
    this.flushLog();
    this.applyLogVisibility();
  }

  private flushLog(): void {
    const log = this.logEl;
    if (log === null) {
      return;
    }
    log.replaceChildren();
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.style.marginBottom = "4px";
      if (line.kind === "system") {
        row.style.color = "#b8ddff";
        row.textContent = line.text;
      } else {
        row.style.color = "#f2f2f7";
        const label = line.label ?? "?";
        row.textContent = `<${label}> ${line.text}`;
      }
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
  }

  private updateHint(): void {
    const hint = this.hintEl;
    const input = this.inputEl;
    if (hint === null || input === null) {
      return;
    }
    const v = input.value;
    if (!v.startsWith("/")) {
      hint.textContent = "";
      return;
    }
    const space = v.indexOf(" ");
    if (space < 0) {
      const prefix = v.slice(1).toLowerCase();
      const matches = CMD_ORDER.filter((c) => c.startsWith(prefix));
      if (matches.length === 1) {
        hint.textContent = CMD_HINTS[matches[0]!] ?? "";
      } else if (matches.length > 1) {
        hint.textContent = matches.map((m) => `/${m}`).join("  ");
      } else {
        hint.textContent = "";
      }
      return;
    }
    const cmd = v.slice(1, space).toLowerCase();
    const rest = v.slice(space + 1);
    const needsPlayer = [
      "kick",
      "ban",
      "mute",
      "op",
      "deop",
      "unban",
      "unmute",
    ].includes(cmd);
    if (!needsPlayer || rest.includes(" ")) {
      hint.textContent = CMD_HINTS[cmd] ?? "";
      return;
    }
    hint.textContent = CMD_HINTS[cmd] ?? "";
  }

  private applyTabCompletion(): void {
    const input = this.inputEl;
    if (input === null) {
      return;
    }
    const v = input.value;
    if (!v.startsWith("/")) {
      return;
    }
    const space = v.indexOf(" ");
    if (space < 0) {
      const prefix = v.slice(1).toLowerCase();
      if (this.cmdTabKey !== prefix) {
        this.cmdTabPool = CMD_ORDER.filter((c) => c.startsWith(prefix)).map(
          (c) => `/${c} `,
        );
        this.cmdTabIdx = 0;
        this.cmdTabKey = prefix;
      }
      if (this.cmdTabPool.length === 0) {
        return;
      }
      input.value = this.cmdTabPool[this.cmdTabIdx]!;
      this.cmdTabIdx = (this.cmdTabIdx + 1) % this.cmdTabPool.length;
      this.updateHint();
      return;
    }
    const cmd = v.slice(1, space).toLowerCase();
    const rest = v.slice(space + 1);
    const needsPlayer = [
      "kick",
      "ban",
      "mute",
      "op",
      "deop",
      "unban",
      "unmute",
    ].includes(cmd);
    if (!needsPlayer) {
      return;
    }
    const names = [...this.roster.values()].map((e) => e.displayName);
    names.push(this.localDisplayName);
    const uniq = [...new Set(names)];
    let pool = uniq.filter((n) =>
      n.toLowerCase().startsWith(rest.trim().toLowerCase()),
    );
    if (pool.length === 0) {
      const hit = resolveRosterPeer(this.roster, rest);
      if (hit !== null) {
        pool = [hit.entry.displayName];
      }
    }
    if (pool.length === 0) {
      return;
    }
    const nk = `${cmd}|${rest.trim().toLowerCase()}`;
    if (this.nameTabKey !== nk) {
      this.nameTabPool = pool;
      this.nameTabIdx = 0;
      this.nameTabKey = nk;
    }
    const pick = this.nameTabPool[this.nameTabIdx]!;
    this.nameTabIdx = (this.nameTabIdx + 1) % this.nameTabPool.length;
    input.value = `/${cmd} ${pick} `;
    this.updateHint();
  }

  destroy(): void {
    this.clearLogFadeTimer();
    if (this.tooltipHideTimer !== null) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    if (this.escWindowHandler !== null) {
      window.removeEventListener("keydown", this.escWindowHandler, true);
      this.escWindowHandler = null;
    }
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs = [];
    this.root?.remove();
    this.root = null;
    this.panelEl = null;
    this.visibilityRowEl = null;
    this.visibilityBtnEl = null;
    this.logEl = null;
    this.inputEl = null;
    this.hintEl = null;
  }
}
