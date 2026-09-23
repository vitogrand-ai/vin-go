import { describe, expect, it } from 'bun:test'

import { officialCatalogForVin } from './official-catalogs'

describe('официальные каталоги заводов по WMI', () => {
  it('УАЗ (XTT) → заводской PDF', () => {
    const found = officialCatalogForVin('XTT316300F1234567')
    expect(found?.brand).toBe('УАЗ')
    expect(found?.url).toContain('uaz.ru')
  })

  it('регистр не важен', () => {
    expect(officialCatalogForVin('xta219010J1234567')?.brand).toBe('LADA')
  })

  it('КАМАЗ (XTC) → магазин завода', () => {
    expect(officialCatalogForVin('XTC541150A1234567')?.url).toContain('shop.kamaz.ru')
  })

  it('иностранный WMI — подсказки нет', () => {
    expect(officialCatalogForVin('WVWZZZ1KZBW000001')).toBeNull()
  })

  it('frame-номер JDM — подсказки нет (WMI у него не бывает)', () => {
    expect(officialCatalogForVin('SXA10-0012345')).toBeNull()
  })
})
