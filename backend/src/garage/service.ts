import type {
  AddVehicleRequest,
  GarageResponse,
  SavedVehicle,
  VehicleResponse,
} from '@web-app-demo/contracts'

import type { CatalogProvider } from '../catalog/providers'
import type { DbClient } from '../db'
import { AppError } from '../http/errors'

type VehicleRecord = {
  id: string
  vin: string
  make: string
  model: string
  year: number
  engine: string | null
  bodyType: string | null
  nickname: string | null
  createdAt: Date
}

/**
 * Гараж: сохранённые автомобили пользователя. При добавлении VIN
 * расшифровывается провайдером каталога, и карточка сохраняется снимком.
 */
export class GarageService {
  constructor(
    private readonly db: DbClient,
    private readonly catalog: CatalogProvider,
  ) {}

  async list(userId: string): Promise<GarageResponse> {
    const vehicles = await this.db.vehicle.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return { vehicles: vehicles.map(toSavedVehicle) }
  }

  async add(userId: string, input: AddVehicleRequest): Promise<VehicleResponse> {
    const decoded = await this.catalog.decodeVin(input.vin)
    if (!decoded) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому VIN не найден')
    }

    const data = {
      make: decoded.make,
      model: decoded.model,
      year: decoded.year,
      engine: decoded.engine,
      bodyType: decoded.bodyType,
      nickname: input.nickname ?? null,
    }

    const record = await this.db.vehicle.upsert({
      where: { userId_vin: { userId, vin: input.vin } },
      create: { userId, vin: input.vin, ...data },
      update: data,
    })

    return { vehicle: toSavedVehicle(record) }
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.db.vehicle.deleteMany({ where: { id, userId } })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль не найден')
    }
  }
}

function toSavedVehicle(record: VehicleRecord): SavedVehicle {
  return {
    id: record.id,
    vin: record.vin,
    make: record.make,
    model: record.model,
    year: record.year,
    engine: record.engine,
    bodyType: record.bodyType,
    nickname: record.nickname,
    createdAt: record.createdAt.toISOString(),
  }
}
