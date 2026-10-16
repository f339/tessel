// How an agent installs on an SSH host (Linux, macOS), from the host's last
// check (remoteAgents:status `host`: node and npm, npm's folder and whether
// it is the user's, snap, curl, wget). The command is shown exactly as it
// runs and runs only once you click Install (App.vue installAgentOnHost), in
// a terminal on that host. Pure functions: tested in
// __tests__/remoteAgentInstalls.spec.js.
//
// - The vendor's own installer where its docs give one for Linux and macOS
//   (HOST_INSTALLERS): downloaded with curl (else wget) and run by the shell
//   its docs name. They install in your home folder (~/.local/bin mostly):
//   no sudo, except where said (Ollama's installer asks for it).
// - Else its npm package, the one this computer installs (the agent's own
//   install steps, agentInstalls.js): `npm install -g` when npm's folder is
//   yours (nvm, a prefix of your own), else into ~/.local (--prefix
//   "$HOME/.local", its command in ~/.local/bin): never sudo, never a system
//   folder (a root-owned /usr/local/lib/node_modules gave EACCES). No npm
//   there, or a Node.js too old for the agent: Node.js LTS first, with nvm in
//   your home folder (its installer from GitHub, said before it runs), as an
//   install in WSL does (shellChain.js nodeStep).
// - Else only its install page (no automatic install known for it, or its
//   package clashes with another agent's command: OpenCode 2).
import { NVM_INSTALL_URL } from './shellChain'

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// The vendor's installer for Linux and macOS, verbatim from its docs (source):
// the script's address (https, on one of the vendor's domains: checked in the
// spec), the shell it runs with, a variable its docs set (goose: no setup
// questions), sudo when it asks for it, the system it is for (os, as uname
// says), and the snap package of the same command when there is one.
export const HOST_INSTALLERS = {
  claude: { url: 'https://claude.ai/install.sh', run: 'bash', domains: ['claude.ai', 'claude.com'], source: 'https://code.claude.com/docs/en/setup' },
  // Its binary goes to ~/.local/bin/agy. Ubuntu also offers a snap of it
  // (`snap install antigravity-cli`): a community wrapper, not Google's,
  // strictly confined and installed with sudo, so only a second choice.
  antigravity: { url: 'https://antigravity.google/cli/install.sh', run: 'bash', domains: ['antigravity.google'], source: 'https://antigravity.google/docs/getting-started', snap: 'antigravity-cli' },
  kimi: { url: 'https://code.kimi.com/kimi-code/install.sh', run: 'bash', domains: ['kimi.com'], source: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started' },
  cursor: { url: 'https://cursor.com/install', run: 'bash', domains: ['cursor.com'], source: 'https://cursor.com/docs/cli/installation' },
  grok: { url: 'https://x.ai/cli/install.sh', run: 'bash', domains: ['x.ai'], source: 'https://docs.x.ai/build/overview' },
  hermes: { url: 'https://hermes-agent.nousresearch.com/install.sh', run: 'bash', domains: ['nousresearch.com'], source: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation' },
  devin: { url: 'https://cli.devin.ai/install.sh', run: 'bash', domains: ['devin.ai'], source: 'https://docs.devin.ai/cli' },
  omp: { url: 'https://omp.sh/install', run: 'sh', domains: ['omp.sh'], source: 'https://github.com/can1357/oh-my-pi' },
  muse: { url: 'https://dev.meta.ai/install.sh', run: 'sh', domains: ['meta.ai'], source: 'https://dev.meta.ai/docs/muse-code' },
  qoder: { url: 'https://qoder.com/install', run: 'bash', domains: ['qoder.com'], source: 'https://docs.qoder.com/cli/installation' },
  kiro: { url: 'https://cli.kiro.dev/install', run: 'bash', domains: ['kiro.dev'], source: 'https://kiro.dev/docs/cli/' },
  vibe: { url: 'https://mistral.ai/vibe/install.sh', run: 'bash', domains: ['mistral.ai'], source: 'https://github.com/mistralai/mistral-vibe' },
  goose: {
    url: 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh',
    run: 'bash',
    env: 'CONFIGURE=false',
    domains: ['github.com/aaif-goose/'],
    source: 'https://goose-docs.ai/docs/getting-started/installation'
  },
  aider: { url: 'https://aider.chat/install.sh', run: 'sh', domains: ['aider.chat'], source: 'https://aider.chat/docs/install.html' },
  // Installs a system service: asks for sudo. Linux only (a macOS app else).
  ollama: { url: 'https://ollama.com/install.sh', run: 'sh', domains: ['ollama.com'], source: 'https://docs.ollama.com/linux', sudo: true, os: 'Linux' }
}

// An npm agent's installer for a host with no npm (or a Node.js too old for
// it), when its vendor has one that needs no Node.js: Codex's standalone
// installer (its README).
export const NO_NODE_INSTALLERS = {
  codex: { url: 'https://chatgpt.com/codex/install.sh', run: 'sh', domains: ['chatgpt.com'], source: 'https://github.com/openai/codex' }
}

// npm packages for a host that this computer installs another way: Auggie's
// docs give npm on Linux and macOS (Windows through WSL only).
export const HOST_NPM = { auggie: '@augmentcode/auggie' }

// The Node.js an npm agent needs (its package's engines), else 18.
const NODE_MIN = { gemini: 20, qwen: 20, copilot: 22 }
const DEFAULT_NODE_MIN = 18

const PLAIN_NPM = /^npm install -g (--ignore-scripts )?((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/i
// A folder that is safe between single quotes.
const POSIX_DIR = /^\/[^'\u0000-\u001f\u007f]{0,1024}$/
// Folders a login shell's PATH has anyway: npm there needs no PATH of its own.
const SYSTEM_BIN = new Set(['/usr/bin', '/usr/local/bin', '/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin'])

// The agent's npm package: { pkg, flags } | null.
export function npmPackageOf(agent) {
  if (!agent || typeof agent.id !== 'string') return null
  if (own(HOST_NPM, agent.id)) return { pkg: HOST_NPM[agent.id], flags: '' }
  const steps = Array.isArray(agent.install) ? agent.install : []
  if (steps.length !== 1) return null
  const m = PLAIN_NPM.exec(String(steps[0] || '').trim())
  return m ? { pkg: m[2], flags: m[1] || '' } : null
}

// A vendor's script, downloaded and run: curl, else wget (a host with
// neither: null).
function fetchLine(inst, host) {
  const runner = inst.env ? `${inst.env} ${inst.run}` : inst.run
  if (!host || host.curl) return `curl -fsSL ${inst.url} | ${runner}` // i18n-ignore
  if (host.wget) return `wget -qO- ${inst.url} | ${runner}` // i18n-ignore
  return null
}

// Node.js LTS with nvm, in the home folder (no password asked); nvm itself
// downloaded first when it is not there yet.
export function nvmNodeStep(host = null) {
  const get = host && !host.curl && host.wget ? `wget -qO- ${NVM_INSTALL_URL}` : `curl -fsSL ${NVM_INSTALL_URL}` // i18n-ignore
  return `export NVM_DIR="$HOME/.nvm" && { [ -s "$NVM_DIR/nvm.sh" ] || ${get} | bash; } && . "$NVM_DIR/nvm.sh" && nvm install --lts` // i18n-ignore
}

function httpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

// agent: { id, install, installSource, docsUrl, custom } (the agents list);
// host: the host's last check's `host` (null: not known, a plain host
// assumed: curl, npm there, its folder not the user's).
// -> { command, source, node, sudo, alt: { command, snap } | null }
//  | { docsUrl } (no automatic install: its page) | { error: 'no-download' }
//  | null (nothing known: a custom agent)
export function remoteInstallPlan(agent, host = null) {
  const id = agent && typeof agent.id === 'string' ? agent.id : null
  if (!id || agent.custom) return null
  const h = host && typeof host === 'object' ? host : null
  const inst = own(HOST_INSTALLERS, id) ? HOST_INSTALLERS[id] : null
  if (inst && !(inst.os && h && h.os && h.os !== inst.os)) {
    const command = fetchLine(inst, h)
    if (!command) return { error: 'no-download' }
    const alt = inst.snap && h && h.snap ? { command: `sudo snap install ${inst.snap}`, snap: inst.snap } : null // i18n-ignore
    return { command, source: inst.source, node: false, sudo: !!inst.sudo, alt }
  }
  const npm = npmPackageOf(agent)
  if (npm) {
    const source = httpsUrl(agent.installSource) ? agent.installSource : `https://www.npmjs.com/package/${npm.pkg}` // i18n-ignore
    const min = NODE_MIN[id] || DEFAULT_NODE_MIN
    const oldNode = !!(h && h.npm && Number.isInteger(h.nodeMajor) && h.nodeMajor < min)
    if ((!h || h.npm) && !oldNode) {
      // npm's own folder when it is the user's; else ~/.local (no sudo).
      const prefix = h && h.npmWritable === true ? '' : '--prefix "$HOME/.local" '
      // npm found outside the usual folders (nvm's, say): that folder first
      // on PATH, in case this shell does not have it.
      const dir = h && h.npm ? h.npm.slice(0, h.npm.lastIndexOf('/')) : ''
      const path = dir && !SYSTEM_BIN.has(dir) && POSIX_DIR.test(dir) ? `export PATH='${dir}':"$PATH" && ` : '' // i18n-ignore
      return { command: `${path}npm install -g ${prefix}${npm.flags}${npm.pkg}`, source, node: false, sudo: false, alt: null } // i18n-ignore
    }
    const standalone = own(NO_NODE_INSTALLERS, id) ? NO_NODE_INSTALLERS[id] : null
    if (standalone) {
      const command = fetchLine(standalone, h)
      return command ? { command, source: standalone.source, node: false, sudo: false, alt: null } : { error: 'no-download' }
    }
    if (h && !h.curl && !h.wget) return { error: 'no-download' }
    // nvm's Node.js puts npm's folder in the home folder: a plain -g.
    return { command: `${nvmNodeStep(h)} && npm install -g ${npm.flags}${npm.pkg}`, source, node: true, sudo: false, alt: null } // i18n-ignore
  }
  return typeof agent.docsUrl === 'string' && httpsUrl(agent.docsUrl) ? { docsUrl: agent.docsUrl } : null
}

// The line typed in the terminal on the host. pane: from a pane's "not
// installed" card, the install alone, then its shell ends (0 when it worked:
// Tessel checks the host again and starts the agent in that pane). Else
// (the offer when a host connects) Claude Code starts once installed, to
// show its sign-in link there (its installer puts it in ~/.local/bin, which
// PATH may lack).
export function remoteInstallLine(id, command, { pane = false } = {}) {
  if (typeof command !== 'string' || !command) return null
  if (pane) return `${command} && exit` // i18n-ignore
  return id === 'claude' ? `${command} && ~/.local/bin/claude` : command // i18n-ignore
}
