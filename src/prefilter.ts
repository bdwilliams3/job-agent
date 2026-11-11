// Cheap structural filters. These run at rank time so that tuning never forces a
// re-scan: the store keeps every posting the scan saw.
import type { Filters } from "./config.ts";
import type { Job } from "./types.ts";
import { classifyLocation } from "./region.ts";

/** How a posting earned its place. Core roles outrank adjacent ones. */
export type DomainTier = "core" | "adjacent";

export interface PrefilterResult {
  kept: Array<{ job: Job; tier: DomainTier }>;
  dropped: Array<{ job: Job; reason: string }>;
}

function matchesAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function countMatches(text: string, needles: string[]): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const needle of needles) {
    const pattern = needle.toLowerCase();
    let index = lower.indexOf(pattern);
    while (index !== -1) {
      total++;
      index = lower.indexOf(pattern, index + pattern.length);
    }
  }
  return total;
}

function titleVerdict(job: Job, filters: Filters): string | null {
  const title = job.title.toLowerCase();
  if (matchesAny(title, filters.titles.exclude)) return "excluded title";
  if (!matchesAny(title, filters.titles.include)) return "not a leadership title";
  return null;
}

/**
 * Decides whether a posting belongs to a targeted field.
 *
 * A strong term in the title is enough on its own. An adjacent-term title (risk,
 * controls, infrastructure, ...) only counts when the posting backs it up:
 * a strong term in the department, or repeated field vocabulary in the body.
 * The body is never sufficient alone, because large employers mention
 * every neighbouring function in their boilerplate.
 */
export function domainVerdict(
  job: Job,
  filters: Filters,
): { tier: DomainTier } | { reason: string } {
  const title = job.title.toLowerCase();
  const department = (job.department ?? "").toLowerCase();
  const { strong, adjacent, min_description_hits, adjacent_enabled } =
    filters.domain;

  if (matchesAny(title, strong)) return { tier: "core" };
  if (matchesAny(department, strong)) return { tier: "core" };

  if (!adjacent_enabled) return { reason: "adjacent lanes disabled" };

  const adjacentInTitle = matchesAny(title, adjacent);
  if (!adjacentInTitle) return { reason: "not in the target field" };

  if (matchesAny(department, adjacent) || matchesAny(department, strong)) {
    return { tier: "adjacent" };
  }
  const hits = countMatches(job.description, strong);
  if (hits >= min_description_hits) return { tier: "adjacent" };

  return { reason: `adjacent lane, only ${hits} target-term mentions in body` };
}

/** Boards often repost one role per location. Same company + title = same job. */
function dedupeKey(job: Job): string {
  return `${job.company}::${job.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/**
 * Applies title, domain, and location filters, then collapses per-location
 * duplicates, preferring a local posting over a remote one and a core lane over
 * an adjacent one.
 */
export function prefilter(jobs: Job[], filters: Filters): PrefilterResult {
  const kept: Array<{ job: Job; tier: DomainTier }> = [];
  const dropped: Array<{ job: Job; reason: string }> = [];

  for (const job of jobs) {
    const titleReason = titleVerdict(job, filters);
    if (titleReason) {
      dropped.push({ job, reason: titleReason });
      continue;
    }
    const domain = domainVerdict(job, filters);
    if ("reason" in domain) {
      dropped.push({ job, reason: domain.reason });
      continue;
    }
    const location = classifyLocation(job, filters);
    if (!location.ok) {
      dropped.push({ job, reason: location.reason });
      continue;
    }
    kept.push({ job, tier: domain.tier });
  }

  const byKey = new Map<string, { job: Job; tier: DomainTier; remote: boolean }>();
  for (const entry of kept) {
    const key = dedupeKey(entry.job);
    const verdict = classifyLocation(entry.job, filters);
    const remote = verdict.ok ? verdict.kind === "remote" : false;
    const existing = byKey.get(key);
    const better =
      !existing ||
      (existing.remote && !remote) ||
      (existing.remote === remote && existing.tier === "adjacent" && entry.tier === "core");
    if (better) {
      byKey.set(key, { job: entry.job, tier: entry.tier, remote });
    } else {
      dropped.push({ job: entry.job, reason: "duplicate of a better posting" });
    }
  }

  return {
    kept: [...byKey.values()].map((entry) => ({ job: entry.job, tier: entry.tier })),
    dropped,
  };
}

/**
 * Whether a posting is worth the cost of a detail fetch at scan time.
 * Deliberately looser than prefilter: it accepts any security vocabulary so the
 * strict decision can be revisited later without re-scanning.
 */
export function worthEnriching(job: Job, filters: Filters): boolean {
  const haystack = `${job.title} ${job.department ?? ""}`.toLowerCase();
  const { strong, adjacent } = filters.domain;
  if (matchesAny(haystack, strong) || matchesAny(haystack, adjacent)) return true;
  return countMatches(job.description, strong) >= filters.domain.min_description_hits;
}
