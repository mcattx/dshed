'use strict'

/**
 * preload — minimal bridge: exposes only allowlisted info.
 * No arbitrary IPC / Node / shell capabilities.
 */

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dshed', {
  version: '0.1.0',
  platform: process.platform,
})
