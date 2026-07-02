import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { ApiClient } from './api'
import type { User } from './contracts'
import { getRefreshToken, setRefreshToken } from './storage'

type AuthContextValue = {
  user: User | null
  isBootstrapping: boolean
  api: ApiClient
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const apiRef = useRef(new ApiClient())
  const api = apiRef.current
  const [user, setUser] = useState<User | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)

  // Восстановление сессии: refresh-токен → access → профиль.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const refreshToken = await getRefreshToken()
        if (!refreshToken) return
        const refreshed = await api.refresh(refreshToken)
        if (!active) return
        api.setAccessToken(refreshed.accessToken)
        if (refreshed.refreshToken) await setRefreshToken(refreshed.refreshToken)
        const me = await api.me()
        if (active) setUser(me.user)
      } catch {
        await setRefreshToken(null)
        api.setAccessToken(null)
      } finally {
        if (active) setIsBootstrapping(false)
      }
    })()
    return () => {
      active = false
    }
  }, [api])

  const applyAuth = async (response: Awaited<ReturnType<ApiClient['login']>>) => {
    api.setAccessToken(response.accessToken)
    if (response.refreshToken) await setRefreshToken(response.refreshToken)
    setUser(response.user)
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isBootstrapping,
      api,
      login: async (email, password) => applyAuth(await api.login({ email, password })),
      register: async (email, password) => applyAuth(await api.register({ email, password })),
      logout: async () => {
        const refreshToken = await getRefreshToken()
        await api.logout(refreshToken)
        await setRefreshToken(null)
        api.setAccessToken(null)
        setUser(null)
      },
    }),
    [api, isBootstrapping, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth должен использоваться внутри AuthProvider')
  return context
}
