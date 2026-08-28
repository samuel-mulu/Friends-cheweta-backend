import { normalizeEthiopianPhone } from './phone.util';

describe('normalizeEthiopianPhone', () => {
  it.each([
    ['0911123456', '251911123456'],
    ['911123456', '251911123456'],
    ['+251 911 123 456', '251911123456'],
    ['0711123456', '251711123456'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeEthiopianPhone(input)).toBe(expected);
  });

  it('rejects invalid numbers', () => {
    expect(() => normalizeEthiopianPhone('123')).toThrow();
  });
});
