import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "GitError";
    this.result = result;
  }
}

export function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (options.check === false || result.status === 0) {
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  throw new GitError(`git ${args.join(" ")} failed`, result);
}

export function gitSuccess(cwd, args) {
  return git(cwd, args, { check: false }).status === 0;
}

export function gitStdout(cwd, args) {
  return git(cwd, args).stdout.trimEnd();
}

export function branchRef(branch) {
  return `refs/heads/${branch}`;
}

export function remoteRef(branch) {
  return `refs/remotes/origin/${branch}`;
}
