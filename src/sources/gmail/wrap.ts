/**
 * Rejoining hard-wrapped lines, shared by both alert parsers.
 *
 * The text/plain part of both Indeed and LinkedIn alerts is hard-wrapped at
 * roughly 72 characters, so a long title arrives as two lines. Both parsers
 * classify a block line by line, so the remainder is read as the next field.
 * Measured on 2026-08-14: an Indeed title wrapping after "…and Global" put
 * "WAN Transformation" in the employer slot, pushed the real employer into the
 * location slot and left the location null. That last part is the damaging
 * one — with no location the description loses its "Location: " prefix, the
 * scorer sees nothing addressing working location, and score.ts caps the
 * posting at 39, so a Claude call is spent on something that can never surface.
 *
 * Length alone cannot tell a wrapped remainder from an unrelated field that
 * simply follows a long line: a LinkedIn title of 60-71 characters is
 * ordinary for a senior architecture role and does not wrap, but a
 * length-only test swallowed the employer line beneath it regardless. The
 * heuristic instead asks whether the next line's first word would have
 * fitted on the end of the previous one — a hard wrap only ever breaks
 * because the next word did not fit, so a line is a wrap source only when
 * `previous + " " + firstWordOfNext` would have overrun WRAP_WIDTH. WRAP_MIN
 * is kept as a floor beneath that test (raised to 66, the lowest genuine wrap
 * point observed in the fixtures) so a short line is never treated as a wrap
 * source even if the arithmetic happens to work out.
 *
 * Both tests are against the *raw* previous input line rather than the
 * accumulated join, so a wrapped remainder — which is short, being the tail of
 * a wrap — does not go on to swallow the line after it. A title wrapped across
 * three lines still joins, because the middle line is itself full width.
 *
 * This is a heuristic and it will occasionally be wrong. That is the trade
 * against losing the location on every wrapped title, which was measured
 * rather than hypothesised.
 */
export const WRAP_MIN = 66;

/** The column both alerts hard-wrap prose at. */
const WRAP_WIDTH = 72;

/** The first whitespace-delimited token of a line, for the overrun test. */
function firstWordLength(line: string): number {
  const trimmed = line.trimStart();
  const gap = trimmed.search(/\s/);
  return gap === -1 ? trimmed.length : gap;
}

/**
 * True when appending the next line's first word to the previous line would
 * have overrun the wrap width — the actual mechanism behind a hard wrap.
 */
function overrunsWrapWidth(previousRaw: string, next: string): boolean {
  return previousRaw.length + 1 + firstWordLength(next) > WRAP_WIDTH;
}

export interface WrapRules {
  /** Could this line have been truncated by the wrapper? Prose, not a URL. */
  canWrap: (line: string) => boolean;
  /** Is this line unmistakably a new field rather than a wrapped remainder? */
  isNewField: (line: string) => boolean;
}

export function joinWrappedLines(lines: string[], rules: WrapRules): string[] {
  const out: string[] = [];
  let previousRaw = '';

  for (const line of lines) {
    const continues =
      out.length > 0 &&
      previousRaw.length >= WRAP_MIN &&
      overrunsWrapWidth(previousRaw, line) &&
      rules.canWrap(previousRaw) &&
      !rules.isNewField(line);

    if (continues) out[out.length - 1] += ` ${line}`;
    else out.push(line);

    previousRaw = line;
  }

  return out;
}
