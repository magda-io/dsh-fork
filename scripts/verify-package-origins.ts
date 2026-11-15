/**
 * Verify where locked and installed packages come from. No published
 * `@deepseek-ai/*` package may come from a registry: workspace packages share
 * the scope but resolve to links or directories, and MAGDA builds and releases
 * the Office kit itself. Every lockfile resolution that is neither the registry
 * nor a directory must match an allowed tarball by exact URL and integrity.
 * This detects in the resulting lockfile what pnpm's `blockExoticSubdeps`
 * would prevent during resolution; the kit's engine subdependency requires
 * that setting off. The installed-tree check rejects unexpected or wrong-version
 * packages it finds. It compares names and versions, not file contents, and
 * does not require optional packages to be installed.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'

/** One tarball the lockfile may resolve outside the registry. */
export interface AllowedTarball {
  name: string
  version: string
  tarball: string
  integrity: string
}

const OFFICE_KIT_RELEASE = 'https://github.com/magda-io/dsh-libreoffice-kit/releases/download/v0.1.5-magda.1'

/** The MAGDA Office kit release; both packages must be locked. */
export const OFFICE_KIT_TARBALLS: readonly AllowedTarball[] = [
  {
    name: '@deepseek-ai/libreoffice-kit',
    version: '0.1.5-magda.1',
    tarball: `${OFFICE_KIT_RELEASE}/deepseek-ai-libreoffice-kit-0.1.5-magda.1.tgz`,
    integrity: 'sha512-BbF/FPDzI2EYwifP3xYPmi49pYUWt71/iv1Doik0AEAIeomU5jEAnlShc+Tud1SEM2YlPAspZdMRHXrCDFk+mg==',
  },
  {
    name: '@deepseek-ai/libreoffice-kit-wasm',
    version: '0.1.5-magda.1',
    tarball: `${OFFICE_KIT_RELEASE}/deepseek-ai-libreoffice-kit-wasm-0.1.5-magda.1.tgz`,
    integrity: 'sha512-VTM7PXCRTYHXZ2VTMhCeAN1haMHJuqRMOODt0qrSUoGcYNfMEjwmvK/t9YFNnVHpm4ywN8D7PnyAVw7zo8ZkfA==',
  },
]

/** Every tarball the lockfile may resolve outside the registry. */
export const ALLOWED_TARBALLS: readonly AllowedTarball[] = [
  ...OFFICE_KIT_TARBALLS,
  // SheetJS publishes current releases only on its own CDN.
  {
    name: 'xlsx',
    version: '0.20.3',
    tarball: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
    integrity: 'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==',
  },
]

const SCOPE = '@deepseek-ai/'

interface LockedPackage {
  resolution?: { integrity?: string; tarball?: string; type?: string }
  version?: string
}

/** The parts of a pnpm v9 lockfile that this check reads. */
export interface Lockfile {
  importers?: Record<string, unknown>
  packages?: Record<string, LockedPackage>
}

/** One installed `@deepseek-ai/*` package. */
export interface InstalledPackage {
  path: string
  name: string
  version: string
}

function packageName(key: string): string {
  return key.slice(0, key.indexOf('@', 1))
}

/**
 * Check every resolution in a lockfile against the origin policy.
 * @param lockfile - the parsed lockfile.
 * @param allowed - tarballs the lockfile may resolve outside the registry.
 * @param required - tarballs the lockfile must contain.
 * @returns One message per violation.
 */
export function checkLockfileOrigins(
  lockfile: Lockfile,
  allowed: readonly AllowedTarball[] = ALLOWED_TARBALLS,
  required: readonly AllowedTarball[] = OFFICE_KIT_TARBALLS,
): string[] {
  const failures: string[] = []
  const found = new Set<string>()
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    const name = packageName(key)
    const resolution = entry.resolution ?? {}
    if (resolution.type === 'directory') continue
    if (resolution.type !== undefined) {
      failures.push(`${key}: ${resolution.type} resolution is not allowed`)
    } else if (resolution.tarball !== undefined) {
      const match = allowed.find(candidate => candidate.name === name && candidate.tarball === resolution.tarball)
      if (match === undefined) {
        failures.push(`${key}: tarball ${resolution.tarball} is not allowed`)
      } else if (resolution.integrity !== match.integrity) {
        failures.push(`${key}: integrity ${resolution.integrity ?? '(none)'} does not match the allowed ${match.integrity}`)
      } else if (entry.version !== match.version) {
        failures.push(`${key}: version ${entry.version ?? '(none)'} does not match the allowed ${match.version}`)
      } else {
        found.add(match.tarball)
      }
    } else if (name.startsWith(SCOPE)) {
      failures.push(`${key}: published ${SCOPE}* package resolves from the registry`)
    }
  }
  for (const tarball of required) {
    if (!found.has(tarball.tarball)) failures.push(`${tarball.name}: the lockfile does not resolve ${tarball.tarball}`)
  }
  return failures
}

