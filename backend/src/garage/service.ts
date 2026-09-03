import {
  addVehicleRequestSchema,
  updateVehicleRequestSchema,
  type AddVehicleRequest,
  type GarageResponse,
  type SavedVehicle,
  type UpdateVehicleRequest,
  type VehicleResponse,
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { CatalogProvider } from '../catalog/providers'
import { requireOrgCustomer } from '../customers/service'
import type { DbClient } from '../db'
import { AppError } from '../http/errors'

type VehicleRecord = {
  id: string
  vin: string
  plate: string | null
  mileageKm: number | null
  make: string
  model: string
  year: number | null
  engine: string | null
  bodyType: string | null
  nickname: string | null
  createdAt: Date
  customer: { id: string; name: string; phone: string | null } | null
}

const customerInclude = { customer: { select: { id: true, name: true, phone: true } } }

/**
 * Гараж автосервиса: машины клиентов, общие для всех сотрудников организации.
 * При добавлении VIN расшифровывается провайдером каталога и карточка
 * сохраняется снимком; госномер, пробег и владелец — то, что приёмщик знает
 * сам и по чему потом находит машину.
 */
export class GarageService {
  constructor(
    private readonly db: DbClient,
    private readonly catalog: CatalogProvider,
  ) {}

  async list(actor: Pick<Actor, 'orgId'>): Promise<GarageResponse> {
    const vehicles = await this.db.vehicle.findMany({
      where: { orgId: actor.orgId },
      include: customerInclude,
      orderBy: { createdAt: 'desc' },
    })
    return { vehicles: vehicles.map(toSavedVehicle) }
  }

  async add(actor: Actor, rawInput: AddVehicleRequest): Promise<VehicleResponse> {
    // Роут уже валидировал тело, но сервис зовут и напрямую (бот, тесты) —
    // нормализуем госномер и VIN здесь же, чтобы ключ уникальности был стабилен.
    const input = addVehicleRequestSchema.parse(rawInput)
    const decoded = await this.catalog.decodeVin(input.vin)
    if (!decoded) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому VIN не найден')
    }
    if (input.customerId) await requireOrgCustomer(this.db, actor.orgId, input.customerId)

    const snapshot = {
      make: decoded.make,
      model: decoded.model,
      year: decoded.year,
      engine: decoded.engine,
      bodyType: decoded.bodyType,
    }
    // Повторное добавление той же машины дополняет карточку только тем, что
    // прислали: молчание про пробег не должно стирать известный пробег.
    const provided = {
      ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
      ...(input.plate !== undefined ? { plate: input.plate } : {}),
      ...(input.mileageKm !== undefined ? { mileageKm: input.mileageKm } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    }

    const record = await this.db.vehicle.upsert({
      where: { orgId_vin: { orgId: actor.orgId, vin: input.vin } },
      create: {
        userId: actor.userId,
        orgId: actor.orgId,
        vin: input.vin,
        nickname: input.nickname ?? null,
        plate: input.plate ?? null,
        mileageKm: input.mileageKm ?? null,
        customerId: input.customerId ?? null,
        ...snapshot,
      },
      update: { ...snapshot, ...provided },
      include: customerInclude,
    })

    return { vehicle: toSavedVehicle(record) }
  }

  /** Правка карточки: null очищает поле, отсутствие ключа — не трогает. */
  async update(actor: Pick<Actor, 'orgId'>, rawInput: UpdateVehicleRequest): Promise<VehicleResponse> {
    const input = updateVehicleRequestSchema.parse(rawInput)
    const existing = await this.db.vehicle.findFirst({
      where: { id: input.id, orgId: actor.orgId },
      select: { id: true },
    })
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль не найден')
    }
    if (input.customerId) await requireOrgCustomer(this.db, actor.orgId, input.customerId)

    const record = await this.db.vehicle.update({
      where: { id: input.id },
      data: {
        ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
        ...(input.plate !== undefined ? { plate: input.plate } : {}),
        ...(input.mileageKm !== undefined ? { mileageKm: input.mileageKm } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      },
      include: customerInclude,
    })
    return { vehicle: toSavedVehicle(record) }
  }

  async remove(actor: Pick<Actor, 'orgId'>, id: string): Promise<void> {
    const result = await this.db.vehicle.deleteMany({ where: { id, orgId: actor.orgId } })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль не найден')
    }
  }
}

function toSavedVehicle(record: VehicleRecord): SavedVehicle {
  return {
    id: record.id,
    vin: record.vin,
    plate: record.plate,
    mileageKm: record.mileageKm,
    make: record.make,
    model: record.model,
    year: record.year,
    engine: record.engine,
    bodyType: record.bodyType,
    nickname: record.nickname,
    customer: record.customer,
    createdAt: record.createdAt.toISOString(),
  }
}
