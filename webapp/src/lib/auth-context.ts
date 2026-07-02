import { createContext } from 'react'
import type { LoginRequest, RegisterRequest, UserDto } from '@web-app-demo/contracts'

import type { ApiClient } from './api'

export type AuthContextValue = {
  user: UserDto | null
  isBootstrapping: boolean
  isAuthenticated: boolean
  /** Авторизованный клиент для защищённых запросов (гараж, корзина, заказы). */
  api: ApiClient
  register: (input: RegisterRequest) => Promise<void>
  login: (input: LoginRequest) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
