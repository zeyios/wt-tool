import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { createProgressReporter, resolve as resolveWt } from "../src/cli.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wtBin = join(repoRoot, "bin", "wt.js");
const shellWrapper = join(repoRoot, "shell", "wt.sh");
const hasZsh = spawnSync("zsh", ["-lc", "true"]).status === 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8"
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function wt(cwd, ...args) {
  return run(process.execPath, [wtBin, "--resolve", ...args], { cwd, check: false });
}

function wtEnv(cwd, env, ...args) {
  return run(process.execPath, [wtBin, "--resolve", ...args], { cwd, check: false, env });
}

function wtDirect(cwd, ...args) {
  return run(process.execPath, [wtBin, ...args], { cwd, check: false });
}

function parseStatus(output) {
  const lines = output.trimEnd().split("\n");
  return lines.slice(1).map((line) => {
    const match = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, `status row should be column-aligned: ${line}`);
    const [, reusable, branch, path] = match;
    return { path, branch, reusable };
  });
}

async function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "wt-tool-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  git(root, "init", "--bare", origin);
  git(root, "clone", origin, repo);
  git(repo, "config", "user.name", "WT Test");
  git(repo, "config", "user.email", "wt@example.com");
  writeFileSync(join(repo, "README.md"), "main\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-u", "origin", "main");

  return { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo) };
}

async function withRepo(fn) {
  const fixture = await makeRepo();
  try {
    await fn(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("fails outside a Git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-not-repo-"));
  try {
    const result = wt(dir, "feature/missing");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Not inside a Git repository\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns an existing worktree for a local branch", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "feature/local");

    const result = wt(repo, "feature/local");

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), repo);
  });
});

test("creates a tracking branch when only origin has the branch", async () => {
  await withRepo(async ({ root, repo }) => {
    const seed = join(root, "seed");
    git(root, "clone", join(root, "origin.git"), seed);
    git(seed, "config", "user.name", "WT Test");
    git(seed, "config", "user.email", "wt@example.com");
    git(seed, "switch", "-c", "feature/remote", "origin/main");
    writeFileSync(join(seed, "remote.txt"), "remote\n");
    git(seed, "add", "remote.txt");
    git(seed, "commit", "-m", "remote branch");
    git(seed, "push", "-u", "origin", "feature/remote");

    const result = wt(repo, "feature/remote");
    const target = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.equal(git(target, "branch", "--show-current").stdout.trim(), "feature/remote");
    assert.equal(git(target, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.trim(), "origin/feature/remote");
  });
});

test("does not create a missing branch without -b", async () => {
  await withRepo(async ({ repo }) => {
    const result = wt(repo, "feature/missing");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Branch not found locally or on origin: feature\/missing/);
    assert.match(result.stderr, /wt -b feature\/missing/);
    assert.equal(git(repo, "branch", "--list", "feature/missing").stdout.trim(), "");
  });
});

test("direct binary reports a missing branch instead of generic usage", async () => {
  await withRepo(async ({ repo }) => {
    const result = wtDirect(repo, "test-wt-tool");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Branch not found locally or on origin: test-wt-tool/);
    assert.match(result.stderr, /wt -b test-wt-tool/);
    assert.doesNotMatch(result.stderr, /^Usage:/);
  });
});

test("direct binary help describes each command", async () => {
  await withRepo(async ({ repo }) => {
    const result = wtDirect(repo, "--help");

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /wt <branch>\s+Open or create a worktree for an existing branch\./);
    assert.match(result.stdout, /wt -b <branch>\s+Create a new branch from the current HEAD and open its worktree\./);
    assert.match(result.stdout, /wt status\s+List worktrees and show which ones can be reused\./);
    assert.match(result.stdout, /wt -x\s+Mark the current branch as reusable after you are done with it\./);
    assert.doesNotMatch(result.stdout, /<command/);
  });
});

