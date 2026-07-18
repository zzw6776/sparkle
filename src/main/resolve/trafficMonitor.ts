import { ChildProcess, spawn } from 'child_process'
import { getAppConfig } from '../config'
import { dataDir, resourcesFilesDir } from '../utils/dirs'
import path from 'path'
import { existsSync } from 'fs'
import { readFile, rm, writeFile } from 'fs/promises'

let child: ChildProcess | undefined

function spawnMonitor(monitorPath: string, detached: boolean): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const monitor = spawn(monitorPath, [], {
      cwd: path.dirname(monitorPath),
      detached,
      stdio: detached ? 'ignore' : undefined,
      windowsHide: true
    })
    const handleError = (error: Error): void => {
      monitor.removeListener('spawn', handleSpawn)
      reject(error)
    }
    const handleSpawn = (): void => {
      monitor.removeListener('error', handleError)
      resolve(monitor)
    }
    monitor.once('error', handleError)
    monitor.once('spawn', handleSpawn)
  })
}

export async function startMonitor(detached = false): Promise<void> {
  if (process.platform !== 'win32') return
  if (existsSync(path.join(dataDir(), 'monitor.pid'))) {
    const pid = parseInt(await readFile(path.join(dataDir(), 'monitor.pid'), 'utf-8'))
    try {
      process.kill(pid, 'SIGINT')
    } catch {
      // ignore
    } finally {
      await rm(path.join(dataDir(), 'monitor.pid'))
    }
  }
  await stopMonitor()
  const { showTraffic = false } = await getAppConfig()
  if (!showTraffic) return
  const monitorPath = path.join(resourcesFilesDir(), 'TrafficMonitor/TrafficMonitor.exe')
  const monitor = await spawnMonitor(monitorPath, detached)
  child = monitor
  monitor.once('exit', () => {
    if (child === monitor) child = undefined
  })
  if (detached) {
    if (monitor.pid) {
      await writeFile(path.join(dataDir(), 'monitor.pid'), monitor.pid.toString())
    }
    monitor.unref()
  }
}

async function stopMonitor(): Promise<void> {
  if (child) {
    child.kill('SIGINT')
    child = undefined
  }
}
