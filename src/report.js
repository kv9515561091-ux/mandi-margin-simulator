/**
 * Terminal rendering. Zero dependencies, ANSI only.
 *
 * Colour is suppressed automatically when stdout is not a TTY, when
 * NO_COLOR is set (https://no-color.org), or when --no-color is passed, so
 * piping to a file or a CI log gives clean text.
 */

'use strict';

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m',
};

const SEVERITY_STYLE = {
  BREACH: { colour: 'red', glyph: 'X', label: 'BREACH  ' },
  CRITICAL: { colour: 'red', glyph: '!', label: 'CRITICAL' },
  WATCH: { colour: 'yellow', glyph: '^', label: 'WATCH   ' },
  REVIEW: { colour: 'blue', glyph: '~', label: 'REVIEW  ' },
  OPPORTUNITY: { colour: 'green', glyph: '+', label: 'OPPORTUN' },
  INFO: { colour: 'grey', glyph: '.', label: 'INFO    ' },
  OK: { colour: 'green', glyph: '=', label: 'OK      ' },
};

function makeStyler(enabled) {
  if (!enabled) return new Proxy({}, { get: () => (s) => s });
  return new Proxy({}, {
    get: (_t, key) => (s) => `${CODES[key] || ''}${s}${CODES.reset}`,
  });
}

/** Detect whether colour should be used. */
function shouldColour(opts = {}) {
  if (opts.noColor) return false;
  if (opts.color === false) return false;
  if (opts.color === true) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const s = makeStyler(shouldColour());

/**
 * Render an aligned table.
 *
 * @param {Array<string>} headers
 * @param {Array<Array<string|number>>} rows
 * @param {object} opts { align: Array<'left'|'right'>, colours: Array<boolean> }
 * @returns {string}
 */
function table(headers, rows, opts = {}) {
  const align = opts.align || headers.map(() => 'right');
  const all = [headers, ...rows.map((r) => r.map((x) => String(x)))];

  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => (r[i] || '').length)));

  const pad = (text, i) => {
    const w = widths[i];
    return align[i] === 'left' ? text.padEnd(w) : text.padStart(w);
  };

  const head = headers.map((h, i) => {
    const t = pad(h, i);
    return i === 0 ? s.bold(t) : align[i] === 'left' ? s.bold(t) : s.bold(t);
  }).join('  ');

  const body = rows.map((r, ri) => r.map((cell, i) => {
    const t = pad(String(cell), i);
    return (opts.colours && opts.colours[ri]) ? s.cyan(t) : t;
  }).join('  ')).join('\n');

  return `${head}\n${s.grey('-'.repeat(head.length))}\n${body}`;
}

/** Render a flag line. */
function flagLine(flag) {
  const st = SEVERITY_STYLE[flag.severity] || SEVERITY_STYLE.INFO;
  const badge = s[st.colour](`${st.glyph} ${st.label}`);
  return `  ${badge} ${s.bold(flag.code)}\n` +
    `      ${flag.message}\n` +
    `      ${s.grey('-> ' + flag.action)}`;
}

/** Section heading. */
function heading(text) {
  return `\n${s.bold(s.cyan(text))}\n${s.grey('='.repeat(Math.min(text.length + 8, 78)))}`;
}

/** Key/value line. */
function kv(key, value, padTo = 22) {
  return `  ${s.grey(key.padEnd(padTo))} ${value}`;
}

/** Status glyph for a margin value, coloured by band. */
function marginStatus(marginPct, cfg) {
  if (marginPct < cfg.margin.minMarginPct) return s.red('negative');
  if (marginPct < cfg.margin.criticalMarginPct) return s.red('critical');
  if (marginPct < cfg.margin.targetGrossMarginPct) return s.yellow('below target');
  if (marginPct < cfg.margin.warningMarginPct) return s.yellow('thin');
  return s.green('healthy');
}

module.exports = { table, flagLine, heading, kv, marginStatus, s, shouldColour, SEVERITY_STYLE };
