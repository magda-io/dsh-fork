#!/usr/bin/env bash
# Build the DSH runtime archive that MAGDA's agent runtime image installs.
#
#   build.sh verify-ref <tag> <sha> <upstream-sha>
#   build.sh build <tag> <sha> <upstream-ref> <upstream-sha> <out-dir>
#
# Run `build` as root inside node:<version>-bookworm-slim, the same base image
# as MAGDA's runtime image (see MAGDA.md, "Runtime archives"), from a full
# checkout of the release tag. Native addons are compiled here, so building on
# another OS or Node version produces an archive the image can't load.
set -euo pipefail

fail() {
  echo "build.sh: $*" >&2
  exit 1
}

full_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "$2 must be a full commit SHA: $1"
}

# The release must be the exact reviewed commit: an annotated tag, checked out,
# on top of the unchanged upstream baseline.
verify_ref() {
  local tag=$1 sha=$2 upstream_sha=$3 head
  full_sha "$sha" "release SHA"
  full_sha "$upstream_sha" "upstream SHA"
  [ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null)" = tag ] \
    || fail "$tag is not an annotated tag"
  [ "$(git rev-parse "refs/tags/$tag^{commit}")" = "$sha" ] \
    || fail "$tag points at $(git rev-parse "refs/tags/$tag^{commit}"), expected $sha"
  head=$(git rev-parse HEAD)
  [ "$head" = "$sha" ] || fail "HEAD is $head, expected $sha"
  git merge-base --is-ancestor "$upstream_sha" HEAD 2>/dev/null \
    || fail "upstream $upstream_sha is not an ancestor of $sha"
}

build() {
  local tag=$1 sha=$2 upstream_ref=$3 upstream_sha=$4 out=$5
  local deploy=${DSH_DEPLOY_DIR:-/opt/dsh-release}
  local repo=${DSH_SOURCE_REPO:-https://github.com/magda-io/dsh-fork.git}

  [ -f /etc/debian_version ] && [[ "$(cut -d. -f1 /etc/debian_version)" == 12 ]] \
    || fail "run inside node:<version>-bookworm-slim (Debian 12)"
  [ "$(id -u)" = 0 ] || fail "run as root inside the build container"
  [ ! -e "$deploy" ] || fail "$deploy already exists"

  export DEBIAN_FRONTEND=noninteractive DSH_TELEMETRY_DISABLED=1
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates git build-essential musl-tools python3
  rm -rf /var/lib/apt/lists/*
  corepack enable
  corepack prepare pnpm@11.7.0 --activate
  # The checkout is usually owned by the host user, not the container's root.
  git config --global --add safe.directory "$PWD"

  verify_ref "$tag" "$sha" "$upstream_sha"
  local version
  version=$(node -p 'require("./package.json").version')
  [ "$(node -p 'require("./apps/cli/package.json").version')" = "$version" ] \
    || fail "apps/cli version differs from the root version $version"

  pnpm install --frozen-lockfile
  pnpm run build:official
  pnpm exec tsx native/system/scripts/build.ts
  pnpm run verify-runtime-closure

  # The CLI manifest alone does not provide its required runtime peers. Use the
  # upstream executable assembly. Modern offline deploy preserves the committed
  # external graph; pnpm 11 legacy+hoisted deploy silently ignores that lockfile.
  node magda/runtime/prepare-deploy.mjs
  pnpm --filter dsh-python-runtime-closure --prod deploy --offline \
    --config.inject-workspace-packages=true --config.allow-unused-patches=true \
    --config.node-linker=hoisted "$deploy"
  git diff --exit-code -- pnpm-lock.yaml
  node magda/runtime/verify-deploy-lock.mjs "$deploy"
  DSH_SOURCE_REPO="$repo" DSH_RELEASE_TAG="$tag" DSH_RELEASE_SHA="$sha" \
    DSH_UPSTREAM_REF="$upstream_ref" DSH_UPSTREAM_SHA="$upstream_sha" \
    node magda/runtime/deploy-runtime.mjs "$deploy" --prune
  # No published @deepseek-ai package other than MAGDA's LibreOffice Kit.
  pnpm exec tsx scripts/verify-package-origins.ts --lockfile pnpm-lock.yaml --installed "$deploy"
  [ "$(node "$deploy/node_modules/@deepseek-ai/dsh/lib/bin.js" --version)" = "$version" ] \
    || fail "the deployed CLI doesn't report version $version"

  # Docker's architecture names, which MAGDA's Dockerfile selects by.
  local arch
  case "$(node -p process.arch)" in
    x64) arch=amd64 ;;
    arm64) arch=arm64 ;;
    *) fail "unsupported architecture $(node -p process.arch)" ;;
  esac
  TAG="$tag" SHA="$sha" VERSION="$version" ARCH="$arch" node -e '
    const { execFileSync } = require("node:child_process");
    const libc = execFileSync("ldd", ["--version"], { encoding: "utf8" }).split("\n")[0];
    const record = {
      tag: process.env.TAG, sha: process.env.SHA, version: process.env.VERSION,
      arch: process.env.ARCH, node: process.version, libc,
      debian: require("node:fs").readFileSync("/etc/debian_version", "utf8").trim(),
    };
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify(record, null, 2) + "\n");
  ' "$deploy/build-info/build.json"

  mkdir -p "$out"
  local archive="$out/dsh-runtime-linux-$arch.tar.gz"
  tar --sort=name --mtime="@$(git log -1 --format=%ct HEAD)" --owner=0 --group=0 --numeric-owner \
    -C "$deploy" -cf - node_modules build-info | gzip -n > "$archive"
  ls -l "$archive"
}

case "${1:-}" in
  verify-ref)
    [ $# = 4 ] || fail "usage: build.sh verify-ref <tag> <sha> <upstream-sha>"
    verify_ref "$2" "$3" "$4"
    ;;
  build)
    [ $# = 6 ] || fail "usage: build.sh build <tag> <sha> <upstream-ref> <upstream-sha> <out-dir>"
    build "$2" "$3" "$4" "$5" "$6"
    ;;
  *)
    fail "usage: build.sh verify-ref|build ..."
    ;;
esac
