import { e2ePassword, expect, test, uniqueEmail } from '../helpers/test'

test('регистрация, восстановление сессии, кабинет и выход', async ({ page }) => {
  const email = uniqueEmail()
  const displayName = 'Web E2E User'
  const greeting = new RegExp(`Здравствуйте, ${displayName}`)

  await page.goto('/')

  await expect(page.getByRole('heading', { name: /Автозапчасти по VIN/i })).toBeVisible()
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  // Сообщения валидации приходят из Zod-контрактов (пока на английском).
  await expect(page.getByText('Invalid email address')).toBeVisible()
  await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()

  await page.getByLabel('Имя').fill('A')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(e2ePassword)
  await page.getByRole('tab', { name: 'Вход' }).click()
  await expect(page.getByLabel('Имя')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled()

  await page.getByRole('tab', { name: 'Регистрация' }).click()
  await page.getByLabel('Имя').fill(displayName)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(e2ePassword)
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()

  // После регистрации — дашборд кабинета (заменил служебный /app).
  await expect(page.getByRole('heading', { name: greeting })).toBeVisible()
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === 'web_app_demo_refresh' && cookie.httpOnly,
      ),
    )
    .toBe(true)

  const refreshAfterReload = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/refresh') && response.request().method() === 'POST',
  )
  const meAfterReload = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/me') && response.request().method() === 'GET',
  )

  await page.reload()

  await expect((await refreshAfterReload).status()).toBe(200)
  await expect((await meAfterReload).status()).toBe(200)
  await expect(page.getByRole('heading', { name: greeting })).toBeVisible()

  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page.getByRole('heading', { name: /Автозапчасти по VIN/i })).toBeVisible()

  await page.getByRole('tab', { name: 'Вход' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill('wrong-password')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByText('Invalid email or password')).toBeVisible()

  await page.getByLabel('Пароль').fill(e2ePassword)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('heading', { name: greeting })).toBeVisible()
})
