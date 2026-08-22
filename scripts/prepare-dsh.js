'use strict'

/**
 * prepare-dsh — prepare dsh engine runtime resources into resources/:
 *   - resources/node/  standalone Node runtime (per-platform, v22.23.2 LTS, pinned)
 *   - resources/dsh/   @deepseek-ai/dsh install (npm, --omit=dev)
 *
 * Features:
 *   - idempotent (skip if present, reuse tarball cache)
 *   - offline cache: HARBOR_CACHE cache root; HARBOR_OFFLINE_NODE points at an
 *     existing node tarball
 *   - mirrors: HARBOR_NPM_MIRROR / HARBOR_NODE_MIRROR
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const crypto = require('node:crypto')
const { packDirectory } = require('../src/tar-util')

const NODE_VERSION = 'v22.23.2'
const DSH_DEFAULT_VERSION = '0.1.0-rc.6'
const DSH_PKG = `@deepseek-ai/dsh@${process.env.DSH_VERSION || DSH_DEFAULT_VERSION}`
const ROOT = path.join(__dirname, '..')
const RESOURCES = process.env.HARBOR_RESOURCES || path.join(ROOT, 'resources')
const CACHE = process.env.HARBOR_CACHE || path.join(RESOURCES, 'cache')

function log(msg) { console.log(`[prepare] ${msg}`) }

function dirSize(dir) {
  let total = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) total += dirSize(p)
    else if (ent.isFile()) total += fs.statSync(p).size
    else if (ent.isSymbolicLink()) { try { total += fs.statSync(p).size } catch (e) { /* broken link */ } }
  }
  return total
}

function countFiles(dir) {
  let n = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

/** Target platform: HARBOR_TARGET_ARCH wins for cross-prep, otherwise current platform */
function targetPlatform() {
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) return env.split('-')[0]
  return process.platform
}

/** Target arch as process.arch semantics (x64/arm64) */
function targetArch() {
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) return env.split('-')[1]
  return process.arch
}

function platformArch() {
  const map = {
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win32-x64': 'win-x64',
    'win32-arm64': 'win-arm64',
  }
  // HARBOR_TARGET_ARCH override: cross-prepare another arch's node runtime
  // (e.g. prepare arm64 from a Rosetta x64 shell)
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) {
    if (!map[env]) throw new Error(`unsupported HARBOR_TARGET_ARCH: ${env} (options: ${Object.keys(map).join(', ')})`)
    return map[env]
  }
  const key = `${process.platform}-${process.arch}`
  if (!map[key]) throw new Error(`unsupported platform/arch: ${key}`)
  return map[key]
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { log(`cache hit: ${dest}`); return resolve() }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    log(`downloading ${url}`)
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'user-agent': 'dshed-prepare' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        file.close()
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlinkSync(dest)
        return reject(new Error(`download failed HTTP ${res.statusCode}: ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    })
    req.on('error', (e) => { file.close(); fs.unlinkSync(dest); reject(e) })
  })
}

/** Prepare the Node runtime (mac/linux tar.gz, win zip; extracted with system tar) */
async function prepareNode() {
  const pa = platformArch()
  const nodeDir = path.join(RESOURCES, 'node')
  // win node package layout: node.exe/npm.cmd at top level (no bin/); unix in bin/
  const bin = targetPlatform() === 'win32'
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node')
  // HARBOR_TARGET_ARCH cross-prep: force reinstall when the existing runtime arch mismatches
  const archSuffix = process.env.HARBOR_TARGET_ARCH || `${process.platform}-${process.arch}`
  const archMarker = path.join(nodeDir, '.arch-' + archSuffix)
  if (fs.existsSync(bin) && fs.existsSync(archMarker)) { log('node runtime already present, skipping'); return bin }
  log(`preparing ${pa} node runtime`)

  const ext = targetPlatform() === 'win32' ? 'zip' : 'tar.gz'
  let tarball = process.env.HARBOR_OFFLINE_NODE
  if (!tarball) {
    const base = process.env.HARBOR_NODE_MIRROR || 'https://nodejs.org/dist'
    const url = `${base}/${NODE_VERSION}/node-${NODE_VERSION}-${pa}.${ext}`
    tarball = path.join(CACHE, `node-${NODE_VERSION}-${pa}.${ext}`)
    await download(url, tarball)
  }

  const tmp = path.join(CACHE, `node-${NODE_VERSION}-${pa}.x`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  log(`extracting ${tarball}`)
  if (targetPlatform() === 'win32') {
    // Windows bsdtar parses "D:\..." as a URL scheme; PowerShell
    // Expand-Archive handles zip reliably.
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${tarball}' -DestinationPath '${tmp}'`,
    ], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xf', tarball, '-C', tmp], { stdio: 'inherit' })
  }

  // flatten node-v22.23.2-xxx/* → resources/node/
  const entries = fs.readdirSync(tmp)
  if (entries.length !== 1) throw new Error(`unexpected archive layout: ${entries.join(',')}`)
  fs.rmSync(nodeDir, { recursive: true, force: true })
  fs.renameSync(path.join(tmp, entries[0]), nodeDir)
  fs.rmSync(tmp, { recursive: true, force: true })

  if (targetPlatform() !== 'win32') fs.chmodSync(bin, 0o755)
  fs.writeFileSync(archMarker, new Date().toISOString())
  log(`node ready: ${bin}`)
  return bin
}

