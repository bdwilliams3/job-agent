// Amazon Jobs adapter. The public search endpoint returns listing metadata plus a
// short description and the qualification lists, so no detail request is needed.
import { getJson } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const PAGE_SIZE = 100;

interface AmazonJob {
  id_icims: string;
  job_path: string;
  title: string;
  location: string;
  posted_date: string;
  job_category: string | null;
  description: string | null;
  basic_qualifications: string | null;
  preferred_qualifications: string | null;
}

interface AmazonSearchResponse {
  jobs: AmazonJob[];
  hits: number;
}

export interface AmazonScanOptions {
  query: string;
  maxJobs: number;
}

/** Parses Amazon's human-readable date ("October  3, 2026"). */
function toIso(value: string): string | null {
  const parsed = Date.parse(value.replace(/\s+/g, " "));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function descriptionOf(job: AmazonJob): string {
  const parts = [job.description, job.basic_qualifications, job.preferred_qualifications]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => htmlToText(part));
  return parts.join("\n\n");
}

/** Lists postings matching one keyword, newest first. */
export async function scanAmazon(
  company: CompanySource,
  options: AmazonScanOptions,
): Promise<Job[]> {
  const jobs: AmazonJob[] = [];
  for (let offset = 0; offset < options.maxJobs; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, options.maxJobs - offset);
    const url =
      "https://www.amazon.jobs/en/search.json" +
      `?base_query=${encodeURIComponent(options.query)}` +
      `&result_limit=${limit}&offset=${offset}&sort=recent`;
    const page = await getJson<AmazonSearchResponse>(url);
    jobs.push(...page.jobs);
    if (page.jobs.length < limit || jobs.length >= page.hits) break;
  }

  return jobs.map((entry) => ({
    key: `${company.name}:${entry.id_icims}`,
    company: company.name,
    tier: company.tier,
    externalId: entry.id_icims,
    title: entry.title,
    locations: entry.location ? [entry.location] : [],
    remote: /remote/i.test(entry.location ?? ""),
    url: `https://www.amazon.jobs${entry.job_path}`,
    description: descriptionOf(entry),
    // The search payload carries a summary and the qualification lists, not the
    // full page body; scoring treats that as partial.
    descriptionQuality: "partial" as const,
    department: entry.job_category,
    postedAt: toIso(entry.posted_date),
  }));
}
