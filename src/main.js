'use strict'

/**
 * main — app lifecycle, window management, engine/proxy orchestration, security whitelist.
 */

const { app, BrowserWindow, session, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { EngineManager } = require('./engine-manager')
const { AuthProxy } = require('./auth-proxy')
const { migrateLegacyDsh, recordVersion } = require('./migration')
const { initUpdater } = require('./updater')
const { t, pageLang } = require('./i18n')
const {
  getActiveRuntime, ensureRuntime, activateRuntime, markRuntimeHealthy, rollbackRuntime, purgeRuntimeCache,
} = require('./runtime-manager')

// —— 文件日志：打包版双击启动无终端，stdout/stderr 会丢失；落盘到
// userData/logs/main.log（mac: ~/Library/Application Support/dshed/logs，
// win: %APPDATA%/dshed/logs），启动早期（app ready 前）用临时目录兜底。
let logFile = null
let bootLog = []
function writeLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n') } catch (e) { /* ignore */ }
  } else {
    bootLog.push(line)
    if (bootLog.length > 200) bootLog.shift()
  }
}
function initLogFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, 'main.log')
    if (bootLog.length) {
      fs.appendFileSync(logFile, bootLog.join('\n') + '\n')
      bootLog = []
    }
    console.log('[dshed] log file:', logFile)
  } catch (e) { /* ignore */ }
}
const logger = {
  info: (...a) => { console.log('[dshed]', ...a); writeLog('info', a) },
  warn: (...a) => { console.warn('[dshed]', ...a); writeLog('warn', a) },
  error: (...a) => { console.error('[dshed]', ...a); writeLog('error', a) },
}

let engine = null
let proxy = null
let win = null
let tray = null
let quitting = false
let proxyOrigin = null
let proxyToken = null

/** bundled resource base: packaged extraResources (process.resourcesPath) or dev project resources/ */
function resourceBase() {
  if (process.env.HARBOR_RESOURCES) return process.env.HARBOR_RESOURCES
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'node'))) {
    return process.resourcesPath
  }
  return path.join(__dirname, '..', 'resources')
}

/** bundled Node executable (platform-specific layout) */
function resolveBundledNodeBin(base) {
  if (process.platform === 'win32') return path.join(base, 'node', 'node.exe')
  return path.join(base, 'node', 'bin', 'node')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  // macOS: clicking the Dock icon restores / recreates the main window
  app.on('activate', () => showWindow())

  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    shutdown().finally(() => app.quit())
  })

  process.on('uncaughtException', (err) => {
    writeLog('error', ['uncaughtException:', err && err.stack ? err.stack : String(err)])
  })
  process.on('unhandledRejection', (reason) => {
    writeLog('error', ['unhandledRejection:', String(reason)])
  })

  app.whenReady().then(async () => {
    // standalone cache-purge invocation: clean downloads/staging/non-active
    // runtimes only, then exit. Never touches DSH_HOME or user data.
    if (process.argv.includes('--purge-engine-cache')) {
      initLogFile()
      const runtimeRoot = path.join(app.getPath('userData'), 'dsh-runtimes')
      await purgeRuntimeCache({ runtimeRoot, logger })
      logger.info('[dshed] engine cache purged')
      app.exit(0)
      return
    }
    return bootstrap()
  }).catch((err) => {
    logger.error('startup failed:', err)
    showFatalError(err)
  })
}

async function bootstrap() {
  initLogFile()
  // macOS: in dev (unpackaged) mode the Dock icon defaults to Electron's;
  // override with the dshed logo. Packaged builds get the icns from
  // electron-builder, so this is dev-only.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')))
  }

  installTokenInjection()

  const userData = app.getPath('userData')
  const dshHome = path.join(userData, 'dsh')
  // first run: merge legacy dsh CLI user data (~/.dsh); version upgrade hook
  migrateLegacyDsh({ dshHome, logger })
  recordVersion({
    userData,
    version: app.getVersion(),
    logger,
    onUpgrade: ({ prevVersion, version }) => {
      logger.info(`[dshed] upgrade hook: ${prevVersion} → ${version} (no migrations yet)`)
    },
  })

  const runtimeRoot = path.join(userData, 'dsh-runtimes')
  const nodeBin = resolveBundledNodeBin(resourceBase())
  const dshPort = await startEngineWithRuntime({ nodeBin, runtimeRoot, dshHome })

  await startProxy(dshPort)
  createWindow()
  if (!process.env.HARBOR_E2E) createTray()
  initUpdater({ logger })
}

