import { Button, Card } from '@heroui/react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import React from 'react'
import { MdSpeed } from 'react-icons/md'
import { useLocation } from 'react-router-dom'
import SiderItem from './sider-item'

interface Props {
  iconOnly?: boolean
  expanded?: boolean
}

const SpeedTestCard: React.FC<Props> = ({ iconOnly, expanded }) => {
  const { appConfig } = useAppConfig()
  const { speedTestCardStatus = 'col-span-1', disableAnimation = false } = appConfig || {}
  const match = useLocation().pathname.includes('/speed-test')
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: sortableTransform,
    transition,
    isDragging
  } = useSortable({ id: 'speedtest' })
  const transform = sortableTransform
    ? { x: sortableTransform.x, y: sortableTransform.y, scaleX: 1, scaleY: 1 }
    : null

  if (iconOnly) {
    return (
      <SiderItem
        className={speedTestCardStatus}
        title="测速"
        route="/speed-test"
        icon={<MdSpeed className="text-[20px]" />}
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
      className={`${speedTestCardStatus} speed-test-card`}
    >
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
          <Button
            isIconOnly
            className="bg-transparent pointer-events-none"
            variant="secondary"
            data-color="default"
          >
            <MdSpeed
              className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px]`}
            />
          </Button>
        </Card.Content>
        <Card.Footer className="pt-1">
          <h3
            className={`text-md font-bold ${match ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            测速
          </h3>
        </Card.Footer>
      </Card>
    </div>
  )
}

export default SpeedTestCard
