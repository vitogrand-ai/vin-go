# VINGO — мобильное приложение (Expo)

Нативное приложение (Этап 5, MVP): **вход + поиск по VIN + три тира** (Эконом /
Оптимальный / Оригинал). Переиспользует тот же backend API, что веб и бот.

## Особенности скаффолда

- Standalone Expo-проект (не часть bun-workspace) — устойчиво запускается в Expo Go.
- Без роутер-библиотек: экраны Вход / Поиск переключаются по состоянию авторизации.
- Минимум зависимостей: `expo`, `react-native`, `@tanstack/react-query`, `zod`,
  `expo-secure-store` (refresh-токен).
- `src/contracts.ts` — локальное зеркало нужных схем из `@web-app-demo/contracts`
  (auth + catalog). При изменении общих контрактов синхронизируйте вручную.

## Запуск

> На этой машине нет виртуализации — Android-эмулятор не поднимется, iOS на Windows
> невозможен. Запускайте на телефоне через **Expo Go**.

1. Поднимите backend (см. корневой README): `bun run dev:backend`.
2. Узнайте LAN-IP машины (например, `192.168.1.50`) и задайте адрес API телефону:
   ```bash
   # PowerShell
   $env:EXPO_PUBLIC_API_URL = "http://192.168.1.50:3000"
   ```
   Телефон и компьютер должны быть в одной Wi‑Fi сети. `localhost` с телефона не работает.
3. Установите зависимости и запустите Metro:
   ```bash
   cd mobile
   npm install     # или: bun install
   npx expo start
   ```
4. Откройте приложение Expo Go на телефоне и отсканируйте QR-код.

## Push-уведомления

Приложение регистрирует Expo push-токен в бэкенде (`/api/devices/register`) после
входа и отзывает его при выходе (`/api/devices/unregister`). На переднем плане
уведомления показываются через `Notifications.setNotificationHandler`, на Android
создаётся канал `default`.

**projectId (обязателен для получения токена вне EAS-сборки).**
`getExpoPushTokenAsync` требует идентификатор EAS-проекта. Варианты:

- **EAS-сборка или залинкованный Expo Go** — выполните `eas init`; он пропишет
  `extra.eas.projectId` в `app.json`, и токен подхватывается автоматически, код
  менять не нужно.
- **Дев-клиент / Expo Go без линковки** — задайте переменную окружения (как
  `EXPO_PUBLIC_API_URL`):
  ```bash
  # PowerShell
  $env:EXPO_PUBLIC_PROJECT_ID = "<uuid из настроек EAS-проекта>"
  ```

Без projectId регистрация токена молча пропускается (push не критичен) — в логах
Expo будет `No projectId found`.

## Дальше

Гараж, корзина, заказы и оплата — отдельным этапом (API на бэкенде уже готов).
