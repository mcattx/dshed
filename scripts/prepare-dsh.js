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

const NODE_VERSION = 'v22.23.2'
const DSH_PKG = '@deepseek-ai/dsh@0.1.0-rc.6'
const ROOT = path.join(__dirname, '..')
const RESOURCES = process.env.HARBOR_RESOURCES || path.join(ROOT, 'resources')
const CACHE = process.env.HARBOR_CACHE || path.join(RESOURCES, 'cache')

function log(msg) { console.log(`[prepare] ${msg}`) }

/** Target platform: HARBOR_TARGET_ARCH wins for cross-prep, otherwise current platform */
function targetPlatform() {
  const env = process.env.HARBOR_TARGET_ARCH
  if (env) return env.split('-')[0]
  return process.platform
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
  execFileSync('tar', ['-xf', tarball, '-C', tmp], { stdio: 'inherit' })

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
    npmCli, 'install', DSH_PKG, '--omit=dev', '--no-audit', '--no-fund', '--registry', registry,
  ], { cwd: dshDir, stdio: 'inherit', env })
  log('dsh installed')
}

async function main() {
  await prepareNode()
  await prepareDsh()
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
