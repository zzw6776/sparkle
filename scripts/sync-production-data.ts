import { access, cp, mkdir, readdir, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDevDataDir = path.join(projectDir, '.sparkle-dev')

const dataFiles = [
  'config.yaml',
  'config.yaml.backup',
  'profile.yaml',
  'mihomo.yaml',
  'override.yaml'
]
const dataDirectories = ['profiles', 'override', 'themes', 'substore']

interface SyncOptions {
  source?: string
  target?: string
  dryRun: boolean
  yes: boolean
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index !== -1) return args[index + 1]

  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline?.slice(prefix.length)
}

function parseOptions(): SyncOptions {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`用法：
  pnpm sync:production-data [选项]

选项：
  --source <目录>  指定正式版数据目录
  --target <目录>  指定开发版数据目录，默认是 .sparkle-dev
  --dry-run        只检查并打印，不复制文件
  --yes            跳过确认提示
`)
    process.exit(0)
  }

  return {
    source: getOption(args, '--source') || process.env.SPARKLE_PRODUCTION_DATA_DIR,
    target: getOption(args, '--target') || process.env.SPARKLE_DEV_DATA_DIR,
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes')
  }
}

function getProductionDataCandidates(): string[] {
  const home = os.homedir()

  switch (process.platform) {
    case 'darwin':
      return [
        path.join(home, 'Library', 'Application Support', 'sparkle'),
        path.join(home, 'Library', 'Application Support', 'Sparkle')
      ]
    case 'win32': {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      return [path.join(appData, 'sparkle'), path.join(appData, 'Sparkle')]
    }
    default: {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
      return [path.join(configHome, 'sparkle'), path.join(configHome, 'Sparkle')]
    }
  }
}

async function resolveProductionDataDir(explicitSource?: string): Promise<string> {
  const candidates = explicitSource ? [explicitSource] : getProductionDataCandidates()

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    const hasRequiredFiles = await Promise.all(
      ['config.yaml', 'profile.yaml', 'mihomo.yaml'].map((file) =>
        pathExists(path.join(resolved, file))
      )
    )
    if (hasRequiredFiles.every(Boolean)) return resolved
  }

  throw new Error(
    `找不到正式版数据目录。请使用 --source <目录> 或设置 SPARKLE_PRODUCTION_DATA_DIR。\n` +
      `已检查：\n${candidates.map((candidate) => `  - ${path.resolve(candidate)}`).join('\n')}`
  )
}

async function confirm(
  source: string,
  target: string,
  backup: string | undefined
): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const backupMessage = backup ? `\n现有开发目录会先备份到：${backup}` : ''
    const answer = await rl.question(
      `将正式版数据复制到开发目录：\n  来源：${source}\n  目标：${target}${backupMessage}\n\n` +
        '请确认已关闭正式版和开发版，继续吗？[y/N] '
    )
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}

async function findMihomoCacheFiles(source: string): Promise<string[]> {
  const workDir = path.join(source, 'work')
  if (!(await pathExists(workDir))) return []

  const cacheFiles: string[] = []
  const rootCache = path.join(workDir, 'cache.db')
  if (await pathExists(rootCache)) cacheFiles.push(path.join('work', 'cache.db'))

  const entries = await readdir(workDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const profileCache = path.join(workDir, entry.name, 'cache.db')
    if (await pathExists(profileCache)) {
      cacheFiles.push(path.join('work', entry.name, 'cache.db'))
    }
  }

  return cacheFiles
}

async function copyEntries(
  source: string,
  target: string,
  mihomoCacheFiles: string[]
): Promise<void> {
  await mkdir(target, { recursive: true })

  for (const name of dataFiles) {
    const sourcePath = path.join(source, name)
    if (!(await pathExists(sourcePath))) {
      console.log(`[跳过] ${name} 不存在`)
      continue
    }
    await cp(sourcePath, path.join(target, name), { recursive: true, force: true })
    console.log(`[复制] ${name}`)
  }

  for (const name of dataDirectories) {
    const sourcePath = path.join(source, name)
    if (!(await pathExists(sourcePath))) {
      console.log(`[跳过] ${name}/ 不存在`)
      continue
    }
    await cp(sourcePath, path.join(target, name), { recursive: true, force: true })
    console.log(`[复制] ${name}/`)
  }

  for (const relativePath of mihomoCacheFiles) {
    const sourcePath = path.join(source, relativePath)
    const targetPath = path.join(target, relativePath)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await cp(sourcePath, targetPath, { force: true })
    console.log(`[复制] ${relativePath}（代理组节点选择状态）`)
  }
}

async function syncProductionData(options: SyncOptions): Promise<void> {
  const source = await resolveProductionDataDir(options.source)
  const target = path.resolve(options.target || defaultDevDataDir)
  const mihomoCacheFiles = await findMihomoCacheFiles(source)

  if (source === target) {
    throw new Error('来源目录和目标目录不能相同')
  }

  const targetExists = await pathExists(target)
  const backup = targetExists
    ? `${target}.before-production-sync-${new Date().toISOString().replace(/[.:]/g, '-')}`
    : undefined
  const productionLockExists = await pathExists(path.join(source, 'SingletonLock'))

  console.log(`正式版数据：${source}`)
  console.log(`开发版数据：${target}`)
  if (productionLockExists) {
    console.warn('[警告] 正式版数据目录存在 SingletonLock，请先关闭正式版应用。')
  }
  console.log(
    '只复制配置、订阅、覆写、主题、Sub-Store 数据和 Mihomo 节点选择状态；不会复制运行配置、日志或其他缓存。'
  )
  if (mihomoCacheFiles.length > 0) {
    console.log(`发现 ${mihomoCacheFiles.length} 个 Mihomo 节点状态文件：`)
    mihomoCacheFiles.forEach((file) => console.log(`  - ${file}`))
  } else {
    console.log('[提示] 未发现 Mihomo cache.db，节点选择状态不会同步。')
  }

  if (options.dryRun) {
    console.log('[dry-run] 未执行任何复制操作。')
    return
  }

  if (!options.yes && !(await confirm(source, target, backup))) {
    console.log('已取消。')
    return
  }

  if (backup) {
    await rename(target, backup)
    console.log(`已备份原开发目录：${backup}`)
  }

  try {
    await copyEntries(source, target, mihomoCacheFiles)
  } catch (error) {
    const failedTarget = `${target}.failed-production-sync-${Date.now()}`
    if (await pathExists(target)) await rename(target, failedTarget)
    if (backup && (await pathExists(backup))) await rename(backup, target)
    throw new Error(`复制失败，已恢复原开发目录。失败目录保留在：${failedTarget}\n${error}`)
  }

  console.log('\n同步完成。开发版下次启动将读取这份正式数据快照。')
  if (backup) console.log(`如需恢复旧开发数据，可使用备份：${backup}`)
}

syncProductionData(parseOptions()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
