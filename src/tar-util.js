'use strict'

/**
 * tar-util — minimal, dependency-free tar.gz pack/unpack used to build dsh
 * runtime artifacts (scripts) and install them (runtime-manager). Written in
 * pure Node with zlib so it runs on any Node version and on all platforms
 * without relying on a system `tar` binary.
 *
 * Security is the priority on unpack: it refuses absolute paths, `..` traversal
 * and symlinks that resolve outside the destination root. The packer is the
 * inverse and is kept in a format this unpacker understands (GNU 'L' longname).
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const BLOCK = 512

// ————————————————————————————————— tar header encode/decode —————————————————

function octal(n, len) {
  const s = n.toString(8)
  if (s.length > len - 1) throw new Error(`octal field overflow: ${n}`)
  return s.padStart(len - 1, '0') + '\0'
}

function checksum(buf) {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : buf[i]
  return sum
}

function writeHeader(name, typeflag, size, linkname, mode) {
  const buf = Buffer.alloc(BLOCK)
  buf.fill(0)
  const nameBuf = Buffer.from(name, 'utf8')
  // name field is 100 bytes; longer names go through the 'L' longname entry
  if (nameBuf.length <= 100) nameBuf.copy(buf, 0)
  buf.write(octal(mode || (typeflag === '5' ? 0o755 : 0o644), 8), 100)
  buf.write(octal(0, 8), 108) // uid
  buf.write(octal(0, 8), 116) // gid
  buf.write(octal(size, 12), 124)
  buf.write(octal(0, 12), 136) // mtime
  buf.write('        ', 148) // chksum placeholder
  buf.write(typeflag, 156)
  if (linkname) {
    const ln = Buffer.from(linkname, 'utf8')
    if (ln.length > 100) throw new Error(`symlink target too long: ${linkname}`)
    ln.copy(buf, 157)
  }
  buf.write('ustar\0', 257)
  buf.write('00', 263)
  const sum = checksum(buf)
  buf.write(octal(sum, 7), 148)
  buf[154] = 0x20
  return buf
}

function writeLongName(name) {
  const data = Buffer.from(name + '\0', 'utf8')
  const header = writeHeader('', 'L', data.length, null, 0o644)
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)
  return Buffer.concat([header, data, padding])
}

function writeData(buf) {
  const padding = Buffer.alloc((BLOCK - (buf.length % BLOCK)) % BLOCK)
  return Buffer.concat([buf, padding])
}

// ————————————————————————————————— pack ————————————————————————————————————

/**
 * Pack a directory into a .tar.gz file. Returns stats (file count + extracted
 * byte size) for the manifest. Symlinks are preserved as relative links; any
 * symlink whose target escapes `srcDir` is rejected at pack time.
 */
function packDirectory(srcDir, outFile) {
  const stream = fs.createWriteStream(outFile)
  const gzip = zlib.createGzip({ level: 3 })
  gzip.pipe(stream)

  let fileCount = 0
  let extractedSize = 0
  const root = path.resolve(srcDir)

  function writeBlock(buf) { gzip.write(buf) }

  function addEntry(relName, typeflag, size, linkname, contentStream) {
    if (typeflag === '0') { fileCount += 1; extractedSize += size }
    if (Buffer.byteLength(relName, 'utf8') > 100) writeBlock(writeLongName(relName))
    writeBlock(writeHeader(relName, typeflag, size, linkname))
    if (contentStream) contentStream()
  }

  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        addEntry(relPath + '/', '5', 0, null)
        walk(abs, relPath)
      } else if (ent.isSymbolicLink()) {
        const target = fs.readlinkSync(abs)
        // reject absolute and escaping symlinks at pack time
        assertSafeLink(abs, target, root)
        addEntry(relPath, '2', 0, target)
      } else if (ent.isFile()) {
        const st = fs.statSync(abs)
        addEntry(relPath, '0', st.size, null, () => {
          gzip.write(fs.readFileSync(abs))
          gzip.write(Buffer.alloc((BLOCK - (st.size % BLOCK)) % BLOCK))
        })
      }
      // ignore sockets/fifos/devices — none expected in a dsh install
    }
  }

  walk(root, '')

  // two zero blocks terminate the archive
  gzip.end(Buffer.alloc(BLOCK * 2))

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve({ fileCount, extractedSize }))
    stream.on('error', reject)
    gzip.on('error', reject)
  })
}

