import { describe, expect, test } from 'bun:test'

import { clientIpFromHeaders, isYooKassaWebhookIp } from './webhook-ip'

describe('isYooKassaWebhookIp', () => {
  test('IP внутри диапазона /27 разрешён', () => {
    expect(isYooKassaWebhookIp('185.71.76.0')).toBe(true)
    expect(isYooKassaWebhookIp('185.71.76.31')).toBe(true)
  })

  test('IP вне диапазона /27 отклоняется', () => {
    expect(isYooKassaWebhookIp('185.71.76.32')).toBe(false)
    expect(isYooKassaWebhookIp('185.71.78.1')).toBe(false)
  })

  test('одиночные /32-адреса ЮKassa разрешены', () => {
    expect(isYooKassaWebhookIp('77.75.156.11')).toBe(true)
    expect(isYooKassaWebhookIp('77.75.156.12')).toBe(false)
  })

  test('произвольный внешний IP отклоняется', () => {
    expect(isYooKassaWebhookIp('8.8.8.8')).toBe(false)
    expect(isYooKassaWebhookIp('127.0.0.1')).toBe(false)
    expect(isYooKassaWebhookIp('')).toBe(false)
  })

  test('IPv4-mapped IPv6 разбирается по IPv4-части', () => {
    expect(isYooKassaWebhookIp('::ffff:185.71.76.5')).toBe(true)
    expect(isYooKassaWebhookIp('::ffff:8.8.8.8')).toBe(false)
  })

  test('документированный IPv6-префикс ЮKassa разрешён', () => {
    expect(isYooKassaWebhookIp('2a02:5180:0:1234::1')).toBe(true)
    expect(isYooKassaWebhookIp('2a03:0:0:0::1')).toBe(false)
  })
})

describe('clientIpFromHeaders', () => {
  test('берёт первый (левый) адрес из X-Forwarded-For', () => {
    expect(clientIpFromHeaders('185.71.76.5, 10.0.0.1, 10.0.0.2')).toBe('185.71.76.5')
  })

  test('падает на X-Real-IP, если X-Forwarded-For пуст', () => {
    expect(clientIpFromHeaders(undefined, '185.71.76.5')).toBe('185.71.76.5')
  })

  test('null, если заголовков нет', () => {
    expect(clientIpFromHeaders(undefined, undefined)).toBeNull()
  })
})