test("shell wrapper help prints without changing directory", async () => {
  await withRepo(async ({ repo }) => {
    const script = [
      `source ${JSON.stringify(shellWrapper)}`,
      "before=$PWD",
      "wt --help",
      "after=$PWD",
      "printf 'cwd:%s\\n' \"$after\""
    ].join("; ");

    const result = run("bash", ["-lc", script], { cwd: repo, check: false });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /wt <branch>\s+Open or create a worktree for an existing branch\./);
    assert.match(result.stdout, new RegExp(`cwd:${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("direct binary rejects command suffixes", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "feature/no-command");

    const result = wtDirect(repo, "feature/no-command", "--", "node");

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage:/);
  });
});

test("creates a new branch from the caller current branch", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "base/topic");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-m", "base topic");

    const callerHead = git(repo, "rev-parse", "HEAD").stdout.trim();
    const result = wt(repo, "-b", "feature/from-current");
    const target = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.equal(git(target, "branch", "--show-current").stdout.trim(), "feature/from-current");
    assert.equal(git(target, "rev-parse", "feature/from-current").stdout.trim(), callerHead);
  });
});

test("rejects -b when branch exists locally or on origin", async () => {
  await withRepo(async ({ root, repo }) => {
    git(repo, "switch", "-c", "feature/local-exists");
    git(repo, "switch", "main");

    const localResult = wt(repo, "-b", "feature/local-exists");
    assert.equal(localResult.status, 1);
    assert.match(localResult.stderr, /Branch already exists locally or on origin: feature\/local-exists/);

    const seed = join(root, "seed");
    git(root, "clone", join(root, "origin.git"), seed);
    git(seed, "config", "user.name", "WT Test");
    git(seed, "config", "user.email", "wt@example.com");
    git(seed, "switch", "-c", "feature/origin-exists", "origin/main");
    writeFileSync(join(seed, "origin-exists.txt"), "origin\n");
    git(seed, "add", "origin-exists.txt");
    git(seed, "commit", "-m", "origin exists");
    git(seed, "push", "-u", "origin", "feature/origin-exists");

    const remoteResult = wt(repo, "-b", "feature/origin-exists");
    assert.equal(remoteResult.status, 1);
    assert.match(remoteResult.stderr, /Branch already exists locally or on origin: feature\/origin-exists/);
  });
});

test("rejects -b from detached HEAD", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "checkout", "--detach");

    const result = wt(repo, "-b", "feature/detached");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot create a branch from detached HEAD/);
  });
});

test("reuses a clean merged worktree but never dirty or main worktrees", async () => {
  await withRepo(async ({ repo }) => {
    const dirtyPath = join(dirname(repo), "repo-dirty");
    const masterPath = join(dirname(repo), "repo-master");
    const mergedPath = join(dirname(repo), "repo-merged");

    git(repo, "worktree", "add", "-b", "dirty/reuse", dirtyPath, "main");
    writeFileSync(join(dirtyPath, "dirty.txt"), "dirty\n");
    git(repo, "worktree", "add", "-b", "master", masterPath, "main");
    git(repo, "worktree", "add", "-b", "merged/reuse", mergedPath, "main");

    const result = wt(repo, "-b", "feature/reused");
    const target = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.equal(target, mergedPath);
    assert.equal(git(target, "branch", "--show-current").stdout.trim(), "feature/reused");
  });
});

test("reuses a clean worktree when GitHub reports its PR as merged", async () => {
  await withRepo(async ({ root, repo }) => {
    const mergedPath = join(dirname(repo), "repo-gh-merged");
    const ghBinDir = join(root, "bin");
    await mkdir(ghBinDir);
    const ghBin = join(ghBinDir, "gh");
    writeFileSync(
      ghBin,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.join(' ') === 'pr view feature/rebased --json state,mergedAt') {",
        "  console.log(JSON.stringify({ state: 'MERGED', mergedAt: '2026-04-23T08:03:01Z' }));",
        "  process.exit(0);",
        "}",
        "console.error(`unexpected gh args: ${args.join(' ')}`);",
        "process.exit(1);"
      ].join("\n")
    );
    chmodSync(ghBin, 0o755);

    git(repo, "worktree", "add", "-b", "feature/rebased", mergedPath, "main");
    writeFileSync(join(mergedPath, "review.txt"), "review guidelines\n");
    git(mergedPath, "add", "review.txt");
    git(mergedPath, "commit", "-m", "add review guidelines");

    writeFileSync(join(repo, "review.txt"), "review guidelines\n");
    git(repo, "add", "review.txt");
    git(repo, "commit", "-m", "squash merge review guidelines");
    git(repo, "push", "origin", "main");

    const result = wtEnv(repo, { PATH: `${ghBinDir}:${process.env.PATH}` }, "-b", "feature/reused-gh");

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), mergedPath);
    assert.equal(git(mergedPath, "branch", "--show-current").stdout.trim(), "feature/reused-gh");
  });
});

test("reuses a clean discardable worktree", async () => {
  await withRepo(async ({ repo }) => {
    const oldPath = join(dirname(repo), "repo-old");
    git(repo, "worktree", "add", "-b", "spike/old", oldPath, "main");
    writeFileSync(join(oldPath, "old.txt"), "old\n");
    git(oldPath, "add", "old.txt");
    git(oldPath, "commit", "-m", "old unmerged work");
    git(oldPath, "config", 'branch.spike/old.description', "done\nwt:discardable\n");

    const result = wt(repo, "-b", "feature/discardable");

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), oldPath);
    assert.equal(git(oldPath, "branch", "--show-current").stdout.trim(), "feature/discardable");
  });
});

test("creates a new numbered worktree when nothing is reusable", async () => {
  await withRepo(async ({ repo }) => {
    const result = wt(repo, "-b", "feature/new-path");
    const target = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.equal(target, join(dirname(repo), "repo-2"));
    assert.equal(git(target, "branch", "--show-current").stdout.trim(), "feature/new-path");
  });
});

test("skips prunable worktrees when looking for a reusable worktree", async () => {
  await withRepo(async ({ repo }) => {
    const stalePath = join(dirname(repo), "repo-stale");
    git(repo, "worktree", "add", "-b", "stale/reuse", stalePath, "main");
    await rm(stalePath, { recursive: true, force: true });

    const result = wt(repo, "-b", "feature/skip-prunable");
    const target = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.notEqual(target, stalePath);
    assert.equal(git(target, "branch", "--show-current").stdout.trim(), "feature/skip-prunable");
  });
});

test("marks the current branch discardable with -x", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "spike/done");

    const result = wt(repo, "-x");
    const description = git(repo, "config", "branch.spike/done.description").stdout;

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), repo);
    assert.equal(result.stderr, "");
    assert.match(description, /wt:discardable/);
  });
});

test("warns when marking a dirty worktree discardable with -x", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "spike/dirty-done");
    writeFileSync(join(repo, "scratch.txt"), "scratch\n");

    const result = wt(repo, "-x");

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), repo);
    assert.match(result.stderr, /Marked spike\/dirty-done as discardable/);
    assert.match(result.stderr, /worktree is not clean/);
    assert.match(result.stderr, /wt status will keep it unavailable/);
  });
});

test("shell wrapper warns for dirty -x without breaking directory change", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "spike/shell-dirty-done");
    writeFileSync(join(repo, "scratch.txt"), "scratch\n");
    const script = [
      `source ${JSON.stringify(shellWrapper)}`,
      "wt -x",
      "printf 'cwd:%s\\n' \"$PWD\""
    ].join("; ");

    const result = run("bash", ["-lc", script], { cwd: repo, check: false });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `cwd:${repo}`);
    assert.match(result.stderr, /Marked spike\/shell-dirty-done as discardable/);
    assert.match(result.stderr, /worktree is not clean/);
  });
});

test("status lists worktree path, branch, and whether it is reusable", async () => {
  await withRepo(async ({ repo }) => {
    const dirtyPath = join(dirname(repo), "repo-dirty");
    const mergedPath = join(dirname(repo), "repo-merged");
    const oldPath = join(dirname(repo), "repo-old");

    git(repo, "worktree", "add", "-b", "dirty/status", dirtyPath, "main");
    writeFileSync(join(dirtyPath, "dirty.txt"), "dirty\n");
    git(repo, "worktree", "add", "-b", "merged/status", mergedPath, "main");
    git(repo, "worktree", "add", "-b", "spike/status", oldPath, "main");
    writeFileSync(join(oldPath, "old.txt"), "old\n");
    git(oldPath, "add", "old.txt");
    git(oldPath, "commit", "-m", "old unmerged work");
    git(oldPath, "config", "branch.spike/status.description", "done\nwt:discardable\n");

    const result = wtDirect(repo, "status");
    const lines = result.stdout.trimEnd().split("\n");
    const rows = parseStatus(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(lines[0], "STATUS  BRANCH         PATH");
    assert.equal(lines[1], `🔴      main           ${repo}`);
    assert.equal(lines[2], `🔴      dirty/status   ${dirtyPath}`);
    assert.equal(lines[3], `🟢      merged/status  ${mergedPath}`);
    assert.equal(lines[4], `🟢      spike/status   ${oldPath}`);
    assert.deepEqual(rows, [
      { path: repo, branch: "main", reusable: "🔴" },
      { path: dirtyPath, branch: "dirty/status", reusable: "🔴" },
      { path: mergedPath, branch: "merged/status", reusable: "🟢" },
      { path: oldPath, branch: "spike/status", reusable: "🟢" }
    ]);
  });
});

test("status reports progress stages without polluting table output", async () => {
  await withRepo(async ({ repo }) => {
    const oldPath = join(dirname(repo), "repo-old");
    git(repo, "worktree", "add", "-b", "spike/status-progress", oldPath, "main");
    git(oldPath, "config", "branch.spike/status-progress.description", "done\nwt:discardable\n");
    const stages = [];

    const result = resolveWt(["status"], repo, {
      progress: (stage) => stages.push(stage)
    });

    assert.match(result.output, /^STATUS\s+BRANCH\s+PATH\n/);
    assert.doesNotMatch(result.output, /Reading worktrees|Scanning reusable worktrees/);
    assert.ok(stages.includes("Reading worktrees"));
    assert.ok(stages.includes("Scanning reusable worktrees 1/2"));
    assert.ok(stages.includes("Scanning reusable worktrees 2/2"));
  });
});

test("TTY progress reporter overwrites successful stages and clears on success", () => {
  let output = "";
  const stream = {
    isTTY: true,
    columns: 80,
    write(chunk) {
      output += chunk;
    }
  };

  const progress = createProgressReporter(stream);
  progress.update("Fetching origin");
  progress.update("Scanning reusable worktrees 2/3");
  progress.success();

  assert.match(output, /\r.*Fetching origin/);
  assert.match(output, /\r.*Scanning reusable worktrees 2\/3/);
  assert.match(output, /\r\u001b\[2K$/);
});

test("TTY progress reporter leaves the last stage visible on failure", () => {
  let output = "";
  const stream = {
    isTTY: true,
    columns: 80,
    write(chunk) {
      output += chunk;
    }
  };

  const progress = createProgressReporter(stream);
  progress.update("Checking branch");
  progress.failure();

  assert.match(output, /Checking branch\n$/);
});

test("shell wrapper status prints worktree status without changing directory", async () => {
  await withRepo(async ({ repo }) => {
    const script = [
      `source ${JSON.stringify(shellWrapper)}`,
      "before=$PWD",
      "wt status",
      "after=$PWD",
      "printf 'cwd:%s\\n' \"$after\""
    ].join("; ");

    const result = run("bash", ["-lc", script], { cwd: repo });
    const lines = result.stdout.trimEnd().split("\n");

    assert.equal(result.status, 0);
    assert.deepEqual(lines, ["STATUS  BRANCH  PATH", `🔴      main    ${repo}`, `cwd:${repo}`]);
  });
});

test("shell wrapper rejects command suffixes", async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "feature/shell-no-command");
    const script = [
      `source ${JSON.stringify(shellWrapper)}`,
      "wt feature/shell-no-command -- node"
    ].join("; ");

    const result = run("bash", ["-lc", script], { cwd: repo, check: false });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage:/);
  });
});

test("zsh wrapper rejects command suffixes", { skip: !hasZsh }, async () => {
  await withRepo(async ({ repo }) => {
    git(repo, "switch", "-c", "feature/zsh-no-command");
    const script = [
      `source ${JSON.stringify(shellWrapper)}`,
      "wt feature/zsh-no-command -- node"
    ].join("; ");

    const result = run("zsh", ["-lc", script], { cwd: repo, check: false });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage:/);
  });
});
