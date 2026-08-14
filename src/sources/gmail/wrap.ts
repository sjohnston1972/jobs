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
 * The heuristic: a line continues the one above it when the line above was
 * long enough to plausibly have been wrapped (WRAP_MIN characters or more),
 * the line above is the kind of line that wraps at all (prose, not a URL or a
 * badge), and the line itself is not recognisably the start of a new field.
 *
 * The length test is against the *raw* previous input line rather than the
 * accumulated join, so a wrapped remainder — which is short, being the tail of
 * a wrap — does not go on to swallow the line after it. A title wrapped across
 * three lines still joins, because the middle line is itself full width.
 *
 * This is a heuristic and it will occasionally be wrong: a genuine field that
 * follows a 60-character line and matches none of the caller's patterns gets
 * swallowed. That is the trade against losing the location on every wrapped
 * title, which was measured rather than hypothesised.
 */
export const WRAP_MIN = 60;

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
      rules.canWrap(previousRaw) &&
      !rules.isNewField(line);

    if (continues) out[out.length - 1] += ` ${line}`;
    else out.push(line);

    previousRaw = line;
  }

  return out;
}
