import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import { statSync } from 'fs'
import { isRunningAsAdmin, runElevated } from '@uruhalushia/sparkle-native'

const scriptPath = fileURLToPath(import.meta.url)
const projectDir = path.resolve(path.dirname(scriptPath), '..')

const unixCorePaths = ['mihomo', 'mihomo-alpha'].map((name) =>
  path.join(projectDir, 'extra', 'sidecar', name)
)

function hasRequiredCorePermissions(corePath: string): boolean {
  try {
    const stat = statSync(corePath)
    return stat.uid === 0 && (stat.mode & 0o4000) !== 0
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function ensureDarwinCorePermissions(): void {
  if (process.platform !== 'darwin') return

  const missingPermissions = unixCorePaths.filter(
    (corePath) => !hasRequiredCorePermissions(corePath)
  )
  if (missingPermissions.length === 0) return

  console.log('检测到开发版内核缺少 root/setuid 权限，正在请求管理员授权…')
  const paths = missingPermissions.map(shellQuote).join(' ')
  const shell = `chown root:admin ${paths} && chmod 6755 ${paths}`
  const command = `do shell script ${JSON.stringify(shell)} with administrator privileges`
  const result = spawnSync('osascript', ['-e', command], { stdio: 'inherit' })

  if (result.error) throw result.error
  if (
    result.status !== 0 ||
    missingPermissions.some((corePath) => !hasRequiredCorePermissions(corePath))
  ) {
    throw new Error('开发版内核授权失败，已停止启动以避免 TUN 和进程识别异常')
  }
}

function runDev(): number {
  const pnpmCli = process.env.npm_execpath
  const result = spawnSync(
    process.platform === 'win32' && pnpmCli ? process.execPath : 'pnpm',
    [...(process.platform === 'win32' && pnpmCli ? [pnpmCli] : []), 'run', 'dev:electron'],
    {
      cwd: projectDir,
      stdio: 'inherit',
      shell: process.platform === 'win32' && !pnpmCli
    }
  )

  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

function main(): number {
  ensureDarwinCorePermissions()

  if (process.platform !== 'win32' || isRunningAsAdmin()) {
    return runDev()
  }

  if (process.argv.includes('--elevated')) {
    throw new Error('已请求管理员权限，但当前进程仍未获得管理员权限')
  }

  const exitCode = runElevated(process.execPath, [scriptPath, '--elevated'])
  if (exitCode !== 0) {
    throw new Error(`管理员权限启动失败，退出码：${exitCode}`)
  }
  return exitCode
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