/**
 * Resolve a runnable dsh runtime (active, or install the bundled local
 * artifact on first run), start it and health-check it. A pending runtime that
 * fails to start triggers rollback to the previous known-good runtime; if that
 * also fails the error propagates to showFatalError.
 */
async function startEngineWithRuntime({ nodeBin, runtimeRoot, dshHome }) {
  const rt = await resolveRuntime({ runtimeRoot, nodeBin })
  try {
    engine = createEngine(nodeBin, path.join(rt.runtimeDir, rt.entry), dshHome)
    const port = await engine.start()
    markRuntimeHealthy({ runtimeRoot, runtimeId: rt.runtimeId, logger })
    return port
  } catch (err) {
    logger.error(`[dshed] runtime ${rt.runtimeId} failed to start, rolling back: ${err.message}`)
    if (engine) await engine.stop().catch(() => {})
    const prev = rollbackRuntime({ runtimeRoot, logger })
    if (!prev) throw err
    engine = createEngine(nodeBin, path.join(prev.runtimeDir, prev.entry), dshHome)
    const port = await engine.start()
    markRuntimeHealthy({ runtimeRoot, runtimeId: prev.runtimeId, logger })
    logger.info(`[dshed] rolled back to ${prev.runtimeId}`)
    return port
  }
}

/** Resolve active runtime, or install the bundled local artifact on first run */
async function resolveRuntime({ runtimeRoot, nodeBin }) {
  const active = getActiveRuntime({ runtimeRoot, logger })
  if (active) {
    return { runtimeId: active.runtimeId, runtimeDir: active.runtimeDir, entry: active.entry }
  }
  const base = resourceBase()
  const manifestPath = path.join(base, 'dsh-runtimes', 'dsh-runtime-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const archivePath = path.join(base, 'dsh-runtimes', manifest.archive)
  const installed = await ensureRuntime({
    runtimeRoot, manifest, archivePath, platform: process.platform, arch: process.arch, logger,
  })
  const pending = activateRuntime({ runtimeRoot, runtimeId: installed.runtimeId, logger })
  return { runtimeId: pending.runtimeId, runtimeDir: pending.runtimeDir, entry: pending.entry }
}

/** Build an EngineManager with explicit paths and wire crash/restart events */
function createEngine(nodeBin, dshBin, dshHome) {
  const em = new EngineManager({ nodeBin, dshBin, dshHome, logger })
  em.on('crash-loop', () => {
    logger.error('[dshed] engine crash loop, showing error page')
    if (win) win.loadFile(path.join(__dirname, 'assets', 'error.html'), { query: { reason: 'crash-loop', lang: pageLang() } })
  })
  em.on('restarted', async (port) => {
    logger.info(`[dshed] engine restarted on port ${port}, reconnecting proxy`)
    await restartProxy(port)
  })
  em.on('restart-failed', (err) => {
    logger.error('[dshed] engine restart failed:', err.message)
    if (win) win.loadFile(path.join(__dirname, 'assets', 'error.html'), { query: { reason: 'restart-failed', lang: pageLang() } })
  })
  return em
}

async function startProxy(dshPort) {
  proxy = new AuthProxy(dshPort, { logger })
  const port = await proxy.start()
  proxyOrigin = `http://127.0.0.1:${port}`
  proxyToken = proxy.token
}

async function restartProxy(dshPort) {
  const old = proxy
  proxy = null
  if (old) await old.stop().catch(() => {})
  await startProxy(dshPort)
  if (win && !win.isDestroyed()) win.loadURL(`${proxyOrigin}/`).catch(() => {})
}

function installTokenInjection() {
  // inject token only for the proxy origin; never leak via redirects to external URLs
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    if (proxyOrigin && details.url.startsWith(`${proxyOrigin}/`)) {
      headers['X-dshed-Token'] = proxyToken
    }
    callback({ requestHeaders: headers })
  })
}

