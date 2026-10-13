# Wholesale Pricing & Margin Simulator

**A zero-dependency Node CLI that simulates daily mandi prices, computes procurement margin against a full landed-cost stack, and flags every day a line stops being worth buying.**

The interesting part is not the price simulator. It is the margin convention.

```bash
git clone https://github.com/kv9515561091-ux/mandi-margin-simulator.git
cd mandi-margin-simulator
node src/index.js simulate --days 30 --seed 99
```

**No `npm install`.** There are zero runtime and zero dev dependencies — this
uses Node's built-in `parseArgs` and `node:test`. Clone and run.

Requires **Node 18+** (developed on 24). Works on any OS.

---

## Why this isn't `retail - mandi`

A margin tool that subtracts the mandi rate from the shelf price is a toy,
because those two numbers are never the whole cost. The full stack, per kg:

```
landed cost =  mandi / (1 - shrink%)      <- shrink is a YIELD loss on what you buy
             +  freight                    <- PC to dark store, then last mile
             +  handling                   <- grading, sorting, palletising
             +  cold chain                 <- chilled lines only
```

Two conventions here change the answer, and both are commonly got wrong:

**Shrink is charged on purchased weight, before margin.** A 12% shrink means
100 kg bought yields 88 kg, so the cost per salable kilo is the purchase price
divided by 0.88. Charging it *after* — dividing the margin by saleable weight —
understates cost on exactly the perishable lines where it matters most, and
quietly flatters the worst performers in the basket.

**Margin is on retail value, not on cost.**

```
gross margin % = (retail - cost) / retail
```

A 22% gross margin is 28.6% markup on cost. A category P&L is built on gross
margin, so that is what a "22% target" means, and computing it on cost
produces a number that looks better and means nothing.

### Worked example

```
$ node src/index.js assess --commodity onion --mandi 51 --retail 58

  Cost stack, Rs/kg of salable produce
    purchase (grossed for shrink)  52.58      51 / 0.97
    freight                        1.85
    handling                       0.95
    cold chain                        0      not required for this category
    landed cost                   55.38

  gross margin   4.52%  critical
  cost to retail 95.48% (ceiling 84%)

  X BREACH   COST_TO_RETAIL_BREACH
      landed cost is 95.48% of retail, above the 84% ceiling
  ! CRITICAL MARGIN_CRITICAL
      gross margin 4.52% is below the 15% critical floor
```

Onion is the tightest line in the basket and the config says so: it carries a
19% organised-trade uplift over the published all-India average, because the
DoCA figure is weighted to loose trade selling at near-mandi. A chain carrying
3% shrink plus ₹2.80/kg of logistics genuinely needs that spread to clear 22%.
It is a real commercial constraint, not a fudge factor — which is why the tool
flags onion on any price rise.

---

## Commands

| Command | Use |
| --- | --- |
| `simulate` | N days of prices plus a daily margin assessment per commodity |
| `assess` | One day at explicit prices — the "should I buy this lot?" question |
| `target` | Retail price needed to hit a target margin at today's mandi price |
| `ceiling` | **Most you can pay** at a given retail price and still clear target |
| `analyse` | Re-run the assessment over a previously written CSV |
| `list` | Configured commodities |
| `config` | The active config as JSON |

### A sourcing manager's daily loop

```bash
# 1. Morning: what does the board look like for the next 30 days?
node src/index.js simulate --days 30 --seed 99

# 2. One line needs a decision right now.
node src/index.js assess --commodity tomato --mandi 38 --retail 48

# 3. Negotiation: what is the most I can pay and still clear 22%?
node src/index.js ceiling --commodity tomato --retail 48

# 4. If the buy price is fixed, what must the shelf price be?
node src/index.js target --commodity tomato --mandi 34

# 5. Archive the run for the weekly category review.
node src/index.js simulate --days 7 --seed $(date +%Y%m%d) --csv data/$(date +%F).csv

# 6. Re-analyse an archived run.
node src/index.js analyse --csv data/2026-10-12.csv
```

