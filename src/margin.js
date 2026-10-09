/**
 * Landed-cost and margin arithmetic.
 *
 * The whole point of this module is that margin is NOT retail minus mandi
 * price. A tool that compares two numbers from a price board is a toy,
 * because those two numbers are never the whole cost.
 *
 * Cost stack, per kg, in the order it accrues:
 *
 *   1. mandi price              the acquisition cost
 *   2. freight                 PC to dark store, then last mile
 *   3. handling                grading, sorting, palletising
 *   4. cold chain              chilled lines only
 *   5. shrink allowance        charged on PURCHASED weight
 *
 * Step 5 is the one that gets mishandled. Shrinkage is a yield loss on the
 * weight you bought, so it must be charged against the purchase cost before
 * margin is computed. Charging it after -- dividing the margin by the saleable
 * weight -- understates cost on exactly the perishable lines where it matters
 * most, and quietly flatters the worst performers.
 *
 * A second convention, and it changes the sign of the answer: margin is
 * expressed on the RETAIL value, not on cost.
 *
 *   gross margin % = (retail - cost) / retail
 *
 * A sourcing manager comparing to a 22% target means gross margin, because
 * that is what a category P&L is built on. Computing it on cost instead makes
 * a 22% gross margin read as 28.6% on cost -- a number that looks better and
 * means nothing.
 */

'use strict';

/** Round to n decimals without float drift artefacts. */
function round(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Full cost stack and margin for one day and commodity.
 *
 * @param {object} args
 * @param {number} args.mandiPrice     Rs/kg
 * @param {number} args.retailPrice    Rs/kg
 * @param {string} args.category
 * @param {object} args.costs          operations.costs
 * @param {object} args.marginCfg      operations.margin
 * @param {boolean} [args.coldChain]   chilled line?
 * @returns {object}
 */
function computeMargin({ mandiPrice, retailPrice, category, costs, marginCfg, coldChain = false }) {
  if (!(mandiPrice > 0)) throw new Error(`mandiPrice must be positive, got ${mandiPrice}`);
  if (!(retailPrice > 0)) throw new Error(`retailPrice must be positive, got ${retailPrice}`);

  const freight = costs.freightInrPerKg;
  const handling = costs.handlingInrPerKg;
  const coldChainCost = coldChain ? costs.coldChainInrPerKg : 0;
  const shrinkPct = costs.shrinkAllowancePct[category];
  if (shrinkPct === undefined) {
    throw new Error(
      `no shrink allowance configured for category "${category}". ` +
      'Add it to costs.shrinkAllowancePct in operations.json');
  }

  // Cost per kg of SALABLE produce. The shrink allowance is applied to the
  // purchased weight, so the divisor is (1 - shrinkPct).
  const purchaseCostPerKg = mandiPrice;
  const yieldRate = 1 - shrinkPct / 100;
  const purchaseCostPerSalableKg = purchaseCostPerKg / yieldRate;

  const landedCost = purchaseCostPerSalableKg + freight + handling + coldChainCost;

  const grossProfitPerKg = retailPrice - landedCost;
  const grossMarginPct = (grossProfitPerKg / retailPrice) * 100;
  const markupPct = (grossProfitPerKg / landedCost) * 100;
  const costToRetailPct = (landedCost / retailPrice) * 100;

  // Per 100 kg purchased, which is the unit a purchase order is written in.
  //
  // The cost lines are expressed per kg OF SALABLE PRODUCE so that they sum to
  // the landed total. Showing the raw purchase cost here instead would make
  // the block fail to add up by exactly the shrink gross-up -- and a cost
  // breakdown that does not add up is worse than no breakdown.
  const per100 = {
    purchased_kg: 100,
    salable_kg: round(100 * yieldRate, 2),
    purchase_cost: round(100 * purchaseCostPerSalableKg, 2),
    shrink_gross_up: round(100 * purchaseCostPerSalableKg - 100 * purchaseCostPerKg, 2),
    freight: round(100 * freight, 2),
    handling: round(100 * handling, 2),
    cold_chain: round(100 * coldChainCost, 2),
    landed_cost: round(100 * landedCost, 2),
    retail_value: round(100 * retailPrice, 2),
    gross_profit: round(100 * grossProfitPerKg, 2),
  };

  return {
    mandi_price: round(mandiPrice, 2),
    retail_price: round(retailPrice, 2),
    shrink_pct: shrinkPct,
    yield_rate: round(yieldRate, 4),
    purchase_cost_per_kg: round(purchaseCostPerKg, 2),
    purchase_cost_per_salable_kg: round(purchaseCostPerSalableKg, 2),
    freight_per_kg: round(freight, 2),
    handling_per_kg: round(handling, 2),
    cold_chain_per_kg: round(coldChainCost, 2),
    landed_cost_per_kg: round(landedCost, 2),
    gross_profit_per_kg: round(grossProfitPerKg, 2),
    gross_margin_pct: round(grossMarginPct, 2),
    markup_pct: round(markupPct, 2),
    cost_to_retail_pct: round(costToRetailPct, 2),
    per_100kg: per100,
  };
}

/**
 * Retail price needed to hit a target gross margin at a given landed cost.
 * Inverts margin = (retail - cost) / retail  =>  retail = cost / (1 - margin).
 *
 * Used by the `target` command: given today's mandi price, what retail price
 * does the category need to clear its margin?
 *
 * @param {number} landedCost
 * @param {number} targetMarginPct
 * @returns {number}
 */
function requiredRetailPrice(landedCost, targetMarginPct) {
  if (!(landedCost > 0)) throw new Error(`landedCost must be positive, got ${landedCost}`);
  const m = targetMarginPct / 100;
  if (!(m > 0 && m < 1)) {
    throw new Error(`targetMarginPct must be between 0 and 100 exclusive, got ${targetMarginPct}`);
  }
  return round(landedCost / (1 - m), 2);
}

/**
 * Maximum mandi price that still clears the target margin at a retail price.
 * The procurement-side question, and the one a buyer actually asks.
 *
 * @param {number} retailPrice
 * @param {number} targetMarginPct
 * @param {number} adders  freight + handling + cold chain, Rs/kg
 * @param {number} yieldRate 1 - shrink allowance
 * @returns {number}
 */
function maxAffordableMandiPrice(retailPrice, targetMarginPct, adders, yieldRate) {
  const costCeiling = retailPrice * (1 - targetMarginPct / 100);
  return round((costCeiling - adders) * yieldRate, 2);
}

module.exports = { computeMargin, requiredRetailPrice, maxAffordableMandiPrice, round };
