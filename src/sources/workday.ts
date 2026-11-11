// Workday CXS adapter. Covers most large enterprises.
import { getJson, postJson } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const PAGE_SIZE = 20;

interface WorkdayPosting {
  // Tenants vary: some summary rows carry only bulletFields, so these are
  // optional and unlistable rows are skipped by the scan.
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WorkdaySearchResponse {
  total: number;
  jobPostings: WorkdayPosting[];
}

interface WorkdayDetailResponse {
  jobPostingInfo: {
    title: string;
    jobDescription: string;
    location: string;
    startDate: string;
    jobRequisitionId: string;
  };
}

export interface WorkdayScanOptions {
  searchText: string;
  maxJobs: number;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`workday company is missing "${field}"`);
  return value;
}

function siteBase(company: CompanySource): string {
  return `https://${required(company.tenant, "tenant")}.${required(company.wd, "wd")}.myworkdayjobs.com`;
}

function cxsBase(company: CompanySource): string {
  return `${siteBase(company)}/wday/cxs/${required(company.tenant, "tenant")}/${required(company.site, "site")}`;
}

/** Workday exposes absolute routes like /job/City-ST/Title_REQ123. */
function externalIdOf(posting: { externalPath: string; bulletFields?: string[] }): string {
  const fromPath = posting.externalPath.match(/_(R\d+|[A-Z]*\d{4,})$/)?.[1];
  return fromPath ?? posting.bulletFields?.[0] ?? posting.externalPath;
}

/** Workday renders relative dates ("Posted 2 Days Ago"), so resolve them against now. */
function parsePostedOn(postedOn: string): string | null {
  const text = postedOn.replace(/^Posted\s*/i, "").trim();
  const now = Date.now();
  if (/^today/i.test(text)) return new Date(now).toISOString();
  if (/^yesterday/i.test(text)) return new Date(now - 86_400_000).toISOString();
  const days = text.match(/(\d+)\+?\s+day/i)?.[1];
  if (days) return new Date(now - Number(days) * 86_400_000).toISOString();
  return null;
}

function isRemote(locationsText: string): boolean {
  return /remote|virtual|work from home/i.test(locationsText);
}

function toJob(
  company: CompanySource,
  posting: WorkdayPosting & { title: string; externalPath: string },
): Job {
  const externalId = externalIdOf(posting);
  return {
    key: `${company.name}:${externalId}`,
    company: company.name,
    tier: company.tier,
    externalId,
    title: posting.title,
    locations: posting.locationsText ? [posting.locationsText] : [],
    remote: isRemote(posting.locationsText ?? ""),
    url: `${siteBase(company)}/en-US/${required(company.site, "site")}${posting.externalPath}`,
    description: "",
    descriptionQuality: "listing",
    department: null,
    postedAt: parsePostedOn(posting.postedOn ?? ""),
  };
}

/** Lists postings for one search term. Descriptions are fetched separately. */
export async function scanWorkday(
  company: CompanySource,
  options: WorkdayScanOptions,
): Promise<Job[]> {
  const endpoint = `${cxsBase(company)}/jobs`;
  const jobs: Job[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total && jobs.length < options.maxJobs) {
    const page = await postJson<WorkdaySearchResponse>(endpoint, {
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset,
      searchText: options.searchText,
    });
    total = page.total;
    if (page.jobPostings.length === 0) break;
    for (const posting of page.jobPostings) {
      // A row without a title or path cannot be listed or opened; skip it rather
      // than inventing placeholders that would pollute the store.
      const { title, externalPath } = posting;
      if (!title || !externalPath) continue;
      jobs.push(toJob(company, { ...posting, title, externalPath }));
    }
    offset += PAGE_SIZE;
  }
  return jobs.slice(0, options.maxJobs);
}

/** Fetches the full description for one posting. */
export async function detailWorkday(
  company: CompanySource,
  job: Job,
): Promise<Job> {
  const externalPath = new URL(job.url).pathname.replace(
    `/en-US/${required(company.site, "site")}`,
    "",
  );
  const detail = await getJson<WorkdayDetailResponse>(
    `${cxsBase(company)}${externalPath}`,
  );
  return {
    ...job,
    description: htmlToText(detail.jobPostingInfo.jobDescription),
    descriptionQuality: "full",
    postedAt: job.postedAt ?? detail.jobPostingInfo.startDate ?? null,
  };
}