`--json` gives machine-readable output on every command. Exit codes: `0` clean,
`1` a breach or critical flag, `2` a usage or config error — so it drops into a
cron or a pre-commit hook unchanged.

---

## What the flags mean

| Severity | Fires when | Action |
| --- | --- | --- |
| `BREACH` | Negative margin, or cost-to-retail above the ceiling | Stop. No sell-through level saves it. |
| `CRITICAL` | Margin under 15%, or a price spike over 1.5× the threshold | Escalate today |
| `WATCH` | Margin under target, or a price spike | Review before committing volume |
| `REVIEW` | Below target for 3+ consecutive days | Structural, not a bad day — reopen the negotiation |
| `OPPORTUNITY` | Price fell more than 12% | Consider buying *more*, if shrink holds |
| `INFO` | A supply shock was detected | For the weekly review; shocks cluster |

Every flag carries a written action. A flag a sourcing manager cannot act on is
an alert they will mute.

The `OPPORTUNITY` flag exists because a tool that only ever says "stop" trains
its user to ignore it. Sourcing is not only about avoiding loss: a 12% fall in
onion is the moment to increase the buy — *if* the shrink holds, because a
falling price usually means a glut and glut produce ages faster.

### On the cost-to-retail ceiling

The breach ceiling is stored as a **margin buffer**, not picked directly:

```
costToRetailPct = 100 - (targetMarginPct - costToRetailBufferPct)
                = 100 - (22 - 6) = 84
```

A hardcoded ceiling can silently contradict the margin target — and then a line
gets reported as a breach while the tool also says it clears target. Config
validation rejects that combination by name. At 84% the line is 6pp under
target, which is a real problem rather than a rounding difference; set the
buffer to 0 for a strictly literal breach.

---

## The price model

Geometric Brownian motion, with a seasonal term and discrete supply shocks:

```
dP/P = mu·dt + sigma·dW + shock(t)
```

**Shocks are the point.** F&V mandi rates do not random-walk politely. A
hailstorm, a mandi holiday, a transport strike or an oversupply week produces a
jump that a pure diffusion model smooths away entirely — and a tool whose
`PRICE_SPIKE` flag never fires is a tool whose most important signal is dead.
A 5.5% daily shock probability with a right-skewed magnitude gives realistic
spikes without a run of shocks on every commodity every week.

**Seasonality is a gentle pull, not a multiplier.** Multiplying by the seasonal
factor each day would compound it and drift the path away from the configured
base within a month. A 6% pull per day tracks the seasonal level properly, and
the angular distance is wrapped so a peak near 31 December does not produce a
discontinuity when the day-of-year rolls over.

**Prices are floored and capped.** An unbounded GBM will cheerfully emit a
₹0.04/kg onion, which makes every downstream margin figure nonsense.

**The whole run is deterministic given a seed.** `Math.random()` is neither
reproducible nor portable, so it is not used — a "simulated" run that cannot be
cited in a report is not evidence of anything. The PRNG is mulberry32 (exactly
specified across engines, unlike anything xorshift-shaped), and the diffusion
and shock processes draw from **separate streams** so that editing the noise
model does not silently rewrite which days happen to be shocked.

---

## Retail price basis

`config/commodities.json` carries both the published figure and the working
figure, and this trips up a lot of margin work:

```json
"retailBase": 53.53,          // DoCA all-India average, published
"retailBasis": {
  "allIndiaAverage": true,
  "organisedUpliftPct": { "onion": 19.0, ... }
}
```

The DoCA retail figure is consumption-weighted across **all** channels and
dominated by unorganised kirana trade. An organised chain's own shelf price
sits above it, because the chain carries cold chain, wastage, staffing and card
costs into the price the way a loose trader does not. Comparing an organised
cost stack against the all-India average flags most lines as breaches — an
artefact of the wrong denominator, not a commercial signal. `config.js` resolves
it once, so every command agrees on the denominator.

