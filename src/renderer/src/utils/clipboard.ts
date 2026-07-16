import { writeClipboardText } from '@renderer/utils/ipc'

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    await writeClipboardText(text)
  }
}
