/**
 * Wholesale price simulation.
 *
 * Model: geometric Brownian motion with a seasonal term and occasional
 * supply shocks.
 *
 *   dP/P = mu dt + sigma dW  +  shock(t)
 *
 * The seasonal term is sinusoidal on day-of-year. The shock term is the part
 * that matters: F&V mandi rates do not random-walk politely. A hailstorm, a
 * mandi holiday, a transport strike or an oversupply week produces a jump
 * that a diffusion model smooths away. Simulating without shocks would give
 * a tool that never fires its PRICE_SPIKE flag, which is the flag a sourcing
 * manager most needs.
 *
 * Prices are floored and capped at values from the commodity config. Real
 * produce prices do not go negative and have bounded upside within a season;
 * an unbounded GBM will cheerfully emit a Rs 0.04/kg onion, which makes every
 * downstream margin figure nonsense.
 *
 * The whole path is deterministic given a seed.
 */

'use strict';

const { mulberry32, gaussian, deriveSeed } = require('./random');

/**
 * Seasonal multiplier for a day of year.
 * @param {number} dayOfYear 0-365
 * @param {number} peakDay  day of year the commodity peaks
 * @param {number} amplitude fractional amplitude
 * @returns {number}
 */
function seasonalMultiplier(dayOfYear, peakDay, amplitude) {
  // Angular distance from the peak, wrapped to [-180, 180) so a peak near
  // the end of the year does not produce a discontinuity at the boundary.
  let delta = dayOfYear - peakDay;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return 1 + amplitude * Math.cos((delta * Math.PI) / 180);
}

function dayOfYearFrom(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86400000);
}

/**
 * Simulate a single commodity's price path.
 *
 * @param {object} commodity config entry
 * @param {object} simConfig operations.sim
 * @param {number} seed
 * @param {number} days
 * @param {Date} startDate
 * @param {boolean} withShocks set false to isolate the diffusion component
 * @returns {Array<object>} one row per day
 */
function simulateCommodity(commodity, simConfig, seed, days, startDate, withShocks = true) {
  // Two independent streams. The diffusion path and the shock process are
  // seeded separately so that the shock sequence does not shift every time
  // the diffusion code changes -- otherwise editing the noise model silently
  // rewrites which days happen to be shocked, and a "reproducible" run stops
  // being comparable to the previous one.
  const rng = mulberry32(deriveSeed(seed, commodity.key));
  const shockRng = mulberry32(deriveSeed(deriveSeed(seed, commodity.key), 'shock'));
  const rows = [];
  let price = commodity.mandiBase;
  let lastShockDir = 0;

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate.getTime() + d * 86400000);
    const doy = dayOfYearFrom(date);

    const prevPrice = price;

    // --- Diffusion ------------------------------------------------------
    // sigma scaled by sqrt(1/252): the config's volatility is an annualised
    // figure, and a single trading day is one of roughly 252.
    const dailySigma = commodity.volatility * Math.sqrt(1 / 252);
    const z = gaussian(rng);
    let next = price * Math.exp(commodity.drift / 252 - 0.5 * dailySigma ** 2 + dailySigma * z);

    // --- Seasonal pull --------------------------------------------------
    // Pull gently toward the seasonal level rather than multiplying by it
    // each day. Multiplying would compound the seasonal term and drift the
    // whole path away from the configured base within a month.
    const seasonalTarget = commodity.mandiBase * seasonalMultiplier(
      doy, commodity.seasonalPeakDayOfYear, commodity.seasonalAmplitude);
    next += (seasonalTarget - next) * 0.06;

    // --- Shock ----------------------------------------------------------
    let shockPct = 0;
    if (withShocks && shockRng() < simConfig.shockProbability) {
      // Direction is symmetric; magnitude is a right-skewed draw so the
      // upside tail is fatter, which is what produce price series show.
      const dir = shockRng() < 0.5 ? -1 : 1;
      const mag = Math.abs(gaussian(shockRng)) * simConfig.shockMagnitudePct;
      shockPct = (dir * mag) / 100;
      next *= 1 + shockPct;
      lastShockDir = dir;
    }

    // --- Bounds ---------------------------------------------------------
    next = Math.min(commodity.maxPrice, Math.max(commodity.minPrice, next));
    next = Math.round(next * 100) / 100;

    const dayReturnPct = ((next - prevPrice) / prevPrice) * 100;

    rows.push({
      date: date.toISOString().slice(0, 10),
      day_index: d,
      day_of_year: doy,
      commodity: commodity.key,
      label: commodity.label,
      mandi_price_inr_kg: next,
      prev_price_inr_kg: prevPrice,
      day_return_pct: Math.round(dayReturnPct * 100) / 100,
      shock_pct: Math.round(shockPct * 1000) / 10,
      shocked: Math.abs(shockPct) > 0.0001,
      shock_direction: lastShockDir > 0 ? 'up' : lastShockDir < 0 ? 'down' : 'none',
      seasonal_multiplier: Math.round(seasonalMultiplier(
        doy, commodity.seasonalPeakDayOfYear, commodity.seasonalAmplitude) * 1000) / 1000,
    });

    price = next;
  }

  return rows;
}

/**
 * Simulate all configured commodities.
 *
 * @param {object} commoditiesConfig
 * @param {object} simConfig
 * @param {object} opts
 * @returns {Array<object>}
 */
function simulateAll(commoditiesConfig, simConfig, opts) {
  const { seed = 42, days = 30, startDate = new Date('2026-10-05'), withShocks = true } = opts || {};
  const out = [];
  for (const [key, c] of Object.entries(commoditiesConfig.commodities)) {
    out.push(...simulateCommodity(
      { key, ...c }, simConfig, seed, days, startDate, withShocks));
  }
  return out;
}

module.exports = {
  simulateAll, simulateCommodity, seasonalMultiplier, dayOfYearFrom,
};
