/**
 * afterSign: ad-hoc sign the bundled Node runtime and its native modules
 * under extraResources.
 *
 * NOTE: this project deliberately does NOT use any company / third-party
 * developer certificate (mac.identity: null). Everything is ad-hoc signed
 * with `--sign -` (no certificate required, anyone can do it):
 *  - keeps Mach-O binaries signed (hardened-runtime / system checks friendly);
 *  - does NOT re-sign the main app (unsigned app, no Seal invalidation).
 * If a personal Developer ID certificate is configured later: set it in
 * electron-builder.yml under mac.identity and re-sign the main app here
 * with the same identity.
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function afterSign(context) {
  const { appOutDir, packager } = context
  const appName = packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')

  // Walk Resources for Mach-O executables / dylibs (node, native modules, etc.)
  const toSign = []
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const head = fs.readFileSync(full)
        if (head.length > 4 && head.slice(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
          toSign.push(full)
        }
      }
    }
  }
  walk(resourcesDir)

  for (const file of toSign) {
    execSync(`codesign --force --sign - "${file}"`, { stdio: 'pipe' })
  }
  console.log(`[afterSign] ad-hoc signed ${toSign.length} Mach-O binaries under Resources/`)
}
