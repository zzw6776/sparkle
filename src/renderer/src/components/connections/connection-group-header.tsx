import { Chip, Button, Card, Avatar } from '@heroui/react'
import { Pressable } from 'react-aria'

import { calcTraffic } from '@renderer/utils/calc'
import React, { memo, useMemo } from 'react'
import { CgClose, CgTrash } from 'react-icons/cg'
import { IoIosArrowBack } from 'react-icons/io'
import { MdSpeed } from 'react-icons/md'
import { RiPushpin2Fill, RiPushpin2Line } from 'react-icons/ri'

interface Props {
  groupKey: string
  label: string
  count: number
  upload: number
  download: number
  uploadSpeed: number
  downloadSpeed: number
  expanded: boolean
  isLast: boolean
  isClosed?: boolean
  displayIcon?: boolean
  iconUrl?: string
  displayName?: string
  isPinned: boolean
  onToggle: (key: string) => void
  onCloseAll: (key: string) => void
  onSpeedTest: (key: string) => void
  onPin: (key: string) => void
}

const ConnectionGroupHeaderComponent: React.FC<Props> = ({
  groupKey,
  label,
  count,
  upload,
  download,
  uploadSpeed,
  downloadSpeed,
  expanded,
  isLast,
  isClosed,
  displayIcon,
  iconUrl,
  displayName,
  isPinned,
  onToggle,
  onCloseAll,
  onSpeedTest,
  onPin
}) => {
  const title = useMemo(() => {
    if (displayName) return displayName
    const name = label.replace(/\.exe$/, '')
    return name || '未知进程'
  }, [displayName, label])

  const uploadTraffic = useMemo(() => calcTraffic(upload), [upload])
  const downloadTraffic = useMemo(() => calcTraffic(download), [download])
  const hasSpeed = uploadSpeed > 0 || downloadSpeed > 0
  const uploadSpeedText = useMemo(() => calcTraffic(uploadSpeed), [uploadSpeed])
  const downloadSpeedText = useMemo(() => calcTraffic(downloadSpeed), [downloadSpeed])

  return (
    <div className={`w-full pt-2 ${isLast && !expanded ? 'pb-2' : ''} px-2`}>
      <Pressable onPress={() => onToggle(groupKey)}>
        <Card className="w-full" data-pressable="true" role="button" tabIndex={0}>
          <Card.Content className="w-full h-16 p-0">
            <div className="flex justify-between items-center h-full pl-2 pr-3">
              <div className="flex items-center overflow-hidden whitespace-nowrap h-full min-w-0">
                {displayIcon && (
                  <Avatar size="lg" className="mr-2 h-12 w-12 shrink-0 bg-transparent">
                    <Avatar.Image className="object-contain" src={iconUrl} />
                  </Avatar>
                )}
                <div className="flex flex-col justify-center gap-1 min-w-0 py-2">
                  <div className="text-md text-ellipsis overflow-hidden whitespace-nowrap leading-snug">
                    {title}
                  </div>
                  <div className="text-xs text-foreground-500 leading-snug whitespace-nowrap text-ellipsis overflow-hidden">
                    <span>
                      ↑ {uploadTraffic} ↓ {downloadTraffic}
                    </span>
                    {hasSpeed && (
                      <span className="ml-2 text-primary">
                        ↑ {uploadSpeedText}/s ↓ {downloadSpeedText}/s
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center shrink-0">
                <Chip
                  size="sm"
                  data-color="default"
                  variant="primary"
                  className={['my-1 mr-1'].filter(Boolean).join(' ')}
                >
                  <Chip.Label>{count}</Chip.Label>
                </Chip>
                <div
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Button
                    size="sm"
                    isIconOnly
                    aria-label={isPinned ? '取消置顶该进程' : '置顶该进程'}
                    onPress={() => onPin(groupKey)}
                    variant="ghost"
                    data-color={isPinned ? 'primary' : 'default'}
                  >
                    {isPinned ? (
                      <RiPushpin2Fill className="text-lg" />
                    ) : (
                      <RiPushpin2Line className="text-lg" />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    isIconOnly
                    aria-label="测试该进程的历史目标"
                    onPress={() => onSpeedTest(groupKey)}
                    variant="ghost"
                    data-color="primary"
                  >
                    <MdSpeed className="text-lg" />
                  </Button>
                  <Button
                    size="sm"
                    isIconOnly
                    aria-label={isClosed ? '清空该进程全部记录' : '关闭该进程全部连接'}
                    onPress={() => onCloseAll(groupKey)}
                    variant="ghost"
                    data-color={isClosed ? 'danger' : 'warning'}
                  >
                    {isClosed ? <CgTrash className="text-lg" /> : <CgClose className="text-lg" />}
                  </Button>
                </div>
                <IoIosArrowBack
                  className={`transition duration-200 ml-1 h-8 text-lg text-foreground-500 flex items-center ${expanded ? '-rotate-90' : ''}`}
                />
              </div>
            </div>
          </Card.Content>
        </Card>
      </Pressable>
    </div>
  )
}

const ConnectionGroupHeader = memo(ConnectionGroupHeaderComponent, (prev, next) => {
  return (
    prev.groupKey === next.groupKey &&
    prev.label === next.label &&
    prev.count === next.count &&
    prev.upload === next.upload &&
    prev.download === next.download &&
    prev.uploadSpeed === next.uploadSpeed &&
    prev.downloadSpeed === next.downloadSpeed &&
    prev.expanded === next.expanded &&
    prev.isLast === next.isLast &&
    prev.isClosed === next.isClosed &&
    prev.displayIcon === next.displayIcon &&
    prev.iconUrl === next.iconUrl &&
    prev.displayName === next.displayName &&
    prev.isPinned === next.isPinned
  )
})

export default ConnectionGroupHeader
