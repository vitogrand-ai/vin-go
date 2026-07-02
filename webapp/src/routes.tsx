import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { CartPage } from './features/cart/CartPage'
import { GaragePage } from './features/garage/GaragePage'
import { OrderDetailPage } from './features/orders/OrderDetailPage'
import { OrdersPage } from './features/orders/OrdersPage'
import { PayPage } from './features/payment/PayPage'
import { SearchPage } from './features/search/SearchPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { HomePage, RootLayout } from './pages'

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  // Deep-link: /search?vin=... прификлит VIN (используется кнопкой из гаража).
  validateSearch: (search: Record<string, unknown>): { vin?: string } => ({
    vin: typeof search.vin === 'string' ? search.vin : undefined,
  }),
  component: SearchPage,
})

const garageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/garage',
  component: GaragePage,
})

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cart',
  component: CartPage,
})

const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orders',
  component: OrdersPage,
})

const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orders/$id',
  component: OrderDetailPage,
})

const payRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pay',
  component: PayPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  searchRoute,
  garageRoute,
  cartRoute,
  ordersRoute,
  orderDetailRoute,
  payRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
