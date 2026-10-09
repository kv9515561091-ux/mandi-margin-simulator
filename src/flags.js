/**
 * Threshold rules engine.
 *
 * Every flag carries a severity and a suggested action, because a flag a
 * sourcing manager cannot act on is just an alert they will mute. Severity
 * is a deliberate function of both the breach size and the persistence --
 * a single bad day is noise, three consecutive days is a trend.
 *
 * Flag taxonomy
 * -------------
 *   BREACH   margin below the floor, or cost-to-retail above the ceiling.
 *            Sell-through cannot save this. Stop buying.
 *   CRITICAL margin below critical, or a price spike above the escalation
 *            threshold. Escalate today.
 *   WATCH    margin below target, or a price spike. Review within a day.
 *   REVIEW   margin has been below target for the configured number of
 *            consecutive days. Reopen the negotiation.
 *   OPPORTUNITY  price has fallen materially. Cheap stock is worth taking
 *            IF the shrink holds -- so the action is conditional.
 *   INFO     context only.
 *
 * The opportunity flag exists because this tool would otherwise only ever
 * tell a buyer to stop doing things. Sourcing is not only about avoiding
 * loss; a 12% fall in onion is the moment to increase the buy, and a tool
 * that flags nothing but margin pressure trains its user to ignore it.
 */

'use strict';

const { round } = require('./margin');

/** Ordered most to least severe, for exit code and summary ordering. */
const SEVERITY_ORDER = ['BREACH', 'CRITICAL', 'WATCH', 'REVIEW', 'OPPORTUNITY', 'INFO'];
const SEVERITY_RANK = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i]));

function worstSeverity(flags) {
  if (!flags.length) return 'OK';
  return flags.reduce((worst, f) =>
    (SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst] ? f.severity : worst),
  SEVERITY_ORDER[SEVERITY_ORDER.length - 1]);
}

/**
 * Evaluate one day/commodity against the thresholds.
 *
 * @param {object} args
 * @param {object} args.marginRow  from computeMargin
 * @param {object} args.priceRow   from the price engine
 * @param {object} args.cfg        operations config
 * @param {object} args.history    { consecutiveBelowTarget }
 * @param {number} [args.daysBelowTarget]  override for the streak
 * @returns {Array<object>}
 */
function evaluateDay({ marginRow, priceRow, cfg, history = {} }) {
  const flags = [];
  const { margin: m, thresholds: t } = cfg;

  // ---- Margin --------------------------------------------------------
  if (marginRow.gross_margin_pct < m.criticalMarginPct) {
    flags.push({
      code: 'MARGIN_CRITICAL',
      severity: 'CRITICAL',
      value: marginRow.gross_margin_pct,
      message: `gross margin ${round(marginRow.gross_margin_pct, 2)}% is below ` +
        `the ${m.criticalMarginPct}% critical floor`,
      action: 'Escalate to the category head today. Renegotiate the FPO ' +
        'price or cap the volume until it recovers.',
    });
  } else if (marginRow.gross_margin_pct < m.targetGrossMarginPct) {
    flags.push({
      code: 'MARGIN_BELOW_TARGET',
      severity: 'WATCH',
      value: marginRow.gross_margin_pct,
      message: `gross margin ${round(marginRow.gross_margin_pct, 2)}% is below ` +
        `the ${m.targetGrossMarginPct}% target`,
      action: 'Check whether a supplier at a better rate is available before ' +
        'committing today\'s volume.',
    });
  }

  if (marginRow.gross_margin_pct < m.minMarginPct) {
    flags.push({
      code: 'MARGIN_BREACH',
      severity: 'BREACH',
      value: marginRow.gross_margin_pct,
      message: `gross margin ${round(marginRow.gross_margin_pct, 2)}% is ` +
        'negative -- every kilo sold loses money',
      action: 'Stop procurement for this line. Reprice or delist.',
    });
  }

  if (marginRow.cost_to_retail_pct > t.costToRetailPct) {
    flags.push({
      code: 'COST_TO_RETAIL_BREACH',
      severity: 'BREACH',
      value: marginRow.cost_to_retail_pct,
      message: `landed cost is ${round(marginRow.cost_to_retail_pct, 2)}% of ` +
        `retail, above the ${t.costToRetailPct}% ceiling`,
      action: 'No sell-through level clears target margin at this cost. ' +
        'The retail price or the buy price must move.',
    });
  }

  // ---- Streak --------------------------------------------------------
  const streak = history.consecutiveBelowTarget || 0;
  if (streak >= t.daysBelowTarget) {
    flags.push({
      code: 'MARGIN_PERSISTENT',
      severity: 'REVIEW',
      value: streak,
      message: `gross margin has been below target for ${streak} ` +
        'consecutive days',
      action: 'This is a structural gap, not a bad day. Reopen the supplier ' +
        'negotiation or re-tier the line.',
    });
  }

  // ---- Price movement ------------------------------------------------
  const ret = priceRow.day_return_pct || 0;
  if (ret >= t.priceSpikePct) {
    flags.push({
      code: 'PRICE_SPIKE',
      severity: ret >= t.priceSpikePct * 1.5 ? 'CRITICAL' : 'WATCH',
      value: ret,
      message: `mandi price up ${round(ret, 1)}% in one day to ` +
        `Rs ${priceRow.mandi_price_inr_kg}/kg`,
      action: 'Confirm the cause before buying -- a genuine supply shock and ' +
        'a reporting error look identical on a price board. Substituting a ' +
        'similar commodity is usually cheaper than absorbing the spike.',
    });
  }

  if (ret <= -t.priceCollapsePct) {
    flags.push({
      code: 'PRICE_OPPORTUNITY',
      severity: 'OPPORTUNITY',
      value: ret,
      message: `mandi price down ${round(Math.abs(ret), 1)}% in one day to ` +
        `Rs ${priceRow.mandi_price_inr_kg}/kg`,
      action: 'Consider increasing the buy IF shrink holds at this volume. ' +
        'A falling price is usually a supply glut, and glut produce ages ' +
        'faster -- buy more only if you can move it.',
    });
  }

  if (priceRow.shocked) {
    flags.push({
      code: 'SHOCK_DETECTED',
      severity: 'INFO',
      value: priceRow.shock_pct,
      message: `supply shock ${priceRow.shock_direction} ` +
        `${round(Math.abs(priceRow.shock_pct), 1)}%`,
      action: 'Recorded for the weekly review. Shocks cluster, so two or ' +
        'three in a fortnight is a supply pattern rather than bad luck.',
    });
  }

  // ---- Ordering ------------------------------------------------------
  return flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Track the below-target streak per commodity across a run.
 *
 * @param {Array<object>} rows
 * @param {object} cfg
 * @returns {Map<string, number>} commodity -> consecutive days below target
 */
function computeStreaks(rows, cfg) {
  const streaks = new Map();
  for (const row of rows) {
    const below = row.gross_margin_pct < cfg.margin.targetGrossMarginPct;
    const cur = streaks.get(row.commodity) || 0;
    streaks.set(row.commodity, below ? cur + 1 : 0);
  }
  return streaks;
}

/**
 * Human-readable summary of a flag set.
 * @param {Array<object>} flags
 * @returns {{worst: string, count: number, actionable: number}}
 */
function summarise(flags) {
  const actionable = flags.filter((f) => f.severity !== 'INFO').length;
  return { worst: worstSeverity(flags), count: flags.length, actionable };
}

module.exports = { evaluateDay, computeStreaks, summarise, worstSeverity, SEVERITY_ORDER };
