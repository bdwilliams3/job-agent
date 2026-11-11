// Ashby adapter. Covers startups on Ashby. One call, full plain-text content.
import { getJson } from "../util/http.ts";
import type { CompanySource, Job } from "../types.ts";

interface AshbyJob {
  id: string;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  secondaryLocations: Array<{ location: string }>;
  publishedAt: string | null;
  isRemote: boolean;
  workplaceType: string | null;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain: string;
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

export interface AshbyScanOptions {
  maxJobs: number;
}

/** Fetches every listed posting for the board. */
export async function scanAshby(
  company: CompanySource,
  options: AshbyScanOptions,
): Promise<Job[]> {
  if (!company.slug) {
    throw new Error(`ashby company ${company.name} is missing "slug"`);
  }
  const response = await getJson<AshbyResponse>(
    `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`,
  );
  return response.jobs.slice(0, options.maxJobs).map((entry) => {
    const locations = [
      entry.location,
      ...entry.secondaryLocations.map((secondary) => secondary.location),
    ].filter((entry): entry is string => Boolean(entry));
    return {
      key: `${company.name}:${entry.id}`,
      company: company.name,
      tier: company.tier,
      externalId: entry.id,
      title: entry.title,
      locations,
      remote: entry.isRemote || entry.workplaceType === "Remote",
      url: entry.jobUrl,
      description: entry.descriptionPlain ?? "",
      descriptionQuality: "full" as const,
      department: entry.department ?? entry.team,
      postedAt: entry.publishedAt ? new Date(entry.publishedAt).toISOString() : null,
    };
  });
}
