import type { RegisterDeviceRequest } from '@web-app-demo/contracts'

import type { DbClient } from '../db'

/** Регистрация push-токенов устройств. */
export class DeviceService {
  constructor(private readonly db: DbClient) {}

  async register(userId: string, input: RegisterDeviceRequest): Promise<void> {
    // Токен уникален: если он уже принадлежал другому пользователю, переносим.
    await this.db.deviceToken.upsert({
      where: { token: input.token },
      create: { userId, token: input.token, platform: input.platform ?? null },
      update: { userId, platform: input.platform ?? null },
    })
  }

  /** Отзыв токена устройства при выходе (удаляем только свой токен). */
  async unregister(userId: string, token: string): Promise<void> {
    await this.db.deviceToken.deleteMany({ where: { token, userId } })
  }
}
