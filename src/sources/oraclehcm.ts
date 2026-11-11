// Oracle HCM (Oracle Recruiting Cloud) adapter. Covers employers on that platform.
//
// The list endpoint returns requisitions without description text, and this
// tenant rejects recruitingCEJobRequisitionDetails finders outright. So the
// scan is cheap and listing-quality, and full text comes from rendering the
// public job page in headless Chrome for shortlisted jobs only.
import { getJson } from "../util/http.ts";
import { dumpDom } from "../util/chrome.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const PAGE_SIZE = 100;

interface OracleRequisition {
  Id: string;
  Title: string;
  PostedDate: string | null;
  PrimaryLocation: string;
  PrimaryLocationCountry: string | null;
  WorkplaceType: string | null;
  ShortDescriptionStr: string | null;
  JobFamily: string | null;
  secondaryLocations: Array<{ Location: string }>;
  workLocation: Array<{
    TownOrCity: string | null;
    Country: string | null;
    Region1: string | null;
  }>;
}

interface OracleSearchResponse {
  items: Array<{
    TotalJobsCount: number;
    requisitionList: OracleRequisition[];
  }>;
  hasMore: boolean;
}

export interface OracleScanOptions {
  keyword: string;
  maxJobs: number;
}

function base(company: CompanySource): string {
  if (!company.host) throw new Error(`oraclehcm company ${company.name} is missing "host"`);
  return `https://${company.host}`;
}

function siteNumber(company: CompanySource): string {
  if (!company.siteNumber) {
    throw new Error(`oraclehcm company ${company.name} is missing "siteNumber"`);
  }
  return company.siteNumber;
}

/** Public job page, used for headless enrichment. */
export function oracleJobUrl(company: CompanySource, externalId: string): string {
  return `${base(company)}/hcmUI/CandidateExperience/en/sites/${siteNumber(company)}/job/${externalId}`;
}

function locationsOf(requisition: OracleRequisition): string[] {
  const secondary = requisition.secondaryLocations.map((entry) => entry.Location);
  if (secondary.length > 0) return secondary;
  return [requisition.PrimaryLocation];
}

function isRemote(requisition: OracleRequisition): boolean {
  if ((requisition.WorkplaceType ?? "").toLowerCase().includes("remote")) return true;
  return locationsOf(requisition).some((entry) => /remote/i.test(entry));
}

function toJob(company: CompanySource, requisition: OracleRequisition): Job {
  return {
    key: `${company.name}:${requisition.Id}`,
    company: company.name,
    tier: company.tier,
    externalId: requisition.Id,
    title: requisition.Title,
    locations: locationsOf(requisition),
    remote: isRemote(requisition),
    url: oracleJobUrl(company, requisition.Id),
    description: requisition.ShortDescriptionStr ?? "",
    descriptionQuality: "listing",
    department: requisition.JobFamily,
    postedAt: requisition.PostedDate ? new Date(requisition.PostedDate).toISOString() : null,
  };
}

/** Lists requisitions matching one keyword, newest first. */
export async function scanOracleHcm(
  company: CompanySource,
  options: OracleScanOptions,
): Promise<Job[]> {
  const jobs: Job[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total && jobs.length < options.maxJobs) {
    // Oracle rejects percent-encoded "," and ";" inside the finder value, so
    // this URL is composed manually instead of through URLSearchParams.
    const finder =
      "findReqs;" +
      [
        `siteNumber=${siteNumber(company)}`,
        `keyword=${encodeURIComponent(options.keyword)}`,
        `limit=${PAGE_SIZE}`,
        `offset=${offset}`,
        "sortBy=POSTING_DATES_DESC",
      ].join(",");
    const query = [
      "onlyData=true",
      "expand=requisitionList.secondaryLocations,requisitionList.workLocation",
      `finder=${finder}`,
    ].join("&");
    const page = await getJson<OracleSearchResponse>(
      `${base(company)}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${query}`,
    );
    const item = page.items[0];
    if (!item) break;
    total = item.TotalJobsCount;
    if (item.requisitionList.length === 0) break;
    for (const requisition of item.requisitionList) {
      jobs.push(toJob(company, requisition));
    }
    offset += PAGE_SIZE;
  }
  return jobs.slice(0, options.maxJobs);
}

/**
 * Renders the public job page and extracts the description block.
 * Costs a Chrome launch per job, so callers only do this for shortlisted roles.
 */
export async function detailOracleHcm(
  company: CompanySource,
  job: Job,
  options: { timeoutMs?: number } = {},
): Promise<Job> {
  const dom = await dumpDom(oracleJobUrl(company, job.externalId), {
    timeoutMs: options.timeoutMs,
  });
  const text = htmlToText(dom);
  const start = text.search(/Job Description/i);
  const end = text.search(/About Us|Equal Opportunity|Our Commitment|Similar Jobs/i);
  const slice = start >= 0 ? text.slice(start, end > start ? end : undefined) : text;
  return {
    ...job,
    description: slice.trim(),
    descriptionQuality: "partial",
  };
}
