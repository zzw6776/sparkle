import { Card, CardBody } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { MdDownload, MdLan, MdOutlineArrowForward, MdSpeed } from 'react-icons/md'
import { useNavigate } from 'react-router-dom'

const SpeedTest: React.FC = () => {
  const navigate = useNavigate()

  return (
    <BasePage title="测速中心">
      <div className="mx-auto grid w-full max-w-4xl gap-4 p-4 md:grid-cols-2">
        <Card isPressable onPress={() => navigate('/speed-test/general')} className="bg-content2">
          <CardBody className="flex min-h-48 flex-col justify-between gap-6 p-5">
            <div>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <MdDownload className="text-2xl" />
              </div>
              <h2 className="text-xl font-semibold">普通测速</h2>
              <p className="mt-2 text-sm leading-6 text-foreground-500">
                在独立页面测试节点延迟和真实下载速度；代理组页面的原有测速入口仍然保留。
              </p>
            </div>
            <div className="flex items-center gap-1 self-start rounded-xl bg-primary/15 px-3 py-2 text-sm font-medium text-primary">
              开始普通测速
              <MdOutlineArrowForward />
            </div>
          </CardBody>
        </Card>

        <Card isPressable onPress={() => navigate('/speed-test/codex')} className="bg-content2">
          <CardBody className="flex min-h-48 flex-col justify-between gap-6 p-5">
            <div>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-secondary/15 text-secondary">
                <MdSpeed className="text-2xl" />
              </div>
              <h2 className="text-xl font-semibold">Codex 测试</h2>
              <p className="mt-2 text-sm leading-6 text-foreground-500">
                支持 TLS、HTTPS、WebSocket 链路测试，并可使用已登录的 Codex
                执行真实响应测试，比较首字和完整返回速度。
              </p>
            </div>
            <div className="flex items-center gap-1 self-start rounded-xl bg-secondary/15 px-3 py-2 text-sm font-medium text-secondary">
              开始专项测试
              <MdOutlineArrowForward />
            </div>
          </CardBody>
        </Card>

        <Card isPressable onPress={() => navigate('/speed-test/process')} className="bg-content2">
          <CardBody className="flex min-h-48 flex-col justify-between gap-6 p-5">
            <div>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-success/15 text-success">
                <MdLan className="text-2xl" />
              </div>
              <h2 className="text-xl font-semibold">进程测速</h2>
              <p className="mt-2 text-sm leading-6 text-foreground-500">
                根据连接监控记录的真实域名，批量比较各节点连接指定进程目标的速度和成功率。
              </p>
            </div>
            <div className="flex items-center gap-1 self-start rounded-xl bg-success/15 px-3 py-2 text-sm font-medium text-success">
              选择进程测速
              <MdOutlineArrowForward />
            </div>
          </CardBody>
        </Card>
      </div>
    </BasePage>
  )
}

export default SpeedTest
