type NetworkTestKind = 'download' | 'codex' | 'codex-actual' | 'process'

let activeTest: NetworkTestKind | undefined

function testName(kind: NetworkTestKind): string {
  if (kind === 'download') return '下载测速'
  if (kind === 'codex') return 'Codex 链路测试'
  return kind === 'codex-actual' ? 'Codex 真实响应测试' : '进程测速'
}

export function acquireNetworkTestChannel(kind: NetworkTestKind): () => void {
  if (activeTest) {
    throw new Error(`已有${testName(activeTest)}正在进行`)
  }

  activeTest = kind
  let released = false
  return () => {
    if (released) return
    released = true
    if (activeTest === kind) activeTest = undefined
  }
}
