# Landing rules

- `main` is protected: direct pushes are rejected, and PRs targeting `main` are
  closed by automation.
- Land changes on `dev`: one commit on `dev`, then one PR with `--base dev`.
- `gh` in this sandbox talks to the local fixture remote only.
