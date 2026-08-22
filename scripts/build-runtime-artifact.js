'use strict'

/**
 * build-runtime-artifact — build a dsh runtime artifact for a given version,
 * independent of the bundled rescue (resources/dsh-runtimes). Uses a fresh full
 * Node (with npm) unpacked from cache to install dsh, packs it, and emits a
 * single-artifact manifest (with releaseTag/channel). Outputs to dist/runtime/.
 *
 * Usage:
 *   DSH_VERSION=0.1.0-rc.8 node scripts/build-runtime-artifact.js
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { packDirectory } = require('../src/tar-util')

const NODE_VERSION = 'v22.23.2'
const ROOT = path.join(__dirname, '..')
const CACHE = process.env.HARBOR_CACHE || path.join(ROOT, 'resources', 'cache')
const OUT = path.join(ROOT, 'dist', 'runtime')

function log(msg) { console.log(`[build-artifact] ${msg}`) }

function platformArch() {
  const map = {
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win32-x64': 'win-x64',
    'win32-arm64': 'win-arm64',
  }
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) {
    if (!map[env]) throw new Error(`unsupported HARBOR_TARGET_ARCH: ${env}`)
    return map[env]
  }
  const key = `${process.platform}-${process.arch}`
  if (!map[key]) throw new Error(`unsupported platform/arch: ${key}`)
  return map[key]
}

function targetPlatform() {
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) return env.split('-')[0]
  return process.platform
}

function targetArch() {
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) return env.split('-')[1]
  return process.arch
}

/** deterministic content digest for the dsh tree → buildId (12 hex chars) */
function computeBuildId(dshDir) {
  const hash = crypto.createHash('sha256')
  const rels = []
  ;(function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(p, r)
      else rels.push(r)
    }
  })(dshDir, '')
  rels.sort()
  for (const r of rels) {
    hash.update(r + '\0')
    const p = path.join(dshDir, r)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) hash.update('link:' + fs.readlinkSync(p))
    else hash.update(fs.readFileSync(p))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** unpack a full Node (with npm) from cache into work/node, return node bin path */
function extractNode(workDir, pa) {
  const isWin = targetPlatform() === 'win32'
  const ext = isWin ? 'zip' : 'tar.gz'
  const tarball = path.join(CACHE, `node-${NODE_VERSION}-${pa}.${ext}`)
  if (!fs.existsSync(tarball)) {
    throw new Error(`node tarball not in cache: ${tarball} (run prepare-dsh.js first, or set HARBOR_OFFLINE_NODE)`)
  }
  const tmp = path.join(workDir, 'node-x')
  fs.mkdirSync(tmp, { recursive: true })
  log(`extracting ${path.basename(tarball)}`)
  if (isWin) {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${tarball}' -DestinationPath '${tmp}'`], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xf', tarball, '-C', tmp], { stdio: 'inherit' })
  }
  const entries = fs.readdirSync(tmp)
  if (entries.length !== 1) throw new Error(`unexpected node archive layout: ${entries.join(',')}`)
  const nodeDir = path.join(workDir, 'node')
  fs.renameSync(path.join(tmp, entries[0]), nodeDir)
  fs.rmSync(tmp, { recursive: true, force: true })
  return isWin ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')
}

/** npm install dsh@version into dshDir using the full node runtime */
function installDsh(nodeBin, dshDir, version) {
  fs.mkdirSync(dshDir, { recursive: true })
  if (!fs.existsSync(path.join(dshDir, 'package.json'))) {
    fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: 'dshed-dsh', private: true, version: '0.0.0' }, null, 2))
  }
  const registry = process.env.HARBOR_NPM_MIRROR || 'https://registry.npmjs.org/'
  const isWin = targetPlatform() === 'win32'
  const nodeDir = path.dirname(nodeBin)
  const npmCli = isWin
    ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(nodeDir, 'npm')
  const env = { ...process.env, npm_config_progress: 'false' }
  env.PATH = `${nodeDir}${path.delimiter}${env.PATH || ''}`
  log(`installing @deepseek-ai/dsh@${version} (registry=${registry})`)
  execFileSync(nodeBin, [
    npmCli, 'install', `@deepseek-ai/dsh@${version}`, '--omit=dev', '--no-audit', '--no-fund', '--registry', registry,
  ], { cwd: dshDir, stdio: 'inherit', env })
}

async function main() {
  const version = process.env.DSH_VERSION
  if (!version) { console.error('DSH_VERSION is required'); process.exit(1) }
  const platform = targetPlatform()
  const arch = targetArch()
  const pa = platformArch()

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshed-build-'))
  try {
    const nodeBin = extractNode(work, pa)
    const dshDir = path.join(work, 'dsh')
    installDsh(nodeBin, dshDir, version)

    const pkg = JSON.parse(fs.readFileSync(path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    if (!pkg.bin || !pkg.bin.dsh) throw new Error('dsh package.json missing bin.dsh')
    const buildId = computeBuildId(dshDir)
    const entry = ['node_modules', '@deepseek-ai', 'dsh', pkg.bin.dsh].join('/')

    fs.mkdirSync(OUT, { recursive: true })
    const archiveName = `dsh-${version}-${buildId}-${platform}-${arch}.tar.gz`
    const archivePath = path.join(OUT, archiveName)
    log(`packing ${archiveName}`)
    const { fileCount, extractedSize } = await packDirectory(dshDir, archivePath)
    const archiveBytes = fs.statSync(archivePath).size
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')

    const shellPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const manifest = {
      schemaVersion: 1,
      runtimeId: `dsh-${version}-${buildId}-${platform}-${arch}`,
      dshVersion: version,
      buildId,
      platform,
      arch,
      archive: archiveName,
      sha256,
      size: archiveBytes,
      extractedSize,
      extractedFileCount: fileCount,
      entry,
      minimumDshedVersion: shellPkg.version,
      releasedAt: new Date().toISOString(),
      releaseTag: `dsh-v${version}-${buildId}`,
      channel: 'stable',
    }
    const manifestPath = path.join(OUT, `${archiveName}.manifest.json`)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    log(`artifact: ${archivePath} (${archiveBytes} bytes, sha256=${sha256})`)
    log(`manifest: ${manifestPath}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main()
