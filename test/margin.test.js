/**
 * Tests for margin arithmetic, the rules engine, and reproducibility.
 *
 * These pin behaviour where a wrong answer costs money rather than crashes.
 * Run: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeMargin, requiredRetailPrice, maxAffordableMandiPrice, round }
  = require('../src/margin');
const { evaluateDay, computeStreaks, worstSeverity, SEVERITY_ORDER }
  = require('../src/flags');
const { simulateCommodity, seasonalMultiplier } = require('../src/priceEngine');
const { loadConfig, resolveCommodity, workingRetailPrice, validate }
  = require('../src/config');
const { mulberry32, deriveSeed, hashString } = require('../src/random');

const cfg = loadConfig();
const COSTS = cfg.operations.costs;
const MARGIN_CFG = cfg.operations.margin;

const costFor = (mandiPrice, retailPrice, category = 'Bulb & Stem', coldChain = false) =>
  computeMargin({
    mandiPrice, retailPrice, category,
    costs: COSTS, marginCfg: MARGIN_CFG, coldChain,
  });

// ---------------------------------------------------------------------------
// Margin arithmetic
// ---------------------------------------------------------------------------

test('shrink is charged on purchased weight, not after margin', () => {
  // 3% shrink: 100 kg bought yields 97 kg, so cost per salable kg is
  // 100/97 times the purchase price. Charging it after margin would
  // understate cost by exactly this factor on the most perishable lines.
  const m = costFor(10, 30);
  const expected = 10 / 0.97;
  assert.ok(Math.abs(m.purchase_cost_per_salable_kg - expected) < 0.01);
  assert.ok(m.landed_cost_per_kg > m.purchase_cost_per_kg,
    'landed cost must exceed purchase cost');
});

test('a zero-shrink category grosses up by exactly 1', () => {
  const costs = { ...COSTS, shrinkAllowancePct: { ...COSTS.shrinkAllowancePct, Test: 0 } };
  const m = computeMargin({
    mandiPrice: 20, retailPrice: 40, category: 'Test',
    costs, marginCfg: MARGIN_CFG,
  });
  assert.strictEqual(m.purchase_cost_per_salable_kg, 20);
  assert.strictEqual(m.yield_rate, 1);
});

test('margin is computed on retail value, not on cost', () => {
  const m = costFor(20, 40);
  // (40 - landed) / 40
  const expectedMargin = (100 * (m.landed_cost_per_kg ? 40 - m.landed_cost_per_kg : 0)) / 40;
  assert.ok(Math.abs(m.gross_margin_pct - expectedMargin) < 0.05);
  // markup and margin must differ; conflating them is a classic error
  assert.ok(Math.abs(m.markup_pct - m.gross_margin_pct) > 1);
});

test('higher shrink lowers margin at identical prices', () => {
  const low = costFor(20, 40, 'Bulb & Stem');
  const high = costFor(20, 40, 'Leafy Greens');
  assert.ok(high.gross_margin_pct < low.gross_margin_pct,
    '12% shrink must produce a lower margin than 3%');
});

test('cold chain cost reduces margin', () => {
  const plain = costFor(20, 40, 'Fruit', false);
  const chilled = costFor(20, 40, 'Fruit', true);
  assert.ok(chilled.landed_cost_per_kg > plain.landed_cost_per_kg);
  assert.ok(chilled.gross_margin_pct < plain.gross_margin_pct);
});

test('a higher mandi price lowers margin', () => {
  const cheap = costFor(20, 40);
  const dear = costFor(30, 40);
  assert.ok(dear.gross_margin_pct < cheap.gross_margin_pct);
});

test('per-100kg block reconciles with the per-kg figures', () => {
  const m = costFor(20, 40);
  const p = m.per_100kg;
  assert.strictEqual(p.purchased_kg, 100);
  assert.ok(Math.abs(p.salable_kg - 100 * m.yield_rate) < 0.02);
  // The per-kg figures are rounded to 2dp for display, the 100 kg block is
  // computed from the unrounded values. So the tolerance is the display
  // rounding scaled by 100, i.e. 0.5 -- not 0.05, which would be asserting
  // that a rounded figure reproduces an exact one.
  const ROUNDING_TOLERANCE = 0.5;
  assert.ok(Math.abs(p.landed_cost - 100 * m.landed_cost_per_kg) < ROUNDING_TOLERANCE,
    `landed ${p.landed_cost} vs ${100 * m.landed_cost_per_kg}`);
  assert.ok(Math.abs(p.gross_profit - 100 * m.gross_profit_per_kg) < ROUNDING_TOLERANCE,
    `profit ${p.gross_profit} vs ${100 * m.gross_profit_per_kg}`);
  // A cost breakdown that does not add up is worse than no breakdown.
  assert.ok(Math.abs(p.landed_cost - (p.purchase_cost + p.freight + p.handling + p.cold_chain)) < 0.02,
    'the cost lines must sum to the landed total');
  assert.ok(p.shrink_gross_up > 0, 'the shrink gross-up must be shown, not absorbed');
  assert.ok(Math.abs(p.purchase_cost - (p.shrink_gross_up + 100 * m.purchase_cost_per_kg)) < 0.02,
    'purchase cost must equal the raw spend plus the shrink gross-up');
});

test('rejects non-positive prices rather than producing NaN margins', () => {
  assert.throws(() => costFor(0, 40), /mandiPrice must be positive/);
  assert.throws(() => costFor(20, 0), /retailPrice must be positive/);
  assert.throws(() => costFor(-5, 40), /mandiPrice must be positive/);
});

test('an unknown category is a named error, not a NaN', () => {
  // A missing shrink allowance silently becomes NaN and then sorts as a
  // number, which is how a broken line hides in a report.
  assert.throws(() => costFor(20, 40, 'Nonexistent'), /no shrink allowance configured/);
});

test('requiredRetailPrice inverts exactly to the target margin', () => {
  for (const target of [10, 22, 30, 45]) {
    const retail = requiredRetailPrice(40, target);
    const margin = (100 * (retail - 40)) / retail;
    assert.ok(Math.abs(margin - target) < 0.05, `${retail} gives ${margin}%, not ${target}%`);
  }
});

test('requiredRetailPrice rejects impossible margins', () => {
  assert.throws(() => requiredRetailPrice(40, 0), /between 0 and 100 exclusive/);
  assert.throws(() => requiredRetailPrice(40, 100), /between 0 and 100 exclusive/);
});

test('maxAffordableMandiPrice is the exact inverse of requiredRetailPrice', () => {
  const adders = 2.8;
  const yieldRate = 0.97;
  const target = 22;
  const ceiling = maxAffordableMandiPrice(60, target, adders, yieldRate);
  const landed = ceiling / yieldRate + adders;
  const margin = (100 * (60 - landed)) / 60;
  assert.ok(Math.abs(margin - target) < 0.05);
});

test('maxAffordableMandiPrice falls as adders rise', () => {
  const cheap = maxAffordableMandiPrice(60, 22, 1, 0.97);
  const dear = maxAffordableMandiPrice(60, 22, 5, 0.97);
  assert.ok(dear < cheap, 'higher freight must lower the affordable buy price');
});

test('maxAffordableMandiPrice falls as shrink rises', () => {
  const lowShrink = maxAffordableMandiPrice(60, 22, 2.8, 0.99);
  const highShrink = maxAffordableMandiPrice(60, 22, 2.8, 0.88);
  assert.ok(highShrink < lowShrink);
});

// ---------------------------------------------------------------------------
// Rules engine
// ---------------------------------------------------------------------------

const cfgOps = cfg.operations;

const priceRow = (over = {}) => ({
  day_return_pct: 0, shock_pct: 0, shocked: false, shock_direction: 'none',
  mandi_price_inr_kg: 20, ...over,
});

test('a healthy day raises no margin flags', () => {
  const m = costFor(12, 30);
  const flags = evaluateDay({
    marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: {},
  });
  assert.strictEqual(worstSeverity(flags), 'OK');
});

test('negative margin is a BREACH', () => {
  const m = costFor(45, 46);
  assert.ok(m.gross_margin_pct < 0, 'test setup must produce a negative margin');
  const flags = evaluateDay({
    marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: {},
  });
  assert.ok(flags.some((f) => f.severity === 'BREACH'));
  assert.ok(flags.some((f) => f.code === 'MARGIN_BREACH'));
});

test('sub-target but positive margin is a WATCH, not a breach', () => {
  // Rs 20 buy at Rs 30 retail: 21.94% margin, above the 15% critical floor
  // and above the 16% implied by the cost-to-retail ceiling, so it is a
  // sub-target WATCH rather than a BREACH. Note that a *smaller* gap between
  // the two prices is not a milder problem -- the ceiling is 84% precisely so
  // that a line has to be within 6pp of target before it counts as a breach.
  const m = costFor(20, 30);
  assert.ok(m.gross_margin_pct > 0, 'test setup must be profitable');
  assert.ok(m.gross_margin_pct < cfgOps.margin.targetGrossMarginPct,
    'test setup must be below target');
  const flags = evaluateDay({
    marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: {},
  });
  assert.strictEqual(worstSeverity(flags), 'WATCH');
  assert.ok(flags.some((f) => f.code === 'MARGIN_BELOW_TARGET'));
});

test('margin in the breach band is a BREACH, not a WATCH', () => {
  // Rs 20 at Rs 25: positive margin, but 6.33% sits under both the 15%
  // critical floor and the 16% implied by the cost-to-retail ceiling.
  const m = costFor(20, 25);
  const flags = evaluateDay({
    marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: {},
  });
  assert.ok(m.gross_margin_pct > 0, 'still profitable, just barely');
  assert.ok(flags.some((f) => f.severity === 'BREACH'));
});

test('every flag carries a non-empty action', () => {
  // A flag a sourcing manager cannot act on is an alert they will mute.
  const m = costFor(45, 46);
  const flags = evaluateDay({
    marginRow: m,
    priceRow: priceRow({ day_return_pct: 25, shock_pct: 20, shocked: true, shock_direction: 'up' }),
    cfg: cfgOps,
    history: { consecutiveBelowTarget: 5 },
  });
  assert.ok(flags.length >= 4);
  for (const f of flags) {
    assert.ok(typeof f.action === 'string' && f.action.length > 20,
      `${f.code} has no usable action`);
    assert.ok(typeof f.message === 'string' && f.message.length > 10,
      `${f.code} has no usable message`);
  }
});

test('no flag message contains undefined', () => {
  // Caught a real bug: numeric interpolation of an unrounded value printed
  // "undefined%" in the breach message.
  const m = costFor(45, 46);
  for (const p of [priceRow({ day_return_pct: 22, shock_pct: 18, shocked: true, shock_direction: 'down' })]) {
    const flags = evaluateDay({ marginRow: m, priceRow: p, cfg: cfgOps, history: { consecutiveBelowTarget: 4 } });
    for (const f of flags) {
      assert.ok(!/undefined|NaN/.test(f.message), `${f.code}: ${f.message}`);
    }
  }
});

test('a price spike is flagged and a fall is an opportunity', () => {
  const m = costFor(12, 30);
  const spike = evaluateDay({
    marginRow: m, priceRow: priceRow({ day_return_pct: 22 }), cfg: cfgOps, history: {},
  });
  assert.ok(spike.some((f) => f.code === 'PRICE_SPIKE'));

  const fall = evaluateDay({
    marginRow: m, priceRow: priceRow({ day_return_pct: -18 }), cfg: cfgOps, history: {},
  });
  assert.ok(fall.some((f) => f.code === 'PRICE_OPPORTUNITY'));
  // The tool must also be able to say "buy more", not only "stop".
  assert.strictEqual(worstSeverity(fall), 'OPPORTUNITY');
});

test('a small move raises no price flag', () => {
  const m = costFor(12, 30);
  const flags = evaluateDay({
    marginRow: m, priceRow: priceRow({ day_return_pct: 3 }), cfg: cfgOps, history: {},
  });
  assert.ok(!flags.some((f) => f.code === 'PRICE_SPIKE' || f.code === 'PRICE_OPPORTUNITY'));
});

test('persistence escalates a one-day dip to a REVIEW', () => {
  const m = costFor(20, 25);
  const oneDay = evaluateDay({ marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: { consecutiveBelowTarget: 1 } });
  const persistent = evaluateDay({ marginRow: m, priceRow: priceRow(), cfg: cfgOps, history: { consecutiveBelowTarget: 5 } });
  assert.ok(!oneDay.some((f) => f.code === 'MARGIN_PERSISTENT'));
  assert.ok(persistent.some((f) => f.code === 'MARGIN_PERSISTENT'));
});

test('worstSeverity picks the most severe flag present', () => {
  assert.strictEqual(worstSeverity([{ severity: 'INFO' }, { severity: 'WATCH' }]), 'WATCH');
  assert.strictEqual(worstSeverity([{ severity: 'CRITICAL' }, { severity: 'BREACH' }]), 'BREACH');
  assert.strictEqual(worstSeverity([]), 'OK');
  assert.strictEqual(SEVERITY_ORDER[0], 'BREACH', 'BREACH must sort most severe');
});

test('flags are returned most-severe-first', () => {
  const m = costFor(45, 46);
  const flags = evaluateDay({
    marginRow: m,
    priceRow: priceRow({ day_return_pct: 25, shock_pct: 20, shocked: true, shock_direction: 'up' }),
    cfg: cfgOps,
    history: { consecutiveBelowTarget: 5 },
  });
  const ranks = flags.map((f) => SEVERITY_ORDER.indexOf(f.severity));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] >= ranks[i - 1], 'flags must be ordered by severity');
  }
});

test('the streak counter resets on a healthy day', () => {
  const below = { commodity: 'onion', gross_margin_pct: 10 };
  const above = { commodity: 'onion', gross_margin_pct: 30 };
  const other = { commodity: 'tomato', gross_margin_pct: 30 };
  const streaks = computeStreaks([below, below, below, above, other], cfgOps);
  assert.strictEqual(streaks.get('onion'), 0, 'a healthy day must reset the streak');
});

test('the streak counter is per commodity', () => {
  const rows = [
    { commodity: 'onion', gross_margin_pct: 10 },
    { commodity: 'tomato', gross_margin_pct: 30 },
    { commodity: 'onion', gross_margin_pct: 10 },
  ];
  const streaks = computeStreaks(rows, cfgOps);
  assert.strictEqual(streaks.get('onion'), 2);
  assert.strictEqual(streaks.get('tomato'), 0);
});

// ---------------------------------------------------------------------------
// Reproducibility -- the property the whole tool rests on
// ---------------------------------------------------------------------------

test('the same seed produces byte-identical prices', () => {
  const sim = cfg.operations.sim;
  const a = simulateCommodity({ key: 'onion', ...cfg.commodities.commodities.onion },
    sim, 42, 30, new Date('2026-10-05T00:00:00Z'));
  const b = simulateCommodity({ key: 'onion', ...cfg.commodities.commodities.onion },
    sim, 42, 30, new Date('2026-10-05T00:00:00Z'));
  assert.deepStrictEqual(a, b, 'a reproducible tool must reproduce exactly');
});

test('a different seed produces a different path', () => {
  const sim = cfg.operations.sim;
  const a = simulateCommodity({ key: 'onion', ...cfg.commodities.commodities.onion },
    sim, 42, 30, new Date('2026-10-05T00:00:00Z'));
  const b = simulateCommodity({ key: 'onion', ...cfg.commodities.commodities.onion },
    sim, 43, 30, new Date('2026-10-05T00:00:00Z'));
  assert.notDeepStrictEqual(a.map((r) => r.mandi_price_inr_kg),
    b.map((r) => r.mandi_price_inr_kg));
});

test('each commodity gets an independent stream', () => {
  // Adding a commodity must not shift every other commodity's path, or
  // comparison across runs becomes meaningless.
  assert.notStrictEqual(deriveSeed(42, 'onion'), deriveSeed(42, 'tomato'));
  assert.strictEqual(deriveSeed(42, 'onion'), deriveSeed(42, 'onion'));
});

test('deriveSeed does not collide on similar short names', () => {
  assert.notStrictEqual(hashString('onion'), hashString('onions'));
  assert.notStrictEqual(hashString('potato'), hashString('tomato'));
});

test('shocks can be disabled to isolate the diffusion component', () => {
  const sim = cfg.operations.sim;
  const c = { key: 'tomato', ...cfg.commodities.commodities.tomato };
  const withS = simulateCommodity(c, sim, 42, 60, new Date('2026-10-05T00:00:00Z'), true);
  const without = simulateCommodity(c, sim, 42, 60, new Date('2026-10-05T00:00:00Z'), false);
  assert.ok(withS.some((r) => r.shocked), 'the shock run must contain shocks');
  assert.ok(!without.some((r) => r.shocked), 'the no-shock run must contain none');
});

test('simulated prices stay inside their configured bounds', () => {
  // An unbounded GBM will cheerfully emit a Rs 0.04/kg onion, which makes
  // every downstream margin figure nonsense.
  for (const [key, c] of Object.entries(cfg.commodities.commodities)) {
    const rows = simulateCommodity({ key, ...c }, cfg.operations.sim, 7, 400,
      new Date('2026-01-01T00:00:00Z'));
    for (const r of rows) {
      assert.ok(r.mandi_price_inr_kg >= c.minPrice,
        `${key}: ${r.mandi_price_inr_kg} below floor ${c.minPrice}`);
      assert.ok(r.mandi_price_inr_kg <= c.maxPrice,
        `${key}: ${r.mandi_price_inr_kg} above ceiling ${c.maxPrice}`);
    }
  }
});

test('simulated spoilage-adjacent prices stay positive', () => {
  const rows = simulateCommodity({ key: 'onion', ...cfg.commodities.commodities.onion },
    cfg.operations.sim, 11, 90, new Date('2026-01-01T00:00:00Z'));
  assert.ok(rows.every((r) => r.mandi_price_inr_kg > 0));
});

test('the seasonal term is continuous across the year boundary', () => {
  // A peak near 31 December must not produce a discontinuity when the
  // day-of-year wraps from 365 to 1.
  const a = seasonalMultiplier(1, 300, 0.4);
  const b = seasonalMultiplier(365, 300, 0.4);
  assert.ok(Math.abs(a - b) < 0.05, `${a} vs ${b} across the year boundary`);
});

test('the seasonal term peaks on the configured day', () => {
  assert.ok(seasonalMultiplier(300, 300, 0.4) > seasonalMultiplier(200, 300, 0.4));
  assert.ok(seasonalMultiplier(300, 300, 0.4) > seasonalMultiplier(30, 300, 0.4));
});

test('the PRNG is uniform enough to be usable', () => {
  const rng = mulberry32(12345);
  const buckets = new Array(10).fill(0);
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, 'PRNG must stay in [0, 1)');
    buckets[Math.floor(v * 10)]++;
  }
  for (const b of buckets) {
    assert.ok(Math.abs(b / n - 0.1) < 0.015, `bucket skew: ${b / n}`);
  }
});

test('the PRNG seed is stable', () => {
  assert.deepStrictEqual([mulberry32(7)(), mulberry32(7)(), mulberry32(7)()],
    [mulberry32(7)(), mulberry32(7)(), mulberry32(7)()]);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('the shipped config validates', () => {
  assert.strictEqual(validate(cfg.commodities, cfg.operations, '.'), true);
});

test('every commodity category has a shrink allowance', () => {
  for (const [key, c] of Object.entries(cfg.commodities.commodities)) {
    assert.ok(cfg.operations.costs.shrinkAllowancePct[c.category] !== undefined,
      `${key} has no shrink allowance for ${c.category}`);
  }
});

test('a missing shrink allowance is caught at validation, not at runtime', () => {
  const broken = JSON.parse(JSON.stringify(cfg));
  // The key must be the category name as it appears on a commodity, not a
  // guess. "Leafy Greens" is what coriander carries.
  delete broken.operations.costs.shrinkAllowancePct['Leafy Greens'];
  assert.throws(() => validate(broken.commodities, broken.operations, '.'),
    /no entry for category "Leafy Greens"/);
});

test('a retail price at or below the mandi price is rejected', () => {
  const broken = JSON.parse(JSON.stringify(cfg));
  broken.commodities.commodities.onion.retailBase = 10;
  assert.throws(() => validate(broken.commodities, broken.operations, '.'),
    /not above mandiBase/);
});

test('an incoherent cost-to-retail ceiling is rejected', () => {
  // A ceiling that implies a breach margin above the target would report a
  // line as a breach while also saying it clears target.
  const broken = JSON.parse(JSON.stringify(cfg));
  broken.operations.thresholds.costToRetailPct = 70;
  assert.throws(() => validate(broken.commodities, broken.operations, '.'),
    /does not match|because a line could be reported/);
});

test('every configured commodity clears its target at the working price', () => {
  // If a line cannot clear its margin at its own base prices, the config is
  // wrong -- not the market.
  for (const [key, c] of Object.entries(cfg.commodities.commodities)) {
    const working = workingRetailPrice(cfg.commodities, key);
    const m = computeMargin({
      mandiPrice: c.mandiBase, retailPrice: working, category: c.category,
      costs: COSTS, marginCfg: MARGIN_CFG,
      coldChain: c.category === 'Leafy Greens' || c.category === 'Fruit',
    });
    assert.ok(m.gross_margin_pct >= cfg.operations.margin.targetGrossMarginPct,
      `${key}: only ${m.gross_margin_pct}% at base prices, target is ` +
      `${cfg.operations.margin.targetGrossMarginPct}%`);
  }
});

test('the working retail price is above the published average', () => {
  for (const [key, c] of Object.entries(cfg.commodities.commodities)) {
    assert.ok(workingRetailPrice(cfg.commodities, key) > c.retailBase,
      `${key} working price must exceed the all-India average`);
  }
});

test('commodity resolution accepts key, label and partial matches', () => {
  assert.strictEqual(resolveCommodity(cfg.commodities, 'onion'), 'onion');
  assert.strictEqual(resolveCommodity(cfg.commodities, 'ONION'), 'onion');
  assert.strictEqual(resolveCommodity(cfg.commodities, 'onion'), 'onion');
  assert.ok(resolveCommodity(cfg.commodities, 'Nashik'), 'partial label must match');
});

test('an unknown commodity suggests alternatives rather than failing bare', () => {
  assert.throws(() => resolveCommodity(cfg.commodities, 'pineaple'), /Did you mean|lotus/);
});

test('the config loader reports a missing file by path', () => {
  assert.throws(() => loadConfig('/nonexistent/dir'), /config file not found/);
});

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

test('rounding avoids binary float drift', () => {
  assert.strictEqual(round(1.005, 2), 1.01);
  assert.strictEqual(round(0.1 + 0.2, 2), 0.3);
  assert.strictEqual(round(2.675, 2), 2.68);
});
