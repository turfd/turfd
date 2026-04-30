#!/usr/bin/env node
/**
 * Computes next package.json version for Stratum release commits.
 * Invoked by scripts/release-commit.sh: `node scripts/release-version.mjs <cur> <bump> <lane>`
 * bump: prerelease | patch | minor | major
 * lane: alpha | beta | release
 */

import semver from "semver";

/** @param {string} current @param {string} bump @param {string} lane */
function computeNextVersion(current, bump, lane) {
  const parsed = semver.parse(current);
  if (parsed === null) {
    throw new Error(`Invalid semver: ${current}`);
  }
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const preHead =
    parsed.prerelease.length > 0 && typeof parsed.prerelease[0] === "string"
      ? String(parsed.prerelease[0]).toLowerCase()
      : "";

  if (lane === "release") {
    let v = core;
    if (bump === "patch") v = semver.inc(v, "patch") ?? v;
    else if (bump === "minor") v = semver.inc(v, "minor") ?? v;
    else if (bump === "major") v = semver.inc(v, "major") ?? v;
    return v;
  }

  if (lane === "beta") {
    if (preHead === "alpha") {
      return `${core}-beta.0`;
    }
    if (preHead === "beta") {
      if (bump === "prerelease") {
        const n = semver.inc(current, "prerelease", "beta");
        if (n === null) throw new Error("prerelease bump failed");
        return n;
      }
      if (bump === "patch") {
        const n = semver.inc(current, "prepatch", "beta");
        if (n === null) throw new Error("prepatch failed");
        return n;
      }
      if (bump === "minor") {
        const n = semver.inc(current, "preminor", "beta");
        if (n === null) throw new Error("preminor failed");
        return n;
      }
      if (bump === "major") {
        const n = semver.inc(current, "premajor", "beta");
        if (n === null) throw new Error("premajor failed");
        return n;
      }
    }
    if (bump === "prerelease") {
      const n = semver.inc(current, "prepatch", "beta");
      if (n === null) throw new Error("start beta failed");
      return n;
    }
    if (bump === "patch") {
      const n = semver.inc(current, "prepatch", "beta");
      if (n === null) throw new Error("prepatch failed");
      return n;
    }
    if (bump === "minor") {
      const n = semver.inc(current, "preminor", "beta");
      if (n === null) throw new Error("preminor failed");
      return n;
    }
    if (bump === "major") {
      const n = semver.inc(current, "premajor", "beta");
      if (n === null) throw new Error("premajor failed");
      return n;
    }
    throw new Error("unreachable beta");
  }

  // lane alpha
  if (preHead === "beta") {
    throw new Error(
      "Current version is a beta prerelease; choose lane beta or release, not alpha.",
    );
  }

  if (bump === "prerelease") {
    if (preHead === "alpha") {
      const n = semver.inc(current, "prerelease", "alpha");
      if (n === null) throw new Error("prerelease bump failed");
      return n;
    }
    const n = semver.inc(current, "prepatch", "alpha");
    if (n === null) throw new Error("start alpha failed");
    return n;
  }
  if (bump === "patch") {
    const n = semver.inc(current, "prepatch", "alpha");
    if (n === null) throw new Error("prepatch failed");
    return n;
  }
  if (bump === "minor") {
    const n = semver.inc(current, "preminor", "alpha");
    if (n === null) throw new Error("preminor failed");
    return n;
  }
  if (bump === "major") {
    const n = semver.inc(current, "premajor", "alpha");
    if (n === null) throw new Error("premajor failed");
    return n;
  }
  throw new Error("unreachable alpha");
}

const [, , cur, bump, lane] = process.argv;
if (cur === undefined || bump === undefined || lane === undefined) {
  console.error(
    "Usage: node scripts/release-version.mjs <current> <bump> <lane>",
  );
  process.exit(1);
}
try {
  console.log(computeNextVersion(cur, bump, lane));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
