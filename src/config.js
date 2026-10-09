/**
 * Config loading and validation.
 *
 * Config errors are the most common way a CLI like this fails for a user:
 * a missing shrink allowance for one category should say so by name, at
 * startup, not surface 40 rows later as NaN.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'config');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`config file not found: ${file}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Load and validate both config files.
 * @param {string} [configDir]
 * @returns {{commodities: object, operations: object}}
 */
function loadConfig(configDir = DEFAULT_DIR) {
  const commodities = readJson(path.join(configDir, 'commodities.json'));
  const operations = readJson(path.join(configDir, 'operations.json'));
  validate(commodities, operations, configDir);
  return { commodities, operations };
}

function validate(commodities, operations, dir) {
  const problems = [];

  if (!commodities.commodities || typeof commodities.commodities !== 'object') {
    throw new Error('commodities.json: missing "commodities" object');
  }
  if (!operations.costs || !operations.margin || !operations.thresholds) {
    throw new Error('operations.json: needs "costs", "margin" and "thresholds"');
  }

  const shrink = operations.costs.shrinkAllowancePct;
  const seenCategories = new Set();
  const seenLabels = new Set();

  for (const [key, c] of Object.entries(commodities.commodities)) {
    for (const field of ['label', 'category', 'mandiBase', 'retailBase',
      'volatility', 'seasonalAmplitude', 'seasonalPeakDayOfYear',
      'minPrice', 'maxPrice']) {
      if (c[field] === undefined) {
        problems.push(`commodities.json: "${key}" is missing "${field}"`);
      }
    }
    if (!(c.mandiBase > 0)) problems.push(`commodities.json: "${key}" mandiBase must be > 0`);
    if (!(c.retailBase > 0)) problems.push(`commodities.json: "${key}" retailBase must be > 0`);
    if (c.retailBase && c.mandiBase && c.retailBase <= c.mandiBase) {
      problems.push(
        `commodities.json: "${key}" retailBase (${c.retailBase}) is not above ` +
        `mandiBase (${c.mandiBase}) -- every day would be a margin breach`);
    }
    if (c.minPrice !== undefined && c.maxPrice !== undefined
        && c.minPrice >= c.maxPrice) {
      problems.push(`commodities.json: "${key}" minPrice must be below maxPrice`);
    }
    if (c.volatility !== undefined && (c.volatility < 0 || c.volatility > 1)) {
      problems.push(`commodities.json: "${key}" volatility must be 0-1 (annualised)`);
    }
    if (c.seasonalAmplitude !== undefined && c.seasonalAmplitude < 0) {
      problems.push(`commodities.json: "${key}" seasonalAmplitude must be >= 0`);
    }

    seenCategories.add(c.category);
    const label = c.label || key;
    if (seenLabels.has(label)) {
      problems.push(`commodities.json: duplicate label "${label}"`);
    }
    seenLabels.add(label);
  }

  for (const cat of seenCategories) {
    if (shrink[cat] === undefined) {
      problems.push(
        `operations.json: costs.shrinkAllowancePct has no entry for category ` +
        `"${cat}", which is used by at least one commodity. Every configured ` +
        `commodity category needs a shrink allowance.`);
    } else if (shrink[cat] < 0 || shrink[cat] >= 100) {
      problems.push(
        `operations.json: shrinkAllowancePct["${cat}"] = ${shrink[cat]} ` +
        '(must be 0 <= x < 100)');
    }
  }

  const m = operations.margin;
  if (!(m.targetGrossMarginPct > 0 && m.targetGrossMarginPct < 100)) {
    problems.push('operations.json: margin.targetGrossMarginPct must be 0-100 exclusive');
  }
  if (m.criticalMarginPct > m.targetGrossMarginPct) {
    problems.push('operations.json: criticalMarginPct is above targetGrossMarginPct');
  }
  if (m.minMarginPct > m.criticalMarginPct) {
    problems.push('operations.json: minMarginPct is above criticalMarginPct');
  }

  // The cost-to-retail breach ceiling and the margin target must agree.
  // 100% - costToRetailPct is the margin at which a breach is declared, and
  // it has to sit strictly below the target or the tool reports a line as a
  // breach while simultaneously saying it clears the target.
  const t = operations.thresholds || {};
  if (t.costToRetailPct !== undefined && t.costToRetailBufferPct !== undefined) {
    const impliedBreachMargin = 100 - t.costToRetailPct;
    const target = m.targetGrossMarginPct;
    if (impliedBreachMargin >= target) {
      problems.push(
        `operations.json: thresholds.costToRetailPct (${t.costToRetailPct}%) ` +
        `implies a breach at ${impliedBreachMargin}% margin, which is at or ` +
        `above the ${target}% target. A line could be reported as a breach ` +
        `while clearing its target. Lower costToRetailPct or raise ` +
        `costToRetailBufferPct.`);
    }
    const expected = 100 - (target - t.costToRetailBufferPct);
    if (Math.abs(t.costToRetailPct - expected) > 0.01) {
      problems.push(
        `operations.json: costToRetailPct (${t.costToRetailPct}%) does not ` +
        `match 100 - (target ${target}% - buffer ${t.costToRetailBufferPct}%) ` +
        `= ${expected}%. Set it to that value so the two stay coherent.`);
    }
  }

  if (problems.length) {
    throw new Error(
      `config validation failed in ${dir}:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

/** List configured commodity keys and labels, for CLI help and errors. */
/**
 * Resolve a commodity's working retail price.
 *
 * The configured `retailBase` is the published all-India average, which is
 * consumption-weighted across all channels and dominated by unorganised
 * kirana trade. An organised chain's own shelf price sits above that, because
 * the chain carries cold chain, wastage, staffing and card costs into the
 * price the way a loose trader does not.
 *
 * Comparing an organised cost stack against the all-India average would
 * understate achievable margin and flag most lines as breaches -- an artefact
 * of the wrong denominator rather than a commercial signal. The uplift is
 * applied here, once, so every command agrees on the denominator.
 *
 * @param {object} commodities
 * @param {string} key
 * @returns {number} Rs/kg
 */
function workingRetailPrice(commodities, key) {
  const c = commodities.commodities[key];
  if (!c) throw new Error(`unknown commodity "${key}"`);
  const basis = commodities.retailBasis;
  if (!basis || basis.allIndiaAverage !== true) return c.retailBase;
  const upliftPct = (basis.organisedUpliftPct || {})[key];
  if (upliftPct === undefined) return c.retailBase;
  return Math.round(c.retailBase * (1 + upliftPct / 100) * 100) / 100;
}

function listCommodities(commodities) {
  return Object.entries(commodities.commodities).map(([key, c]) => ({
    key, label: c.label, category: c.category,
    workingRetail: workingRetailPrice(commodities, key),
  }));
}

/** Nearest-match a user-supplied commodity string, with suggestions. */
function resolveCommodity(commodities, input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  const entries = Object.entries(commodities.commodities);
  const exact = entries.find(([k, c]) => k.toLowerCase() === key
    || (c.label || '').toLowerCase() === key);
  if (exact) return exact[0];

  const partial = entries.find(([k, c]) => k.toLowerCase().includes(key)
    || (c.label || '').toLowerCase().includes(key));
  if (partial) return partial[0];

  const suggestions = entries
    .map(([k, c]) => {
      const target = (key + ' ' + (c.label || '')).toLowerCase();
      const name = (k + ' ' + (c.label || '')).toLowerCase();
      let score = 0;
      for (const ch of new Set(target)) if (name.includes(ch)) score++;
      return { k, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.k);

  const err = new Error(`unknown commodity "${input}"`);
  if (suggestions.length) {
    err.message += `. Did you mean: ${suggestions.join(', ')}?`;
  } else {
    err.message += `. Run \`node src/index.js list\` to see all commodities.`;
  }
  throw err;
}

module.exports = {
  loadConfig, listCommodities, resolveCommodity, validate, workingRetailPrice,
};
