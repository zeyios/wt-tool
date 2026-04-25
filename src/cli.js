import { git, GitError, gitStdout } from "./git.js";
import {
  currentBranch,
  currentHead,
  findReusableWorktree,
  findWorktreeForBranch,
  isWorktreeClean,
  listWorktrees,
  localBranchExists,
  nextWorktreePath,
  remoteBranchExists
} from "./worktrees.js";

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function progressFunction(progress) {
  if (typeof progress === "function") {
    return progress;
  }
  return progress?.update?.bind(progress) ?? (() => {});
}

export function createProgressReporter(stream = process.stderr) {
  if (!stream?.isTTY) {
    return {
      update() {},
      success() {},
      failure() {}
    };
  }

  let frame = 0;
  let active = false;
  let lastLine = "";

  function render(stage) {
    const prefix = spinnerFrames[frame % spinnerFrames.length];
    frame += 1;
    const width = Math.max(20, stream.columns || 80);
    const line = `${prefix} ${stage}`.slice(0, width - 1);
    lastLine = line;
    active = true;
    stream.write(`\r\u001b[2K${line}`);
  }

  return {
    update(stage) {
      if (stage) {
        render(stage);
      }
    },
    success() {
      if (active) {
        stream.write("\r\u001b[2K");
      }
      active = false;
      lastLine = "";
    },
    failure() {
      if (active) {
        stream.write(`\r\u001b[2K${lastLine}\n`);
      }
      active = false;
    }
  };
}

function usage() {
  return [
    "Usage:",
    "  wt <branch>                  Open or create a worktree for an existing branch.",
    "  wt -b <branch>               Create a new branch from the current HEAD and open its worktree.",
    "  wt status                    List worktrees and show which ones can be reused.",
    "  wt -x                        Mark the current branch as reusable after you are done with it."
  ].join("\n");
}

function parseArgs(args) {
  const resolveOnly = args[0] === "--resolve";
  const rest = resolveOnly ? args.slice(1) : args;

  if (rest.length === 1 && ["--help", "-h", "help"].includes(rest[0])) {
    return { mode: "help", resolveOnly };
  }

  if (rest.length === 1 && rest[0] === "-x") {
    return { mode: "markDone", resolveOnly };
  }

  if (rest.length === 1 && rest[0] === "status") {
    return { mode: "status", resolveOnly };
  }

  if (rest.length === 2 && rest[0] === "-b") {
    return { mode: "create", branch: rest[1], resolveOnly };
  }

  if (rest.length === 1 && !rest[0].startsWith("-")) {
    return { mode: "switch", branch: rest[0], resolveOnly };
  }

  throw new UserError(usage());
}

function repoTopLevel(cwd, progress) {
  progress("Finding repo");
  const result = git(cwd, ["rev-parse", "--show-toplevel"], { check: false });
  if (result.status !== 0) {
    throw new UserError("Not inside a Git repository.");
  }
  return result.stdout.trim();
}

function fetchOrigin(cwd, progress) {
  progress("Fetching origin");
  git(cwd, ["fetch", "origin", "--prune"]);
}

function switchExistingBranch(repo, branch, worktrees, progress) {
  const target = findWorktreeForBranch(worktrees, branch);
  if (target) {
    return target.path;
  }

  const reusable = findReusableWorktree(worktrees, { progress });
  if (reusable) {
    progress("Switching worktree");
    git(reusable.path, ["switch", branch]);
    return reusable.path;
  }

  const path = nextWorktreePath(worktrees);
  progress("Creating worktree");
  git(repo, ["worktree", "add", path, branch]);
  return path;
}

function switchRemoteBranch(repo, branch, worktrees, progress) {
  const reusable = findReusableWorktree(worktrees, { progress });
  if (reusable) {
    progress("Switching worktree");
    git(reusable.path, ["switch", "--track", "-c", branch, `origin/${branch}`]);
    return reusable.path;
  }

  const path = nextWorktreePath(worktrees);
  progress("Creating worktree");
  git(repo, ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]);
  return path;
}

function resolveSwitch(repo, branch, progress) {
  progress("Reading worktrees");
  let worktrees = listWorktrees(repo);
  const target = findWorktreeForBranch(worktrees, branch);
  if (target) {
    return target.path;
  }

  progress("Checking branch");
  if (localBranchExists(repo, branch)) {
    return switchExistingBranch(repo, branch, worktrees, progress);
  }

  fetchOrigin(repo, progress);
  progress("Reading worktrees");
  worktrees = listWorktrees(repo);

  progress("Checking branch");
  if (remoteBranchExists(repo, branch)) {
    return switchRemoteBranch(repo, branch, worktrees, progress);
  }

  throw new UserError(
    [
      `Branch not found locally or on origin: ${branch}`,
      "If you want to create a new branch, use:",
      `  wt -b ${branch}`
    ].join("\n")
  );
}

