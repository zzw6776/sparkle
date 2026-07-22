import React, { useId, useImperativeHandle, useMemo, useRef } from 'react'

export interface TrafficChartProps {
  isActive: boolean
}

export interface TrafficChartHandle {
  push(traffic: number): void
}

const viewBoxWidth = 100
const viewBoxHeight = 100
const chartTop = 48

function createAreaPath(data: number[]): string {
  if (data.length === 0) return `M 0 ${viewBoxHeight} L ${viewBoxWidth} ${viewBoxHeight} Z`

  const maxTraffic = Math.max(1, ...data)
  const pointCount = data.length
  const points = data.map((traffic, index) => ({
    x: pointCount === 1 ? viewBoxWidth : (index / (pointCount - 1)) * viewBoxWidth,
    y: viewBoxHeight - (Math.max(0, traffic) / maxTraffic) * (viewBoxHeight - chartTop)
  }))

  let path = `M 0 ${viewBoxHeight} L ${points[0].x} ${points[0].y}`

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const controlX = (previous.x + current.x) / 2
    path += ` C ${controlX} ${previous.y}, ${controlX} ${current.y}, ${current.x} ${current.y}`
  }

  return `${path} L ${viewBoxWidth} ${viewBoxHeight} Z`
}

const TrafficChart = React.forwardRef<TrafficChartHandle, TrafficChartProps>(function TrafficChart(
  { isActive },
  ref
) {
  const gradientId = `traffic-gradient-${useId().replaceAll(':', '')}`
  const trafficRef = useRef(Array<number>(10).fill(0))
  const pathRef = useRef<SVGPathElement>(null)
  const initialAreaPath = useMemo(() => createAreaPath(trafficRef.current), [])
  const chartColor = isActive
    ? 'hsl(var(--heroui-primary-foreground))'
    : 'hsl(var(--heroui-foreground))'

  useImperativeHandle(
    ref,
    () => ({
      push(traffic: number): void {
        const values = trafficRef.current
        values.copyWithin(0, 1)
        values[values.length - 1] = Math.max(0, traffic)
        pathRef.current?.setAttribute('d', createAreaPath(values))
      }
    }),
    []
  )

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-hidden rounded-[14px]"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1={chartTop}
          x2="0"
          y2={viewBoxHeight}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={chartColor} stopOpacity={0.8} />
          <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path ref={pathRef} d={initialAreaPath} stroke="none" fill={`url(#${gradientId})`} />
    </svg>
  )
})

export default React.memo(TrafficChart)
