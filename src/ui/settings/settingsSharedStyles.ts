/** Shared settings UI (main menu + pause); idempotent inject. */
export const SETTINGS_SHARED_STYLE_ID = "stratum-settings-shared-styles";

export function injectSettingsSharedStyles(base: string): void {
  if (document.getElementById(SETTINGS_SHARED_STYLE_ID)) {
    return;
  }
  const fontUrl = (name: string): string => `${base}assets/fonts/${name}`;
  const style = document.createElement("style");
  style.id = SETTINGS_SHARED_STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: 'BoldPixels';
      src: url('${fontUrl("BoldPixels.ttf")}') format('truetype');
      font-weight: normal;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'M5x7';
      src: url('${fontUrl("m5x7.ttf")}') format('truetype');
      font-weight: normal;
      font-style: normal;
      font-display: swap;
    }

    .st-settings-root .mm-panel-title {
      font-family: 'BoldPixels', monospace;
      font-size: clamp(22px, 2.6vw, 28px);
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--st-mm-ink);
      margin: 0 0 1.1rem;
      line-height: 1.15;
    }

    .st-settings-root {
      --st-mm-ink: #f2f2f7;
      --st-mm-ink-mid: #aeaeb2;
      --st-mm-ink-soft: #8e8e93;
      --st-mm-surface-deep: rgba(36, 36, 38, 0.9);
      --st-mm-surface-raised: rgba(58, 58, 60, 0.92);
      --st-mm-border: rgba(255, 255, 255, 0.1);
      --st-mm-border-strong: rgba(255, 255, 255, 0.16);
      --st-mm-radius-sm: 10px;
      --st-mm-radius-md: 14px;
      --st-mm-m5-nudge: 4px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
    }
    .mm-root .st-settings-root {
      --st-mm-ink: var(--mm-ink);
      --st-mm-ink-mid: var(--mm-ink-mid);
      --st-mm-ink-soft: var(--mm-ink-soft);
      --st-mm-surface-deep: var(--mm-surface-deep);
      --st-mm-surface-raised: var(--mm-surface-raised);
      --st-mm-border: var(--mm-border);
      --st-mm-border-strong: var(--mm-border-strong);
      --st-mm-radius-sm: var(--mm-radius-sm);
      --st-mm-radius-md: var(--mm-radius-md);
      --st-mm-m5-nudge: var(--mm-m5-nudge);
    }

    .st-settings-subtabbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 1rem;
    }
    .st-settings-subtab {
      padding: 10px 16px;
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      cursor: pointer;
      border-radius: var(--st-mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--st-mm-border);
      background: var(--st-mm-surface-deep);
      color: var(--st-mm-ink-soft);
      transition: border-color 130ms ease, background 130ms ease, color 130ms ease;
    }
    .st-settings-subtab:hover {
      background: var(--st-mm-surface-raised);
      color: var(--st-mm-ink);
      border-color: var(--st-mm-border-strong);
    }
    .st-settings-subtab:focus-visible {
      outline: none;
      border-color: var(--st-mm-border-strong);
    }
    .st-settings-subtab--active {
      background: var(--st-mm-surface-raised) !important;
      border-color: var(--st-mm-border-strong) !important;
      color: var(--st-mm-ink) !important;
    }

    .st-settings-tab-panels {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .st-settings-tab-panel { display: none; }
    .st-settings-tab-panel--active { display: block; }

    .st-settings-tab-panels::-webkit-scrollbar { width: 4px; }
    .st-settings-tab-panels::-webkit-scrollbar-thumb {
      background: var(--st-mm-border-strong);
      border-radius: 4px;
    }

    /* Buttons (pause menu has no .mm-btn from main menu CSS) */
    .st-settings-root .mm-btn {
      box-sizing: border-box;
      padding: 12px 18px;
      min-height: 44px;
      background: var(--st-mm-ink);
      border: 1px solid var(--st-mm-ink);
      color: #1c1c1e;
      font-family: 'BoldPixels', monospace;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: var(--st-mm-radius-sm);
      corner-shape: squircle;
      transition: opacity 120ms ease;
    }
    .st-settings-root .mm-btn:hover { opacity: 0.92; }
    .st-settings-root .mm-btn:active { opacity: 0.85; }
    .st-settings-root .mm-btn-secondary {
      background: var(--st-mm-surface-deep);
      border-color: var(--st-mm-border);
      color: var(--st-mm-ink-mid);
    }
    .st-settings-root .mm-btn-secondary:hover {
      background: var(--st-mm-surface-raised);
      color: var(--st-mm-ink);
      opacity: 1;
    }

    .st-settings-section {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--st-mm-ink-soft);
      margin: 1.1rem 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--st-mm-border);
    }
    .st-settings-section:first-child { margin-top: 0; }

    .st-settings-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .st-settings-row label {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--st-mm-ink-soft);
      width: 112px;
      flex-shrink: 0;
    }
    .st-settings-row input[type="range"] {
      flex: 1;
      accent-color: #aeaeb2;
    }
    .st-settings-val {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--st-mm-m5-nudge));
      color: var(--st-mm-ink-mid);
      width: 44px;
      text-align: right;
    }

    .st-settings-hint {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--st-mm-m5-nudge));
      color: var(--st-mm-ink-soft);
      line-height: 1.45;
      margin: 0 0 10px;
    }

    .st-bind-table {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .st-bind-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 12px;
      padding: 10px 12px;
      border-radius: var(--st-mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--st-mm-border);
      background: rgba(0, 0, 0, 0.12);
    }
    .st-bind-row--capture {
      border-color: var(--st-mm-border-strong);
      box-shadow: 0 0 0 1px rgba(242, 242, 247, 0.12);
    }
    .st-bind-label {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--st-mm-ink-mid);
      min-width: min(160px, 38%);
      flex: 0 0 auto;
    }
    .st-bind-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 120px;
    }
    .st-bind-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px 4px 10px;
      border-radius: 8px;
      corner-shape: squircle;
      background: var(--st-mm-surface-raised);
      border: 1px solid var(--st-mm-border);
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--st-mm-m5-nudge));
      color: var(--st-mm-ink);
    }
    .st-bind-chip-remove {
      padding: 0 4px;
      border: none;
      background: transparent;
      color: var(--st-mm-ink-soft);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .st-bind-chip-remove:hover { color: var(--st-mm-ink); }
    .st-bind-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .st-bind-actions .mm-btn {
      padding: 8px 14px;
      min-height: 38px;
      font-size: 14px;
    }
    .st-bind-capture-msg {
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--st-mm-m5-nudge));
      color: #ffcc66;
      width: 100%;
      margin-top: 2px;
    }
    .st-settings-controls-footer {
      margin-top: 1rem;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    /* Toggle switch */
    .st-settings-toggle-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .st-settings-toggle-row label {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--st-mm-ink-soft);
      flex: 1;
      cursor: pointer;
      user-select: none;
    }
    .st-toggle {
      position: relative;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }
    .st-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    .st-toggle-track {
      position: absolute;
      inset: 0;
      background: rgba(120, 120, 128, 0.36);
      border-radius: 12px;
      transition: background 200ms ease;
      cursor: pointer;
    }
    .st-toggle-track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: var(--st-mm-ink);
      border-radius: 50%;
      transition: transform 200ms ease;
    }
    .st-toggle input:checked + .st-toggle-track {
      background: #34c759;
    }
    .st-toggle input:checked + .st-toggle-track::after {
      transform: translateX(20px);
    }
    .st-toggle input:focus-visible + .st-toggle-track {
      outline: 2px solid var(--st-mm-border-strong);
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}