function createTray() {
  logger.info('[dshed] creating tray icon…')
  // macOS requires RGBA PNGs — Electron 43 does not render template or
  // alpha-less tray images; use the colored brand image on every platform.
  // The @2x variant is picked up automatically.
  const tImg = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
  logger.info('[dshed] tray image loaded:', JSON.stringify(tImg.getSize()), 'empty=', tImg.isEmpty())
  tray = new Tray(tImg)
  tray.setToolTip(t('tray.tooltip'))
  const menu = Menu.buildFromTemplate([
    { label: t('tray.show'), click: () => showWindow() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => quitFromTray() },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showWindow())
  logger.info('[dshed] tray created')
}

function quitFromTray() {
  quitting = true
  shutdown().finally(() => app.quit())
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function isAllowed(url) {
  return proxyOrigin && url.startsWith(`${proxyOrigin}/`)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.loadFile(path.join(__dirname, 'assets', 'loading.html'), { query: { lang: pageLang() } })
  win.once('ready-to-show', () => win.show())

  // security whitelist: only the proxy origin is allowed
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowed(url)) {
      logger.warn(`[dshed] navigation blocked: ${url}`)
      e.preventDefault()
    }
  })
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAllowed(url)) {
      logger.warn(`[dshed] redirect blocked: ${url}`)
      e.preventDefault()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false))

  // platform habit: macOS hides to tray on close (app stays resident);
  // Windows/Linux quit on close
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { win = null })

  // load the proxy once the engine is ready (called after startProxy)
  win.loadURL(`${proxyOrigin}/`).catch((err) => {
    logger.error('[dshed] failed to load proxy:', err.message)
    win.loadFile(path.join(__dirname, 'assets', 'error.html'), { query: { reason: 'load-failed', lang: pageLang() } })
  })

  // HARBOR_E2E: automated verification mode — check render results then exit
  if (process.env.HARBOR_E2E) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // real POST from the page (webRequest token injection + proxy forward), verifies the API path
          let apiStatus = null
          try {
            const r = await win.webContents.executeJavaScript(`fetch('/api/host.describe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-api', method: 'host.describe', payload: {} })
            }).then(res => res.status)`)
            apiStatus = r
          } catch (e) { /* page-script failure must not fail e2e */ }
          const info = await win.webContents.executeJavaScript(`(() => ({
            title: document.title,
            boot: !!window.__DSH_BOOT__,
            bodyText: (document.body ? document.body.innerText : '').slice(0, 200),
            apiStatus: window.__DSH_API_STATUS__ || null,
          }))()`)
          console.log('[e2e]', JSON.stringify({ ...info, apiStatus }))
        } catch (e) {
          console.log('[e2e] error:', e.message)
        }
        shutdown().finally(() => app.exit(0))
      }, 6000)
    })
  }
}

function showFatalError(err) {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, 'assets', 'error.html'), { query: { reason: encodeURIComponent(err.message), lang: pageLang() } })
    win.show()
    return
  }
  // startup failed before the main window existed (e.g. archive missing,
  // extraction failed, or both runtimes failed to start): create a minimal
  // error window so the user is not left with a silent, invisible failure.
  win = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(path.join(__dirname, 'assets', 'error.html'), { query: { reason: encodeURIComponent(err.message), lang: pageLang() } })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
}

async function shutdown() {
  logger.info('[dshed] shutting down…')
  if (proxy) { await proxy.stop().catch(() => {}); proxy = null }
  if (engine) { await engine.stop().catch(() => {}); engine = null }
}
