import path from 'node:path'

function configuredPath(value?: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

export function getCodexBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates: Array<string | undefined> = [configuredPath(env.SPARKLE_CODEX_BINARY)]

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex'
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

    const localAppData = configuredPath(env.LOCALAPPDATA)
    if (localAppData) {
      candidates.push(
        path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.cmd'),
        path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe')
      )
    }
    candidates.push('codex.exe', 'codex.cmd')
  }

  candidates.push('codex')
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))]
}

export function codexBinaryNeedsShell(
  binary: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)
}
