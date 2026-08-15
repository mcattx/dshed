'use strict'

/**
 * i18n — minimal user-facing strings for dshed's own UI.
 *
 * The dsh engine UI has its own language switcher; this covers only dshed's
 * own surfaces: loading page, error page, tray menu, update dialog.
 *
 * Selection order: HARBOR_LANG (zh|en) env override → system locale → en.
 */

function currentLang(app) {
  const env = process.env.HARBOR_LANG
  if (env === 'zh' || env === 'en') return env
  const sys = (app && app.getLocale ? app.getLocale() : '').toLowerCase()
  return sys.startsWith('zh') ? 'zh' : 'en'
}

const strings = {
  zh: {
    'tray.show': '显示 dshed',
    'tray.quit': '退出',
    'tray.tooltip': 'dshed',
    'update.title': 'dshed 更新',
    'update.message': (v) => `新版本 ${v} 已就绪`,
    'update.detail': '重启应用以完成安装。',
    'update.restart': '立即重启',
    'update.later': '稍后',
  },
  en: {
    'tray.show': 'Show dshed',
    'tray.quit': 'Quit',
    'tray.tooltip': 'dshed',
    'update.title': 'dshed Update',
    'update.message': (v) => `Version ${v} is ready`,
    'update.detail': 'Restart the app to finish installing.',
    'update.restart': 'Restart now',
    'update.later': 'Later',
  },
}

/** Get a string for the current language. */
function t(key, ...args) {
  const table = strings[currentLang(require('electron').app)]
  const fn = table[key]
  return typeof fn === 'function' ? fn(...args) : fn
}

/** Resolve the language tag ('zh' | 'en') for a renderer page. */
function pageLang() {
  return currentLang(require('electron').app)
}

module.exports = { t, pageLang, currentLang }
