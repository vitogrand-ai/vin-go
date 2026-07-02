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
