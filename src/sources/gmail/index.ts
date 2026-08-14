import type { Criteria, Env, NormalisedJob } from '../../lib/types';
import { inferContractType, looksRemote, withHash } from '../../pipeline/normalise';
import { getAccessToken, getMessage, listMessageIds } from './client';
import { parseIndeedAlert } from './indeed';
import { parseLinkedInAlert } from './linkedin';
import type { RawPosting } from './types';

/**
 * Job alert emails as a third source.
 *
 * Indeed and LinkedIn have no usable public API, so their alert mail is the
 * only practical route in. Both are read from the text/plain part, which is
 * rigidly structured and far cheaper to parse than the HTML.
 *
 * queryOverride exists for /gmail/preview, which widens the window to inspect
 * what the parsers make of the last few days.
 */
export async function fetchGmail(
  env: Env,
  criteria: Criteria,
  queryOverride?: string,
): Promise<NormalisedJob[]> {
  const token = await getAccessToken(env);
  const query = queryOverride ?? criteria.gmailQuery;
  const ids = await listMessageIds(token, query, criteria.maxEmailsPerRun);

  const postings: RawPosting[] = [];
  let sponsored = 0;
  let indeedMails = 0;
  let linkedinMails = 0;
  let unparsed = 0;

  for (const id of ids) {
    const message = await getMessage(token, id);
    if (!message.plainText) {
      unparsed++;
      continue;
    }
    const from = message.from.toLowerCase();

    if (from.includes('jobalert.indeed.com')) {
      indeedMails++;
      const result = parseIndeedAlert(message.plainText, message.receivedAt);
      postings.push(...result.postings);
      sponsored += result.skippedSponsored;
    } else if (from.includes('linkedin.com')) {
      linkedinMails++;
      postings.push(...parseLinkedInAlert(message.plainText, message.receivedAt));
    }
    // Anything else matched the query but has no parser; ignored silently.
  }

  console.log(
    'gmail: ' +
      `${ids.length} messages (${indeedMails} indeed, ${linkedinMails} linkedin), ` +
      `${postings.length} postings, ${sponsored} sponsored skipped, ${unparsed} without a text part`,
  );

  return Promise.all(postings.map(toNormalisedJob));
}

function toNormalisedJob(posting: RawPosting): Promise<NormalisedJob> {
  // The location is prepended because Indeed frequently writes "Remote" or
  // "Hybrid remote in London" there, and it is the only text in the email that
  // addresses working location for the scorer to quote as remote_evidence.
  const description = [
    posting.location ? `Location: ${posting.location}` : '',
    posting.snippet,
  ]
    .filter(Boolean)
    .join('\n');

  return withHash({
    id: `${posting.source}:${posting.sourceId}`,
    source: posting.source,
    source_id: posting.sourceId,
    title: posting.title,
    employer: posting.employer,
    location_raw: posting.location,
    remote_flag: looksRemote(posting.title, description),
    contract_type: inferContractType(`${posting.title} ${posting.snippet}`),
    salary_min: posting.salaryMin,
    salary_max: posting.salaryMax,
    salary_period: posting.salaryPeriod,
    // Indeed estimates a salary when the employer states none and does not say
    // which is which, so every figure from it is treated as predicted.
    salary_predicted: posting.source === 'indeed' && posting.salaryMin !== null ? 1 : 0,
    currency: posting.salaryMin !== null ? 'GBP' : null,
    url: posting.url,
    description,
    // An alert excerpt is never the whole advert, so the body gate defers it to
    // the scorer exactly as it does for Adzuna.
    description_truncated: 1,
    posted_at: posting.postedAt,
  });
}
