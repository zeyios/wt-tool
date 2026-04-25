# Repository Guidelines

## Project Structure & Module Organization

This repository contains a small Node.js CLI for managing Git worktrees.

- `bin/wt.js` is the executable entry point published as `wt`.
- `src/cli.js` handles argument parsing, command dispatch, and process output.
- `src/worktrees.js` contains worktree discovery, reuse, status, and branch logic.
- `src/git.js` wraps Git command execution.
- `shell/wt.sh` provides the shell function that can change the caller's directory.
- `test/wt.test.js` contains the Node test suite.
- `README.md` documents user-facing installation and usage.

Keep new behavior close to the existing module boundary. CLI parsing belongs in `src/cli.js`; Git/worktree rules belong in `src/worktrees.js`.

## Build, Test, and Development Commands

- `npm test` runs the full test suite with Node's built-in test runner.
- `node bin/wt.js status` runs the CLI directly from this checkout.
- `source ./shell/wt.sh` loads the local shell wrapper for manual testing.
- `wt <branch>` or `wt -b <branch>` can then be tested from inside a Git repository.

There is no build step; the package runs as native ESM on Node `>=20`.

## Coding Style & Naming Conventions

Use JavaScript ESM syntax and keep imports explicit. Follow the existing style: two-space indentation, semicolons, double quotes, and small focused functions. Prefer descriptive function names such as `findReusableWorktree` or `remoteBranchExists`.

Avoid broad refactors while changing CLI behavior. Preserve plain text output and keep shell wrapper changes POSIX-friendly where practical, with Bash/Zsh compatibility.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add or update tests in `test/wt.test.js` for every behavior change. Prefer fixture repositories created inside temporary directories, as existing tests do with `withRepo`.

When changing command behavior, cover both direct binary usage and shell-wrapper behavior if directory changes or command output are affected. Run `npm test` before handing off changes.

## Commit & Pull Request Guidelines

This repository currently has no commit history to infer conventions from. Use concise imperative commit subjects, for example `Add worktree status command` or `Handle merged GitHub PR worktrees`.

Pull requests should include a short description, the user-visible behavior change, and the verification command run, usually `npm test`. Link related issues when available. Screenshots are not needed for this CLI unless documenting terminal output.
