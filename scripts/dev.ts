import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import { isRunningAsAdmin, runElevated } from '@uruhalushia/sparkle-native'

const scriptPath = fileURLToPath(import.meta.url)
const projectDir = path.resolve(path.dirname(scriptPath), '..')

function runDev(): number {
  const pnpmCli = process.env.npm_execpath
  const result = spawnSync(
    process.platform === 'win32' && pnpmCli ? process.execPath : 'pnpm',
    [...(process.platform === 'win32' && pnpmCli ? [pnpmCli] : []), 'run', 'dev:app'],
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
