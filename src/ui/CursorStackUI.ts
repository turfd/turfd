/** Floating cursor stack overlay (follows mouse; pointer-events none). */

import { INVENTORY_ITEM_ICON_DISPLAY_PX } from "../core/constants";
import "./inventory.css";
import type { ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import {
  getItemIconStyleForDefinition,
  type ItemIconUrlLookup,
} from "./atlasItemIcon";

type GetCursorStack = () => ItemStack | null;
type GetItemIconUrlLookup = () => ItemIconUrlLookup | null;

export class CursorStackUI {
  private readonly el: HTMLDivElement;
  private readonly icon: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly durWrap: HTMLDivElement;
  private readonly durFill: HTMLDivElement;
  private readonly itemRegistry: ItemRegistry;
  private readonly getCursorStack: GetCursorStack;
  private readonly getItemIconUrlLookup: GetItemIconUrlLookup;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private lastHadStack = false;
  private placeAnimActive = false;
  /** Bumps when the cursor gains a stack while a place-out animation is in flight. */
  private cursorAnimGeneration = 0;

  constructor(
    mount: HTMLElement,
    itemRegistry: ItemRegistry,
    getCursorStack: GetCursorStack,
    getItemIconUrlLookup: GetItemIconUrlLookup,
  ) {
    this.itemRegistry = itemRegistry;
    this.getCursorStack = getCursorStack;
    this.getItemIconUrlLookup = getItemIconUrlLookup;

    const wrap = document.createElement("div");
    wrap.id = "cursor-stack-ui";
    const ip = INVENTORY_ITEM_ICON_DISPLAY_PX;
    const wrapPx = ip + 8;
    const half = wrapPx / 2;
    wrap.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:110;width:${wrapPx}px;height:${wrapPx}px;display:none;margin:-${half}px 0 0 -${half}px;--cursor-dur-w:${ip}px;`;

    const stackCol = document.createElement("div");
    stackCol.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;";

    const icon = document.createElement("div");
    icon.style.cssText = `width:${ip}px;height:${ip}px;flex-shrink:0;image-rendering:pixelated;`;

    const durWrap = document.createElement("div");
    durWrap.className = "cursor-stack-durability cursor-stack-durability--hidden";
    durWrap.setAttribute("aria-hidden", "true");
    const durFill = document.createElement("div");
    durFill.className = "cursor-stack-durability-fill";
    durWrap.appendChild(durFill);

    stackCol.appendChild(icon);
    stackCol.appendChild(durWrap);

    const count = document.createElement("span");
    count.style.cssText =
      "position:absolute;right:0;bottom:0;font-family:M5x7,monospace;font-size:24px;font-weight:normal;font-synthesis:none;-webkit-font-smoothing:antialiased;color:#f2f2f7;text-shadow:1px 1px 0 #0d0d0d;line-height:1;";
    wrap.appendChild(stackCol);
    wrap.appendChild(count);
    mount.appendChild(wrap);
    this.el = wrap;
    this.icon = icon;
    this.count = count;
    this.durWrap = durWrap;
    this.durFill = durFill;

    this.onMouseMove = (e: MouseEvent): void => {
      this.el.style.left = `${e.clientX}px`;
      this.el.style.top = `${e.clientY}px`;
    };
    window.addEventListener("mousemove", this.onMouseMove);
  }

  sync(): void {
    const stack = this.getCursorStack();
    const urlLookup = this.getItemIconUrlLookup();
    const has =
      stack !== null && stack.count > 0;

    if (has) {
      if (this.placeAnimActive) {
        this.cursorAnimGeneration++;
        this.placeAnimActive = false;
        this.el.classList.remove("cursor-stack-ui--place");
      }
      this.el.style.display = "block";
      this.applyStackVisuals(stack, urlLookup);
      if (!this.lastHadStack) {
        this.el.classList.remove("cursor-stack-ui--place");
        this.el.classList.remove("cursor-stack-ui--pickup");
        requestAnimationFrame(() => {
          void this.el.offsetWidth;
          this.el.classList.add("cursor-stack-ui--pickup");
          this.el.addEventListener(
            "animationend",
            () => {
              this.el.classList.remove("cursor-stack-ui--pickup");
            },
            { once: true },
          );
        });
      }
      this.lastHadStack = true;
      return;
    }

    if (this.lastHadStack) {
      this.lastHadStack = false;
      this.placeAnimActive = true;
      const gen = this.cursorAnimGeneration;
      this.el.classList.remove("cursor-stack-ui--pickup");
      this.el.classList.remove("cursor-stack-ui--place");
      requestAnimationFrame(() => {
        void this.el.offsetWidth;
        let finished = false;
        const finish = (): void => {
          if (finished || gen !== this.cursorAnimGeneration) {
            return;
          }
          finished = true;
          this.el.classList.remove("cursor-stack-ui--place");
          this.placeAnimActive = false;
          this.el.style.display = "none";
          this.clearStackVisuals();
        };
        this.el.addEventListener("animationend", finish, { once: true });
        window.setTimeout(finish, 200);
        this.el.classList.add("cursor-stack-ui--place");
      });
      return;
    }

    if (!this.placeAnimActive) {
      this.el.style.display = "none";
      this.clearStackVisuals();
    }
  }

  private clearStackVisuals(): void {
    const ip = INVENTORY_ITEM_ICON_DISPLAY_PX;
    this.icon.style.cssText = `width:${ip}px;height:${ip}px;flex-shrink:0;image-rendering:pixelated;`;
    this.icon.removeAttribute("title");
    this.count.textContent = "";
    this.durWrap.classList.add("cursor-stack-durability--hidden");
    this.durFill.style.width = "0%";
    this.durFill.classList.remove("cursor-stack-durability-fill--low");
  }

  private applyStackVisuals(
    stack: ItemStack,
    urlLookup: ItemIconUrlLookup | null,
  ): void {
    const def = this.itemRegistry.getById(stack.itemId);
    const ip = INVENTORY_ITEM_ICON_DISPLAY_PX;
    if (def === undefined || urlLookup === null) {
      this.icon.style.cssText = `width:${ip}px;height:${ip}px;flex-shrink:0;image-rendering:pixelated;`;
      this.count.textContent = stack.count > 1 ? String(stack.count) : "";
      this.durWrap.classList.add("cursor-stack-durability--hidden");
      return;
    }
    const style = getItemIconStyleForDefinition(
      def,
      urlLookup,
      INVENTORY_ITEM_ICON_DISPLAY_PX,
    );
    this.icon.style.cssText = [
      `width:${ip}px`,
      `height:${ip}px`,
      "flex-shrink:0",
      style,
    ].join(";");
    const tip = def.inventoryTooltip;
    this.icon.title =
      tip !== undefined && tip.length > 0
        ? `${def.displayName}\n${tip}`
        : def.displayName;
    this.count.textContent = stack.count > 1 ? String(stack.count) : "";

    const maxD = def.maxDurability;
    if (maxD !== undefined && maxD > 0) {
      this.durWrap.classList.remove("cursor-stack-durability--hidden");
      const dmg = stack.damage ?? 0;
      const rem = Math.max(0, maxD - dmg);
      const pct = (rem / maxD) * 100;
      this.durFill.style.width = `${pct}%`;
      this.durFill.classList.toggle("cursor-stack-durability-fill--low", pct <= 25);
    } else {
      this.durWrap.classList.add("cursor-stack-durability--hidden");
      this.durFill.style.width = "0%";
      this.durFill.classList.remove("cursor-stack-durability-fill--low");
    }
  }

  destroy(): void {
    window.removeEventListener("mousemove", this.onMouseMove);
    this.el.remove();
  }
}
