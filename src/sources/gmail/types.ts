/** A posting as lifted out of an alert email, before it becomes a NormalisedJob. */
export interface RawPosting {
  source: 'indeed' | 'linkedin';
  sourceId: string;
  title: string;
  employer: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** Board day rates and annual salaries share two columns; this tells them apart. */
  salaryPeriod: 'annual' | 'daily' | 'unknown';
  snippet: string;
  url: string;
  postedAt: string | null; // ISO
}

export interface IndeedParseResult {
  postings: RawPosting[];
  /**
   * Blocks carrying a pagead link and no jk key. Roughly two thirds of an
   * Indeed digest measured on 2026-08-14, so this is the majority path — it is
   * counted rather than ignored so a further rise is visible in the logs.
   */
  skippedSponsored: number;
  /**
   * Blocks with an organic rc/clk link whose job key could not be read. Kept
   * apart from skippedSponsored because this one means the template changed,
   * and folding the two together would make a parser failure look like a rise
   * in advertising — masking the very signal skippedSponsored exists to give.
   */
  skippedNoKey: number;
}