function resolveCreate(repo, callerCwd, branch, progress) {
  progress("Checking branch");
  const sourceBranch = currentBranch(callerCwd);
  if (!sourceBranch) {
    throw new UserError("Cannot create a branch from detached HEAD. Run wt -b from an existing branch.");
  }

  const sourceHead = currentHead(callerCwd);
  fetchOrigin(repo, progress);

  progress("Checking branch");
  if (localBranchExists(repo, branch) || remoteBranchExists(repo, branch)) {
    throw new UserError(`Branch already exists locally or on origin: ${branch}`);
  }

  progress("Reading worktrees");
  const worktrees = listWorktrees(repo);
  const reusable = findReusableWorktree(worktrees, { progress });

  if (reusable) {
    progress("Switching worktree");
    git(reusable.path, ["switch", "-c", branch, sourceHead]);
    return reusable.path;
  }

  const path = nextWorktreePath(worktrees);
  progress("Creating worktree");
  git(repo, ["worktree", "add", "-b", branch, path, sourceHead]);
  return path;
}

function resolveMarkDone(cwd) {
  const branch = currentBranch(cwd);
  if (!branch) {
    throw new UserError("Cannot mark detached HEAD as discardable.");
  }

  if (branch === "main" || branch === "master") {
    throw new UserError(`Cannot mark ${branch} as discardable.`);
  }

  const key = `branch.${branch}.description`;
  const existing = git(cwd, ["config", key], { check: false });
  const description = existing.status === 0 ? existing.stdout.trimEnd() : "";
  const next = description.includes("wt:discardable")
    ? description
    : [description, "wt:discardable"].filter(Boolean).join("\n");

  git(cwd, ["config", key, next]);
  const path = gitStdout(cwd, ["rev-parse", "--show-toplevel"]);
  const warning = isWorktreeClean(cwd)
    ? null
    : [
        `Marked ${branch} as discardable, but this worktree is not clean.`,
        "wt status will keep it unavailable until you commit, stash, or remove the changes."
      ].join(" ");

  return { path, warning };
}

function resolveStatus(repo, progress) {
  progress("Reading worktrees");
  const worktrees = listWorktrees(repo);
  const rows = worktrees.map((worktree, index) => {
    progress(`Scanning reusable worktrees ${index + 1}/${worktrees.length}`);
    return {
      path: worktree.path,
      branch: worktree.branch ?? "-",
      reusable: findReusableWorktree([worktree], { progress: (stage) => {
        if (stage === "Checking GitHub merge status") {
          progress(stage);
        }
      } }) ? "🟢" : "🔴"
    };
  });
  const branchWidth = Math.max("BRANCH".length, ...rows.map((row) => row.branch.length));
  const lines = [`${"STATUS".padEnd(6)}  ${"BRANCH".padEnd(branchWidth)}  PATH`];

  for (const row of rows) {
    lines.push(`${row.reusable.padEnd(6)}  ${row.branch.padEnd(branchWidth)}  ${row.path}`);
  }
  return `${lines.join("\n")}\n`;
}

export function resolve(args, cwd, options = {}) {
  const parsed = parseArgs(args);
  const progress = progressFunction(options.progress);

  if (parsed.mode === "help") {
    return { output: `${usage()}\n`, resolveOnly: parsed.resolveOnly };
  }

  const repo = repoTopLevel(cwd, progress);

  if (parsed.mode === "status") {
    return { output: resolveStatus(repo, progress), resolveOnly: parsed.resolveOnly };
  }

  if (parsed.mode === "switch") {
    return { path: resolveSwitch(repo, parsed.branch, progress), resolveOnly: parsed.resolveOnly };
  }

  if (parsed.mode === "create") {
    return { path: resolveCreate(repo, cwd, parsed.branch, progress), resolveOnly: parsed.resolveOnly };
  }

  const { path, warning } = resolveMarkDone(cwd);
  return { path, warning, resolveOnly: parsed.resolveOnly };
}

export function main(args, cwd) {
  const progress = createProgressReporter(process.stderr);
  try {
    const { path, output, warning } = resolve(args, cwd, { progress });
    progress.success();
    if (output !== undefined) {
      process.stdout.write(output);
      return;
    }

    if (warning) {
      process.stderr.write(`${warning}\n`);
    }

    process.stdout.write(`${path}\n`);
  } catch (error) {
    progress.failure();
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof GitError) {
      process.stderr.write(error.result?.stderr || `${error.message}\n`);
      process.exitCode = error.result?.status || 1;
      return;
    }

    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
