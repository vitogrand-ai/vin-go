import * as SecureStore from 'expo-secure-store'

const REFRESH_KEY = 'vingo_refresh_token'

/** Refresh-токен хранится в защищённом хранилище устройства. */
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY)
}

export async function setRefreshToken(token: string | null): Promise<void> {
  if (token) {
    await SecureStore.setItemAsync(REFRESH_KEY, token)
  } else {
    await SecureStore.deleteItemAsync(REFRESH_KEY)
  }
}
