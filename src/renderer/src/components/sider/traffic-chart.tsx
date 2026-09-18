import React, { useId, useImperativeHandle, useMemo, useRef } from 'react'

export interface TrafficChartProps {
  isActive: boolean
}

export interface TrafficChartHandle {
  push(traffic: number): void
}

const viewBoxWidth = 100
const viewBoxHeight = 100
const chartTop = 50

interface Point {
  x: number
  y: number
}

function sign(value: number): number {
  return value < 0 ? -1 : 1
}

// Steffen monotone interpolation, matching the curve used by Recharts for `type="monotone"`.
function createMonotoneAreaPath(values: number[]): string {
  const maxTraffic = Math.max(...values, 1)
  const points: Point[] = values.map((traffic, index) => ({
    x: (index / (values.length - 1)) * 100,
    y: 100 - (traffic / maxTraffic) * 50
  }))
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y} L 100 100 L 0 100 Z`
  }
  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index]
    return (point.y - previous.y) / (point.x - previous.x)
  })
  const tangents = points.map((_, index) => {
    if (index === 0 || index === points.length - 1) return 0

    const previousWidth = points[index].x - points[index - 1].x
    const nextWidth = points[index + 1].x - points[index].x
    const previousSlope = slopes[index - 1]
    const nextSlope = slopes[index]
    const weightedSlope =
      (previousSlope * nextWidth + nextSlope * previousWidth) / (previousWidth + nextWidth)
    return (
      (sign(previousSlope) + sign(nextSlope)) *
        Math.min(Math.abs(previousSlope), Math.abs(nextSlope), 0.5 * Math.abs(weightedSlope)) || 0
    )
  })
  tangents[0] = (3 * slopes[0] - tangents[1]) / 2
  tangents[tangents.length - 1] =
    (3 * slopes[slopes.length - 1] - tangents[tangents.length - 2]) / 2
  const curve = points
    .slice(1)
    .map((point, index) => {
      const previous = points[index]
      const width = point.x - previous.x
      return [
        'C',
        previous.x + width / 3,
        previous.y + (tangents[index] * width) / 3,
        point.x - width / 3,
        point.y - (tangents[index + 1] * width) / 3,
        point.x,
        point.y
      ].join(' ')
    })
    .join(' ')

  return `M ${points[0].x} ${points[0].y} ${curve} L 100 100 L 0 100 Z`
}

const TrafficChart = React.forwardRef<TrafficChartHandle, TrafficChartProps>(function TrafficChart(
  { isActive },
  ref
) {
  const gradientId = `traffic-gradient-${useId().replaceAll(':', '')}`
  const trafficRef = useRef(Array<number>(10).fill(0))
  const pathRef = useRef<SVGPathElement>(null)
  const initialAreaPath = useMemo(() => createMonotoneAreaPath(trafficRef.current), [])
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
        pathRef.current?.setAttribute('d', createMonotoneAreaPath(values))
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
