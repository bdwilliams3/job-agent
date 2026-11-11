// Loads and validates the three YAML files. This is the only place that parses
// untrusted file shapes, so it is where shape assumptions are checked.
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AdapterName, CompanySource } from "./types.ts";

const ADAPTERS: AdapterName[] = [
  "workday",
  "oraclehcm",
  "eightfold",
  "greenhouse",
  "ashby",
  "amazon",
  "netflix",
  "google",
];

export interface Filters {
  locations: {
    accept_cities: string[];
    accept_states: string[];
    /** States accepted as local when the posting names the state but no accepted city. */
    accept_states_fully: string[];
    reject_cities: string[];
    remote: { include: boolean; accept_patterns: string[] };
  };
  titles: { include: string[]; exclude: string[] };
  /** Terms that define the field being targeted, in any industry. */
  domain: {
    strong: string[];
    adjacent: string[];
    min_description_hits: number;
    adjacent_enabled: boolean;
    adjacent_score_multiplier: number;
  };
  ranking: {
    weights: {
      title_fit: number;
      domain_fit: number;
      seniority_fit: number;
      location_fit: number;
      recency: number;
    };
    max_age_days: number;
    min_base_comp_usd?: number;
  };
  applications: { mode: string; auto_submit: boolean };
}

export interface ProfileBullet {
  id: string;
  text: string;
  alt?: string;
  metrics?: Record<string, number | string>;
  tags: string[];
}

export interface ProfileRole {
  company: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  group?: string;
  lead_bullet?: string;
  bullets: ProfileBullet[];
}

/** A side project or public repo worth showing when it matches the posting. */
export interface ProfileProject {
  name: string;
  text: string;
  tags: string[];
  /** Optional public link; only add one you are happy for a recruiter to open. */
  url?: string;
}

export interface ProfilePrior {
  company: string;
  title: string;
  start: string;
  end: string;
  text: string;
  tags: string[];
}

/** Facts an application form asks for. Never printed on a resume. */
export interface PersonalDetails {
  first_name: string;
  last_name: string;
  preferred_name: string;
  address: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  pronouns: string;
  gender_identity: string;
  race_ethnicity: string[];
  hispanic_latino: boolean;
  veteran_status: string;
  disability_status: string;
  work_authorized: boolean;
  requires_sponsorship: boolean;
  /** Answer to the "how did you hear about us" field most boards require. */
  how_did_you_hear: string;
  sexual_orientation: string;
  /** False when no agreement limits which roles can be taken. */
  non_compete: boolean;
}

export interface Profile {
  name: string;
  headline: string;
  location: string;
  contact: {
    email: string;
    phone: string;
    linkedin?: string;
    github?: string;
    website?: string;
  };
  personal: PersonalDetails;
  summary: string;
  tracks: Array<{ id: string; label: string; titles: string[] }>;
  skill_tags: {
    strong: string[];
    working: string[];
    leadership: string[];
  };
  roles: ProfileRole[];
  /** One line summarising the earlier career; rendered under Earlier Career. */
  prior_line?: string;
  prior: ProfilePrior[];
  /** Optional: selected only when a posting overlaps their tags. */
  projects: ProfileProject[];
  education: string[];
  certifications: string[];
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function asRecord(file: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(file, "expected a YAML mapping at the top level");
  }
  return value as Record<string, unknown>;
}

function asCompanies(file: string, value: unknown): CompanySource[] {
  const record = asRecord(file, value);
  const raw = record.companies;
  if (!Array.isArray(raw)) fail(file, "expected a \"companies\" list");
  return raw.map((entry, index) => {
    const company = asRecord(`${file}[companies][${index}]`, entry);
    const name = String(company.name ?? "");
    const adapter = String(company.adapter ?? "");
    if (!name) fail(file, `companies[${index}] is missing name`);
    if (!ADAPTERS.includes(adapter as AdapterName)) {
      fail(file, `companies[${index}] has unknown adapter "${adapter}"`);
    }
    return {
      name,
      tier: Number(company.tier ?? 2),
      adapter: adapter as AdapterName,
      careers: String(company.careers ?? ""),
      tenant: company.tenant as string | undefined,
      wd: company.wd as string | undefined,
      site: company.site as string | undefined,
      host: company.host as string | undefined,
      siteNumber: company.siteNumber as string | undefined,
      efHost: company.efHost as string | undefined,
      domain: company.domain as string | undefined,
      slug: company.slug as string | undefined,
    };
  });
}

export interface CompanyFile {
  companies: CompanySource[];
  pending: Array<{ name: string; careers: string }>;
}

export async function loadCompanies(path: string): Promise<CompanyFile> {
  const record = asRecord(path, parse(await readFile(path, "utf8")));
  return {
    companies: asCompanies(path, record),
    pending: Array.isArray(record.pending)
      ? record.pending.map((entry) => {
          const item = asRecord(path, entry);
          return { name: String(item.name ?? ""), careers: String(item.careers ?? "") };
        })
      : [],
  };
}

export async function loadFilters(path: string): Promise<Filters> {
  return asRecord(path, parse(await readFile(path, "utf8"))) as unknown as Filters;
}

export async function loadProfile(path: string): Promise<Profile> {
  return asRecord(path, parse(await readFile(path, "utf8"))) as unknown as Profile;
}
