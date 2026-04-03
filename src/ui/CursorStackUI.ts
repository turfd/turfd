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
    wrap.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:110;width:${wrapPx}px;height:${wrapPx}px;display:none;margin:-${half}px 0 0 -${half}px;`;
    const icon = document.createElement("div");
    icon.style.cssText = `position:absolute;inset:0;width:${ip}px;height:${ip}px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;`;
    const count = document.createElement("span");
    count.style.cssText =
      "position:absolute;right:0;bottom:0;font-family:M5x7,monospace;font-size:24px;font-weight:normal;font-synthesis:none;-webkit-font-smoothing:none;color:#f2f2f7;text-shadow:1px 1px 0 #0d0d0d;line-height:1;";
    wrap.appendChild(icon);
    wrap.appendChild(count);
    mount.appendChild(wrap);
    this.el = wrap;
    this.icon = icon;
    this.count = count;

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
    this.icon.style.cssText = `position:absolute;inset:0;width:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;height:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;`;
    this.icon.removeAttribute("title");
    this.count.textContent = "";
  }

  private applyStackVisuals(
    stack: ItemStack,
    urlLookup: ItemIconUrlLookup | null,
  ): void {
    const def = this.itemRegistry.getById(stack.itemId);
    if (def === undefined || urlLookup === null) {
      this.icon.style.cssText = `position:absolute;inset:0;width:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;height:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;`;
      this.count.textContent = stack.count > 1 ? String(stack.count) : "";
      return;
    }
    const style = getItemIconStyleForDefinition(
      def,
      urlLookup,
      INVENTORY_ITEM_ICON_DISPLAY_PX,
    );
    const ip = INVENTORY_ITEM_ICON_DISPLAY_PX;
    this.icon.style.cssText = [
      "position:absolute",
      "inset:0",
      `width:${ip}px`,
      `height:${ip}px`,
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      style,
    ].join(";");
    this.icon.title = def.displayName;
    this.count.textContent = stack.count > 1 ? String(stack.count) : "";
  }

  destroy(): void {
    window.removeEventListener("mousemove", this.onMouseMove);
    this.el.remove();
  }
}
