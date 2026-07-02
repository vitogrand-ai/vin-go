import type { AppEnv } from '../env'
import { MockPaymentProvider, type PaymentProvider } from './providers'
import { YooKassaPaymentProvider } from './yookassa-provider'

/**
 * Выбор платёжного провайдера по конфигурации. Боевой ЮKassa включается при
 * заданных YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY, иначе — мок (Этап 3).
 * Единая точка для app.ts и cron (reconcile), чтобы выбор не расходился.
 */
export function createPaymentProvider(env: AppEnv): PaymentProvider {
  if (env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY) {
    return new YooKassaPaymentProvider(env.YOOKASSA_SHOP_ID, env.YOOKASSA_SECRET_KEY)
  }
  return new MockPaymentProvider()
}
