import { mobileCursor, mobilePageSize } from './mobile-page';

describe('mobile page size', () => {
  it('defaults to 20 and caps at 50', () => {
    expect(mobilePageSize(undefined)).toBe(20);
    expect(mobilePageSize('10')).toBe(10);
    expect(mobilePageSize('500')).toBe(50);
    expect(mobilePageSize('0')).toBe(1);
    expect(mobilePageSize('nope')).toBe(20);
  });

  it('ignores a device clock value that is not a timestamp', () => {
    expect(mobileCursor(undefined)).toBeUndefined();
    expect(mobileCursor('not-a-date')).toBeUndefined();
    expect(mobileCursor('2026-10-07T08:00:00.000Z')?.toISOString()).toBe(
      '2026-10-07T08:00:00.000Z',
    );
  });
});
