import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { getAppConfigSync } from '../config/app'
import { managedCodexBinaryPath } from './codexRuntime'

function configuredPath(value?: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((current) => current.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => envValue(env, name) || match)
}

function windowsRegistryPaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  const keys = [
    ['HKCU\\Environment', 'Path'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path']
  ]

  for (const [key, valueName] of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/v', valueName], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        windowsHide: true
      })
      const match = output.match(/\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)
      if (match?.[1]) paths.push(expandWindowsEnv(match[1].trim(), env))
    } catch {
      // PATH discovery must continue when registry access is unavailable.
    }
  }
  return paths
}

function pathDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const values = [envValue(env, 'PATH')]
  if (platform === 'win32') values.push(...windowsRegistryPaths(env))
  return values
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(platform === 'win32' ? ';' : ':'))
    .map((value) => configuredPath(value))
    .filter((value): value is string => Boolean(value))
}

function windowsDesktopCodexCandidates(localAppData?: string): string[] {
  if (!localAppData) return []
  const binDir = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin')
  try {
    return readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.win32.join(binDir, entry.name, 'codex.exe'))
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => ({ candidate, updatedAt: statSync(candidate).mtimeMs }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ candidate }) => candidate)
  } catch {
    return []
  }
}

function dedupeCandidates(
  candidates: Array<string | undefined>,
  platform: NodeJS.Platform
): string[] {
  const seen = new Set<string>()
  return candidates.filter((candidate): candidate is string => {
    if (!candidate) return false
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getCodexBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const override = configuredPath(env.SPARKLE_CODEX_BINARY)
  if (override) return [override]

  const useCurrentRuntimeConfig = platform === process.platform && env === process.env
  const preference = useCurrentRuntimeConfig
    ? getAppConfigSync().codexRuntimePreference
    : undefined
  const managedBinary = useCurrentRuntimeConfig ? managedCodexBinaryPath() : undefined
  if (preference === 'managed') return managedBinary ? [managedBinary] : []

  const candidates: Array<string | undefined> = [
    preference === 'system' ? undefined : managedBinary
  ]
  const home = configuredPath(envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME'))

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      home
        ? path.posix.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')
        : undefined
    )
  }

  if (platform === 'win32') {
    const installDir = configuredPath(env.CODEX_INSTALL_DIR)
    if (installDir) {
      if (/\.(?:exe|cmd|bat)$/i.test(installDir)) {
        candidates.push(installDir)
      } else {
        candidates.push(
          path.win32.join(installDir, 'codex.exe'),
          path.win32.join(installDir, 'codex.cmd')
        )
        if (path.win32.basename(installDir).toLowerCase() !== 'bin') {
          candidates.push(
            path.win32.join(installDir, 'bin', 'codex.exe'),
            path.win32.join(installDir, 'bin', 'codex.cmd')
          )
        }
      }
    }

    const localAppData = configuredPath(envValue(env, 'LOCALAPPDATA'))
    const appData = configuredPath(envValue(env, 'APPDATA'))
    candidates.push(...windowsDesktopCodexCandidates(localAppData))
    if (localAppData) {
      candidates.push(
        path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.cmd'),
        path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe'),
        path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.cmd'),
        path.win32.join(localAppData, 'pnpm', 'codex.exe'),
        path.win32.join(localAppData, 'pnpm', 'codex.cmd')
      )
    }
    if (appData) candidates.push(path.win32.join(appData, 'npm', 'codex.cmd'))
    if (home) {
      candidates.push(
        path.win32.join(home, '.local', 'bin', 'codex.exe'),
        path.win32.join(home, 'scoop', 'shims', 'codex.exe'),
        path.win32.join(home, 'scoop', 'shims', 'codex.cmd')
      )
    }
    pathDirectories(env, platform).forEach((directory) => {
      const pathCandidates = [
        path.win32.join(directory, 'codex.exe'),
        path.win32.join(directory, 'codex.cmd'),
        path.win32.join(directory, 'codex.bat')
      ]
      candidates.push(...pathCandidates.filter((candidate) => existsSync(candidate)))
    })
    candidates.push('codex.exe', 'codex.cmd')
  } else {
    if (home) {
      candidates.push(
        path.posix.join(home, '.local', 'bin', 'codex'),
        path.posix.join(home, '.npm-global', 'bin', 'codex')
      )
    }
    candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex')
    pathDirectories(env, platform).forEach((directory) => {
      const candidate = path.join(directory, 'codex')
      if (existsSync(candidate)) candidates.push(candidate)
    })
  }

  candidates.push('codex')
  return dedupeCandidates(candidates, platform)
}

export function codexBinaryNeedsShell(
  binary: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)
}
