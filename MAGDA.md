# MAGDA maintenance of DSH

This fork carries the DSH revision that [MAGDA](https://github.com/magda-io/magda)'s agent runtime image (`magda-agent-runtime`) builds from source. MAGDA pins an exact release tag and commit SHA from this repository, chosen from the repository's **Releases** page; it never builds from a branch.

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

Never pin a branch (including `magda`), a commit without a release, or a tag without a release record.

Review enforces this rule, not automation; MAGDA's image build checks only the tag type, the commit SHA and the upstream ancestry. A MAGDA pull request that changes the pin links the release in its description. Its reviewer checks:
- that the release exists, and isn't a draft or withdrawn;
- that `DSH_SOURCE_REF` is the release's tag;
- that `DSH_SOURCE_SHA` is the full SHA of the commit that tag points at.

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

   Don't attach built packages: MAGDA builds DSH from source at the pinned SHA, and GitHub attaches the source archives automatically. Attach evidence files only when a release needs them.

4. Verify that the tag is still annotated and points at the release commit, and that the release is not a draft:

   ```sh
   git fetch origin --tags --force
   git ls-remote --tags origin 'magda/<upstream-version>/<magda-version>*'   # the tag object, then ^{} = $SHA
   git cat-file -t refs/tags/magda/<upstream-version>/<magda-version>       # tag
   gh release view magda/<upstream-version>/<magda-version> --json isPrerelease,isDraft,assets
   ```

5. Pin the release in MAGDA, under the rules in [Versions MAGDA may pin](#versions-magda-may-pin):
   - in `magda-agent-runtime/Dockerfile`, set `DSH_SOURCE_REF` to the tag name and `DSH_SOURCE_SHA` to its full commit SHA;
   - run that component's image checks;
   - link the release in the MAGDA pull request.

   `DSH_SOURCE_REF` is always a release tag name, never a branch name. The build clones it with `git clone --branch`, which accepts a tag despite its name, and fails unless the ref is an annotated tag at `DSH_SOURCE_SHA`. The build checks:
   - the tag type and the commit SHA;
   - that the upstream baseline is an ancestor;
   - the locked dependency graph.

   It also records both commits in the image.

## CI on the fork

Pull-request CI (`.github/workflows/ci.yml`) is configured by two repository variables (Settings → Secrets and variables → Actions → Variables). With both unset, the workflows behave as upstream's.

| Variable | Value here | Effect |
|---|---|---|
| `DSH_CI_FAILOVER_LINUX` | `github` | The static, unit and consumer jobs run on GitHub-hosted `ubuntu-24.04`. The unit job runs the uninstrumented `check:ci:unit`, because the coverage lane is too heavy for these runners. |
| `DSH_CI_DISABLED` | `windows-build,windows-coverage,windows-native-tests,python-runtime-windows,python-live-api` | A comma-separated list of job IDs to skip. `python-runtime-windows` drops the Windows Python runtime target, and `python-live-api` skips the real-API tests that need `DEEPSEEK_API_KEY_EXTERNAL`. |

The `all checks passed` verdict accepts a skipped job only when `DSH_CI_DISABLED` lists it. To switch off a job that the fork's runners can't run, add its ID to the variable; no code change is needed.
