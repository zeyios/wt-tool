# worktree-tools

`worktree-tools` provides a `wt` shell function for jumping to a Git worktree by branch name.

## Install

```bash
npm install -g worktree-tools
```

Add the shell wrapper to `~/.zshrc` or `~/.bashrc`:

```bash
source "$(npm root -g)/worktree-tools/shell/wt.sh"
```

To install from this repository without publishing (adds the `wt` binary to your PATH):

```bash
npm link
source "$(npm root -g)/worktree-tools/shell/wt.sh"
```

Or for local development without linking:

```bash
source ./shell/wt.sh
```

Verify that your shell is using the function, not only the binary:

```bash
type wt
```

It should say `wt is a shell function`. The `wt` binary can resolve branches, but only the sourced shell function can change your current shell directory.

## Usage

```bash
wt <branch>
wt status
wt -b <branch>
wt -x
```

Examples:

```bash
wt feature/foo
wt status
wt feature/foo && npm run test -- --watch
wt -b spike/test-agent && claude
wt feature/foo && cursor .
wt -x
```

## Behavior

- `wt <branch>` switches to an existing local branch worktree, creates a tracking branch when only `origin/<branch>` exists, and errors when neither exists.
- `wt status` lists every worktree in the current Git repository with its path, branch, and whether it is reusable.
- `wt -b <branch>` creates a new branch from the branch/HEAD where `wt` was invoked. It refuses to create the branch if it exists locally or on `origin`.
- `wt -x` marks the current branch as reusable by adding `wt:discardable` to the branch description.
- Existing target worktrees are preferred over reuse or creation.
- Reusable worktrees must be clean, not on `main` or `master`, and either merged into `origin/main`, reported as merged by `gh pr view <branch>`, or marked `wt:discardable`.
- When no reusable worktree exists, a new path is created as `<repo-parent>/<repo-name>-<n>`, starting with `-2`.

## Development

```bash
npm test
```
