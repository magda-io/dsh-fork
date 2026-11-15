import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_TARBALLS,
  checkInstalledPackages,
  checkLockfileOrigins,
  findInstalledScopePackages,
  OFFICE_KIT_TARBALLS,
  workspacePackageNames,
  type AllowedTarball,
  type Lockfile,
} from './verify-package-origins.ts'

const [adapter, wasm] = OFFICE_KIT_TARBALLS as [AllowedTarball, AllowedTarball]

function locked(tarball: AllowedTarball): NonNullable<Lockfile['packages']> {
  return {
    [`${tarball.name}@${tarball.tarball}`]: {
      resolution: { integrity: tarball.integrity, tarball: tarball.tarball },
      version: tarball.version,
    },
  }
}

const officeKit = { ...locked(adapter), ...locked(wasm) }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function installed(files: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-origins-'))
  roots.push(root)
  for (const [relative, manifest] of Object.entries(files)) {
    mkdirSync(join(root, relative), { recursive: true })
    writeFileSync(join(root, relative, 'package.json'), JSON.stringify(manifest))
  }
  return root
}

describe('lockfile package origins', () => {
  it('accepts the Office kit release, registry packages, and directory sources', () => {
    expect(checkLockfileOrigins({
      packages: {
        ...officeKit,
        'koffi@3.1.1': { resolution: { integrity: 'sha512-k' } },
        '@deepseek-ai/dsh-core@file:packages/core/core': { resolution: { type: 'directory' } },
      },
    })).toEqual([])
  })

  it('rejects the published Office kit from the registry', () => {
    expect(checkLockfileOrigins({
      packages: {
        '@deepseek-ai/libreoffice-kit@0.1.5': { resolution: { integrity: 'sha512-upstream' } },
        '@deepseek-ai/libreoffice-kit-wasm@0.1.5': { resolution: { integrity: 'sha512-upstream' } },
        '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5': { resolution: { integrity: 'sha512-upstream' } },
      },
    })).toEqual([
      '@deepseek-ai/libreoffice-kit@0.1.5: published @deepseek-ai/* package resolves from the registry',
      '@deepseek-ai/libreoffice-kit-wasm@0.1.5: published @deepseek-ai/* package resolves from the registry',
      '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5: published @deepseek-ai/* package resolves from the registry',
      `@deepseek-ai/libreoffice-kit: the lockfile does not resolve ${adapter.tarball}`,
      `@deepseek-ai/libreoffice-kit-wasm: the lockfile does not resolve ${wasm.tarball}`,
    ])
  })

  it('rejects any other published package in the scope', () => {
    expect(checkLockfileOrigins({
      packages: { ...officeKit, '@deepseek-ai/dsh-core@0.2.1': { resolution: { integrity: 'sha512-x' } } },
    })).toEqual(['@deepseek-ai/dsh-core@0.2.1: published @deepseek-ai/* package resolves from the registry'])
  })

  it('requires the WASM engine, which pnpm silently skips when its optional resolution fails', () => {
    expect(checkLockfileOrigins({ packages: locked(adapter) }))
      .toEqual([`@deepseek-ai/libreoffice-kit-wasm: the lockfile does not resolve ${wasm.tarball}`])
  })

  it('rejects an allowed URL with a different integrity or version', () => {
    const key = `${wasm.name}@${wasm.tarball}`
    expect(checkLockfileOrigins({
      packages: { ...officeKit, [key]: { resolution: { integrity: 'sha512-other', tarball: wasm.tarball }, version: wasm.version } },
    })).toEqual([
      `${key}: integrity sha512-other does not match the allowed ${wasm.integrity}`,
      `@deepseek-ai/libreoffice-kit-wasm: the lockfile does not resolve ${wasm.tarball}`,
    ])
    expect(checkLockfileOrigins({
      packages: { ...officeKit, [key]: { resolution: { integrity: wasm.integrity, tarball: wasm.tarball }, version: '0.1.5' } },
    })).toEqual([
      `${key}: version 0.1.5 does not match the allowed ${wasm.version}`,
      `@deepseek-ai/libreoffice-kit-wasm: the lockfile does not resolve ${wasm.tarball}`,
    ])
  })

  it('rejects tarballs and git sources outside the allowlist, in any scope', () => {
    expect(checkLockfileOrigins({
      packages: {
        ...officeKit,
        'left-pad@https://example.com/left-pad.tgz': { resolution: { integrity: 'sha512-l', tarball: 'https://example.com/left-pad.tgz' } },
        'right-pad@git+https://example.com/right-pad.git#abc': { resolution: { type: 'git' } },
      },
    })).toEqual([
      'left-pad@https://example.com/left-pad.tgz: tarball https://example.com/left-pad.tgz is not allowed',
      'right-pad@git+https://example.com/right-pad.git#abc: git resolution is not allowed',
    ])
  })

  it('accepts the committed lockfile', () => {
    const root = resolve(import.meta.dirname, '..')
    const lockfile = load(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lockfile
    expect(checkLockfileOrigins(lockfile)).toEqual([])
  })

  it('keeps the allowlist aligned with the workspace overrides', () => {
    const root = resolve(import.meta.dirname, '..')
    const workspace = load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { overrides: Record<string, string> }
    for (const tarball of OFFICE_KIT_TARBALLS) expect(workspace.overrides[tarball.name]).toBe(tarball.tarball)
    expect(ALLOWED_TARBALLS).toEqual(expect.arrayContaining([...OFFICE_KIT_TARBALLS]))
  })
})

describe('installed package origins', () => {
  it('finds scope packages in isolated and hoisted layouts without entering workspace links', () => {
    const root = installed({
      [`node_modules/.pnpm/kit/node_modules/${adapter.name}`]: { name: adapter.name, version: adapter.version },
      [`node_modules/${wasm.name}`]: { name: wasm.name, version: wasm.version },
      'node_modules/host/node_modules/@deepseek-ai/dsh-core': { name: '@deepseek-ai/dsh-core', version: '0.2.1' },
      'node_modules/koffi': { name: 'koffi', version: '3.1.1' },
      'workspace/node_modules/@deepseek-ai/hidden': { name: '@deepseek-ai/hidden', version: '1.0.0' },
    })
    symlinkSync(join(root, 'workspace'), join(root, 'node_modules/@deepseek-ai/linked'), 'dir')
    writeFileSync(join(root, 'workspace/package.json'), JSON.stringify({ name: '@deepseek-ai/linked', version: '0.2.1' }))

    expect(findInstalledScopePackages(root).map(({ name }) => name).sort()).toEqual([
      '@deepseek-ai/dsh-core', adapter.name, wasm.name, '@deepseek-ai/linked',
    ].sort())
  })

  it('rejects an installed kit at another version and packages the lockfile does not know', () => {
    expect(checkInstalledPackages([
      { path: 'a', name: adapter.name, version: '0.1.5' },
      { path: 'b', name: '@deepseek-ai/libreoffice-kit-darwin-arm64', version: '0.1.5' },
      { path: 'c', name: '@deepseek-ai/dsh-core', version: '0.2.1' },
      { path: 'd', name: wasm.name, version: wasm.version },
    ], new Set(['@deepseek-ai/dsh-core']))).toEqual([
      `a: ${adapter.name}@0.1.5 is not the allowed ${adapter.version}`,
      'b: @deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5 is not a workspace package or an allowed tarball',
    ])
  })

  it('names workspace importers and directory-resolved packages', () => {
    const root = installed({ 'packages/core': { name: '@deepseek-ai/dsh-core' } })
    expect(workspacePackageNames({
      importers: { 'packages/core': {}, 'packages/missing': {} },
      packages: { '@deepseek-ai/dsh-web@file:/src/web': { resolution: { type: 'directory' } } },
    }, root)).toEqual(new Set(['@deepseek-ai/dsh-core', '@deepseek-ai/dsh-web']))
  })
})
