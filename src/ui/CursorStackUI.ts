/** Floating cursor stack overlay (follows mouse; pointer-events none). */

import type { ItemStack } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import { getItemIconStyle, type AtlasIconLayout } from "./atlasItemIcon";

type GetCursorStack = () => ItemStack | null;
type GetLayout = () => AtlasIconLayout | null;

export class CursorStackUI {
  private readonly el: HTMLDivElement;
  private readonly icon: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly itemRegistry: ItemRegistry;
  private readonly getCursorStack: GetCursorStack;
  private readonly getLayout: GetLayout;
  private readonly onMouseMove: (e: MouseEvent) => void;

  constructor(
    mount: HTMLElement,
    itemRegistry: ItemRegistry,
    getCursorStack: GetCursorStack,
    getLayout: GetLayout,
  ) {
    this.itemRegistry = itemRegistry;
    this.getCursorStack = getCursorStack;
    this.getLayout = getLayout;

    const wrap = document.createElement("div");
    wrap.id = "cursor-stack-ui";
    wrap.style.cssText =
      "position:fixed;left:0;top:0;pointer-events:none;z-index:110;width:40px;height:40px;display:none;margin:-20px 0 0 -20px;";
    const icon = document.createElement("div");
    icon.style.cssText =
      "position:absolute;inset:0;width:32px;height:32px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;";
    const count = document.createElement("span");
    count.style.cssText =
      "position:absolute;right:0;bottom:0;font-family:M5x7,monospace;font-size:13px;font-weight:700;color:#f2f2f7;text-shadow:1px 0 0 #1c1c1e,-1px 0 0 #1c1c1e,0 1px 0 #1c1c1e,0 -1px 0 #1c1c1e;line-height:1;";
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
    const layout = this.getLayout();
    if (stack === null || stack.count <= 0) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "block";
    const def = this.itemRegistry.getById(stack.itemId);
    if (def === undefined || layout === null) {
      this.icon.style.cssText =
        "position:absolute;inset:0;width:32px;height:32px;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;";
      this.count.textContent = stack.count > 1 ? String(stack.count) : "";
      return;
    }
    const style = getItemIconStyle(def.textureName, layout, 32);
    this.icon.style.cssText = [
      "position:absolute",
      "inset:0",
      "width:32px",
      "height:32px",
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
