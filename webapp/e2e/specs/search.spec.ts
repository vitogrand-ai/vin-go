import { expect, test } from '../helpers/test'

test('поиск подсказывает, какого поля не хватает, и находит запчасти по демо-VIN', async ({
  page,
}) => {
  await page.goto('/search')

  const submit = page.getByRole('button', { name: 'Найти' })
  const vinInput = page.getByPlaceholder('WVWZZZ1JZ3W386752')
  const queryInput = page.getByPlaceholder('тормозные колодки')

  // Пустая форма: кнопка активна и объясняет, чего не хватает, — начиная с VIN.
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText('Введите VIN автомобиля')

  // VIN заполнен, запчасть — нет: подсказка переезжает на второе поле.
  await vinInput.fill('WVWZZZ1JZ3W386752')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText(/Укажите, что ищем/)
  await expect(queryInput).toBeFocused()

  // Оба поля заполнены — подбор отрабатывает.
  await queryInput.fill('тормозные колодки')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await submit.click()

  await expect(page.getByText('Golf IV')).toBeVisible()
  await expect(page.getByRole('button', { name: /Колодки тормозные передние/ })).toBeVisible()
})
