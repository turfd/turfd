/**
 * Build Discord webhook embed payloads for Stratum changelogs (shared: CI post + dev update tool).
 */

import { normalizeReleaseTypography } from "./releaseTypography";

const DISCORD_EMBED_DESCRIPTION_MAX = 4096;
const DISCORD_WEBHOOK_EMBEDS_MAX = 10;
const VISUAL_RULE = "-".repeat(36);
const TRUNCATION_NOTE =
  "\n\n*(Patch notes truncated for Discord length limits.)*";

type DiscordWebhookEmbed = {
  title?: string;
  description?: string;
  color?: number | null;
  image?: { url: string };
};

type BuildChangelogDiscordEmbedsOpts = {
  version: string;
  summaryPlain: string;
  changesMd: string;
  headerImageUrl?: string;
  /**
   * Second / bottom embed: large `image` plus, when git notes exist, `title` + `description` on the
   * **same** embed (Discord renders text under the image). First embed is the banner only.
   */
  mainEmbedImageUrl?: string;
  footerImageUrl?: string;
  /** When set with `mainEmbedImageUrl`: do not add `description` / `title` on the bottom embed. */
  omitTextOnMainImageEmbed?: boolean;
  embedColor?: number | null;
};

/** GFM horizontal rules → ASCII line (Discord has no `<hr>`). */
function toDiscordDescriptionMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(VISUAL_RULE);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function summaryAsDiscordBlockquote(summary: string): string {
  const s = summary.trim().replace(/\r\n/g, "\n");
  if (s.length === 0) {
    return "";
  }
  return s
    .split("\n")
    .map((ln) => (ln.trim().length === 0 ? ">" : `> ${ln}`))
    .join("\n");
}

function buildDiscordChangelogBody(
  summaryNormalized: string,
  changesNormalized: string,
): string {
  const sq = summaryAsDiscordBlockquote(summaryNormalized);
  const ch = toDiscordDescriptionMarkdown(changesNormalized);
  if (sq.length > 0 && ch.length > 0) {
    return `${sq}\n\n${ch}`;
  }
  if (sq.length > 0) {
    return sq;
  }
  return ch;
}

function chunkDiscordDescription(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.replace(/\r\n/g, "\n").trimEnd();
  if (rest.length === 0) {
    return [];
  }
  while (rest.length > 0) {
    if (rest.length <= DISCORD_EMBED_DESCRIPTION_MAX) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, DISCORD_EMBED_DESCRIPTION_MAX);
    let cut = slice.lastIndexOf("\n\n");
    if (cut < DISCORD_EMBED_DESCRIPTION_MAX / 3) {
      cut = slice.lastIndexOf("\n");
    }
    if (cut < DISCORD_EMBED_DESCRIPTION_MAX / 3) {
      cut = DISCORD_EMBED_DESCRIPTION_MAX;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return chunks;
}

function fitChunks(raw: string, maxChunks: number): string[] {
  const chunks = chunkDiscordDescription(raw);
  if (chunks.length <= maxChunks) {
    return chunks;
  }
  const head = chunks.slice(0, maxChunks - 1);
  let tail = chunks.slice(maxChunks - 1).join("\n\n");
  const note = TRUNCATION_NOTE;
  const maxTail =
    DISCORD_EMBED_DESCRIPTION_MAX - note.length;
  if (tail.length > maxTail) {
    tail = `${tail.slice(0, Math.max(0, maxTail - 3)).trimEnd()}...`;
  }
  head.push(tail + note);
  return head;
}

export function parseDiscordEmbedColor(
  envVal: string | undefined,
): number | null {
  if (envVal === undefined || envVal.trim().length === 0) {
    return null;
  }
  const n = Number.parseInt(envVal.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffff) {
    return null;
  }
  return n;
}

export function buildChangelogDiscordEmbeds(
  opts: BuildChangelogDiscordEmbedsOpts,
): DiscordWebhookEmbed[] {
  const embeds: DiscordWebhookEmbed[] = [];
  const color = opts.embedColor ?? null;
  const header = opts.headerImageUrl?.trim();
  const footer = opts.footerImageUrl?.trim();
  const mainImg = opts.mainEmbedImageUrl?.trim();

  function appendDescriptionEmbeds(
    reserveTrailingFooterSlot: boolean,
    usePlaceholderWhenEmpty: boolean,
  ): void {
    const summaryN = normalizeReleaseTypography(opts.summaryPlain.trim());
    const changesN = normalizeReleaseTypography(opts.changesMd.trim());
    let body = buildDiscordChangelogBody(summaryN, changesN);
    if (body.trim().length === 0) {
      if (!usePlaceholderWhenEmpty) {
        return;
      }
      body = "_No release summary or detailed changes._";
    }

    const reserved =
      embeds.length +
      (reserveTrailingFooterSlot &&
      footer !== undefined &&
      footer.length > 0
        ? 1
        : 0);
    const maxTextEmbeds = Math.max(1, DISCORD_WEBHOOK_EMBEDS_MAX - reserved);
    const chunks = fitChunks(body, maxTextEmbeds);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        continue;
      }
      const e: DiscordWebhookEmbed = {
        description: chunk,
        color,
      };
      if (i === 0) {
        e.title = `Stratum - ${opts.version}`;
      }
      embeds.push(e);
    }
  }

  // First embed: banner image only. Second: main graphic + changelog markdown on the same embed.
  if (mainImg !== undefined && mainImg.length > 0) {
    if (header !== undefined && header.length > 0) {
      embeds.push({ color, image: { url: header } });
    }

    const summaryN = normalizeReleaseTypography(opts.summaryPlain.trim());
    const changesN = normalizeReleaseTypography(opts.changesMd.trim());
    const body = buildDiscordChangelogBody(summaryN, changesN).trim();
    const h = embeds.length;
    const f = footer !== undefined && footer.length > 0 ? 1 : 0;
    const maxChunks = Math.max(1, DISCORD_WEBHOOK_EMBEDS_MAX - h - f);

    const second: DiscordWebhookEmbed = { color, image: { url: mainImg } };
    const addText =
      body.length > 0 && opts.omitTextOnMainImageEmbed !== true;
    if (addText) {
      second.title = `Stratum - ${opts.version}`;
      const chunks = fitChunks(body, maxChunks);
      const first = chunks[0];
      if (first !== undefined) {
        second.description = first;
      }
      embeds.push(second);
      for (let i = 1; i < chunks.length; i++) {
        const ch = chunks[i];
        if (ch !== undefined) {
          embeds.push({ color, description: ch });
        }
      }
    } else {
      embeds.push(second);
    }

    if (footer !== undefined && footer.length > 0) {
      embeds.push({ color, image: { url: footer } });
    }
    if (embeds.length > DISCORD_WEBHOOK_EMBEDS_MAX) {
      return embeds.slice(0, DISCORD_WEBHOOK_EMBEDS_MAX);
    }
    return embeds;
  }

  if (header !== undefined && header.length > 0) {
    embeds.push({ color, image: { url: header } });
  }

  appendDescriptionEmbeds(true, true);

  if (footer !== undefined && footer.length > 0) {
    embeds.push({ color, image: { url: footer } });
  }

  if (embeds.length > DISCORD_WEBHOOK_EMBEDS_MAX) {
    return embeds.slice(0, DISCORD_WEBHOOK_EMBEDS_MAX);
  }
  return embeds;
}
