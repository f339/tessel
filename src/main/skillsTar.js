// A small reader for the .tar.gz archives GitHub serves (git archive: ustar
// headers, a pax global header carrying the commit, pax or GNU long names).
// Nothing is written to disk here: the entries come back as buffers for
// skillsManager.js to check (paths, links, sizes) before anything is copied.
import zlib from 'node:zlib'

const BLOCK = 512

function text(buf) {
  const end = buf.indexOf(0)
  return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8')
}

// Octal, or base-256 when the first byte has its high bit set (big sizes).
function number(buf) {
  if (buf[0] & 0x80) {
    let value = 0
    for (let i = 1; i < buf.length; i++) value = value * 256 + buf[i]
    return value
  }
  const s = text(buf).trim()
  if (!s) return 0
  if (!/^[0-7]+$/.test(s)) throw new Error('bad tar number') // i18n-ignore internal, replaced by the caller
  return parseInt(s, 8)
}

function checksumOk(header) {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
  return sum === number(header.subarray(148, 156))
}

// "27 path=some/long/name\n" records.
function pax(data) {
  const out = {}
  let off = 0
  while (off < data.length) {
    const space = data.indexOf(0x20, off)
    if (space < 0) break
    const len = parseInt(data.subarray(off, space).toString('utf8'), 10)
    if (!Number.isFinite(len) || len <= 0 || off + len > data.length) break
    const record = data.subarray(space + 1, off + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    off += len
  }
  return out
}

const KIND = { 0: 'file', '': 'file', 7: 'file', 5: 'dir', 1: 'hardlink', 2: 'symlink' }

// -> { entries: [{ path, kind, size, data?, linkname? }], comment }
// kind: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'. `comment` is the
// pax global comment (git archive writes the commit id there).
export function readTar(buf, { maxEntries = 50000 } = {}) {
  const entries = []
  let off = 0
  let next = {} // pax / GNU long-name values for the next entry
  let comment = null
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK)
    if (header.every((b) => b === 0)) break
    if (!checksumOk(header)) throw new Error('bad tar checksum') // i18n-ignore internal, replaced by the caller
    const type = String.fromCharCode(header[156] || 48).replace('\0', '0')
    const size = next.size != null && type !== 'x' && type !== 'g' ? next.size : number(header.subarray(124, 136))
    const start = off + BLOCK
    const end = start + size
    if (end > buf.length) throw new Error('truncated tar') // i18n-ignore internal, replaced by the caller
    const data = buf.subarray(start, end)
    off = start + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'x') {
      const values = pax(data)
      next = { ...next, ...values, size: values.size != null ? Number(values.size) : next.size }
      continue
    }
    if (type === 'g') {
      const values = pax(data)
      if (values.comment) comment = values.comment
      continue
    }
    if (type === 'L') {
      next.path = text(data)
      continue
    }
    if (type === 'K') {
      next.linkpath = text(data)
      continue
    }
    const name = text(header.subarray(0, 100))
    const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? text(header.subarray(345, 500)) : ''
    const path = next.path || (prefix ? `${prefix}/${name}` : name)
    const kind = KIND[type] || 'other'
    const entry = { path, kind, size }
    if (kind === 'file') entry.data = data
    if (kind === 'symlink' || kind === 'hardlink') entry.linkname = next.linkpath || text(header.subarray(157, 257))
    entries.push(entry)
    next = {}
    if (entries.length > maxEntries) throw Object.assign(new Error('too many entries'), { code: 'SKILL_TOO_BIG' }) // i18n-ignore internal, replaced by the caller
  }
  return { entries, comment }
}

// Gunzip with a cap on the unpacked size (a small archive can unpack huge).
export function gunzipCapped(buf, maxBytes) {
  try {
    return zlib.gunzipSync(buf, { maxOutputLength: maxBytes })
  } catch (err) {
    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError))
      throw Object.assign(new Error('archive too large'), { code: 'SKILL_TOO_BIG' }) // i18n-ignore internal, replaced by the caller
    throw err
  }
}
