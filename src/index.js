#!/usr/bin/env node
/**
 * mandi-margin-simulator
 *
 * Simulates daily wholesale mandi prices for seasonal commodities and
 * computes the procurement margin against a full landed-cost stack, flagging
 * every instance where acquisition cost threatens retail profitability.
 *
 * Zero runtime dependencies. Node >= 18 for parseArgs and node:test.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const { loadConfig, listCommodities, resolveCommodity, workingRetailPrice } = require('./config');
const { simulateAll } = require('./priceEngine');
const { computeMargin, requiredRetailPrice, maxAffordableMandiPrice, round } = require('./margin');
const { evaluateDay, summarise, SEVERITY_ORDER } = require('./flags');
const report = require('./report');

const s = report.s;

const USAGE = `
${s.bold('mandi-margin-simulator')} ${s.grey('v1.0.0')}

Daily wholesale price simulation and procurement margin guardrails for
Indian F&V retail. Margin is computed on landed cost, not on mandi-vs-retail
spread, and on retail value, not on cost.

${s.bold('USAGE')}
  node src/index.js <command> [options]

${s.bold('COMMANDS')}
  simulate    Simulate N days of prices and daily margin assessments
  assess      Assess a single day at explicit prices
  target      Retail price needed to hit a target margin
  ceiling     Max mandi price that still clears the target margin
  analyse     Re-run the assessment over a previously written CSV
  list        List configured commodities
  config      Print the active configuration

${s.bold('EXAMPLES')}
  ${s.grey('#')} 30-day run, fixed seed, every commodity
  node src/index.js simulate --days 30 --seed 42

  ${s.grey('#')} 7 days of tomato only, with detail
  node src/index.js simulate --days 7 --seed 42 --commodity tomato --detail

  ${s.grey('#')} no shocks, to isolate the diffusion component
  node src/index.js simulate --days 30 --no-shocks

  ${s.grey('#')} one-off: is Rs 51/kg onion still buyable at Rs 58 retail?
  node src/index.js assess --commodity onion --mandi 51 --retail 58

  ${s.grey('#')} what retail does tomato need at today's Rs 34/kg?
  node src/index.js target --commodity tomato --mandi 34

  ${s.grey('#')} what is the most I can pay for potato at Rs 22.81 retail?
  node src/index.js ceiling --commodity potato --retail 22.81

  ${s.grey('#')} write the run to CSV for the category review
  node src/index.js simulate --days 30 --seed 42 --out data/run.csv

${s.bold('OPTIONS')}
  --days <n>          days to simulate            ${s.grey('(default 30)')}
  --seed <n>          PRNG seed; same seed, same run   ${s.grey('(default 42)')}
  --commodity <key>   restrict to one commodity
  --mandi <r>         mandi price Rs/kg, for assess/target
  --retail <r>        retail price Rs/kg
  --margin <pct>      target margin, for target/ceiling  ${s.grey('(default from config)')}
  --start <date>      start date YYYY-MM-DD      ${s.grey('(default from config)')}
  --no-shocks         disable supply shocks
  --detail            print every flagged day, not just the worst
  --json              machine-readable output
  --csv <path>        write full run to CSV
  --out <path>        alias for --csv
  --quiet             suppress the summary
  --no-color          disable ANSI colour
  --config <dir>      alternate config directory
  -h, --help          this message

${s.bold('EXIT CODES')}
  0  no breach or critical flag
  1  a breach or critical flag was raised
  2  a usage or configuration error
`;

const OPTIONS = {
  days: { type: 'string' },
  seed: { type: 'string' },
  commodity: { type: 'string' },
  mandi: { type: 'string' },
  retail: { type: 'string' },
  margin: { type: 'string' },
  start: { type: 'string' },
  shocks: { type: 'boolean', default: true },
  'no-shocks': { type: 'boolean' },
  detail: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  csv: { type: 'string' },
  out: { type: 'string' },
  quiet: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  color: { type: 'boolean' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
};

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new UsageError(`--${name} must be a number, got "${v}"`);
  }
  return n;
}

class UsageError extends Error {}

function parseCommon(opts) {
  const seed = opts.seed !== undefined ? num(opts.seed, 'seed') : 42;
  const days = opts.days !== undefined ? num(opts.days, 'days') : 30;
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new UsageError(`--days must be an integer 1-3650, got ${days}`);
  }
  return { seed, days };
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

function cmdSimulate(cfg, opts) {
  const { commodities, operations } = cfg;
  const { seed, days } = parseCommon(opts);
  const withShocks = !(opts['no-shocks'] || opts.shocks === false);

  const startDate = opts.start
    ? new Date(opts.start + 'T00:00:00Z')
    : new Date(operations.sim.startDate + 'T00:00:00Z');
  if (Number.isNaN(startDate.getTime())) {
    throw new UsageError(`--start must be YYYY-MM-DD, got "${opts.start}"`);
  }

  let keys = Object.keys(commodities.commodities);
  if (opts.commodity) {
    keys = [resolveCommodity(commodities, opts.commodity)];
  }

  const targets = keys.map((k) => ({ key: k, ...commodities.commodities[k] }));
  const priceRows = simulateAll(
    { commodities: Object.fromEntries(targets.map((t) => [t.key, t])) },
    operations.sim, { seed, days, startDate, withShocks });

  // ---- price -> margin -> flags --------------------------------------
  const streakState = new Map();
  const lastRetail = new Map();
  const assessed = [];
  const byKey = new Map(targets.map((t) => [t.key, t]));

  for (const row of priceRows) {
    const c = byKey.get(row.commodity);
    // The working retail price for this commodity, after the organised-trade
    // uplift is applied to the published all-India average. Every command
    // resolves it through the same helper, so they cannot disagree about the
    // denominator.
    const retailAnchor = workingRetailPrice(commodities, row.commodity);

    // Retail tracks mandi with a lag and damped, because a price board moves
    // faster than a shelf label. Full pass-through would mean every mandi
    // spike is immediately repriced, which is not how retail works.
    //
    // Tracked per commodity in a map rather than by scanning `assessed`:
    // a filter over the whole array inside the hot loop is O(n^2) and, worse,
    // reads the wrong field name once the row shape changes.
    const priorRetail = lastRetail.get(row.commodity);
    const retailBase = priorRetail === undefined
      ? retailAnchor
      : priorRetail * 0.75 + retailAnchor * 0.25;
    const retail = Math.max(
      retailAnchor * 0.6,
      Math.min(retailAnchor * 1.8, round(retailBase, 2)),
    );

    const coldChain = c.category === 'Leafy Greens' || c.category === 'Fruit';
    const m = computeMargin({
      mandiPrice: row.mandi_price_inr_kg,
      retailPrice: retail,
      category: c.category,
      costs: operations.costs,
      marginCfg: operations.margin,
      coldChain,
    });

    // Streak is computed on the assessment, not the price series.
    const below = m.gross_margin_pct < operations.margin.targetGrossMarginPct;
    const cur = streakState.get(row.commodity) || 0;
    streakState.set(row.commodity, below ? cur + 1 : 0);

    const flags = evaluateDay({
      marginRow: m,
      priceRow: row,
      cfg: operations,
      history: { consecutiveBelowTarget: streakState.get(row.commodity) },
    });

    assessed.push({
      date: row.date,
      day_index: row.day_index,
      commodity: row.commodity,
      label: row.label,
      category: row.category,
      mandi_price_inr_kg: row.mandi_price_inr_kg,
      retail_price_inr_kg: retail,
      day_return_pct: row.day_return_pct,
      shrink_pct: m.shrink_pct,
      landed_cost_per_kg: m.landed_cost_per_kg,
      gross_profit_per_kg: m.gross_profit_per_kg,
      gross_margin_pct: m.gross_margin_pct,
      cost_to_retail_pct: m.cost_to_retail_pct,
      worst_severity: summarise(flags).worst,
      flag_codes: flags.map((f) => f.code).join('|'),
      flag_count: flags.length,
      _margin: m,
      _price: row,
      _flags: flags,
    });
    lastRetail.set(row.commodity, retail);
  }

  // ---- output ---------------------------------------------------------
  const csvPath = opts.csv || opts.out;
  if (csvPath) {
    const headers = ['date', 'day_index', 'commodity', 'label', 'category',
      'mandi_price_inr_kg', 'retail_price_inr_kg', 'day_return_pct',
      'shrink_pct', 'landed_cost_per_kg', 'gross_profit_per_kg',
      'gross_margin_pct', 'cost_to_retail_pct', 'worst_severity',
      'flag_codes', 'flag_count'];
    const full = path.resolve(csvPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = assessed.map((r) => headers.map((h) => r[h]).join(',')).join('\n');
    fs.writeFileSync(full, `${headers.join(',')}\n${body}\n`, 'utf8');
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      seed, days, with_shocks: withShocks, start: startDate.toISOString().slice(0, 10),
      commodities: keys,
      summary: buildSummary(assessed, operations),
      rows: assessed.map(({ _margin, _price, _flags, ...r }) => r),
    }, null, 2) + '\n');
    return exitCodeFor(assessed);
  }

  if (!opts.quiet) {
    renderSimulateSummary(assessed, operations, { seed, days, withShocks, startDate, csvPath, keys });
  }
  return exitCodeFor(assessed);
}

function buildSummary(assessed, operations) {
  const byCommodity = {};
  for (const r of assessed) {
    (byCommodity[r.commodity] ||= []).push(r);
  }
  const commodities = {};
  for (const [key, rows] of Object.entries(byCommodity)) {
    const margins = rows.map((r) => r.gross_margin_pct).sort((a, b) => a - b);
    const worst = rows.reduce((w, r) =>
      SEVERITY_ORDER.indexOf(r.worst_severity) < SEVERITY_ORDER.indexOf(w.worst_severity)
        ? r : w, rows[0]);
    commodities[key] = {
      label: rows[0].label,
      category: rows[0].category,
      days: rows.length,
      mandi_min: Math.min(...rows.map((r) => r.mandi_price_inr_kg)),
      mandi_max: Math.max(...rows.map((r) => r.mandi_price_inr_kg)),
      mandi_mean: round(rows.reduce((a, r) => a + r.mandi_price_inr_kg, 0) / rows.length, 2),
      margin_min: margins[0],
      margin_median: margins[Math.floor(margins.length / 2)],
      margin_max: margins[margins.length - 1],
      margin_mean: round(margins.reduce((a, b) => a + b, 0) / margins.length, 2),
      days_below_target: rows.filter((r) =>
        r.gross_margin_pct < operations.margin.targetGrossMarginPct).length,
      breaches: rows.filter((r) => r.worst_severity === 'BREACH').length,
      criticals: rows.filter((r) => r.worst_severity === 'CRITICAL').length,
      worst_day: worst.date,
      worst_severity: worst.worst_severity,
      flags: [...new Set(rows.flatMap((r) => r.flag_codes.split('|')).filter(Boolean))],
    };
  }
  return {
    target_margin_pct: operations.margin.targetGrossMarginPct,
    total_rows: assessed.length,
    total_breaches: assessed.filter((r) => r.worst_severity === 'BREACH').length,
    total_criticals: assessed.filter((r) => r.worst_severity === 'CRITICAL').length,
    total_below_target: assessed.filter((r) =>
      r.gross_margin_pct < operations.margin.targetGrossMarginPct).length,
    commodities,
  };
}

function renderSimulateSummary(assessed, operations, meta) {
  const summary = buildSummary(assessed, operations);
  const st = (sev) => (SEVERITY_ORDER.indexOf(sev) < 2 ? s.red(sev) : sev === 'WATCH' || sev === 'REVIEW' ? s.yellow(sev) : s.green(sev));

  console.log(report.heading(
    `Simulation — ${meta.days} days from ${meta.startDate.toISOString().slice(0, 10)}`));
  console.log(report.kv('seed', `${meta.seed} ${s.grey('(reproducible)')}`));
  console.log(report.kv('commodities', meta.keys.join(', ')));
  console.log(report.kv('supply shocks', meta.withShocks ? s.green('enabled') : s.grey('disabled')));
  console.log(report.kv('target margin', `${operations.margin.targetGrossMarginPct}% ${s.grey('(on retail value)')}`));
  if (meta.csvPath) console.log(report.kv('written to', s.cyan(path.resolve(meta.csvPath))));

  console.log(report.heading('Daily assessment'));
  const rows = Object.values(summary.commodities).map((c) => [
    c.label,
    `Rs ${c.mandi_min.toFixed(2)}-${c.mandi_max.toFixed(2)}`,
    `${c.margin_min.toFixed(1)}%`,
    `${c.margin_median.toFixed(1)}%`,
    `${c.days_below_target}/${c.days}`,
    c.breaches,
    c.criticals,
    st(c.worst_severity),
  ]);
  console.log(report.table(
    ['commodity', 'mandi range', 'min margin', 'median', 'below tgt', 'brch', 'crit', 'worst'],
    rows, { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'] }));

  const flagged = assessed
    .filter((r) => r.worst_severity !== 'OK' && r.worst_severity !== 'INFO')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.worst_severity)
      - SEVERITY_ORDER.indexOf(b.worst_severity));

  console.log(report.heading(`Flagged days — ${flagged.length} of ${assessed.length}`));
  if (!flagged.length) {
    console.log(`  ${s.green('No margin flags raised. Every day cleared the target margin.')}`);
  } else {
    const show = meta.detail ? flagged : flagged.slice(0, 8);
    for (const row of show) {
      const acts = row._flags.filter((f) => f.severity !== 'INFO');
      console.log(`\n  ${s.bold(row.date)}  ${s.grey(row.label)}  ` +
        `mandi Rs ${row.mandi_price_inr_kg}  ` +
        `margin ${s.bold(row.gross_margin_pct + '%')}  ` +
        `${report.marginStatus(row.gross_margin_pct, operations)}`);
      for (const f of acts) console.log(report.flagLine(f));
    }
    if (!meta.detail && flagged.length > show.length) {
      console.log(s.grey(`\n  ... ${flagged.length - show.length} more. Re-run with --detail for all.`));
    }
  }

  console.log(report.heading('Summary'));
  console.log(report.kv('days below target', `${summary.total_below_target} of ${summary.total_rows}`));
  console.log(report.kv('critical flags', summary.total_criticals
    ? s.red(String(summary.total_criticals)) : s.green('0')));
  console.log(report.kv('breaches', summary.total_breaches
    ? s.red(String(summary.total_breaches)) : s.green('0')));
}

function exitCodeFor(assessed) {
  const bad = assessed.some((r) => r.worst_severity === 'BREACH' || r.worst_severity === 'CRITICAL');
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------------------
// assess / target / ceiling
// ---------------------------------------------------------------------------

function cmdAssess(cfg, opts) {
  const { commodities, operations } = cfg;
  if (!opts.commodity) throw new UsageError('assess requires --commodity');
  const key = resolveCommodity(commodities, opts.commodity);
  const c = commodities.commodities[key];
  if (opts.mandi === undefined) throw new UsageError('assess requires --mandi');
  if (opts.retail === undefined) throw new UsageError('assess requires --retail');

  const coldChain = c.category === 'Leafy Greens' || c.category === 'Fruit';
  const m = computeMargin({
    mandiPrice: num(opts.mandi, 'mandi'),
    retailPrice: num(opts.retail, 'retail'),
    category: c.category,
    costs: operations.costs,
    marginCfg: operations.margin,
    coldChain,
  });

  const priceRow = { day_return_pct: 0, shock_pct: 0, shocked: false, shock_direction: 'none',
    mandi_price_inr_kg: m.mandi_price };
  const flags = evaluateDay({
    marginRow: m, priceRow, cfg: operations, history: {},
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ commodity: key, ...m, flags }, null, 2) + '\n');
    return flags.some((f) => f.severity === 'BREACH' || f.severity === 'CRITICAL') ? 1 : 0;
  }

  console.log(report.heading(`Assessment — ${c.label} (${c.category})`));
  console.log(report.kv('mandi price', `Rs ${m.mandi_price}/kg`));
  console.log(report.kv('retail price', `Rs ${m.retail_price}/kg`));
  console.log(report.kv('cold chain', coldChain
    ? `applied, Rs ${m.cold_chain_per_kg}/kg` : s.grey('not required for this category')));
  console.log(report.kv('shrink allowance', `${m.shrink_pct}% of purchased weight`));
  console.log('');
  console.log('  ' + s.bold('Cost stack, Rs/kg of salable produce'));
  console.log(report.kv('  purchase (grossed for shrink)', m.purchase_cost_per_salable_kg));
  console.log(report.kv('  freight', m.freight_per_kg));
  console.log(report.kv('  handling', m.handling_per_kg));
  console.log(report.kv('  cold chain', m.cold_chain_per_kg));
  console.log(report.kv('  landed cost', s.bold(String(m.landed_cost_per_kg))));
  console.log('');
  console.log(report.kv('gross margin', `${s.bold(m.gross_margin_pct + '%')}  ${report.marginStatus(m.gross_margin_pct, operations)}`));
  console.log(report.kv('markup on cost', `${m.markup_pct}%`));
  console.log(report.kv('cost to retail', `${m.cost_to_retail_pct}% ${s.grey(`(ceiling ${operations.thresholds.costToRetailPct}%)`)}`));
  console.log(report.kv('per 100 kg bought', `${m.per_100kg.salable_kg} kg salable, Rs ${m.per_100kg.landed_cost} landed, Rs ${m.per_100kg.gross_profit} profit`));

  console.log(report.heading('Flags'));
  if (!flags.length) {
    console.log(`  ${s.green('None. This buy clears the target margin.')}`);
  } else {
    for (const f of flags) console.log(report.flagLine(f));
  }
  return flags.some((f) => f.severity === 'BREACH' || f.severity === 'CRITICAL') ? 1 : 0;
}

function cmdTarget(cfg, opts) {
  const { commodities, operations } = cfg;
  if (!opts.commodity) throw new UsageError('target requires --commodity');
  const key = resolveCommodity(commodities, opts.commodity);
  const c = commodities.commodities[key];
  if (opts.mandi === undefined) throw new UsageError('target requires --mandi');
  const target = opts.margin !== undefined
    ? num(opts.margin, 'margin') : operations.margin.targetGrossMarginPct;

  const coldChain = c.category === 'Leafy Greens' || c.category === 'Fruit';
  const shrinkPct = operations.costs.shrinkAllowancePct[c.category];
  const adders = operations.costs.freightInrPerKg + operations.costs.handlingInrPerKg
    + (coldChain ? operations.costs.coldChainInrPerKg : 0);
  const yieldRate = 1 - shrinkPct / 100;
  const mandi = num(opts.mandi, 'mandi');
  const landed = mandi / yieldRate + adders;
  const required = requiredRetailPrice(landed, target);
  const workingRetail = workingRetailPrice(commodities, key);
  // Headroom is how far the working retail sits ABOVE the price the target
  // demands. Positive means the line clears with room to spare. Computed the
  // other way round it reads as negative precisely when the line is fine,
  // which is the worst possible sign error to ship in a margin tool.
  const headroom = round(workingRetail - required, 2);
  const headroomPct = round((100 * headroom) / workingRetail, 1);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      commodity: key, mandi_price: mandi, landed_cost: round(landed, 2),
      target_margin_pct: target, required_retail: required,
      all_india_average_retail: c.retailBase,
      working_retail: workingRetail,
      headroom_inr: headroom, headroom_pct: headroomPct,
    }, null, 2) + '\n');
    return 0;
  }

  console.log(report.heading(`Retail price required — ${c.label}`));
  console.log(report.kv('mandi price', `Rs ${mandi}/kg`));
  console.log(report.kv('landed cost', `Rs ${round(landed, 2)}/kg ${s.grey(`(incl. ${shrinkPct}% shrink gross-up)`)}`));
  console.log(report.kv('target margin', `${target}% ${s.grey('(on retail value)')}`));
  console.log(report.kv('required retail', s.bold(`Rs ${required}/kg`)));
  console.log(report.kv('all-India average', `Rs ${c.retailBase}/kg ${s.grey('(published DoCA figure)')}`));
  console.log(report.kv('working retail', `Rs ${workingRetail}/kg ${s.grey('(after organised-trade uplift)')}`));
  // The parens must sit inside the substitution. `${cond ? s.green : s.red}(x)`
  // stringifies the *function* and appends the literal "(x)" -- the call never
  // happens.
  const paint = headroom >= 0 ? s.green : s.red;
  console.log(report.kv('headroom', `${paint(`(${headroomPct}%)`)}`));
  console.log('');
  console.log(headroom >= 0
    ? `  ${s.green('Clears')} the target at the benchmark retail price.`
    : `  ${s.red('Does not clear')} the target at the benchmark retail price. ` +
      `Either the buy price must fall to Rs ` +
      `${maxAffordableMandiPrice(workingRetail, target, adders, yieldRate)}/kg ` +
      'or the line cannot hold its margin.');
  return 0;
}

function cmdCeiling(cfg, opts) {
  const { commodities, operations } = cfg;
  if (!opts.commodity) throw new UsageError('ceiling requires --commodity');
  const key = resolveCommodity(commodities, opts.commodity);
  const c = commodities.commodities[key];
  let retail;
  if (opts.retail !== undefined) {
    // Explicit price wins; otherwise fall back to the working retail price so
    // the ceiling is answerable without the caller knowing the denominator.
    retail = num(opts.retail, 'retail');
  } else {
    retail = workingRetailPrice(commodities, key);
  }
  const target = opts.margin !== undefined
    ? num(opts.margin, 'margin') : operations.margin.targetGrossMarginPct;

  const coldChain = c.category === 'Leafy Greens' || c.category === 'Fruit';
  const shrinkPct = operations.costs.shrinkAllowancePct[c.category];
  const adders = operations.costs.freightInrPerKg + operations.costs.handlingInrPerKg
    + (coldChain ? operations.costs.coldChainInrPerKg : 0);
  const yieldRate = 1 - shrinkPct / 100;
  const ceiling = maxAffordableMandiPrice(retail, target, adders, yieldRate);
  const base = c.mandiBase;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      commodity: key, retail_price: retail, target_margin_pct: target,
      max_mandi_price: ceiling, benchmark_mandi: base,
      headroom_inr: round(ceiling - base, 2),
      headroom_pct: round((100 * (ceiling - base)) / base, 1),
    }, null, 2) + '\n');
    return 0;
  }

  console.log(report.heading(`Maximum affordable buy price — ${c.label}`));
  console.log(report.kv('retail price used', `Rs ${retail}/kg ` +
    (opts.retail !== undefined
      ? s.grey('(supplied)')
      : s.grey('(working price, after organised-trade uplift)'))));
  console.log(report.kv('target margin', `${target}% ${s.grey('(on retail value)')}`));
  console.log(report.kv('adders (freight+handling)', `Rs ${adders}/kg ${s.grey(coldChain ? '(incl. cold chain)' : '')}`));
  console.log(report.kv('yield after shrink', `${round(yieldRate * 100, 1)}%`));
  console.log('');
  console.log(report.kv('MAX MANDI PRICE', s.bold(`Rs ${ceiling}/kg`)));
  console.log(report.kv('benchmark mandi', `Rs ${base}/kg`));
  const head = round(ceiling - base, 2);
  const paintHead = head >= 0 ? s.green : s.red;
  console.log(report.kv('headroom',
    paintHead(`Rs ${head}/kg (${round((100 * head) / base, 1)}%)`)));
  console.log('');
  console.log(head >= 0
    ? `  ${s.green('Headroom')} — the line can absorb a rise to Rs ${ceiling}/kg ` +
      `before the ${target}% target breaks.`
    : `  ${s.red('Already over')} the ceiling at the benchmark mandi rate. ` +
      'This line cannot hold its margin at today\'s price.');
  return 0;
}

// ---------------------------------------------------------------------------
// analyse / list / config
// ---------------------------------------------------------------------------

function cmdAnalyse(cfg, opts) {
  const { operations } = cfg;
  const file = opts.csv || opts.out;
  if (!file) throw new UsageError('analyse requires --csv <path>');
  if (!fs.existsSync(file)) throw new UsageError(`CSV not found: ${file}`);

  const text = fs.readFileSync(file, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const headers = lines[0].split(',');
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  for (const required of ['date', 'commodity', 'mandi_price_inr_kg',
    'retail_price_inr_kg', 'gross_margin_pct']) {
    if (idx[required] === undefined) {
      throw new UsageError(`${file} is missing column "${required}"`);
    }
  }

  const rows = lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    return {
      date: cells[idx.date],
      commodity: cells[idx.commodity],
      label: cells[idx.label] || cells[idx.commodity],
      category: cells[idx.category] || '',
      mandi: Number(cells[idx.mandi_price_inr_kg]),
      retail: Number(cells[idx.retail_price_inr_kg]),
      margin: Number(cells[idx.gross_margin_pct]),
      worst: cells[idx.worst_severity] || 'OK',
    };
  });

  const target = operations.margin.targetGrossMarginPct;
  const byKey = {};
  for (const r of rows) (byKey[r.commodity] ||= []).push(r);

  const summary = Object.entries(byKey).map(([key, rs]) => {
    const margins = rs.map((r) => r.margin).sort((a, b) => a - b);
    const best = rs.reduce((w, r) => (r.margin > w.margin ? r : w), rs[0]);
    const worst = rs.reduce((w, r) => (r.margin < w.margin ? r : w), rs[0]);
    return {
      commodity: key,
      label: rs[0].label,
      days: rs.length,
      margin_min: margins[0],
      margin_median: margins[Math.floor(margins.length / 2)],
      margin_max: margins[margins.length - 1],
      mean: round(margins.reduce((a, b) => a + b, 0) / margins.length, 2),
      below_target: rs.filter((r) => r.margin < target).length,
      best_day: best.date,
      worst_day: worst.date,
      breaches: rs.filter((r) => r.worst === 'BREACH').length,
    };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ file, rows: rows.length, target_margin_pct: target, summary }, null, 2) + '\n');
    return summary.some((x) => x.breaches) ? 1 : 0;
  }

  console.log(report.heading(`Re-analysis — ${path.basename(file)}`));
  console.log(report.kv('rows', String(rows.length)));
  console.log(report.kv('target margin', `${target}%`));
  console.log('');
  console.log(report.table(
    ['commodity', 'days', 'min', 'median', 'mean', 'max', 'below tgt', 'worst day'],
    summary.map((x) => [x.label, x.days, `${x.margin_min.toFixed(1)}%`,
      `${x.margin_median.toFixed(1)}%`, `${x.mean.toFixed(1)}%`,
      `${x.margin_max.toFixed(1)}%`, `${x.below_target}/${x.days}`, x.worst_day]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'] }));
  return summary.some((x) => x.breaches) ? 1 : 0;
}

function cmdList(cfg) {
  console.log(report.heading('Configured commodities'));
  const rows = listCommodities(cfg.commodities).map((c) => [
    c.key, c.label, c.category,
    `Rs ${cfg.commodities.commodities[c.key].mandiBase}`,
    `Rs ${cfg.commodities.commodities[c.key].retailBase}`,
    `${cfg.operations.costs.shrinkAllowancePct[c.category]}%`,
  ]);
  console.log(report.table(
    ['key', 'label', 'category', 'mandi', 'retail', 'shrink'], rows,
    { align: ['left', 'left', 'left', 'right', 'right', 'right'] }));
  console.log(`\n  ${s.grey('as of')} ${cfg.commodities.asOf}`);
  return 0;
}

function cmdConfig(cfg) {
  process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  let parsed;
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv, options: OPTIONS, allowPositionals: true, strict: true,
    }));
  } catch (err) {
    process.stderr.write(`${s.red('error')} ${err.message}\n\nRun with --help for usage.\n`);
    return 2;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write('1.0.0\n');
    return 0;
  }

  const command = positionals[0];
  if (!['simulate', 'assess', 'target', 'ceiling', 'analyse', 'list', 'config'].includes(command)) {
    process.stderr.write(`${s.red('error')} unknown command "${command}"\n` +
      `Valid: simulate, assess, target, ceiling, analyse, list, config\n`);
    return 2;
  }

  let cfg;
  try {
    cfg = loadConfig(values.config);
  } catch (err) {
    process.stderr.write(`${s.red('config error')} ${err.message}\n`);
    return 2;
  }

  try {
    switch (command) {
      case 'simulate': return cmdSimulate(cfg, values);
      case 'assess': return cmdAssess(cfg, values);
      case 'target': return cmdTarget(cfg, values);
      case 'ceiling': return cmdCeiling(cfg, values);
      case 'analyse': return cmdAnalyse(cfg, values);
      case 'list': return cmdList(cfg);
      case 'config': return cmdConfig(cfg);
      default: return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${s.red('usage error')} ${err.message}\n\nRun with --help for usage.\n`);
      return 2;
    }
    process.stderr.write(`${s.red('error')} ${err.message}\n`);
    if (process.env.DEBUG) process.stderr.write(s.grey(err.stack + '\n'));
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, buildSummary };