/** Install dsh (npm) into resources/dsh */
async function prepareDsh() {
  const dshDir = path.join(RESOURCES, 'dsh')
  if (fs.existsSync(path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh'))) {
    log('dsh already installed, skipping (delete resources/dsh to force reinstall)')
    return
  }
  fs.mkdirSync(dshDir, { recursive: true })
  if (!fs.existsSync(path.join(dshDir, 'package.json'))) {
    fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: 'dshed-dsh', private: true, version: '0.0.0' }, null, 2))
  }
  const registry = process.env.HARBOR_NPM_MIRROR || 'https://registry.npmjs.org/'
  log(`installing ${DSH_PKG} (registry=${registry}, ~5 min)`)
  // run npm with the bundled node so native deps (koffi etc.) install for the
  // runtime's arch — avoids an outer x64 npm producing x64 prebuilt modules
  // under an arm64 target
  const isWin = targetPlatform() === 'win32'
  const bundledNode = isWin
    ? path.join(RESOURCES, 'node', 'node.exe')
    : path.join(RESOURCES, 'node', 'bin', 'node')
  // Windows: npm.cmd is a batch file that cannot run under node.exe; invoke
  // npm-cli.js directly instead. Unix: npm shell script is fine via node.
  const npmCli = isWin
    ? path.join(RESOURCES, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(RESOURCES, 'node', 'bin', 'npm')
  const env = { ...process.env, npm_config_progress: 'false' }
  // install scripts (e.g. koffi's `sh -c node cnoke.cjs`) resolve node from PATH;
  // prepend the bundled node dir so native deps install for the right arch
  // (x64 → arm64 outputs are unusable)
  env.PATH = `${path.dirname(bundledNode)}${path.delimiter}${env.PATH || ''}`
  execFileSync(bundledNode, [
    '--max-old-space-size=4096',
    npmCli, 'install', DSH_PKG, '--omit=dev', '--no-audit', '--no-fund', '--registry', registry,
  ], { cwd: dshDir, stdio: 'inherit', env })
  log('dsh installed')
}

/**
 * Slim the bundled Node runtime after dsh is built. Node is only needed to run
 * dsh at runtime, so npm/corepack/include/docs/man-pages are all removable.
 * Keeps the executable, runtime libs (ICU is compiled into the binary) and the
 * license. Reports bytes/files before and after; fails if still > 150MB.
 *
 * Keep/delete lists are per-platform (unix keeps npm/npx/corepack as bin
 * symlinks; Windows ships them as top-level .cmd shims + node_modules/).
 */
