'use strict'

/**
 * updater — auto-update (skeleton).
 *
 * Enabled only for packaged builds (app.isPackaged); skipped in dev mode.
 * Strategy: background check → silently download when a new version exists →
 * prompt to restart on completion (never forced).
 * Channel: GitHub Releases (publish config in electron-builder.yml).
 */

const { autoUpdater } = require('electron-updater')
const { dialog, app } = require('electron')
const { t } = require('./i18n')

let initialized = false

/**
 * Initialize auto-update.
 * @param {object} opts { logger }
 */
function initUpdater({ logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }

  if (!app.isPackaged) {
    log.info('[updater] dev mode, auto-update skipped')
    return
  }
  if (initialized) return
  initialized = true

  autoUpdater.logger = {
    info: (msg) => log.info('[updater] ' + msg),
    warn: (msg) => log.warn('[updater] ' + msg),
    error: (msg) => log.error('[updater] ' + msg),
  }
  // download in background; prompt to restart when done
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => log.info('[updater] checking for updates…'))
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] new version ${info.version} found, downloading`)
  })
  autoUpdater.on('update-not-available', () => log.info('[updater] already up to date'))
  autoUpdater.on('error', (err) => log.warn(`[updater] check failed: ${err.message}`))

  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[updater] new version ${info.version} downloaded`)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: t('update.title'),
      message: t('update.message', info.version),
      detail: t('update.detail'),
      buttons: [t('update.restart'), t('update.later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall())
    }
  })

  // check 8s after launch, avoid competing with engine startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log.warn(`[updater] check error: ${err.message}`))
  }, 8000)
}

module.exports = { initUpdater }
