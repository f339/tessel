// Join command steps so each runs only if the previous one succeeded, in the
// syntax of the shell that will run them. Windows PowerShell 5.1 has no `&&`,
// so it gets `a; if ($?) { b }`.
export function chainCommands(steps, shellId) {
  const list = (Array.isArray(steps) ? steps : [steps])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  if (list.length <= 1) return list[0] || ''
  if (shellId === 'powershell') {
    return list.reduceRight((rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step), '') // i18n-ignore
  }
  // cmd, PowerShell 7, Git Bash and WSL all understand &&.
  return list.join(' && ')
}

// Install steps, then (only if they all succeeded) `start`, with a marker
// printed either way so Tessel knows how the install ended (installLog.js in
// the main process watches the pane's output for it). The marker is split in
// the command line itself (quotes, ^), so the typed line never contains it:
// only running it prints it.
export const MARK_OK = 'TESSEL-INSTALL-OK'
export const MARK_FAILED = 'TESSEL-INSTALL-FAILED'

// An npm install on a PC without Node.js ("npm is not recognized"): Node.js
// LTS is installed first with winget (Windows' own package manager), and the
// pane's PATH read again from Windows, so npm is found right after. Nothing
// happens when npm is there. PowerShell and the Command Prompt (Git Bash and
// WSL have their own Node.js, or not: left as they are).
const WINGET_NODE = 'winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements'
const NODE_MISSING = 'Node.js is not installed: installing it with winget...' // i18n-ignore
const NODE_FAILED = 'Node.js (npm) could not be installed. Install it from https://nodejs.org and try again.' // i18n-ignore
export function nodeStep(shellId) {
  if (shellId === 'powershell' || shellId === 'pwsh') {
    const refresh = "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    return `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host '${NODE_MISSING}'; ${WINGET_NODE}; ${refresh} }; if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Error '${NODE_FAILED}' }` // i18n-ignore
  }
  // No parenthesis in the message: it would close the block.
  if (shellId === 'cmd') return `(where npm >nul 2>nul || (echo ${NODE_MISSING} && ${WINGET_NODE} && set "PATH=%ProgramFiles%\\nodejs;%APPDATA%\\npm;%PATH%"))` // i18n-ignore
  return null
}

export function installChain(steps, start, shellId) {
  const given = (Array.isArray(steps) ? steps : [steps])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  const node = given.some((s) => /^npm\s/i.test(s)) ? nodeStep(shellId) : null
  const list = node ? [node, ...given] : given
  const then = String(start || '').trim()
  if (shellId === 'powershell' || shellId === 'pwsh') {
    const ok = "Write-Host ('TESSEL-INSTALL' + '-OK')"
    const bad = "Write-Host ('TESSEL-INSTALL' + '-FAILED')"
    const last = then ? `${ok}; ${then}` : ok
    return list.reduceRight((rest, step) => `${step}; if ($?) { ${rest} } else { ${bad} }`, last) // i18n-ignore
  }
  const [ok, bad] =
    shellId === 'cmd'
      ? ['echo TESSEL-INSTALL^-OK', 'echo TESSEL-INSTALL^-FAILED']
      : ['echo TESSEL-INSTALL"-OK"', 'echo TESSEL-INSTALL"-FAILED"']
  // The marker comes before the agent starts: the agent failing later is not
  // an install failure (the first marker seen is the one that counts).
  return `${[...list, ok, then].filter(Boolean).join(' && ')} || ${bad}`
}

// Human-readable version for tooltips and lists.
export function describeSteps(steps) {
  return (Array.isArray(steps) ? steps : [steps]).filter(Boolean).join(', then ')
}
