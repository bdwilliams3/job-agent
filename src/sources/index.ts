// Adapter dispatch. Every source collapses into the same Job shape here.
import type { CompanySource, Job } from "../types.ts";
import { detailWorkday, scanWorkday } from "./workday.ts";
import { detailEightfold, scanEightfold } from "./eightfold.ts";
import { scanGreenhouse } from "./greenhouse.ts";
import { scanAshby } from "./ashby.ts";
import { detailOracleHcm, scanOracleHcm } from "./oraclehcm.ts";
import { scanAmazon } from "./amazon.ts";
import { detailNetflix, scanNetflix } from "./netflix.ts";
import { scanGoogle } from "./google.ts";

export interface ScanContext {
  /**
   * Search terms sent to adapters that paginate by keyword.
   * Boards that list everything (Greenhouse, Ashby) ignore this.
   */
  terms: string[];
  /** Upper bound per term per company, so one broad term cannot flood the store. */
  maxJobsPerCompany: number;
}

/** Boards that list every open role ignore the per-term cap. */
const FULL_BOARD_CAP = 5000;

async function scanOneTerm(
  company: CompanySource,
  term: string,
  context: ScanContext,
): Promise<Job[]> {
  const listsEverything =
    company.adapter === "greenhouse" || company.adapter === "ashby";
  const limit = listsEverything ? FULL_BOARD_CAP : context.maxJobsPerCompany;
  switch (company.adapter) {
    case "workday":
      return scanWorkday(company, { searchText: term, maxJobs: limit });
    case "eightfold":
      return scanEightfold(company, { query: term, maxJobs: limit });
    case "oraclehcm":
      return scanOracleHcm(company, { keyword: term, maxJobs: limit });
    case "greenhouse":
      return scanGreenhouse(company, { maxJobs: limit });
    case "ashby":
      return scanAshby(company, { maxJobs: limit });
    case "amazon":
      return scanAmazon(company, { query: term, maxJobs: limit });
    case "netflix":
      return scanNetflix(company, { query: term, maxJobs: limit });
    case "google":
      return scanGoogle(company, { query: term, maxJobs: limit });
  }
}

/**
 * Scans one company across every term, deduping by job key.
 * Greenhouse and Ashby return their whole board, so they run once.
 */
export async function scanCompany(
  company: CompanySource,
  context: ScanContext,
): Promise<Job[]> {
  const listsEverything =
    company.adapter === "greenhouse" || company.adapter === "ashby";
  const terms = listsEverything ? [context.terms[0] ?? ""] : context.terms;

  const byKey = new Map<string, Job>();
  for (const term of terms) {
    const jobs = await scanOneTerm(company, term, context);
    for (const job of jobs) {
      if (!byKey.has(job.key)) byKey.set(job.key, job);
    }
  }
  return [...byKey.values()];
}

/**
 * Fetches full description text for a posting that only came back as listing
 * metadata. Sources that already return full text are returned untouched.
 */
export interface EnrichOptions {
  /** Hard cap per posting. The scan records a failure when it trips. */
  timeoutMs?: number;
}

/**
 * Fetches full description text for a posting that only came back as listing
 * metadata. Sources that already return full text are returned untouched.
 */
export async function enrichJob(
  company: CompanySource,
  job: Job,
  options: EnrichOptions = {},
): Promise<Job> {
  if (job.descriptionQuality === "full") return job;
  switch (company.adapter) {
    case "workday":
      return detailWorkday(company, job);
    case "eightfold":
      return detailEightfold(company, job);
    case "oraclehcm":
      return detailOracleHcm(company, job, { timeoutMs: options.timeoutMs });
    case "netflix":
      return detailNetflix(company, job);
    case "greenhouse":
    case "ashby":
    case "amazon":
    case "google":
      return job;
  }
}