function assertSafeLink(absPath, target, root) {
  if (path.isAbsolute(target)) throw new Error(`absolute symlink target forbidden: ${absPath} -> ${target}`)
  const resolved = path.resolve(path.dirname(absPath), target)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`symlink escapes archive root: ${absPath} -> ${target}`)
  }
}

// ————————————————————————————————— unpack ——————————————————————————————————

/**
 * Unpack a .tar.gz into destDir. Returns stats. Throws on any path traversal,
 * escaping symlink or malformed entry. Supports regular files, directories,
 * relative symlinks and GNU 'L' long names.
 */
function unpackArchive(archivePath, destDir, opts = {}) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(destDir)
    fs.mkdirSync(root, { recursive: true })

    const gunzip = zlib.createGunzip()
    const input = fs.createReadStream(archivePath)
    input.on('error', reject)
    gunzip.on('error', reject)
    input.pipe(gunzip)

    let buf = Buffer.alloc(0)
    let pendingLongName = null
    let fileCount = 0
    let extractedSize = 0
    let sawEnd = false
    let settled = false

    function fail(err) {
      if (settled) return
      settled = true
      input.destroy()
      reject(err)
    }

    function done() {
      if (settled) return
      settled = true
      resolve({ fileCount, extractedSize })
    }

    function resolveDest(name) {
      if (name.length === 0) return root
      if (name.indexOf('\0') !== -1) throw new Error(`NUL byte in path: ${name}`)
      if (path.isAbsolute(name)) throw new Error(`absolute path forbidden: ${name}`)
      const resolved = path.resolve(root, name)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`path escapes archive root: ${name}`)
      }
      return resolved
    }

    function onData(chunk) {
      try {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= BLOCK) {
          const header = buf.slice(0, BLOCK)
          // two zero blocks = end of archive
          if (header.every((b) => b === 0)) {
            sawEnd = true
            break
          }
          const nameField = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '')
          const typeflag = String.fromCharCode(header[156])
          const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0
          const linkname = header.slice(157, 257).toString('utf8').replace(/\0.*$/, '')
          const dataLen = Math.ceil(size / BLOCK) * BLOCK

          // long name entry: next header's data block carries the real name
          if (typeflag === 'L') {
            if (buf.length < BLOCK + dataLen) return
            pendingLongName = buf.slice(BLOCK, BLOCK + size).toString('utf8').replace(/\0.*$/, '')
            buf = buf.slice(BLOCK + dataLen)
            continue
          }

          const name = pendingLongName || nameField

          if (buf.length < BLOCK + dataLen) return
          pendingLongName = null
          const data = buf.slice(BLOCK, BLOCK + dataLen)
          buf = buf.slice(BLOCK + dataLen)

          const dest = resolveDest(name)

          if (typeflag === '5') {
            fs.mkdirSync(dest, { recursive: true })
          } else if (typeflag === '2') {
            assertSafeLink(dest, linkname, root)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            try { fs.symlinkSync(linkname, dest) } catch (e) { /* best effort */ }
          } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            const fd = fs.openSync(dest, 'w')
            try { fs.writeSync(fd, data.slice(0, size)) } finally { fs.closeSync(fd) }
            fileCount += 1
            extractedSize += size
          }
          // other types (long link 'K', pax 'x', etc.) are not produced by our packer
        }
      } catch (e) {
        fail(e)
      }
    }

    gunzip.on('data', onData)
    gunzip.on('end', () => {
      if (settled) return
      if (sawEnd || pendingLongName === null) {
        done()
      } else {
        fail(new Error('truncated archive: missing terminator'))
      }
    })
  })
}

module.exports = {
  packDirectory,
  unpackArchive,
  assertSafeLink,
  // exported for tests that construct malicious archives
  BLOCK,
  writeHeader,
  writeLongName,
  writeData,
}
