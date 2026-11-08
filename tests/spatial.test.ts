import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../src/world/spatial';
import { Rng } from '../src/runtime/rng';

describe('spatial hash', () => {
  const n = 500;
  const rng = new Rng(9);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    xs[i] = rng.range(0, 800);
    ys[i] = rng.range(0, 600);
  }
  alive[3] = 0;
  const hash = new SpatialHash(32, 800, 600, n);
  hash.rebuild(xs, ys, alive, n);

  it('finds the same k nearest neighbours as brute force', () => {
    const out = new Int32Array(7);
    for (let i = 0; i < n; i += 13) {
      if (!alive[i]) continue;
      const got = Array.from(out.subarray(0, hash.nearestK(i, 7, 80, out)));
      const want = [...Array(n).keys()]
        .filter(j => j !== i && alive[j] && Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) < 80)
        .sort((a, b) => Math.hypot(xs[a] - xs[i], ys[a] - ys[i]) - Math.hypot(xs[b] - xs[i], ys[b] - ys[i]))
        .slice(0, 7);
      expect(got).toEqual(want);
    }
  });

  it('returns everything inside a radius and nothing dead', () => {
    const out = new Int32Array(n);
    const count = hash.queryRadius(400, 300, 90, out);
    const got = Array.from(out.subarray(0, count)).sort((a, b) => a - b);
    const want = [...Array(n).keys()].filter(j => alive[j] && Math.hypot(xs[j] - 400, ys[j] - 300) < 90);
    expect(got).toEqual(want);
  });
});
