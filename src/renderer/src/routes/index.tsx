import { Navigate } from 'react-router-dom'
import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement
} from 'react'

const Override = lazy(() => import('@renderer/pages/override'))
const Proxies = lazy(() => import('@renderer/pages/proxies'))
const Rules = lazy(() => import('@renderer/pages/rules'))
const Settings = lazy(() => import('@renderer/pages/settings'))
const Profiles = lazy(() => import('@renderer/pages/profiles'))
const Logs = lazy(() => import('@renderer/pages/logs'))
const Connections = lazy(() => import('@renderer/pages/connections'))
const Mihomo = lazy(() => import('@renderer/pages/mihomo'))
const Sysproxy = lazy(() => import('@renderer/pages/syspeoxy'))
const Tun = lazy(() => import('@renderer/pages/tun'))
const Resources = lazy(() => import('@renderer/pages/resources'))
const DNS = lazy(() => import('@renderer/pages/dns'))
const Sniffer = lazy(() => import('@renderer/pages/sniffer'))
const SubStore = lazy(() => import('@renderer/pages/substore'))
const SpeedTest = lazy(() => import('@renderer/pages/speed-test'))
const CodexTest = lazy(() => import('@renderer/pages/codex-test'))
const GeneralSpeedTest = lazy(() => import('@renderer/pages/general-speed-test'))
const ProcessTest = lazy(() => import('@renderer/pages/process-test'))

function page(Component: LazyExoticComponent<ComponentType>): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center text-sm text-foreground-400">
          正在加载…
        </div>
      }
    >
      <Component />
    </Suspense>
  )
}
const routes = [
  {
    path: '/mihomo',
    element: page(Mihomo)
  },
  {
    path: '/sysproxy',
    element: page(Sysproxy)
  },
  {
    path: '/tun',
    element: page(Tun)
  },
  {
    path: '/proxies',
    element: page(Proxies)
  },
  {
    path: '/rules',
    element: page(Rules)
  },
  {
    path: '/resources',
    element: page(Resources)
  },
  {
    path: '/dns',
    element: page(DNS)
  },
  {
    path: '/sniffer',
    element: page(Sniffer)
  },
  {
    path: '/logs',
    element: page(Logs)
  },
  {
    path: '/speed-test',
    element: page(SpeedTest)
  },
  {
    path: '/speed-test/general',
    element: page(GeneralSpeedTest)
  },
  {
    path: '/speed-test/codex',
    element: page(CodexTest)
  },
  {
    path: '/speed-test/process',
    element: page(ProcessTest)
  },
  {
    path: '/connections',
    element: page(Connections)
  },
  {
    path: '/override',
    element: page(Override)
  },
  {
    path: '/profiles',
    element: page(Profiles)
  },
  {
    path: '/settings',
    element: page(Settings)
  },
  {
    path: '/substore',
    element: page(SubStore)
  },
  {
    path: '/',
    element: <Navigate to="/proxies" />
  }
]

export default routes