function slimNode() {
  const nodeDir = path.join(RESOURCES, 'node')
  const isWin = targetPlatform() === 'win32'

  const before = dirSize(nodeDir)
  const beforeCount = countFiles(nodeDir)

  const remove = (rel) => fs.rmSync(path.join(nodeDir, rel), { recursive: true, force: true })

  if (isWin) {
    remove('node_modules') // npm + corepack
    remove('include')
    remove('npm'); remove('npm.cmd')
    remove('npx'); remove('npx.cmd')
    remove('corepack'); remove('corepack.cmd')
    remove('CHANGELOG.md'); remove('README.md')
    remove('share')
  } else {
    remove('include')
    remove(path.join('lib', 'node_modules')) // npm + corepack
    remove(path.join('bin', 'npm'))
    remove(path.join('bin', 'npx'))
    remove(path.join('bin', 'corepack'))
    remove(path.join('share', 'man'))
    remove(path.join('share', 'doc'))
    remove('CHANGELOG.md'); remove('README.md')
  }

  const after = dirSize(nodeDir)
  const afterCount = countFiles(nodeDir)
  log(`node slimmed: ${before} → ${after} bytes (${beforeCount} → ${afterCount} files)`)

  if (after > 150 * 1024 * 1024) {
    throw new Error(`slimmed node still ${after} bytes (> 150MB); stop and re-evaluate architecture`)
  }
  if (after > 110 * 1024 * 1024) {
    log(`WARNING: slimmed node ${after} bytes exceeds the 110MB target (but under 150MB)`)
  }

  const nodeBin = isWin ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')
  if (!fs.existsSync(nodeBin)) throw new Error(`node executable missing after slim: ${nodeBin}`)
  const ver = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim()
  log(`node still runs after slim: ${ver}`)
  return { before, after, beforeCount, afterCount }
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

/**
 * Build the dsh artifact (tar.gz, node excluded) + runtime manifest. The dsh
 * tree is packed with the dependency-free packer so the produced archive is
 * guaranteed to match the unpacker's expectations (long names + relative
 * symlinks). Produces resources/dsh-runtimes/dsh-<version>-<buildId>-<plat>-<arch>.tar.gz
 * and dsh-runtime-manifest.json.
 */
async function buildArtifact() {
  const dshDir = path.join(RESOURCES, 'dsh')
  const pkgPath = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!fs.existsSync(pkgPath)) throw new Error('dsh not installed; run prepareDsh first')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg.bin || !pkg.bin.dsh) throw new Error('dsh package.json missing bin.dsh field')

  const version = pkg.version
  const platform = targetPlatform()
  const arch = targetArch()
  const buildId = computeBuildId(dshDir)
  const entry = ['node_modules', '@deepseek-ai', 'dsh', pkg.bin.dsh].join('/')

  const outDir = path.join(RESOURCES, 'dsh-runtimes')
  fs.mkdirSync(outDir, { recursive: true })
  const archiveName = `dsh-${version}-${buildId}-${platform}-${arch}.tar.gz`
  const archivePath = path.join(outDir, archiveName)

  log(`packing dsh artifact: ${archiveName}`)
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

  const manifestPath = path.join(outDir, 'dsh-runtime-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  log(`artifact: ${archivePath} (${archiveBytes} bytes, sha256=${sha256})`)
  log(`manifest: ${manifestPath}`)
  return { manifest, archivePath }
}

async function main() {
  await prepareNode()
  await prepareDsh()
  // slim Node only after dsh is fully built (npm needs the full runtime)
  slimNode()
  await buildArtifact()
  log('all done ✅')
  const nodeBin = targetPlatform() === 'win32'
    ? path.join(RESOURCES, 'node', 'node.exe')
    : path.join(RESOURCES, 'node', 'bin', 'node')
  log(`  node: ${await runVersion(nodeBin)}`)
  const dshManifest = path.join(RESOURCES, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(dshManifest, 'utf8'))
  log(`  dsh: ${pkg.name}@${pkg.version} bin=${pkg.bin.dsh}`)
}

function runVersion(nodeBin) {
  const out = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim()
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
