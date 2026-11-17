// Run with Node 22+: node --test magda/runtime/build.test.mjs
// build.sh refuses to build anything but the exact reviewed release: an
// annotated tag on the expected commit, with the upstream baseline as ancestor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("build.sh", import.meta.url));

function git(cwd, ...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

async function repository(t) {
    const cwd = await mkdtemp(path.join(tmpdir(), "magda-build-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "tag.gpgSign", "false");
    const commit = async (name) => {
        await writeFile(path.join(cwd, name), name);
        git(cwd, "add", name);
        git(cwd, "commit", "-q", "--no-gpg-sign", "-m", name);
        return git(cwd, "rev-parse", "HEAD");
    };
    const upstream = await commit("upstream");
    const release = await commit("release");
    git(cwd, "tag", "-a", "magda/1.0.0/1.0.0", "-m", "release");
    git(cwd, "tag", "light", release);
    git(cwd, "checkout", "-q", "--orphan", "other");
    const unrelated = await commit("unrelated");
    git(cwd, "checkout", "-q", "magda/1.0.0/1.0.0");
    return { cwd, upstream, release, unrelated };
}

function verifyRef(cwd, ...args) {
    return spawnSync("bash", [script, "verify-ref", ...args], { cwd, encoding: "utf8" });
}

test("accepts an annotated tag on the expected commit with the upstream baseline as ancestor", async (t) => {
    const r = await repository(t);
    const result = verifyRef(r.cwd, "magda/1.0.0/1.0.0", r.release, r.upstream);
    assert.equal(result.status, 0, result.stderr);
});

test("rejects a lightweight tag", async (t) => {
    const r = await repository(t);
    git(r.cwd, "checkout", "-q", "light");
    const result = verifyRef(r.cwd, "light", r.release, r.upstream);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an annotated tag/);
});

test("rejects a checkout that isn't the expected commit", async (t) => {
    const r = await repository(t);
    git(r.cwd, "checkout", "-q", r.upstream);
    const result = verifyRef(r.cwd, "magda/1.0.0/1.0.0", r.release, r.upstream);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HEAD is .* expected/);
});

test("rejects a tag that points at another commit", async (t) => {
    const r = await repository(t);
    const result = verifyRef(r.cwd, "magda/1.0.0/1.0.0", r.upstream, r.upstream);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /points at .* expected/);
});

test("rejects an upstream baseline that isn't an ancestor", async (t) => {
    const r = await repository(t);
    const result = verifyRef(r.cwd, "magda/1.0.0/1.0.0", r.release, r.unrelated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an ancestor/);
});

test("rejects SHAs that aren't full 40-character SHAs", async (t) => {
    const r = await repository(t);
    const result = verifyRef(r.cwd, "magda/1.0.0/1.0.0", r.release.slice(0, 12), r.upstream);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /full commit SHA/);
});
