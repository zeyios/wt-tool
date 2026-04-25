import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { branchRef, git, gitStdout, gitSuccess, remoteRef } from "./git.js";

export function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;

  for (const line of output.split(/\r?\n/)) {
    if (line === "") {
      if (current) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }

    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);

    if (key === "worktree") {
      if (current) {
        worktrees.push(current);
      }
      current = { path: value, branch: null, detached: false, prunable: false };
    } else if (current && key === "branch") {
      current.branch = value.startsWith("refs/heads/")
        ? value.slice("refs/heads/".length)
        : value;
    } else if (current && key === "detached") {
      current.detached = true;
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

export function listWorktrees(cwd) {
  return parseWorktreeList(gitStdout(cwd, ["worktree", "list", "--porcelain"]));
}

export function findWorktreeForBranch(worktrees, branch) {
  return worktrees.find((worktree) => worktree.branch === branch) ?? null;
}

export function nextWorktreePath(worktrees) {
  const mainWorktree = worktrees[0];
  if (!mainWorktree) {
    throw new Error("No worktrees found.");
  }

  const parent = dirname(mainWorktree.path);
  const name = basename(mainWorktree.path);
  const existing = new Set(worktrees.map((worktree) => worktree.path));

  for (let index = 2; index < 10000; index += 1) {
    const candidate = join(parent, `${name}-${index}`);
    if (!existing.has(candidate) && !existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find an available worktree path.");
}

export function localBranchExists(cwd, branch) {
  return gitSuccess(cwd, ["show-ref", "--verify", "--quiet", branchRef(branch)]);
}

export function remoteBranchExists(cwd, branch) {
  return gitSuccess(cwd, ["show-ref", "--verify", "--quiet", remoteRef(branch)]);
}

export function currentBranch(cwd) {
  const result = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { check: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function currentHead(cwd) {
  return gitStdout(cwd, ["rev-parse", "HEAD"]);
}

export function isWorktreeClean(path) {
  const result = git(path, ["status", "--porcelain"], { check: false });
  return result.status === 0 && result.stdout.trimEnd() === "";
}

function isMergedOnGitHub(path, branch) {
  const result = spawnSync("gh", ["pr", "view", branch, "--json", "state,mergedAt"], {
    cwd: path,
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" }
  });

  if (result.status !== 0) {
    return false;
  }

  try {
    const pullRequest = JSON.parse(result.stdout);
    return pullRequest.state === "MERGED";
  } catch {
    return false;
  }
}

export function isMergedIntoOriginMain(path, branch, options = {}) {
  if (gitSuccess(path, ["merge-base", "--is-ancestor", branch, "origin/main"])) {
    return true;
  }

  options.progress?.("Checking GitHub merge status");
  return isMergedOnGitHub(path, branch);
}

export function isDiscardable(path, branch) {
  const result = git(path, ["config", `branch.${branch}.description`], { check: false });
  return result.status === 0 && result.stdout.includes("wt:discardable");
}

export function isReusableWorktree(worktree, options = {}) {
  if (worktree.prunable || !worktree.branch || worktree.detached) {
    return false;
  }

  if (worktree.branch === "main" || worktree.branch === "master") {
    return false;
  }

  if (!isWorktreeClean(worktree.path)) {
    return false;
  }

  return isMergedIntoOriginMain(worktree.path, worktree.branch, options) || isDiscardable(worktree.path, worktree.branch);
}

export function findReusableWorktree(worktrees, options = {}) {
  for (const [index, worktree] of worktrees.entries()) {
    options.progress?.(`Scanning reusable worktrees ${index + 1}/${worktrees.length}`);
    if (isReusableWorktree(worktree, options)) {
      return worktree;
    }
  }

  return null;
}
