/**
 * In-game chat: log, command hints (Minecraft-style), tab completion.
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
  op: "/op <player> — Grant operator (host only)",
  deop: "/deop <player|uuid> — Revoke operator (host only)",
};

const CMD_ORDER = [
  "ban",
  "deop",
  "kick",
  "mute",
  "op",
  "ping",
  "unban",
  "unmute",
] as const;

const MAX_LOG_LINES = 120;
const BASE_URL = import.meta.env.BASE_URL;

function injectFontFaces(): void {
  if (document.getElementById("turfd-chat-fonts")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "turfd-chat-fonts";
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
  private logEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private hintEl: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private open = false;
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

  init(mount: HTMLElement, bus: EventBus): void {
    injectFontFaces();

    const root = document.createElement("div");
    root.id = "turfd-chat-root";
    root.style.cssText = [
      "position:absolute",
      "inset:0",
      "pointer-events:none",
      "z-index:950",
      "display:flex",
      "flex-direction:column",
      "justify-content:flex-end",
      "padding:0 12px 12px",
      "box-sizing:border-box",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "pointer-events:none",
      "max-width:min(1280px,92vw)",
      "align-self:flex-start",
    ].join(";");

    const log = document.createElement("div");
    log.style.cssText = [
      "max-height:min(38vh,220px)",
      "overflow-y:auto",
      "margin-bottom:6px",
      "padding:8px 10px",
      "border-radius:12px",
      "background:rgba(36,36,38,0.88)",
      "border:1px solid rgba(255,255,255,0.1)",
      "font-family:'M5x7',monospace",
      "font-size:18px",
      "line-height:1.35",
      "color:#f2f2f7",
      "text-shadow:0 1px 2px rgba(0,0,0,0.6)",
      "display:none",
    ].join(";");

    const hint = document.createElement("div");
    hint.style.cssText = [
      "min-height:1.2em",
      "margin-bottom:4px",
      "padding:0 4px",
      "font-family:'M5x7',monospace",
      "font-size:14px",
      "color:#8e8e93",
      "text-shadow:0 1px 2px rgba(0,0,0,0.5)",
      "display:none",
    ].join(";");

    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = [
      "pointer-events:auto",
      "display:none",
      "border-radius:10px",
      "border:1px solid rgba(255,255,255,0.14)",
      "background:rgba(44,44,46,0.95)",
    ].join(";");

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:10px 12px",
      "border:none",
      "outline:none",
      "background:transparent",
      "font-family:'M5x7',monospace",
      "font-size:18px",
      "color:#f2f2f7",
    ].join(";");

    inputWrap.appendChild(input);
    panel.appendChild(log);
    panel.appendChild(hint);
    panel.appendChild(inputWrap);
    root.appendChild(panel);
    mount.appendChild(root);

    this.root = root;
    this.logEl = log;
    this.hintEl = hint;
    this.inputEl = input;
    this.open = false;

    const onInput = (): void => {
      this.cmdTabKey = "";
      this.nameTabKey = "";
      this.updateHint();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!this.open) {
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
        this.setOpen(e.open, bus);
      }),
    );
    this.unsubs.push(
      bus.on("ui:chat-line", (e) => {
        this.pushLine(e.kind, e.text, e.senderLabel);
      }),
    );
    this.unsubs.push(
      bus.on("game:worldLoaded", () => {
        this.flushLog();
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
  }

  setLocalDisplayName(name: string): void {
    this.localDisplayName = name.trim() !== "" ? name : "Player";
  }

  private setOpen(next: boolean, bus: EventBus): void {
    if (this.open === next) {
      return;
    }
    this.open = next;
    const log = this.logEl;
    const wrap = this.inputEl?.parentElement as HTMLDivElement | null;
    const input = this.inputEl;
    const hint = this.hintEl;
    if (log === null || wrap === null || input === null || hint === null) {
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
      log.style.display = "block";
      wrap.style.display = "block";
      hint.style.display = "block";
      this.root!.style.pointerEvents = "auto";
      this.flushLog();
      this.updateHint();
      queueMicrotask(() => {
        input.focus();
      });
    } else {
      if (this.escWindowHandler !== null) {
        window.removeEventListener("keydown", this.escWindowHandler, true);
        this.escWindowHandler = null;
      }
      log.style.display = "none";
      wrap.style.display = "none";
      hint.style.display = "none";
      this.root!.style.pointerEvents = "none";
      input.blur();
      bus.emit({ type: "game:chat-closed" } satisfies GameEvent);
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
    if (this.open) {
      this.flushLog();
    }
  }

  private flushLog(): void {
    const log = this.logEl;
    if (log === null) {
      return;
    }
    log.replaceChildren();
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.style.marginBottom = "3px";
      if (line.kind === "system") {
        row.style.color = "#c8e6ff";
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
    this.logEl = null;
    this.inputEl = null;
    this.hintEl = null;
  }
}
