/** Floating cursor stack overlay (follows mouse; pointer-events none). */

import { INVENTORY_ITEM_ICON_DISPLAY_PX } from "../core/constants";
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
      "position:absolute;right:0;bottom:0;font-family:M5x7,monospace;font-size:24px;font-weight:700;color:#f2f2f7;text-shadow:1px 0 0 #1c1c1e,-1px 0 0 #1c1c1e,0 1px 0 #1c1c1e,0 -1px 0 #1c1c1e;line-height:1;";
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
    if (stack === null || stack.count <= 0) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "block";
    const def = this.itemRegistry.getById(stack.itemId);
    if (def === undefined || urlLookup === null) {
      this.icon.style.cssText = `position:absolute;inset:0;width:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;height:${INVENTORY_ITEM_ICON_DISPLAY_PX}px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;`;
      this.count.textContent = stack.count > 1 ? String(stack.count) : "";
      return;
    }
    const style = getItemIconStyleForDefinition(def, urlLookup, INVENTORY_ITEM_ICON_DISPLAY_PX);
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
