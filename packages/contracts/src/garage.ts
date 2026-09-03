import { z } from 'zod'

import { plateSchema, vehicleSchema, vinOrFrameSchema } from './catalog'
import { customerBriefSchema } from './customers'

const nicknameSchema = z.string().trim().min(1).max(60)
/** Пробег в километрах; 2 млн — заведомо опечатка. */
export const mileageKmSchema = z.number().int().min(0).max(2_000_000)

/** Автомобиль в гараже автосервиса: VIN, госномер, пробег и клиент-владелец. */
export const savedVehicleSchema = vehicleSchema.extend({
  id: z.string(),
  nickname: z.string().nullable(),
  plate: z.string().nullable(),
  mileageKm: z.number().int().nullable(),
  customer: customerBriefSchema.nullable(),
  createdAt: z.string().datetime(),
})

export const addVehicleRequestSchema = z.object({
  vin: vinOrFrameSchema,
  nickname: nicknameSchema.optional(),
  plate: plateSchema.optional(),
  mileageKm: mileageKmSchema.optional(),
  customerId: z.string().min(1).optional(),
})

/** Правка карточки авто: null очищает поле, отсутствие — не трогает. */
export const updateVehicleRequestSchema = z.object({
  id: z.string().min(1),
  nickname: nicknameSchema.nullable().optional(),
  plate: plateSchema.nullable().optional(),
  mileageKm: mileageKmSchema.nullable().optional(),
  customerId: z.string().min(1).nullable().optional(),
})

export const removeVehicleRequestSchema = z.object({
  id: z.string().min(1),
})

export const garageResponseSchema = z.object({
  vehicles: z.array(savedVehicleSchema),
})

export const vehicleResponseSchema = z.object({
  vehicle: savedVehicleSchema,
})

export type SavedVehicle = z.infer<typeof savedVehicleSchema>
export type AddVehicleRequest = z.input<typeof addVehicleRequestSchema>
export type UpdateVehicleRequest = z.input<typeof updateVehicleRequestSchema>
export type RemoveVehicleRequest = z.infer<typeof removeVehicleRequestSchema>
export type GarageResponse = z.infer<typeof garageResponseSchema>
export type VehicleResponse = z.infer<typeof vehicleResponseSchema>
