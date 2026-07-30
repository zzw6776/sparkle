import type { BrowserWindow, WebContents } from 'electron'

export function safeSendToWebContents(
  webContents: WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()) {
    return false
  }

  try {
    const frame = webContents.mainFrame
    if (frame.isDestroyed() || frame.detached) {
      return false
    }
    frame.send(channel, ...args)
    return true
  } catch {
    // The frame can be replaced between the lifecycle checks and send().
    return false
  }
}

export function safeSendToWindow(
  window: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed()) return false
  return safeSendToWebContents(window.webContents, channel, ...args)
}
