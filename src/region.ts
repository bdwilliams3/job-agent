// Decides whether a posting is somewhere the candidate would actually work.
//
// The region itself is configuration, not code: accepted cities, states where the
// whole state counts, and rejected cities all come from `filters.locations`. This
// module only parses ATS location strings and applies those lists.
// ATS strings are inconsistent ("City, ST", "CITY, State, United States",
// "Building 400-Some Campus"), so both abbreviations and full state names are
// matched.
import type { Filters } from "./config.ts";
import type { Job } from "./types.ts";

export type LocationVerdict =
  | { ok: true; kind: "local" | "remote"; reason: string }
  | { ok: false; reason: string };

/** Abbreviation and full name for every US state, plus DC and territories. */
const STATES: Array<{ code: string; names: string[] }> = [
  { code: "AL", names: ["AL", "Alabama"] },
  { code: "AK", names: ["AK", "Alaska"] },
  { code: "AZ", names: ["AZ", "Arizona"] },
  { code: "AR", names: ["AR", "Arkansas"] },
  { code: "CA", names: ["CA", "California"] },
  { code: "CO", names: ["CO", "Colorado"] },
  { code: "CT", names: ["CT", "Connecticut"] },
  { code: "DE", names: ["DE", "Delaware"] },
  { code: "DC", names: ["DC", "District of Columbia", "Washington, DC"] },
  { code: "FL", names: ["FL", "Florida"] },
  { code: "GA", names: ["GA", "Georgia"] },
  { code: "HI", names: ["HI", "Hawaii"] },
  { code: "ID", names: ["ID", "Idaho"] },
  { code: "IL", names: ["IL", "Illinois"] },
  { code: "IN", names: ["IN", "Indiana"] },
  { code: "IA", names: ["IA", "Iowa"] },
  { code: "KS", names: ["KS", "Kansas"] },
  { code: "KY", names: ["KY", "Kentucky"] },
  { code: "LA", names: ["LA", "Louisiana"] },
  { code: "ME", names: ["ME", "Maine"] },
  { code: "MD", names: ["MD", "Maryland"] },
  { code: "MA", names: ["MA", "Massachusetts"] },
  { code: "MI", names: ["MI", "Michigan"] },
  { code: "MN", names: ["MN", "Minnesota"] },
  { code: "MS", names: ["MS", "Mississippi"] },
  { code: "MO", names: ["MO", "Missouri"] },
  { code: "MT", names: ["MT", "Montana"] },
  { code: "NE", names: ["NE", "Nebraska"] },
  { code: "NV", names: ["NV", "Nevada"] },
  { code: "NH", names: ["NH", "New Hampshire"] },
  { code: "NJ", names: ["NJ", "New Jersey"] },
  { code: "NM", names: ["NM", "New Mexico"] },
  { code: "NY", names: ["NY", "New York"] },
  { code: "NC", names: ["NC", "North Carolina"] },
  { code: "ND", names: ["ND", "North Dakota"] },
  { code: "OH", names: ["OH", "Ohio"] },
  { code: "OK", names: ["OK", "Oklahoma"] },
  { code: "OR", names: ["OR", "Oregon"] },
  { code: "PA", names: ["PA", "Pennsylvania"] },
  { code: "RI", names: ["RI", "Rhode Island"] },
  { code: "SC", names: ["SC", "South Carolina"] },
  { code: "SD", names: ["SD", "South Dakota"] },
  { code: "TN", names: ["TN", "Tennessee"] },
  { code: "TX", names: ["TX", "Texas"] },
  { code: "UT", names: ["UT", "Utah"] },
  { code: "VT", names: ["VT", "Vermont"] },
  { code: "VA", names: ["VA", "Virginia"] },
  { code: "WA", names: ["WA", "Washington"] },
  { code: "WV", names: ["WV", "West Virginia"] },
  { code: "WI", names: ["WI", "Wisconsin"] },
  { code: "WY", names: ["WY", "Wyoming"] },
  { code: "PR", names: ["PR", "Puerto Rico"] },
];

/**
 * Finds the last state mentioned. Postings list later locations as the broader
 * scope, so the last match is the most specific one available.
 */
function stateOf(text: string): string | null {
  let found: { code: string; index: number } | null = null;
  for (const state of STATES) {
    for (const name of state.names) {
      const pattern =
        name.length === 2
          ? new RegExp(`\\b${name}\\b`, "g")
          : new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "gi");
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (!found || index > found.index) found = { code: state.code, index };
      }
    }
  }
  return found?.code ?? null;
}

/** Full name for a state code, for readable rejection reasons. */
function stateName(code: string): string {
  const state = STATES.find((entry) => entry.code === code);
  return state?.names[1] ?? code;
}

function textOf(job: Job): string {
  return job.locations.join(" | ");
}

function containsAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const needle of needles) {
    if (lower.includes(needle.toLowerCase())) return needle;
  }
  return null;
}

/** Classifies a job against the configured region. */
export function classifyLocation(job: Job, filters: Filters): LocationVerdict {
  const text = textOf(job);
  const explicitRemote = containsAny(text, filters.locations.remote.accept_patterns);

  if (job.remote || explicitRemote) {
    if (!filters.locations.remote.include) {
      return { ok: false, reason: "remote excluded by config" };
    }
    return { ok: true, kind: "remote", reason: "remote" };
  }

  const rejected = containsAny(text, filters.locations.reject_cities);
  if (rejected) return { ok: false, reason: `${rejected} is outside commuting range` };

  const accepted = containsAny(text, filters.locations.accept_cities);
  if (accepted) return { ok: true, kind: "local", reason: accepted };

  const state = stateOf(text);
  if (state && filters.locations.accept_states_fully.includes(state)) {
    return { ok: true, kind: "local", reason: stateName(state) };
  }
  if (state) return { ok: false, reason: `${state} is out of region` };

  return { ok: false, reason: "no recognizable location" };
}
