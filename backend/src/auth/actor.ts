import type { OrgRole, UserRole } from '@web-app-demo/contracts'

/**
 * Кто выполняет запрос. Собирается в `requireAuth` и передаётся в сервисы
 * вместо голого userId: почти каждое действие в кабинете — про автосервис
 * (общий гараж, клиенты, заказы), а не про отдельного сотрудника.
 *
 * `role` — платформенная роль (OPERATOR = сотрудник VINGO, видит заказы всех
 * автосервисов), `orgRole` — роль внутри автосервиса (OWNER управляет
 * настройками и наценкой).
 */
export type Actor = {
  userId: string
  orgId: string
  role: UserRole
  orgRole: OrgRole
}
