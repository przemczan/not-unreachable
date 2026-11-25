# Contributing

## Commit messages

Every push to `main` may make a release: semantic-release reads the commit
messages since the last release, in the
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format,
to decide the next version and write the release notes. So each commit that
lands on `main` (with a squash merge, the pull request's title) reads:

```
<type>[(<scope>)][!]: <what changes, in the imperative>

[body: why]

[BREAKING CHANGE: what breaks, and what to do about it]
```

| Type                                                                       | Release                                 |
| -------------------------------------------------------------------------- | --------------------------------------- |
| `feat`: a new feature for admins or users                                  | minor (1.2.0 → 1.3.0)                   |
| `fix`: a bug fix                                                           | patch (1.2.0 → 1.2.1)                   |
| `!` after the type or scope, or a `BREAKING CHANGE:` footer, with any type | major (1.2.0 → 2.0.0)                   |
| `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`        | none; they ride along with the next one |

Examples:

```
feat(shares): let a share link expire after its first download
fix(install): keep the config when the service fails to start
feat(api)!: remove the v0 routes
```

The scope is optional: name the part it changes, such as `server`, `web`,
`install`, `shares` or `smb`.

## Releases

The workflow Release (`.github/workflows/release.yml`) runs on every push to
`main`. When a commit calls for a release, it tags `v<version>`, builds the
tarballs on x64 and arm64, and publishes the GitHub Release with
`SHA256SUMS`, the SBOMs and the one-line installer. Nobody tags by hand.

To see what the next release would be without publishing anything, start the
workflow by hand from the Actions tab with **dry run** checked (the default):
it prints the version and the notes and builds the tarballs. Locally,
`pnpm exec semantic-release --dry-run --no-ci` prints the same version and
notes when you can push to the repository and `GITHUB_TOKEN` is set.

If a build fails after the tag is made, re-run the failed jobs: the draft
Release is published once they pass. Re-running the whole workflow finds the
tag already made and releases nothing.

The design behind it is in
[docs/design/stack.md, "Release artefact"](docs/design/stack.md#release-artefact).
