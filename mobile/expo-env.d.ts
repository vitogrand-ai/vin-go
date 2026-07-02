/// <reference types="expo/types" />

// Типизация публичных env-переменных Expo (инлайнятся при сборке).
declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string
  } & Record<string, string | undefined>
}