Mandi rates are the reported All-India median modal wholesale prices for early
October 2026 (potato ₹1,200/qtl, onion ₹4,500/qtl, tomato ₹3,095/qtl).

---

## Tests

```bash
npm test     # 49 tests, node:test, no dependencies
```

They pin behaviour where a wrong answer costs money rather than crashes:

- shrink is grossed up on purchased weight, and 0% shrink grosses up by exactly 1
- margin on retail differs from markup on cost, by a meaningful margin
- `requiredRetailPrice` and `maxAffordableMandiPrice` are exact inverses
- a higher freight charge or a higher shrink rate *lowers* the affordable buy price
- a non-positive price raises rather than returning `NaN`, and an unknown
  category names itself instead of producing a silent `NaN` that then sorts as a number
- same seed → byte-identical prices; different seed → different path
- each commodity gets an independent stream, so adding one does not shift the others
- 400 simulated days per commodity stay inside their configured bounds
- the seasonal term is continuous across the year boundary
- the PRNG is uniform to within 1.5% across ten buckets
- every shipped commodity clears its target at its own base prices — if a line
  cannot, the config is wrong, not the market
- an incoherent cost-to-retail ceiling is rejected at load, naming the setting

**Two real bugs the suite caught during development**, both left in as
regression tests:

1. The per-100 kg cost block did not sum to its own total. It showed the raw
   purchase cost while the total included the shrink gross-up, so the block was
   short by exactly that amount. A cost breakdown that does not add up is worse
   than no breakdown.
2. Shock draws came from the same stream as the diffusion path, so a commodity
   could go 60 simulated days with zero shocks purely because of how the
   streams interleaved. Now seeded separately.

---

## Layout

```
src/index.js         CLI entry, all seven commands
src/config.js        loading, validation, retail-price resolution
src/priceEngine.js   GBM + seasonality + supply shocks
src/margin.js        landed-cost stack and margin arithmetic
src/flags.js         threshold rules engine
src/report.js        ANSI terminal rendering (suppressed when piped)
src/random.js        seeded PRNG and stream derivation
config/              commodities and operations, fully commented
data/sample_run.csv  a committed 30-day run (seed 99)
test/                49 tests
```

## Requirements

Node 18 or newer. Nothing to install — `package.json` declares no dependencies,
and `npm test` runs on Node's built-in test runner.

## Licence

MIT — see [LICENSE](LICENSE).

---

## Related projects

Three companion projects on the same problem — how much of the gap between
farm-gate cost and shelf price is recoverable in Indian F&V retail. They share
a commodity master, a lane (Bengaluru PC → dark store, 62 km), and a set of
grounded price and loss benchmarks. Each is a standalone repository; clone
only the one you want.

| project | question it answers | try it |
| --- | --- | --- |
| [fpo-sourcing-automation](https://github.com/kv9515561091-ux/fpo-sourcing-automation) | Can field data become a purchase-order line a buyer can act on? Apps Script; runs offline via a Python mirror | `python samples/generate_samples.py && python -m unittest discover -s samples` |
| [fv-shrinkage-dashboard](https://github.com/kv9515561091-ux/fv-shrinkage-dashboard) | Why is stock being written off, and would enforcing rotation fix it? A counterfactual re-simulation attributes **57.3% of expiry** to FEFO failure | `pip install -r requirements.txt && python scripts/generate_data.py && python scripts/analyze.py` |
| [transit-spoilage-anova](https://github.com/kv9515561091-ux/transit-spoilage-anova) | Which handling method extends shelf life? Finds that onions must **not** be chilled — worth ₹28.6 lakh/year on one lane | `pip install -r requirements.txt && python analysis/generate_experiment.py && python analysis/anova_analysis.py` |

The connection worth noting: this tool's `shrinkAllowancePct` is a
**planning assumption**, and the dashboard project measures what it should
actually be — **4.29%** at the processing centre, with **57.3% of expiry
traceable to picking out of date order rather than to the produce itself**.
Tuning the allowance to the measured figure, rather than to a round number,
is what turns this from a margin calculator into a decision tool.
