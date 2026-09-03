import type {
  CreateCustomerRequest,
  CustomerDto,
  CustomerResponse,
  CustomersResponse,
  UpdateCustomerRequest,
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { DbClient } from '../db'
import { AppError } from '../http/errors'

type CustomerRecord = {
  id: string
  name: string
  phone: string | null
  note: string | null
  createdAt: Date
  _count: { vehicles: number; orders: number }
}

const countInclude = { _count: { select: { vehicles: true, orders: true } } }

/**
 * Проверка, что клиент принадлежит автосервису — перед привязкой к авто или
 * заказу. Чужой id (перебор, ошибка клиента) отдаём как «не найден».
 */
export async function requireOrgCustomer(
  db: Pick<DbClient, 'customer'>,
  orgId: string,
  customerId: string,
): Promise<{ id: string }> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, orgId },
    select: { id: true },
  })
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Клиент не найден')
  return customer
}

/**
 * Клиенты автосервиса — владельцы машин. Общие для всех сотрудников
 * организации: приёмщик заводит человека один раз, дальше к нему цепляются
 * авто из гаража и заказы.
 */
export class CustomersService {
  constructor(private readonly db: DbClient) {}

  async list(actor: Pick<Actor, 'orgId'>): Promise<CustomersResponse> {
    const customers = await this.db.customer.findMany({
      where: { orgId: actor.orgId },
      include: countInclude,
      orderBy: { name: 'asc' },
    })
    return { customers: customers.map(toDto) }
  }

  async create(actor: Pick<Actor, 'orgId'>, input: CreateCustomerRequest): Promise<CustomerResponse> {
    const customer = await this.db.customer.create({
      data: {
        orgId: actor.orgId,
        name: input.name,
        phone: input.phone ?? null,
        note: input.note ?? null,
      },
      include: countInclude,
    })
    return { customer: toDto(customer) }
  }

  async update(actor: Pick<Actor, 'orgId'>, input: UpdateCustomerRequest): Promise<CustomerResponse> {
    await requireOrgCustomer(this.db, actor.orgId, input.id)
    const customer = await this.db.customer.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      include: countInclude,
    })
    return { customer: toDto(customer) }
  }

  /** Авто и заказы клиента остаются (связь обнуляется), удаляется только карточка. */
  async remove(actor: Pick<Actor, 'orgId'>, id: string): Promise<void> {
    const result = await this.db.customer.deleteMany({ where: { id, orgId: actor.orgId } })
    if (result.count === 0) throw new AppError(404, 'NOT_FOUND', 'Клиент не найден')
  }
}

function toDto(customer: CustomerRecord): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    note: customer.note,
    vehicleCount: customer._count.vehicles,
    orderCount: customer._count.orders,
    createdAt: customer.createdAt.toISOString(),
  }
}
