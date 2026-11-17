# MAGDA changes to DSH

What the `magda` branch changes from its upstream baseline, release by release, newest first. Use it to review a release, or to see which changes to carry forward when moving to a new upstream release. [`MAGDA.md`](MAGDA.md) covers the branches, the release process and the pinning rules. Each release's notes on the [Releases page](https://github.com/magda-io/dsh-fork/releases) have the details and its verification.

**Upstream baseline:** `upstream/0.2.1-alpha.1`, the official `dsh-v0.2.1-alpha.1` source, unchanged.

Each change is one of:
- **Runtime:** what MAGDA's agent runtime installs;
- **Build:** how DSH is built, locked or released;
- **CI:** the fork's pull-request checks;
- **Test:** tests only;
- **Docs:** documentation only.

## `magda/0.2.1-alpha.1/1.0.3`

No runtime changes.

- **Runtime archives** (Build, [#26](https://github.com/magda-io/dsh-fork/pull/26)).
  - The release workflow builds `dsh-runtime-linux-amd64.tar.gz` and `dsh-runtime-linux-arm64.tar.gz` from the release tag, inside `node:22.22.0-bookworm-slim`, and attaches them with `SHA256SUMS`. MAGDA's image installs these instead of building DSH.
  - Files: `magda/runtime/` (moved here from MAGDA's `magda-agent-runtime/`) and `.github/workflows/magda-runtime-release.yml`.
  - Forward-port: these files are MAGDA's own and don't overlap upstream. Check that `build.sh`'s build and deploy commands still match upstream's scripts, and keep the workflow's `BUILD_IMAGE` equal to MAGDA's `NODE_VERSION`.
- **Keep-alive snapshot timing** (Test, [#26](https://github.com/magda-io/dsh-fork/pull/26)).
  - The headless DeepSeek keep-alive snapshot test uses a 1000 ms stream idle timeout and 20 keep-alives, instead of 150 ms and 3. The old margin failed intermittently on loaded CI runners.
  - Files: `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` and `fixtures/deepseek-defaults.patch.yml`.
  - Forward-port: drop it if upstream has widened the margin itself.
- **MAGDA docs** (Docs, [#23](https://github.com/magda-io/dsh-fork/pull/23), [#24](https://github.com/magda-io/dsh-fork/pull/24)).
  - `MAGDA.md`: branches, release process, pinning rules, fork CI.

## `magda/0.2.1-alpha.1/1.0.2`

- **MAGDA's LibreOffice Kit release** (Runtime and Build, [#21](https://github.com/magda-io/dsh-fork/pull/21)).
  - `@deepseek-ai/libreoffice-kit` and `-wasm` are installed from [magda-io/dsh-libreoffice-kit](https://github.com/magda-io/dsh-libreoffice-kit/releases) release `v0.1.5-magda.1`, by exact tarball URL and integrity, instead of the npm registry. The darwin/win32 engine packages leave the graph. `blockExoticSubdeps` is off for the kit's engine subdependency.
  - `pnpm run verify-package-origins` fails if a published `@deepseek-ai/*` package resolves from a registry, or if a non-registry resolution isn't allow-listed.
  - Files:
    - `pnpm-workspace.yaml` (overrides), `pnpm-lock.yaml`;
    - the kit dependency in `packages/skill/skill-office`, `packages/document/office-to-pdf`, `packages/bundle/web-app` and `apps/desktop-host`;
    - `scripts/verify-package-origins.ts` and its spec, added to `scripts/run-gates.ts`;
    - `scripts/gen-third-party-notices.ts`, `THIRD_PARTY_NOTICES.md`;
    - the `office-to-pdf` README and subsystem page.
  - Forward-port: conflicts with any upstream lockfile or kit change. If upstream moves to another kit version, MAGDA needs a matching kit release first. Then re-pin and re-run `verify-package-origins`.
- **Fork CI on GitHub-hosted runners** (CI, [#22](https://github.com/magda-io/dsh-fork/pull/22)).
  - The `DSH_CI_FAILOVER_LINUX=github` and `DSH_CI_DISABLED` repository variables select GitHub-hosted runners and skip jobs the fork can't run (see `MAGDA.md`, "CI on the fork").
  - Files: `.github/workflows/ci.yml`, `build-exe-for-python-sdk.yml` and their specs under `scripts/`.
  - Forward-port: re-apply against upstream's workflow changes; the variables stay in the repository settings.

## `magda/0.2.1-alpha.1/1.0.1`

- **Memory-bounded Office checks** (Runtime, [#15](https://github.com/magda-io/dsh-fork/pull/15)).
  - `check_office.py` streams worksheets and shared strings, so a 2.2-million-cell workbook checks in about 20 MiB rather than 1.5 GiB. `--contains` uses a compact shared-string table with a 64 MiB budget. The `office-docx`, `office-pptx` and `office-xlsx` skills add large-workbook guidance and run LibreOffice Kit commands one at a time.
  - Files: `packages/skill/skill-office/assets/` (`SKILL.md` files and `scripts/check_office.py`), its tests, and two session snapshots under `snapshots/session/`.
  - Forward-port: compare with upstream's `check_office.py` and skills, and keep the memory bound.
