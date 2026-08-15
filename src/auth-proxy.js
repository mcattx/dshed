'use strict'

/**
 * auth-proxy — local reverse proxy (the security boundary).
 *
 * BrowserWindow talks only to the proxy, never to dsh directly. The proxy:
 *  - validates X-dshed-Token (HTTP) + Origin (WS upgrade; browsers always
 *    send it and it cannot be forged)
 *  - rewrites Host to the real dsh address (dsh's browser-trust fence checks
 *    Host, see P6)
 *  - tunnels HTTP/SSE/WS transparently
 *
 * Threat model (accepted after two review rounds): defends against remote web
 * pages / DNS rebinding / CSRF / ordinary local programs; does NOT claim to
 * stop same-user privileged malware (that needs dsh native token or an OS
 * sandbox).
 */

const http = require('node:http')
const crypto = require('node:crypto')
const { WebSocketServer, WebSocket } = require('ws')

// hop-by-hop headers to strip when forwarding
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

class AuthProxy {
  /**
   * @param {number} targetPort the real port dsh listens on
   * @param {object} opts { logger }
   */
  constructor(targetPort, { logger } = {}) {
    this.targetPort = targetPort
    this.logger = logger || { info: () => {}, error: () => {} }
    this.token = crypto.randomBytes(32).toString('hex')
    this.port = null
    this.server = null
    this.wss = null
  }

  /** Start the proxy, resolves with the listening port */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res))
      this.wss = new WebSocketServer({ noServer: true })
      this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
      this.server.on('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        this.logger.info(`[proxy] listening 127.0.0.1:${this.port} → dsh:${this.targetPort}`)
        resolve(this.port)
      })
    })
  }

  async stop() {
    if (this.wss) { for (const c of this.wss.clients) c.terminate(); this.wss.close() }
    if (this.server) {
      // with keep-alive/SSE the close callback never fires; must disconnect first (Node 18.2+)
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections()
      await new Promise((r) => this.server.close(r))
    }
  }

  _origin() {
    return `http://127.0.0.1:${this.port}`
  }

  /** HTTP auth: token is the gate */
  _authorizedHttp(req) {
    return req.headers['x-dshed-token'] === this.token
  }

  /** WS auth: Origin must equal the proxy origin (browser-enforced, unforgeable); token also checked when injected via webRequest */
  _authorizedWs(req) {
    const origin = req.headers['origin']
    const token = req.headers['x-dshed-token']
    this.logger.info(`[proxy] WS handshake check url=${req.url} origin=${origin} token=${token ? 'present' : 'absent'}`)
    if (origin && origin !== this._origin()) return false
    if (token !== undefined && token !== this.token) return false
    return true
  }

  _handleRequest(req, res) {
    if (!this._authorizedHttp(req)) {
      this.logger.error(`[proxy] rejecting unauthenticated HTTP ${req.method} ${req.url}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    this._forwardHttp(req, res)
  }

  _forwardHttp(req, res) {
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      if (k.toLowerCase() === 'content-length') continue // handled by chunked
      headers[k] = v
    }
    headers.host = `127.0.0.1:${this.targetPort}`
    // dsh enforces a CSRF Origin check on POST (mutations): Origin must be dsh's
    // own origin or it returns 403 forbidden. The browser's Origin is the proxy
    // origin, so rewrite it to dsh's when forwarding (the security boundary stays
    // in dshed's token auth; the WS path is untouched — its Origin check is
    // dshed's own WS auth loop)
    if (headers.origin) headers.origin = `http://127.0.0.1:${this.targetPort}`

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      this.logger.error(`[proxy] forward failed: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad gateway')
      } else {
        res.end()
      }
    })

    req.pipe(proxyReq)
  }

  _handleUpgrade(req, socket, head) {
    if (!this._authorizedWs(req)) {
      this.logger.error(`[proxy] rejecting unauthenticated WS upgrade ${req.url}`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (clientWs) => {
      this._bridgeWs(clientWs, req.url)
    })
  }

  _bridgeWs(clientWs, url) {
    const targetWs = new WebSocket(`ws://127.0.0.1:${this.targetPort}${url}`)
    const closeTarget = () => {
      // terminating while CONNECTING triggers a "closed before established" false positive; log first, then destroy
      if (targetWs.readyState === WebSocket.OPEN) targetWs.close()
      else if (targetWs.readyState !== WebSocket.CLOSED && targetWs.readyState !== WebSocket.CLOSING) targetWs.terminate()
    }
    clientWs.on('message', (data, isBinary) => targetWs.send(data, { binary: isBinary }))
    targetWs.on('message', (data, isBinary) => clientWs.send(data, { binary: isBinary }))
    clientWs.on('close', () => closeTarget())
    targetWs.on('open', () => this.logger.info(`[proxy] WS bridge up: ${url}`))
    targetWs.on('close', () => { try { clientWs.close() } catch (e) { /* ignore */ } })
    targetWs.on('error', (err) => {
      // closing at CLOSING/CLOSED fires a spurious error (known ws behavior); not a failure
      if (targetWs.readyState === WebSocket.CLOSING || targetWs.readyState === WebSocket.CLOSED) return
      this.logger.error(`[proxy] WS target connect failed: ${err.message} url=${url} state=${targetWs.readyState}`)
      closeTarget()
    })
  }
}

module.exports = { AuthProxy }
