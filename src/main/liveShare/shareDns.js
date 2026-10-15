// Finding a Live Share address (a new trycloudflare.com name): the system's
// lookup first; a name it cannot find through public DNS instead. A home
// router's DNS can keep the "no such name" of a try made a moment too early
// (or not know trycloudflare.com's new names at all) for minutes, while the
// tunnel works for everyone else. The connection itself is unchanged: TLS
// still checks the certificate for that name.
import dns from 'dns'

export const PUBLIC_DNS = ['1.1.1.1', '1.0.0.1', '8.8.8.8']

// A lookup(hostname, options, callback) for http/ws requests (net.connect's).
export function fallbackLookup({ systemLookup = dns.lookup, makeResolver = () => new dns.Resolver({ timeout: 3000, tries: 1 }) } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const opts = typeof options === 'number' ? { family: options } : options || {}
    systemLookup(hostname, opts, (err, address, family) => {
      if (!err) return callback(null, address, family)
      let resolver
      try {
        resolver = makeResolver()
        resolver.setServers(PUBLIC_DNS)
      } catch {
        return callback(err)
      }
      const finish = (list) => {
        if (!list.length) return callback(err)
        if (opts.all) return callback(null, list)
        callback(null, list[0].address, list[0].family)
      }
      resolver.resolve4(hostname, (e4, v4) => {
        const list4 = !e4 && Array.isArray(v4) ? v4.map((a) => ({ address: a, family: 4 })) : []
        if (list4.length || opts.family === 4) return finish(list4)
        resolver.resolve6(hostname, (e6, v6) => finish(!e6 && Array.isArray(v6) ? v6.map((a) => ({ address: a, family: 6 })) : []))
      })
    })
  }
}
