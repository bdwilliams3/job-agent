// Eightfold adapter (pcsx API). Covers employers on Eightfold.
// Search pages in fixed blocks of 10 and never returns descriptions, so both
// listing and detail are two separate calls.
import { getJson } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const PAGE_SIZE = 10;

interface EightfoldPosition {
  id: number;
  displayJobId: string;
  name: string;
  locations: string[];
  standardizedLocations: string[];
  postedTs: number | null;
  department: string | null;
  positionUrl: string;
  workLocationOption: string | null;
}

interface EightfoldSearchResponse {
  data: {
    count: number;
    positions: EightfoldPosition[];
  };
}

interface EightfoldDetailResponse {
  data: {
    name: string;
    locations: string[];
    jobDescription: string;
    publicUrl: string | null;
    positionUrl: string;
    department: string | null;
    postedTs: number | null;
  };
}

export interface EightfoldScanOptions {
  query: string;
  maxJobs: number;
  /** Optional city filter. Server-side, so it cuts paging a lot. */
  location?: string;
}

function host(company: CompanySource): string {
  if (!company.efHost) throw new Error(`eightfold company ${company.name} is missing "efHost"`);
  return company.efHost;
}

function domain(company: CompanySource): string {
  if (!company.domain) throw new Error(`eightfold company ${company.name} is missing "domain"`);
  return company.domain;
}

function searchUrl(company: CompanySource, options: EightfoldScanOptions, start: number): string {
  const params = new URLSearchParams({
    domain: domain(company),
    query: options.query,
    start: String(start),
  });
  if (options.location) params.set("location", options.location);
  return `https://${host(company)}/api/pcsx/search?${params.toString()}`;
}

function locationOption(company: CompanySource, positionUrl: string): string {
  return `https://${host(company)}${positionUrl}`;
}

/** Lists postings for one query. */
export async function scanEightfold(
  company: CompanySource,
  options: EightfoldScanOptions,
): Promise<Job[]> {
  const jobs: Job[] = [];
  let start = 0;
  let total = Number.POSITIVE_INFINITY;

  while (start < total && jobs.length < options.maxJobs) {
    const page = await getJson<EightfoldSearchResponse>(
      searchUrl(company, options, start),
    );
    total = page.data.count;
    if (page.data.positions.length === 0) break;
    for (const position of page.data.positions) {
      const locations = position.locations.length
        ? position.locations
        : position.standardizedLocations;
      const remote =
        position.workLocationOption === "remote" ||
        locations.some((entry) => /remote/i.test(entry));
      jobs.push({
        key: `${company.name}:${position.displayJobId}`,
        company: company.name,
        tier: company.tier,
        externalId: position.displayJobId,
        title: position.name,
        locations,
        remote,
        url: locationOption(company, position.positionUrl),
        description: "",
        descriptionQuality: "listing",
        department: position.department,
        postedAt: position.postedTs
          ? new Date(position.postedTs * 1000).toISOString()
          : null,
      });
    }
    start += PAGE_SIZE;
  }
  return jobs.slice(0, options.maxJobs);
}

/** Fetches the full description for one posting. */
export async function detailEightfold(
  company: CompanySource,
  job: Job,
): Promise<Job> {
  const positionUrl = new URL(job.url).pathname;
  const params = new URLSearchParams({ domain: domain(company) });
  const positionId = job.url.match(/\/job\/(\d+)/)?.[1];
  if (!positionId) throw new Error(`cannot resolve position id from ${job.url}`);
  params.set("position_id", positionId);
  const detail = await getJson<EightfoldDetailResponse>(
    `https://${host(company)}/api/pcsx/position_details?${params.toString()}`,
  );
  return {
    ...job,
    url: detail.data.publicUrl ?? `https://${host(company)}${positionUrl}`,
    description: htmlToText(detail.data.jobDescription),
    descriptionQuality: "full",
    postedAt: job.postedAt,
  };
}
