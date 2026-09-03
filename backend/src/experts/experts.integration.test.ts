import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ExpertRequestResponse, ExpertRequestsResponse } from '@web-app-demo/contracts'

import { createApp } from '../app'
import { createPrisma } from '../db'
import type { AppEnv } from '../env'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

const DEMO_VIN = 'WVWZZZ1JZ3W386752'

maybeDescribe('заявки эксперту: автосервис → оператор → ответ', () => {
  const env: AppEnv = {
    PORT: 3000,
    DATABASE_URL: databaseUrl!,
    JWT_SECRET: '12345678901234567890123456789012',
    CORS_ORIGINS: ['http://localhost:5173'],
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    COOKIE_SECURE: false,
    YOOKASSA_WEBHOOK_IP_ALLOWLIST: false,
    SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    SPACES_UPLOAD_URL_TTL_SECONDS: 900,
    SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
    SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
  }
  const prisma = createPrisma(databaseUrl!)
  const app = createApp({ env, prisma })

  async function reset() {
    await prisma.expertRequest.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
    await prisma.organization.deleteMany()
  }

  async function register(email: string): Promise<string> {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
      body: JSON.stringify({ email, password: 'password123' }),
    })
    return ((await res.json()) as { accessToken: string }).accessToken
  }

  function authed(token: string, path: string, body?: unknown) {
    return app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  beforeEach(reset)
  afterAll(reset)

  test('сотрудник создаёт заявку с карточкой авто, чужой автосервис её не видит', async () => {
    const shop = await register('shop@example.com')
    const other = await register('other@example.com')

    const created = await authed(shop, '/api/experts/requests', {
      vin: DEMO_VIN,
      query: 'маслоотделитель',
      comment: 'Каталог молчит, нужен номер под 1.6 MPI',
    })
    expect(created.status).toBe(201)
    const { request } = (await created.json()) as ExpertRequestResponse
    expect(request.status).toBe('NEW')
    expect(request.number).toBeGreaterThan(0)
    expect(request.vehicle?.make).toBe('Volkswagen')
    expect(request.orgName).toContain('Автосервис')

    const mine = (await (await authed(shop, '/api/experts/requests')).json()) as ExpertRequestsResponse
    expect(mine.requests).toHaveLength(1)

    const foreign = (await (await authed(other, '/api/experts/requests')).json()) as ExpertRequestsResponse
    expect(foreign.requests).toHaveLength(0)
    expect((await authed(other, `/api/experts/requests/${request.id}`)).status).toBe(404)
  })

  test('отвечает только оператор платформы; ответ с номерами виден автору', async () => {
    const shop = await register('shop@example.com')
    const { request } = (await (
      await authed(shop, '/api/experts/requests', { vin: DEMO_VIN, query: 'гранатка' })
    ).json()) as ExpertRequestResponse

    // Сотрудник автосервиса ответить не может.
    const forbidden = await authed(shop, '/api/experts/requests/answer', {
      id: request.id,
      status: 'ANSWERED',
      answerText: 'сам себе',
    })
    expect(forbidden.status).toBe(403)

    // Оператор платформы видит очередь и отвечает.
    const operator = await register('operator@example.com')
    await prisma.user.update({ where: { email: 'operator@example.com' }, data: { role: 'OPERATOR' } })
    const queue = (await (await authed(operator, '/api/experts/requests')).json()) as ExpertRequestsResponse
    expect(queue.requests.map((item) => item.id)).toContain(request.id)

    const answered = (await (
      await authed(operator, '/api/experts/requests/answer', {
        id: request.id,
        status: 'ANSWERED',
        answerText: 'ШРУС наружный, подходит и аналог GKN',
        answerOems: ['1k0407271aa', ' 1K0498099 '],
      })
    ).json()) as ExpertRequestResponse
    expect(answered.request.status).toBe('ANSWERED')
    expect(answered.request.answerOems).toEqual(['1K0407271AA', '1K0498099'])
    expect(answered.request.answeredAt).not.toBeNull()

    const mine = (await (await authed(shop, '/api/experts/requests')).json()) as ExpertRequestsResponse
    expect(mine.requests[0]?.answerText).toContain('ШРУС')
  })

  test('заявка без описания отклоняется валидацией', async () => {
    const shop = await register('shop@example.com')
    const res = await authed(shop, '/api/experts/requests', { vin: DEMO_VIN, query: '   ' })
    expect(res.status).toBe(400)
  })
})
