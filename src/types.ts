// Shared vocabulary for the job agent.

export type AdapterName =
  | "workday"
  | "oraclehcm"
  | "eightfold"
  | "greenhouse"
  | "ashby"
  | "amazon"
  | "netflix"
  | "google";

export interface CompanySource {
  name: string;
  tier: number;
  adapter: AdapterName;
  careers: string;
  // workday
  tenant?: string;
  wd?: string;
  site?: string;
  // oraclehcm
  host?: string;
  siteNumber?: string;
  // eightfold
  efHost?: string;
  domain?: string;
  // greenhouse | ashby
  slug?: string;
}

/** A normalized posting. Every adapter must produce exactly this shape. */
export interface Job {
  /** Stable dedupe key: `company:externalId`. */
  key: string;
  company: string;
  tier: number;
  externalId: string;
  title: string;
  locations: string[];
  remote: boolean;
  url: string;
  description: string;
  /**
   * "full"    - complete description text
   * "listing" - search-result metadata only (title, location, short blurb)
   * Adapters that need a second call start at "listing".
   */
  descriptionQuality: "full" | "listing" | "partial";
  department: string | null;
  postedAt: string | null;
}

/** What a job description is scored against after scraping. */
export interface ScoreComponents {
  titleFit: number;
  domainFit: number;
  seniorityFit: number;
  locationFit: number;
  recency: number;
}

/** A lane id, defined by the profile's `tracks` list. */
export type TrackId = string;

export interface Score {
  key: string;
  score: number;
  track: TrackId | null;
  components: ScoreComponents;
  matchedTags: string[];
  reasons: string[];
  extractions: Extraction;
}

/** Facts pulled out of the posting text. Kept so tailoring does not re-parse. */
export interface Extraction {
  responsibilities: string[];
  requirements: string[];
  keywords: string[];
  seniority: string | null;
}

export type PacketKind = "resume" | "cover";

export interface Packet {
  key: string;
  kind: PacketKind;
  markdown: string;
  pdfPath: string | null;
  model: string;
  createdAt: string;
}

export interface ApplicationRow {
  key: string;
  status: "queued" | "packet_ready" | "submitted" | "skipped" | "rejected";
  applyUrl: string | null;
  notes: string | null;
  updatedAt: string;
}
