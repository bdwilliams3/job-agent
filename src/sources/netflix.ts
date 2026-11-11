// Netflix adapter. The job board exposes a paginated JSON search endpoint
// (metadata only) and a per-position endpoint that carries the full description.
import { getJson } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const HOST = "https://explore.jobs.netflix.net";
const DOMAIN = "netflix.com";
const PAGE_SIZE = 50;

interface NetflixPosition {
  id: number;
  name: string;
  location: string | null;
  locations: string[] | null;
  department: string | null;
  canonicalPositionUrl: string;
  t_update: number | null;
}

interface NetflixSearchResponse {
  positions: NetflixPosition[];
  count: number;
}

interface NetflixDetailResponse extends NetflixPosition {
  job_description: string | null;
}

export interface NetflixScanOptions {
  query: string;
  maxJobs: number;
}

function postedAt(position: NetflixPosition): string | null {
  return position.t_update ? new Date(position.t_update * 1000).toISOString() : null;
}

/** Lists postings matching one keyword. */
export async function scanNetflix(
  company: CompanySource,
  options: NetflixScanOptions,
): Promise<Job[]> {
  const positions: NetflixPosition[] = [];
  for (let start = 0; start < options.maxJobs; start += PAGE_SIZE) {
    const url =
      `${HOST}/api/apply/v2/jobs?domain=${DOMAIN}` +
      `&start=${start}&num=${Math.min(PAGE_SIZE, options.maxJobs - start)}` +
      `&query=${encodeURIComponent(options.query)}`;
    const page = await getJson<NetflixSearchResponse>(url);
    positions.push(...page.positions);
    if (page.positions.length === 0 || positions.length >= page.count) break;
  }

  return positions.map((position) => {
    const locations = position.locations ?? (position.location ? [position.location] : []);
    return {
      key: `${company.name}:${position.id}`,
      company: company.name,
      tier: company.tier,
      externalId: String(position.id),
      title: position.name,
      locations,
      remote: locations.some((entry) => /remote/i.test(entry)),
      url: position.canonicalPositionUrl,
      description: "",
      descriptionQuality: "listing" as const,
      department: position.department,
      postedAt: postedAt(position),
    };
  });
}

/** Fetches the full description for one posting. */
export async function detailNetflix(
  company: CompanySource,
  job: Job,
): Promise<Job> {
  const detail = await getJson<NetflixDetailResponse>(
    `${HOST}/api/apply/v2/jobs/${job.externalId}?domain=${DOMAIN}`,
  );
  return {
    ...job,
    description: htmlToText(detail.job_description ?? ""),
    descriptionQuality: "full",
    department: detail.department ?? job.department,
    postedAt: postedAt(detail) ?? job.postedAt,
  };
}
