import { createPaymentProvider } from './payments/factory'
import { PaymentService } from './payments/service'
import { createBackendRuntime, type BackendRuntime } from './runtime'

type CronTask = (runtime: BackendRuntime) => Promise<void>

const cronTasks = {
  noop: async () => {
    console.log('Cron noop task completed.')
  },
  'db:ping': async ({ prisma }) => {
    await prisma.$queryRaw`SELECT 1`
    console.log('Cron db:ping task completed.')
  },
  // Гигиена таблиц, которые растут сами по себе: каждый refresh создаёт новую
  // строку сессии, коды привязки и кэш VIN живут по TTL, сессии бота — пока
  // чат активен. Запускать раз в сутки (systemd-timer или cron).
  'auth:cleanup': async ({ prisma }) => {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const sessions = await prisma.authSession.deleteMany({
      where: { OR: [{ revokedAt: { lt: weekAgo } }, { expiresAt: { lt: weekAgo } }] },
    })
    const codes = await prisma.telegramLinkCode.deleteMany({ where: { expiresAt: { lt: now } } })
    const vins = await prisma.vinDecode.deleteMany({ where: { expiresAt: { lt: now } } })
    const chats = await prisma.botSession.deleteMany({ where: { updatedAt: { lt: monthAgo } } })
    console.log(
      `Cron auth:cleanup: сессий ${sessions.count}, кодов ${codes.count}, ` +
        `VIN-кэша ${vins.count}, чатов бота ${chats.count}.`,
    )
  },
  // Страховка от потерянного webhook: синхронизирует зависшие PENDING-платежи
  // и возвраты со статусом у провайдера. Запускать по расписанию (напр. раз в 5 мин).
  'payments:reconcile': async ({ prisma, env }) => {
    const webappOrigin = env.CORS_ORIGINS[0] ?? 'http://localhost:5173'
    const service = new PaymentService(prisma, createPaymentProvider(env), {
      webappOrigin,
      returnUrl: env.PAYMENT_RETURN_URL ?? `${webappOrigin}/orders`,
    })
    const result = await service.reconcilePending()
    console.log(
      `Cron payments:reconcile: проверено платежей ${result.payments}, возвратов ${result.refunds}.`,
    )
  },
} satisfies Record<string, CronTask>

export type CronTaskName = keyof typeof cronTasks

export async function runCronTask(taskName: string, runtime: BackendRuntime) {
  const task = cronTasks[taskName as CronTaskName]

  if (!task) {
    throw new Error(`Unknown cron task "${taskName}". Available tasks: ${Object.keys(cronTasks).join(', ')}`)
  }

  await task(runtime)
}

export async function main(argv: string[] = Bun.argv.slice(2)) {
  const [taskName] = argv

  if (!taskName) {
    console.error(`Cron task name is required. Available tasks: ${Object.keys(cronTasks).join(', ')}`)
    process.exit(1)
  }

  const runtime = createBackendRuntime()

  try {
    await runCronTask(taskName, runtime)
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
