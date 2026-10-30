import { Button, Card } from '@heroui/react'

import { FaCircleArrowDown, FaCircleArrowUp } from 'react-icons/fa6'
import { useLocation } from 'react-router-dom'
import { calcTraffic } from '@renderer/utils/calc'
import React, { useEffect, useState, useRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { IoLink } from 'react-icons/io5'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import TrafficChart, { type TrafficChartHandle } from './traffic-chart'
import SiderItem from './sider-item'

interface Props {
  iconOnly?: boolean
  expanded?: boolean
}

const ConnCard: React.FC<Props> = (props) => {
  const { iconOnly, expanded } = props
  const { appConfig } = useAppConfig()
  const { connectionCardStatus = 'col-span-2', disableAnimation = false } = appConfig || {}

  const location = useLocation()
  const match = location.pathname.includes('/connections')

  const [upload, setUpload] = useState(0)
  const [download, setDownload] = useState(0)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: 'connection'
  })
  const trafficChartRef = useRef<TrafficChartHandle>(null)

  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null

  useEffect(() => {
    const handleTraffic = (_e: unknown, info: ControllerTraffic): void => {
      setUpload(info.up)
      setDownload(info.down)

      trafficChartRef.current?.push(info.up + info.down)
    }

    const unsubscribe = window.electron.ipcRenderer.on('mihomoTraffic', handleTraffic)

    return unsubscribe
  }, [])

  if (iconOnly) {
    return (
      <SiderItem
        className={connectionCardStatus}
        title="连接"
        route="/connections"
        icon={<IoLink className="text-[20px]" />}
        expanded={expanded}
      />
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
      className={`${connectionCardStatus} conn-card`}
    >
      {connectionCardStatus === 'col-span-2' ? (
        <>
          <Card
            {...attributes}
            {...listeners}
            className={[
              'w-full',
              `${match ? 'bg-primary' : 'hover:bg-primary/30'} ${isDragging ? `${disableAnimation ? '' : 'scale-[0.95]'} tap-highlight-transparent` : ''} relative overflow-hidden`
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <Card.Content className="pb-1 pt-0 px-0 overflow-y-visible">
              <div className="flex justify-between">
                <Button
                  isIconOnly
                  variant="secondary"
                  data-color="default"
                  className="bg-transparent pointer-events-none"
                >
                  <IoLink
                    color="default"
                    className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px]`}
                  />
                </Button>
                <div
                  className={`p-2 w-full ${match ? 'text-primary-foreground' : 'text-foreground'} `}
                >
                  <div className="flex justify-between">
                    <div className="w-full text-right mr-2">{calcTraffic(upload)}/s</div>
                    <FaCircleArrowUp className="h-6 leading-6" />
                  </div>
                  <div className="flex justify-between">
                    <div className="w-full text-right mr-2">{calcTraffic(download)}/s</div>
                    <FaCircleArrowDown className="h-6 leading-6" />
                  </div>
                </div>
              </div>
            </Card.Content>
            <Card.Footer className="pt-1 relative z-10">
              <div
                className={`flex justify-between items-center w-full text-md font-bold ${match ? 'text-primary-foreground' : 'text-foreground'}`}
              >
                <h3>连接</h3>
              </div>
            </Card.Footer>
            <TrafficChart ref={trafficChartRef} isActive={match} />
          </Card>
        </>
      ) : (
        <Card
          {...attributes}
          {...listeners}
          className={[
            'w-full',
            `${match ? 'bg-primary' : 'hover:bg-primary/30'} ${isDragging ? `${disableAnimation ? '' : 'scale-[0.95]'} tap-highlight-transparent` : ''}`
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <Card.Content className="pb-1 pt-0 px-0 overflow-y-visible">
            <div className="flex justify-between">
              <Button
                isIconOnly
                variant="secondary"
                data-color="default"
                className="bg-transparent pointer-events-none"
              >
                <IoLink
                  color="default"
                  className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px] font-bold`}
                />
              </Button>
            </div>
          </Card.Content>
          <Card.Footer className="pt-1">
            <h3
              className={`text-md font-bold ${match ? 'text-primary-foreground' : 'text-foreground'}`}
            >
              连接
            </h3>
          </Card.Footer>
        </Card>
      )}
    </div>
  )
}

export default React.memo(ConnCard, (prevProps, nextProps) => {
  return prevProps.iconOnly === nextProps.iconOnly && prevProps.expanded === nextProps.expanded
})
