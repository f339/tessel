// Windows PowerShell's script policy, read once. "Restricted" (Windows' own
// default on a PC, nobody chose another, no group policy) keeps npm's .ps1
// commands (npm, claude, codex...) from running in a pane: "running scripts
// is disabled on this system". Tessel's Windows PowerShell panes then start
// with RemoteSigned for their own process only, as npm asks (scripts made on
// this PC run, ones from the internet must be signed). Nothing is saved, and
// a policy someone chose (AllSigned, RemoteSigned, a group policy) is left as
// it is.
import { execFile } from 'child_process'

export const RELAXED_ARGS = ['-ExecutionPolicy', 'RemoteSigned']
const READ = "[string](Get-ExecutionPolicy) + '|' + [string](Get-ExecutionPolicy -Scope MachinePolicy) + '|' + [string](Get-ExecutionPolicy -Scope UserPolicy)"

// "Restricted|Undefined|Undefined" (what Get-ExecutionPolicy says) -> true:
// the default, which RemoteSigned for the pane may replace.
export function onlyTheDefault(text) {
  const [effective, machine, user] = String(text || '').trim().split('|')
  return /^Restricted$/i.test(effective || '') && /^Undefined$/i.test(machine || '') && /^Undefined$/i.test(user || '')
}

// -> true when the panes should get RELAXED_ARGS (never on an error).
export function readDefaultPolicy({ exe = 'powershell.exe', execFileImpl = execFile, timeoutMs = 15000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      execFileImpl(exe, ['-NoProfile', '-NonInteractive', '-Command', READ], { windowsHide: true, timeout: timeoutMs }, (err, stdout) =>
        resolve(!err && onlyTheDefault(stdout))
      )
    } catch {
      resolve(false)
    }
  })
}

// The Windows PowerShell shell (discoverShells' entry) given RELAXED_ARGS,
// once.
export function relaxShell(shell) {
  if (!shell || shell.id !== 'powershell' || !Array.isArray(shell.args)) return false
  if (shell.args.some((a) => /^-ExecutionPolicy$/i.test(a))) return false
  shell.args = [...shell.args, ...RELAXED_ARGS]
  return true
}
