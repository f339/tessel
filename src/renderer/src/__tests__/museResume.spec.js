// A Muse Code pane resumed: `muse resume <id>`, the subcommand right after
// the program and before the options its command has (Muse takes no option
// ahead of a subcommand), only once the main process says its log exists.
import { describe, it, expect, vi } from 'vitest'
import { resumeArgs, resumeLine, OWN_ID_AGENTS, FOUND_IN_FILES } from '../agentResumeLine'

const U = '019a1b2c-3d4e-7f80-9123-456789abcdef'
const api = (target) => ({ agentResumeTarget: vi.fn().mockResolvedValue(target) })

describe('resuming a Muse Code pane', () => {
  it('found in its files (or reported by its hooks), checked first', async () => {
    expect(OWN_ID_AGENTS).toContain('muse')
    expect(FOUND_IN_FILES).toContain('muse')
    const check = api({})
    expect(await resumeArgs('muse', U, check)).toEqual(['resume', U])
    expect(check.agentResumeTarget).toHaveBeenCalledWith({ agent: 'muse', sessionId: U })
    expect(await resumeArgs('muse', U, api(null))).toBe(null)
  })
  it('the subcommand goes right after the program, its options after it', () => {
    expect(resumeLine('muse', 'muse --trust-workspace', ['resume', U])).toBe(`muse resume ${U} --trust-workspace`)
    expect(resumeLine('muse', '"C:\\Users\\me\\AppData\\Local\\Programs\\muse\\muse.cmd" --trust-workspace', ['resume', U])).toBe(
      `"C:\\Users\\me\\AppData\\Local\\Programs\\muse\\muse.cmd" resume ${U} --trust-workspace`
    )
    expect(resumeLine('muse', '& "C:\\Program Files\\Muse\\muse.exe" --trust-workspace', ['resume', U])).toBe(`& "C:\\Program Files\\Muse\\muse.exe" resume ${U} --trust-workspace`)
    expect(resumeLine('muse', 'muse', ['resume', U])).toBe(`muse resume ${U}`)
    // The other agents: after the whole command, as before.
    expect(resumeLine('droid', 'droid --auto high', ['--resume', U])).toBe(`droid --auto high --resume ${U}`)
  })
})
