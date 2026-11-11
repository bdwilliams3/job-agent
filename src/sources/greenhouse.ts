// Greenhouse adapter. Covers companies that post their whole board here.
// One call returns every posting with full HTML content, so no detail step.
import { getJson } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  location: { name: string | null } | null;
  content: string;
  departments: Array<{ name: string }>;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export interface GreenhouseScanOptions {
  maxJobs: number;
}

/** Fetches every listed posting for the board. */
export async function scanGreenhouse(
  company: CompanySource,
  options: GreenhouseScanOptions,
): Promise<Job[]> {
  if (!company.slug) {
    throw new Error(`greenhouse company ${company.name} is missing "slug"`);
  }
  const response = await getJson<GreenhouseResponse>(
    `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`,
  );
  return response.jobs.slice(0, options.maxJobs).map((entry) => {
    const location = entry.location?.name ?? "";
    return {
      key: `${company.name}:${entry.id}`,
      company: company.name,
      tier: company.tier,
      externalId: String(entry.id),
      title: entry.title,
      locations: location ? [location] : [],
      remote: /remote/i.test(location),
      url: entry.absolute_url,
      description: htmlToText(entry.content ?? ""),
      descriptionQuality: "full" as const,
      department: entry.departments.map((d) => d.name).join(", ") || null,
      postedAt: entry.updated_at ? new Date(entry.updated_at).toISOString() : null,
    };
  });
}
