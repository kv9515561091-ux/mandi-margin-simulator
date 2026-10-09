/**
 * Seeded pseudo-random number generation.
 *
 * Zero dependencies, and deterministic across platforms and Node versions.
 * Math.random() is neither, so a "simulated" run could not be reproduced or
 * cited in a README. A sourcing manager who runs this twice with the same
 * seed must get the same numbers, or the tool is not evidence of anything.
 *
 * mulberry32: 32-bit state, good statistical properties for this purpose,
 * and trivially portable across engines because it relies only on
 * Math.imul, which is exactly specified.
 */

'use strict';

/**
 * Mulberry32 PRNG. Returns a function producing floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal via the Box-Muller transform.
 *
 * The margin model needs a normal shock, and a uniform shock would produce
 * symmetric noise around the trend -- which is precisely wrong for produce,
 * where price moves are right-skewed and fall as often as they rise but by
 * very different amounts.
 *
 * @param {() => number} rng
 * @returns {number}
 */
function gaussian(rng) {
  // Guard against log(0). u1 is drawn in the open interval.
  let u1 = 0;
  while (u1 === 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Derive a stream seed from a base seed and a string label.
 *
 * Lets each commodity get its own independent stream while keeping the whole
 * run reproducible from one --seed. Without this, adding a commodity would
 * shift every other commodity's path, which makes comparison across runs
 * meaningless.
 *
 * @param {number} baseSeed
 * @param {string} label
 * @returns {number}
 */
function deriveSeed(baseSeed, label) {
  let h = 2166136261 >>> 0;
  const s = String(label);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h ^ (baseSeed >>> 0)) >>> 0;
}

/**
 * Hash a string to a uint32. FNV-1a, chosen over a naive sum because the
 * naive version collides badly on short similar strings -- "onion" and
 * "onions" must not share a stream.
 *
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

module.exports = { mulberry32, gaussian, deriveSeed, hashString };