/**
 * Find every installed `@deepseek-ai/*` package under a directory's `node_modules`.
 * Symlinked packages are read but not entered, so workspace links stay shallow.
 * @param root - the directory whose `node_modules` to scan.
 * @returns The installed packages.
 */
export function findInstalledScopePackages(root: string): InstalledPackage[] {
  const found: InstalledPackage[] = []
  const visit = (modules: string): void => {
    if (!existsSync(modules)) return
    for (const entry of readdirSync(modules)) {
      if (entry === '.pnpm') {
        for (const store of readdirSync(join(modules, entry))) visit(join(modules, entry, store, 'node_modules'))
      } else if (entry.startsWith('@')) {
        for (const child of readdirSync(join(modules, entry))) inspect(join(modules, entry, child), `${entry}/${child}`)
      } else if (!entry.startsWith('.')) {
        inspect(join(modules, entry), entry)
      }
    }
  }
  const inspect = (path: string, name: string): void => {
    const manifest = join(path, 'package.json')
    if (name.startsWith(SCOPE) && existsSync(manifest)) {
      const { name: declared, version } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
      found.push({ path, name: declared ?? name, version: version ?? '' })
    }
    if (!lstatSync(path).isSymbolicLink()) visit(join(path, 'node_modules'))
  }
  visit(join(root, 'node_modules'))
  return found
}

/**
 * Check installed `@deepseek-ai/*` packages against the lockfile that produced them.
 * @param installed - the installed packages.
 * @param workspaceNames - names the lockfile links or resolves to directories.
 * @param allowed - tarballs the lockfile may resolve outside the registry.
 * @returns One message per violation.
 */
export function checkInstalledPackages(
  installed: readonly InstalledPackage[],
  workspaceNames: ReadonlySet<string>,
  allowed: readonly AllowedTarball[] = ALLOWED_TARBALLS,
): string[] {
  const failures: string[] = []
  for (const { path, name, version } of installed) {
    const tarball = allowed.find(candidate => candidate.name === name)
    if (tarball !== undefined) {
      if (version !== tarball.version) failures.push(`${path}: ${name}@${version} is not the allowed ${tarball.version}`)
    } else if (!workspaceNames.has(name)) {
      failures.push(`${path}: ${name}@${version} is not a workspace package or an allowed tarball`)
    }
  }
  return failures
}

/**
 * Collect the `@deepseek-ai/*` names a lockfile links to workspace sources.
 * @param lockfile - the parsed lockfile.
 * @param directory - the lockfile's directory, which importer paths are relative to.
 * @returns Names of importers and of directory-resolved packages.
 */
export function workspacePackageNames(lockfile: Lockfile, directory: string): Set<string> {
  const names = new Set<string>()
  for (const importer of Object.keys(lockfile.importers ?? {})) {
    const manifest = join(directory, importer, 'package.json')
    if (!existsSync(manifest)) continue
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
    if (name !== undefined) names.add(name)
  }
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    if (entry.resolution?.type === 'directory') names.add(packageName(key))
  }
  return names
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { lockfile: { type: 'string' }, installed: { type: 'string' } },
  })
  const root = resolve(import.meta.dirname, '..')
  const installedRoot = values.installed === undefined ? undefined : resolve(values.installed)
  const lockfilePath = resolve(values.lockfile ?? join(installedRoot ?? root, 'pnpm-lock.yaml'))
  const lockfile = load(readFileSync(lockfilePath, 'utf8')) as Lockfile
  const failures = checkLockfileOrigins(lockfile)
  const installed = installedRoot === undefined ? [] : findInstalledScopePackages(installedRoot)
  failures.push(...checkInstalledPackages(installed, workspacePackageNames(lockfile, dirname(lockfilePath))))
  if (failures.length > 0) {
    console.error(`verify-package-origins: ${lockfilePath} violates the package origin policy:`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    const scanned = installedRoot === undefined ? '' : ` and ${installed.length} installed ${SCOPE}* packages under ${installedRoot}`
    console.log(`verify-package-origins: ${lockfilePath}${scanned} use only workspace sources, the registry, and allowed tarballs.`)
  }
}
