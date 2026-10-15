// Windows PowerShell's default script policy (Restricted) and Tessel's panes:
// RemoteSigned for the pane's own process, only when nobody chose a policy.
import { describe, it, expect } from 'vitest'
import { onlyTheDefault, readDefaultPolicy, relaxShell, RELAXED_ARGS } from '../psPolicy'

describe('the script policy Tessel may relax for its panes', () => {
  it('only Windows\' default: Restricted with no group policy', () => {
    expect(onlyTheDefault('Restricted|Undefined|Undefined\r\n')).toBe(true)
    // Someone chose: left as it is.
    expect(onlyTheDefault('AllSigned|Undefined|Undefined')).toBe(false)
    expect(onlyTheDefault('RemoteSigned|Undefined|Undefined')).toBe(false)
    expect(onlyTheDefault('Bypass|Undefined|Undefined')).toBe(false)
    // A group policy (company PC): never worked around.
    expect(onlyTheDefault('Restricted|Restricted|Undefined')).toBe(false)
    expect(onlyTheDefault('Restricted|Undefined|AllSigned')).toBe(false)
    expect(onlyTheDefault('')).toBe(false)
    expect(onlyTheDefault(null)).toBe(false)
  })

  it('read with Windows PowerShell; an error or a slow answer relaxes nothing', async () => {
    if (process.platform !== 'win32') return
    let called = null
    const ok = await readDefaultPolicy({
      execFileImpl: (exe, args, opts, cb) => {
        called = { exe, args, opts }
        cb(null, 'Restricted|Undefined|Undefined\r\n')
      }
    })
    expect(ok).toBe(true)
    expect(called.exe).toBe('powershell.exe')
    expect(called.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(called.args[3]).toContain('Get-ExecutionPolicy -Scope MachinePolicy')
    expect(called.opts).toMatchObject({ windowsHide: true })
    expect(await readDefaultPolicy({ execFileImpl: (_e, _a, _o, cb) => cb(new Error('timeout'), '') })).toBe(false)
    expect(
      await readDefaultPolicy({
        execFileImpl: () => {
          throw new Error('no powershell')
        }
      })
    ).toBe(false)
  })

  it('Windows PowerShell\'s panes get RemoteSigned for themselves, once; no other shell', () => {
    const ps = { id: 'powershell', args: ['-NoLogo'] }
    expect(relaxShell(ps)).toBe(true)
    expect(ps.args).toEqual(['-NoLogo', ...RELAXED_ARGS])
    expect(RELAXED_ARGS).toEqual(['-ExecutionPolicy', 'RemoteSigned'])
    expect(relaxShell(ps)).toBe(false)
    expect(ps.args).toHaveLength(3)
    for (const other of [{ id: 'pwsh', args: ['-NoLogo'] }, { id: 'cmd', args: [] }, null]) {
      expect(relaxShell(other)).toBe(false)
    }
    expect(relaxShell({ id: 'powershell', args: ['-ExecutionPolicy', 'AllSigned'] })).toBe(false)
  })
})
