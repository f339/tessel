// How each agent installs on an SSH host (remoteAgentInstalls.js), chosen
// from what the host's check found there: the vendor's own installer, else
// its npm package (npm's folder when it is yours, else ~/.local; Node.js
// with nvm first when npm is missing or too old), else its install page.
import { describe, expect, it } from 'vitest'
import { HOST_INSTALLERS, NO_NODE_INSTALLERS, npmPackageOf, remoteInstallLine, remoteInstallPlan } from '../remoteAgentInstalls'
import { NVM_INSTALL_URL } from '../shellChain'
import { onAllowedDomain } from '../../../main/agentInstalls'

// A Linux host as its check describes it.
const host = (over = {}) => ({ node: '/usr/bin/node', nodeMajor: 22, npm: '/usr/bin/npm', npmPrefix: '/usr', npmWritable: false, snap: null, curl: '/usr/bin/curl', wget: null, os: 'Linux', ...over })
const gemini = { id: 'gemini', install: ['npm install -g @google/gemini-cli'] }

describe("each vendor's own installer", () => {
  it('Antigravity: its official script (to ~/.local/bin/agy), never sudo; snap only offered as a second choice where the host has snap', () => {
    const plain = remoteInstallPlan({ id: 'antigravity', install: ['irm https://antigravity.google/cli/install.ps1 | iex'] }, host())
    expect(plain).toEqual({ command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', source: 'https://antigravity.google/docs/getting-started', node: false, sudo: false, alt: null })
    const withSnap = remoteInstallPlan({ id: 'antigravity' }, host({ snap: '/usr/bin/snap' }))
    expect(withSnap.command).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash')
    expect(withSnap.alt).toEqual({ command: 'sudo snap install antigravity-cli', snap: 'antigravity-cli' })
  })

  it('Claude Code: its native installer even where npm is there', () => {
    expect(remoteInstallPlan({ id: 'claude', install: ['npm install -g @anthropic-ai/claude-code'] }, host({ npmWritable: true })).command).toBe('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('downloaded with wget when the host has no curl; neither: said, nothing to run', () => {
    expect(remoteInstallPlan({ id: 'kimi' }, host({ curl: null, wget: '/usr/bin/wget' })).command).toBe('wget -qO- https://code.kimi.com/kimi-code/install.sh | bash')
    expect(remoteInstallPlan({ id: 'kimi' }, host({ curl: null, wget: null }))).toEqual({ error: 'no-download' })
    expect(remoteInstallPlan(gemini, host({ npm: null, curl: null, wget: null }))).toEqual({ error: 'no-download' })
  })

  it('goose without its setup questions; Ollama asks for sudo, and only on Linux', () => {
    expect(remoteInstallPlan({ id: 'goose' }, host()).command).toBe('curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash')
    expect(remoteInstallPlan({ id: 'ollama', install: ['winget install --id Ollama.Ollama -e'] }, host())).toMatchObject({ command: 'curl -fsSL https://ollama.com/install.sh | sh', sudo: true })
    // On macOS: its app's page (not a Linux script).
    expect(remoteInstallPlan({ id: 'ollama', install: ['winget install --id Ollama.Ollama -e'], docsUrl: null }, host({ os: 'Darwin' }))).toBe(null)
  })

  it('every script is https, from its vendor, run by bash or sh, with no sudo inside the line', () => {
    for (const [id, inst] of Object.entries({ ...HOST_INSTALLERS, ...NO_NODE_INSTALLERS })) {
      expect(onAllowedDomain(inst.url, inst.domains), id).toBe(true)
      expect(['bash', 'sh'], id).toContain(inst.run)
      expect(inst.source.startsWith('https://'), id).toBe(true)
      expect(inst.url, id).not.toMatch(/\s|'|"|\$/)
      const plan = remoteInstallPlan(id === 'codex' ? { id, install: ['npm install -g @openai/codex'] } : { id }, host({ npm: null }))
      expect(plan.command, id).not.toMatch(/\bsudo\b/)
    }
  })
})

describe('npm packages', () => {
  it("npm's folder is the user's (nvm, a prefix of their own): a plain npm install -g", () => {
    expect(remoteInstallPlan(gemini, host({ npm: '/usr/local/bin/npm', npmWritable: true }))).toEqual({
      command: 'npm install -g @google/gemini-cli',
      source: 'https://www.npmjs.com/package/@google/gemini-cli',
      node: false,
      sudo: false,
      alt: null
    })
  })

  // Found on a server: `npm install -g @openai/codex` failed with EACCES on
  // mkdir '/usr/local/lib/node_modules' (a global npm folder owned by root).
  it("npm's folder is root's: into ~/.local (its command in ~/.local/bin), never sudo", () => {
    expect(remoteInstallPlan(gemini, host()).command).toBe('npm install -g --prefix "$HOME/.local" @google/gemini-cli')
    expect(remoteInstallPlan({ id: 'codex', install: ['npm install -g @openai/codex'] }, host()).command).toBe('npm install -g --prefix "$HOME/.local" @openai/codex')
    // Not known (an older check): the same safe choice.
    expect(remoteInstallPlan(gemini, null).command).toBe('npm install -g --prefix "$HOME/.local" @google/gemini-cli')
    expect(remoteInstallPlan(gemini, host({ npmWritable: null })).command).toContain('--prefix "$HOME/.local"')
  })

  it('npm found outside the usual folders (nvm not loaded by this shell): its folder first on PATH', () => {
    const npm = '/home/u/.nvm/versions/node/v22.11.0/bin/npm'
    expect(remoteInstallPlan(gemini, host({ npm, npmWritable: true })).command).toBe(
      'export PATH=\'/home/u/.nvm/versions/node/v22.11.0/bin\':"$PATH" && npm install -g @google/gemini-cli'
    )
    // A folder that cannot be quoted safely: no PATH of its own.
    expect(remoteInstallPlan(gemini, host({ npm: "/home/it's/bin/npm", npmWritable: true })).command).toBe('npm install -g @google/gemini-cli')
  })

  it('no npm on the host: Node.js LTS with nvm first (in the home folder), then a plain npm install -g', () => {
    const plan = remoteInstallPlan(gemini, host({ node: null, nodeMajor: null, npm: null }))
    expect(plan.node).toBe(true)
    expect(plan.command).toBe(
      `export NVM_DIR="$HOME/.nvm" && { [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL ${NVM_INSTALL_URL} | bash; } && . "$NVM_DIR/nvm.sh" && nvm install --lts && npm install -g @google/gemini-cli`
    )
    expect(plan.command).not.toMatch(/\bsudo\b/)
    // nvm itself with wget when there is no curl.
    expect(remoteInstallPlan(gemini, host({ npm: null, curl: null, wget: '/usr/bin/wget' })).command).toContain(`wget -qO- ${NVM_INSTALL_URL} | bash`)
  })

  it("a Node.js too old for the agent: nvm's Node.js; old enough: npm as it is", () => {
    expect(remoteInstallPlan(gemini, host({ nodeMajor: 18 })).node).toBe(true)
    expect(remoteInstallPlan({ id: 'copilot', install: ['npm install -g @github/copilot'] }, host({ nodeMajor: 20 })).node).toBe(true)
    expect(remoteInstallPlan({ id: 'crush', install: ['npm install -g @charmland/crush'] }, host({ nodeMajor: 18 })).node).toBe(false)
  })

  it("Codex without npm: OpenAI's standalone installer (no Node.js needed)", () => {
    expect(remoteInstallPlan({ id: 'codex', install: ['npm install -g @openai/codex'] }, host({ npm: null }))).toEqual({
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      source: 'https://github.com/openai/codex',
      node: false,
      sudo: false,
      alt: null
    })
  })

  it("the package this computer installs (its flags kept), Auggie's for a host, the agent's own source page", () => {
    expect(npmPackageOf({ id: 'pi', install: ['npm install -g --ignore-scripts @earendil-works/pi-coding-agent'] })).toEqual({ pkg: '@earendil-works/pi-coding-agent', flags: '--ignore-scripts ' })
    expect(remoteInstallPlan({ id: 'pi', install: ['npm install -g --ignore-scripts @earendil-works/pi-coding-agent'] }, host({ npmWritable: true })).command).toBe('npm install -g --ignore-scripts @earendil-works/pi-coding-agent')
    expect(remoteInstallPlan({ id: 'auggie', docsUrl: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli' }, host({ npmWritable: true })).command).toBe('npm install -g @augmentcode/auggie')
    expect(remoteInstallPlan({ id: 'openclaude', install: ['npm install -g @gitlawb/openclaude'], installSource: 'https://github.com/Gitlawb/openclaude' }, host()).source).toBe('https://github.com/Gitlawb/openclaude')
    // Only a plain npm install is taken as one.
    expect(npmPackageOf({ id: 'x', install: ['npm install -g a && rm -rf ~'] })).toBe(null)
    expect(npmPackageOf({ id: 'x', install: ['npm install -g a', 'npm install -g b'] })).toBe(null)
  })
})

describe('no automatic install known', () => {
  it('its install page (OpenCode 2: its package would clash with OpenCode); your own agents: nothing', () => {
    expect(remoteInstallPlan({ id: 'opencode2', docsUrl: 'https://opencode.ai/v2/docs/' }, host())).toEqual({ docsUrl: 'https://opencode.ai/v2/docs/' })
    expect(remoteInstallPlan({ id: 'rovo', docsUrl: 'http://example.com' }, host())).toBe(null)
    expect(remoteInstallPlan({ id: 'mine', custom: true, install: ['npm install -g x'] }, host())).toBe(null)
    expect(remoteInstallPlan({ id: 'constructor' }, host())).toBe(null)
    expect(remoteInstallPlan(null, host())).toBe(null)
  })
})

describe('the line typed on the host', () => {
  it("from a pane's card: the install, then its shell ends (0 when it worked)", () => {
    expect(remoteInstallLine('antigravity', 'curl -fsSL https://antigravity.google/cli/install.sh | bash', { pane: true })).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash && exit')
    expect(remoteInstallLine('antigravity', 'sudo snap install antigravity-cli', { pane: true })).toBe('sudo snap install antigravity-cli && exit')
  })
  it('from the offer when a host connects: Claude Code starts once installed, to sign in', () => {
    expect(remoteInstallLine('claude', 'curl -fsSL https://claude.ai/install.sh | bash')).toBe('curl -fsSL https://claude.ai/install.sh | bash && ~/.local/bin/claude')
    expect(remoteInstallLine('codex', 'npm install -g --prefix "$HOME/.local" @openai/codex')).toBe('npm install -g --prefix "$HOME/.local" @openai/codex')
    expect(remoteInstallLine('codex', null)).toBe(null)
  })
})
