import { describe, it, expect } from 'vitest'
import { chainCommands, describeSteps, installChain, nodeStep, NVM_INSTALL_URL, MARK_OK, MARK_FAILED } from '../shellChain'

describe('installChain', () => {
  it('Windows PowerShell and pwsh: a marker for success, one for each failure', () => {
    const line = installChain(['pip i a', 'setup-a'], 'a', 'powershell')
    expect(line).toBe(
      "pip i a; if ($?) { setup-a; if ($?) { Write-Host ('TESSEL-INSTALL' + '-OK'); a } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') } } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') }"
    )
    expect(installChain(['x'], null, 'pwsh')).toBe("x; if ($?) { Write-Host ('TESSEL-INSTALL' + '-OK') } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') }")
  })
  it('cmd, bash, wsl: && then || for the failure', () => {
    expect(installChain(['pip i a'], 'a', 'cmd')).toBe('pip i a && echo TESSEL-INSTALL^-OK && a || echo TESSEL-INSTALL^-FAILED')
    expect(installChain(['pip i a'], '', 'gitbash')).toBe('pip i a && echo TESSEL-INSTALL"-OK" || echo TESSEL-INSTALL"-FAILED"')
  })
  it('an npm install on a PC without Node.js: Node.js first, with winget, then npm found on the same line', () => {
    const ps = installChain(['npm install -g @anthropic-ai/claude-code'], 'claude', 'powershell')
    expect(ps.startsWith(nodeStep('powershell') + '; if ($?) { npm install -g @anthropic-ai/claude-code; if ($?) {')).toBe(true)
    expect(nodeStep('powershell')).toContain('Get-Command npm -ErrorAction SilentlyContinue')
    expect(nodeStep('powershell')).toContain('winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements')
    expect(nodeStep('powershell')).toContain("[Environment]::GetEnvironmentVariable('Path','Machine')")
    // Node.js still missing after winget: the step fails, so the install says so.
    expect(nodeStep('powershell')).toMatch(/Write-Error 'Node\.js \(npm\) could not be installed\. Install it from https:\/\/nodejs\.org and try again\.' \}$/)
    expect(nodeStep('pwsh')).toBe(nodeStep('powershell'))
    const cmd = installChain(['npm install -g @openai/codex'], 'codex', 'cmd')
    expect(cmd).toBe(`${nodeStep('cmd')} && npm install -g @openai/codex && echo TESSEL-INSTALL^-OK && codex || echo TESSEL-INSTALL^-FAILED`)
    expect(nodeStep('cmd')).toMatch(/^\(where npm >nul 2>nul \|\| \(echo [^()]*&& winget install .* && set "PATH=%ProgramFiles%\\nodejs;%APPDATA%\\npm;%PATH%"\)\)$/)
    // Not for other installs.
    expect(installChain(['winget install x'], null, 'powershell')).not.toContain('Get-Command npm')
  })
  it('Git Bash: Node.js with winget too; WSL (Linux): with nvm in the home folder, a Windows npm through /mnt not counted', () => {
    const gb = nodeStep('gitbash')
    expect(gb).toMatch(/^\{ command -v npm >\/dev\/null 2>&1 \|\| \{ echo '[^']*'; winget\.exe install -e --id OpenJS\.NodeJS\.LTS/)
    expect(gb).toContain('export PATH="/c/Program Files/nodejs:$(cygpath -u "$APPDATA")/npm:$PATH"')
    expect(gb).toMatch(/false; \}; \}$/)
    expect(installChain(['npm install -g @openai/codex'], 'codex', 'gitbash')).toBe(`${gb} && npm install -g @openai/codex && echo TESSEL-INSTALL"-OK" && codex || echo TESSEL-INSTALL"-FAILED"`)
    const wsl = nodeStep('wsl')
    expect(wsl).toContain('case "$(command -v npm 2>/dev/null)" in ""|/mnt/*)')
    expect(wsl).toContain(`curl -fsSL ${NVM_INSTALL_URL}`)
    expect(wsl).toContain(`wget -qO- ${NVM_INSTALL_URL}`)
    expect(wsl).toContain('. "$NVM_DIR/nvm.sh" && nvm install --lts')
    expect(NVM_INSTALL_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v\d+\.\d+\.\d+\/install\.sh$/)
    expect(installChain(['npm install -g @anthropic-ai/claude-code'], 'claude', 'wsl').startsWith(`${wsl} && npm install -g`)).toBe(true)
  })
  it('the typed line never contains a marker (only running it prints one)', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd', 'gitbash', 'wsl']) {
      const line = installChain(['npm i -g a'], 'a', shell)
      expect(line).not.toContain(MARK_OK)
      expect(line).not.toContain(MARK_FAILED)
    }
  })
})

describe('chainCommands', () => {
  it('returns a single step unchanged', () => {
    expect(chainCommands(['npm install -g x'], 'cmd')).toBe('npm install -g x')
    expect(chainCommands('copilot', 'powershell')).toBe('copilot')
  })
  it('uses && for cmd, pwsh, bash and wsl', () => {
    for (const shell of ['cmd', 'pwsh', 'gitbash', 'wsl']) {
      expect(chainCommands(['a', 'b', 'c'], shell)).toBe('a && b && c')
    }
  })
  it('nests if ($?) for Windows PowerShell 5.1', () => {
    expect(chainCommands(['a', 'b'], 'powershell')).toBe('a; if ($?) { b }')
    expect(chainCommands(['a', 'b', 'c'], 'powershell')).toBe('a; if ($?) { b; if ($?) { c } }')
  })
  it('ignores empty steps', () => {
    expect(chainCommands(['', 'a', '  ', 'b'], 'cmd')).toBe('a && b')
    expect(chainCommands([], 'cmd')).toBe('')
  })
})

describe('describeSteps', () => {
  it('reads naturally', () => {
    expect(describeSteps(['python -m pip install aider-install', 'aider-install'])).toBe(
      'python -m pip install aider-install, then aider-install'
    )
  })
})
