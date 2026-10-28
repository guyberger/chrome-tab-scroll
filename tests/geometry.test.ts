import { describe, expect, it } from 'vitest';
import { centerIn } from '../src/background/geometry';

const SIZE = { width: 820, height: 240 };

describe('centring the fallback window', () => {
  it('centres on the browser window', () => {
    expect(centerIn({ left: 0, top: 0, width: 1200, height: 800 }, SIZE)).toEqual({
      left: 190,
      top: 280,
    });
  });

  it('offsets by the browser window position', () => {
    expect(centerIn({ left: 100, top: 50, width: 1200, height: 800 }, SIZE)).toEqual({
      left: 290,
      top: 330,
    });
  });

  // A monitor to the left of the primary one has negative coordinates, so
  // clamping to zero would throw the popup onto the wrong screen.
  it('keeps negative coordinates for a monitor left of the primary', () => {
    expect(centerIn({ left: -1920, top: 0, width: 1920, height: 1080 }, SIZE)).toEqual({
      left: -1370,
      top: 420,
    });
  });

  it('handles a monitor above the primary', () => {
    expect(centerIn({ left: 0, top: -1080, width: 1920, height: 1080 }, SIZE)).toEqual({
      left: 550,
      top: -660,
    });
  });

  it('handles a monitor to the right', () => {
    const placement = centerIn({ left: 2560, top: 0, width: 1440, height: 900 }, SIZE);
    expect(placement.left).toBe(2870);
    expect(placement.top).toBe(330);
  });

  it('rounds to whole pixels', () => {
    const placement = centerIn({ left: 0, top: 0, width: 1001, height: 601 }, SIZE);
    expect(Number.isInteger(placement.left)).toBe(true);
    expect(Number.isInteger(placement.top)).toBe(true);
  });

  it('copes with a browser window smaller than the popup', () => {
    expect(centerIn({ left: 0, top: 0, width: 400, height: 200 }, SIZE)).toEqual({
      left: -210,
      top: -20,
    });
  });

  it('lets Chrome place it when bounds are unusable', () => {
    expect(centerIn(undefined, SIZE)).toEqual({});
    expect(centerIn({}, SIZE)).toEqual({});
    expect(centerIn({ left: 0, top: 0 }, SIZE)).toEqual({});
    expect(centerIn({ left: NaN, top: 0, width: 100, height: 100 }, SIZE)).toEqual({});
  });
});
