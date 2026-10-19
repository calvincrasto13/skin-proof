import { describe, expect, it } from 'vitest';
import { flipDensity } from './flip';

// 3×2:  1 2 3
//       4 5 6
const d = { data: new Uint8Array([1, 2, 3, 4, 5, 6]), w: 3, h: 2 };

describe('flipDensity', () => {
  it('mirrors left-right', () => {
    expect([...flipDensity(d, 'h').data]).toEqual([3, 2, 1, 6, 5, 4]);
  });

  it('mirrors top-bottom', () => {
    expect([...flipDensity(d, 'v').data]).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('keeps the size and leaves the original untouched', () => {
    const f = flipDensity(d, 'h');
    expect([f.w, f.h]).toEqual([3, 2]);
    expect([...d.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('undoes itself', () => {
    expect([...flipDensity(flipDensity(d, 'v'), 'v').data]).toEqual([...d.data]);
  });
});
