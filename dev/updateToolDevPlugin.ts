/**
 * Dev-only: serves `/stratum/update` and JSON APIs to preview/commit release notes
 * using the local Git + npm identity (same outcome as `scripts/release-commit.sh`).
 * Never registered for production builds.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Bump = "prerelease" | "patch" | "minor" | "major";
type Lane = "alpha" | "beta" | "release";

type CommitPayload = {
  bump?: string;
  lane?: string;
  summary?: string;
  changes?: string;
};

function readPageHtml(): string {
  return readFileSync(
    path.join(__dirname, "update-tool", "page.html"),
    "utf-8",
  );
}

function isLocalHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) {
    return false;
  }
  const h = host.split(",")[0]?.trim().toLowerCase() ?? "";
  return (
    h.startsWith("localhost:") ||
    h.startsWith("127.0.0.1:") ||
    h.startsWith("[::1]:")
  );
}

function pathnameOnly(url: string | undefined): string {
  if (url === undefined) {
    return "";
  }
  return url.split("?", 1)[0] ?? "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function execGit(args: string[], root: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function isBump(s: string): s is Bump {
  return s === "prerelease" || s === "patch" || s === "minor" || s === "major";
}

function isLane(s: string): s is Lane {
  return s === "alpha" || s === "beta" || s === "release";
}

function nextVersion(root: string, cur: string, bump: Bump, lane: Lane): string {
  return execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "release-version.mjs"),
      cur,
      bump,
      lane,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

function assembleCommitMessage(
  nextVersion: string,
  summary: string,
  changes: string,
): string {
  return `${nextVersion}\n\n[Summary]\n${summary.trim()}\n\n[Changes]\n${changes.trim()}\n`;
}

function getTokenHeader(req: IncomingMessage): string | undefined {
  const v = req.headers["x-stratum-update-token"];
  if (Array.isArray(v)) {
    return v[0];
  }
  return v;
}

function checkToken(
  required: string | undefined,
  req: IncomingMessage,
): boolean {
  if (required === undefined || required.length === 0) {
    return true;
  }
  return getTokenHeader(req) === required;
}

export function updateToolDevPlugin(options: {
  root: string;
  /** From `.env.local` key `STRATUM_UPDATE_TOOL_TOKEN` (never `VITE_*`). */
  toolToken?: string;
}): Plugin {
  const pageHtml = readPageHtml();
  const { root, toolToken } = options;

  type Next = (err?: unknown) => void;

  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: Next,
  ): void => {
    if (!isLocalHost(req.headers.host)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Stratum update tool: localhost only.");
      return;
    }

    const p = pathnameOnly(req.url);
    if (
      p !== "/stratum/update" &&
      p !== "/update" &&
      !p.startsWith("/stratum/__update-tool/")
    ) {
      next();
      return;
    }

    if (p === "/update") {
      res.statusCode = 302;
      res.setHeader("Location", "/stratum/update");
      res.end();
      return;
    }

    if (p === "/stratum/update" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(pageHtml);
      return;
    }

    const api = "/stratum/__update-tool/api";
    if (!p.startsWith(api + "/")) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const sub = p.slice((api + "/").length);

    if (sub === "state" && req.method === "GET") {
      try {
        const pkgPath = path.join(root, "package.json");
        const version = (
          JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }
        ).version;
        const branch = execGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
        const userName = execGit(["config", "user.name"], root);
        const userEmail = execGit(["config", "user.email"], root);
        const st = execGit(["status", "--porcelain"], root);
        const tokenRequired =
          toolToken !== undefined && toolToken.length > 0;
        json(res, 200, {
          version,
          branch,
          userName,
          userEmail,
          dirty: st.length > 0,
          tokenRequired,
        });
      } catch (e) {
        json(res, 500, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    void (async () => {
      if (sub === "preview" && req.method === "POST") {
        if (!checkToken(toolToken, req)) {
          json(res, 401, { error: "Invalid or missing update tool token." });
          return;
        }
        let body: CommitPayload;
        try {
          body = JSON.parse(await readBody(req)) as CommitPayload;
        } catch {
          json(res, 400, { error: "Invalid JSON body." });
          return;
        }
        const bump = body.bump ?? "";
        const lane = body.lane ?? "";
        if (!isBump(bump) || !isLane(lane)) {
          json(res, 400, { error: "Invalid bump or lane." });
          return;
        }
        const summary = body.summary ?? "";
        const changes = body.changes ?? "";
        if (summary.trim().length === 0) {
          json(res, 400, { error: "Summary must not be empty." });
          return;
        }
        try {
          const pkgPath = path.join(root, "package.json");
          const cur = (
            JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }
          ).version;
          const next = nextVersion(root, cur, bump, lane);
          const message = assembleCommitMessage(next, summary, changes);
          json(res, 200, { nextVersion: next, message });
        } catch (e) {
          json(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      if (sub === "commit" && req.method === "POST") {
        if (!checkToken(toolToken, req)) {
          json(res, 401, { error: "Invalid or missing update tool token." });
          return;
        }
        let body: CommitPayload;
        try {
          body = JSON.parse(await readBody(req)) as CommitPayload;
        } catch {
          json(res, 400, { error: "Invalid JSON body." });
          return;
        }
        const bump = body.bump ?? "";
        const lane = body.lane ?? "";
        if (!isBump(bump) || !isLane(lane)) {
          json(res, 400, { error: "Invalid bump or lane." });
          return;
        }
        const summary = body.summary ?? "";
        const changes = body.changes ?? "";
        if (summary.trim().length === 0) {
          json(res, 400, { error: "Summary must not be empty." });
          return;
        }
        const tmpDir = mkdtempSync(path.join(tmpdir(), "stratum-update-"));
        try {
          const pkgPath = path.join(root, "package.json");
          const cur = (
            JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }
          ).version;
          const next = nextVersion(root, cur, bump, lane);
          const message = assembleCommitMessage(next, summary, changes);
          const msgFile = path.join(tmpDir, "COMMIT_EDITMSG");
          writeFileSync(msgFile, message, "utf-8");

          execFileSync("npm", ["version", next, "--no-git-tag-version"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          execFileSync("git", ["add", "-A"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          execFileSync("git", ["commit", "-F", msgFile], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          json(res, 200, {
            ok: true,
            nextVersion: next,
            message: `Committed as ${next}. Push manually when ready.`,
          });
        } catch (e) {
          json(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
        return;
      }

      res.statusCode = 404;
      res.end();
    })().catch((e: unknown) => {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  };

  return {
    name: "stratum-update-tool-dev",
    configureServer(server) {
      type Layer = { route: string; handle: typeof handler };
      const stack = (server.middlewares as unknown as { stack: Layer[] }).stack;
      stack.unshift({ route: "", handle: handler });
    },
  };
}

/** True if repo has `.git` (update tool runs git commands). */
export function repoHasGit(root: string): boolean {
  return existsSync(path.join(root, ".git"));
}
