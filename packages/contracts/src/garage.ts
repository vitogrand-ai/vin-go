import { z } from 'zod'

import { vehicleSchema, vinSchema } from './catalog'

/** Сохранённый автомобиль в гараже пользователя. */
export const savedVehicleSchema = vehicleSchema.extend({
  id: z.string(),
  nickname: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const addVehicleRequestSchema = z.object({
  vin: vinSchema,
  nickname: z.string().trim().min(1).max(60).optional(),
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
export type AddVehicleRequest = z.infer<typeof addVehicleRequestSchema>
export type RemoveVehicleRequest = z.infer<typeof removeVehicleRequestSchema>
export type GarageResponse = z.infer<typeof garageResponseSchema>
export type VehicleResponse = z.infer<typeof vehicleResponseSchema>
