// Live Share: "Open this address in my own browser" on a host's page a guest
// watches (LiveSharePageView.vue). The address the guest has is the one the
// host's Tessel shows guests (liveShare/sharePages.js shownPageUrl: scheme,
// host and path, a secret-looking segment as ••••, the query and fragment as
// ?… and #…). What opens is its origin and path, http(s) only, with no user
// or password: never a host's cookie or session, only the address. A path
// with a masked segment opens at the site's root (the real one is not known
// here). An address that only works on the host's computer or network (this
// computer, a private range, a .local or single-label name) does not open.
//
// Pure: no DOM, no Electron.

const MASK = '••••'
// Names that only mean something on the host's network.
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.intranet', '.home.arpa', '.corp']

function ipv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

// A host name (as URL gives it: lowercase, IPv6 in brackets) that only works
// on the host's computer or its network.
export function localOnlyHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1)
    if (v6 === '::' || v6 === '::1') return true
    // fc00::/7 (unique local), fe80::/10 (link local)
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)) return true
    // ::ffff:a.b.c.d (or its hex form): the IPv4 address it maps.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return localOnlyHost(mapped[1])
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return localOnlyHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  // A single-label name (intranet, nas): the host's network's.
  return !host.includes('.')
}

// The address as a guest sees it -> { ok: true, url } (what opens) |
// { ok: false, reason: 'scheme' | 'local' | 'invalid' }.
export function externalPageUrl(shown) {
  let s = typeof shown === 'string' ? shown.trim() : ''
  // The masked query and fragment are not part of it.
  s = s.replace(/[?#].*$/s, '')
  if (!s || s.length > 4000) return { ok: false, reason: 'invalid' }
  let url
  try {
    url = new URL(s)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (localOnlyHost(url.hostname)) return { ok: false, reason: 'local' }
  let path = url.pathname || '/'
  let decoded
  try {
    decoded = decodeURIComponent(path)
  } catch {
    decoded = path
  }
  if (decoded.includes(MASK) || decoded.includes('…')) path = '/'
  // url.origin never has the user or the password.
  return { ok: true, url: `${url.origin}${path}` }
}
