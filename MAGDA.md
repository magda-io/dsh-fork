# MAGDA maintenance of DSH

This fork carries the DSH revision that [MAGDA](https://github.com/magda-io/magda)'s agent runtime image (`magda-agent-runtime`) installs. Each release's [runtime archives](#runtime-archives) are built from its tag by this repository's CI. MAGDA pins an exact release tag, its commit SHA and the archives' checksums, chosen from the repository's **Releases** page; it never uses a branch.

## Branches and tags

| Ref | Purpose |
|---|---|
| `upstream/<version>` branch, e.g. `upstream/0.2.1-alpha.1` | The official upstream release, kept unchanged as the baseline for review and forward-ports. |
| `magda` branch | MAGDA's maintained revision: the upstream baseline plus reviewed MAGDA changes. Pull requests target it. |
| `magda/<upstream-version>/<magda-version>` tag, e.g. `magda/0.2.1-alpha.1/1.0.2` | A MAGDA maintenance release: an annotated tag on a `magda` merge commit. |
| `main` branch | The repository default, mirroring upstream. MAGDA work doesn't land here. |

`<magda-version>` counts MAGDA releases on one upstream baseline; raise its patch number for each maintenance release.

## Versions MAGDA may pin

MAGDA may pin a version only when all of these hold:

1. It is an annotated `magda/<upstream-version>/<magda-version>` tag on a merge commit of the `magda` branch.
2. It has a published GitHub release on that tag, not a draft. The repository's **Releases** page is therefore the list of versions MAGDA can use; a tag without a release record isn't one of them.
3. Its release isn't marked withdrawn.
4. Its release has both [runtime archives](#runtime-archives) and `SHA256SUMS` attached by the `MAGDA runtime archives` workflow.

Never pin a branch (including `magda`), a commit without a release, or a tag without a release record.

Review enforces this rule, not automation. The release build checks the tag type, the commit SHA and the upstream ancestry; MAGDA's image build checks only the archive checksums and the release that the archive records. A MAGDA pull request that changes the pin links the release in its description. Its reviewer checks:
- that the release exists, and isn't a draft or withdrawn;
- that `DSH_RELEASE_TAG` is the release's tag;
- that `DSH_RELEASE_SHA` is the full SHA of the commit that tag points at.

### Withdrawing a release

If a release must no longer be used, keep its tag: images built from it record the tag and the commit SHA, so never delete, move or re-create it. Instead:
- edit the release title to start with `[Withdrawn]`;
- add a first line to its notes giving the reason and the version to use instead.

A MAGDA pin that still uses the withdrawn version moves to a later release in its next update.

## Changing the `magda` branch

1. Open a pull request into `magda`. Keep public text technical.
2. Wait for CI to pass (see [CI on the fork](#ci-on-the-fork)), then merge with a **merge commit**, not a squash. The release tag must point at a commit on `magda` that contains the reviewed history.

The lefthook pre-push hook runs `pnpm run typecheck`. It needs `pnpm` on `PATH` (`corepack enable`) and a local `main` branch, which it diffs against: `git branch --no-track main origin/main`.

## Releasing a maintenance version

Create the annotated tag first, then the GitHub release on that existing tag. MAGDA's image build requires an annotated tag object: it checks `git cat-file -t refs/tags/<tag>` is `tag`. A tag created by `gh release create` or the GitHub web form is a lightweight tag and fails that check.

1. Update and check the release commit:

   ```sh
   git fetch origin --tags
   SHA=$(git rev-parse origin/magda)
   git log --oneline -5 "$SHA"
   git merge-base --is-ancestor <upstream-sha> "$SHA" && echo "baseline is an ancestor"
   git merge-base --is-ancestor <previous-tag> "$SHA" && echo "previous release is an ancestor"
   ```

   The upstream SHA is the commit of the `upstream/<version>` branch. MAGDA's build checks that it is an ancestor of the tag.

2. Create and push the annotated tag. Name the baseline and list the changes since the previous release, with their pull requests:

   ```sh
   git tag -a magda/<upstream-version>/<magda-version> "$SHA" -F - <<'EOF'
   MAGDA DSH <upstream-version> maintenance release <magda-version>

   Upstream baseline: upstream/<upstream-version>
   (<upstream-sha>, official dsh-v<upstream-version>).

   MAGDA delta since <previous-magda-version>:
   - <conventional-commit summary> (magda-io/dsh-fork#<pr>).
   EOF
   git push origin refs/tags/magda/<upstream-version>/<magda-version>
   ```

   Never move or re-create a pushed release tag; publish a new version instead.

3. Create the GitHub release on the existing tag. Mark it a pre-release while the upstream version is a prerelease, such as `0.2.1-alpha.1`:

   ```sh
   gh release create magda/<upstream-version>/<magda-version> --verify-tag --prerelease \
     --title "MAGDA DSH <upstream-version> maintenance release <magda-version>" \
     --notes-file release-notes.md
   ```

   The notes state:
   - what the release is for;
   - the tag and its commit SHA;
   - the upstream baseline and the previous MAGDA release;
   - the changes since that release, with pull-request links;
   - how it was verified, including the CI run;
   - what is not yet qualified.

   Publishing the release starts the `MAGDA runtime archives` workflow, which attaches the two runtime archives and `SHA256SUMS` (see [Runtime archives](#runtime-archives)). Don't attach anything else built locally. Attach evidence files only when a release needs them.

4. Verify that the tag is still annotated and points at the release commit, and that the release is not a draft:

   ```sh
   git fetch origin --tags --force
   git ls-remote --tags origin 'magda/<upstream-version>/<magda-version>*'   # the tag object, then ^{} = $SHA
   git cat-file -t refs/tags/magda/<upstream-version>/<magda-version>       # tag
   gh release view magda/<upstream-version>/<magda-version> --json isPrerelease,isDraft,assets
   ```

   Wait for the `MAGDA runtime archives` run to finish. The release must list `dsh-runtime-linux-amd64.tar.gz`, `dsh-runtime-linux-arm64.tar.gz` and `SHA256SUMS`, and its notes must end with the checksums.

5. Pin the release in MAGDA, under the rules in [Versions MAGDA may pin](#versions-magda-may-pin). In `magda-agent-runtime/Dockerfile`:
   - set `DSH_RELEASE_TAG` to the tag name and `DSH_RELEASE_SHA` to its full commit SHA;
   - set `DSH_RUNTIME_SHA256_AMD64` and `DSH_RUNTIME_SHA256_ARM64` from the release's `SHA256SUMS`.

   Then run that component's image checks, and link the release in the MAGDA pull request.

   MAGDA's build downloads the archive for its architecture and fails unless the archive matches its pinned checksum. Its `build-info/dsh-source.json` must also name the pinned tag, SHA and upstream baseline. The image checks then test the installed tree itself.

## Runtime archives

MAGDA's image doesn't build DSH. It installs a runtime archive from the release it pins: the production `node_modules` of DSH's executable assembly, plus a `build-info/` directory. The `MAGDA runtime archives` workflow (`.github/workflows/magda-runtime-release.yml`) builds one archive per architecture with `magda/runtime/build.sh`:

| Asset | Built on |
|---|---|
| `dsh-runtime-linux-amd64.tar.gz` | GitHub-hosted `ubuntu-24.04` |
| `dsh-runtime-linux-arm64.tar.gz` | GitHub-hosted `ubuntu-24.04-arm` |
| `SHA256SUMS` | The checksums of both, also added to the release notes with a link to the run |

**The build must run inside the same `node:<version>-bookworm-slim` image as MAGDA's runtime image.** The archive contains native addons (for example node-pty, koffi and the Landlock runner) compiled against that Node version and Debian bookworm's glibc. An archive built directly on the runner's Ubuntu, or with another Node version, can fail to load in MAGDA's image. The workflow's `BUILD_IMAGE` must therefore match `NODE_VERSION` in MAGDA's `magda-agent-runtime/Dockerfile`. Change both together; the image checks fail if the archive's recorded Node version or architecture differs from the image's.

`build.sh` refuses to build anything but the exact release:
- the tag must be annotated and point at the checked-out commit;
- the upstream baseline in `magda/runtime/upstream.env` must be an ancestor of it;
- the lockfile must be unchanged by the deploy;
- DSH's `verify-package-origins` must pass on the deployed tree.

`build-info/` records:
- `dsh-source.json`: the repository, tag, SHA, upstream baseline and every shipped package;
- `build.json`: the Node version, architecture, glibc and Debian version used;
- the lockfile and pruning reports, the licence and the third-party notices.

A pull request into `magda` that touches `magda/runtime/` or the workflow builds both archives without publishing them, under a throwaway tag.

If a release's run fails, fix the cause and re-run the failed jobs from the run's page. The upload never replaces an asset that is already attached. If a wrong asset was attached, withdraw the release (see [Withdrawing a release](#withdrawing-a-release)) and publish a new version.

To build an archive locally, for example to test a change, run `build.sh` in that image on a full clone with an annotated tag. A locally built archive is never attached to a release.

## CI on the fork

Pull-request CI (`.github/workflows/ci.yml`) is configured by two repository variables (Settings → Secrets and variables → Actions → Variables). With both unset, the workflows behave as upstream's.

| Variable | Value here | Effect |
|---|---|---|
| `DSH_CI_FAILOVER_LINUX` | `github` | The static, unit and consumer jobs run on GitHub-hosted `ubuntu-24.04`. The unit job runs the uninstrumented `check:ci:unit`, because the coverage lane is too heavy for these runners. |
| `DSH_CI_DISABLED` | `windows-build,windows-coverage,windows-native-tests,python-runtime-windows,python-live-api` | A comma-separated list of job IDs to skip. `python-runtime-windows` drops the Windows Python runtime target, and `python-live-api` skips the real-API tests that need `DEEPSEEK_API_KEY_EXTERNAL`. |

The `all checks passed` verdict accepts a skipped job only when `DSH_CI_DISABLED` lists it. To switch off a job that the fork's runners can't run, add its ID to the variable; no code change is needed.
