// Deterministic scoring. No model calls here: ranking has to be reproducible and
// free so that re-filtering is instant. Generation happens later in tailor.ts.
import type { Filters, Profile } from "./config.ts";
import type { Extraction, Job, Score, ScoreComponents, TrackId } from "./types.ts";
import type { DomainTier } from "./prefilter.ts";
import { classifyLocation } from "./region.ts";

/** Title vocabulary mapped to a management seniority, best first. */
const LEVELS: Array<{ level: Seniority; patterns: string[] }> = [
  { level: "head", patterns: ["head of", "global head", "chief"] },
  {
    level: "director",
    patterns: ["executive director", "managing director", "senior director", "director"],
  },
  { level: "manager", patterns: ["senior manager", "group manager", "manager"] },
  { level: "vp", patterns: ["svp", "senior vice president", "vice president", "vp", "avp"] },
  { level: "lead", patterns: ["principal", "team lead", "tech lead", "lead"] },
  { level: "senior", patterns: ["partner", "senior counsel", "counsel", "attending", "senior"] },
];

export type Seniority =
  | "head"
  | "director"
  | "manager"
  | "vp"
  | "lead"
  | "senior"
  | "unknown";

/** How well each seniority matches the candidate's stated goal. */
const LEVEL_FIT: Record<Seniority, number> = {
  head: 1.0,
  director: 1.0,
  manager: 0.85,
  vp: 0.8,
  lead: 0.55,
  senior: 0.5,
  unknown: 0.45,
};

const SECTION_HEADS = {
  responsibilities: [
    "responsibilities",
    "what you'll do",
    "what you will do",
    "the role",
    "about the role",
    "job description",
    "key responsibilities",
    "you will",
  ],
  requirements: [
    "requirements",
    "qualifications",
    "what we're looking for",
    "what we are looking for",
    "who you are",
    "basic qualifications",
    "minimum qualifications",
    "preferred qualifications",
    "skills",
    "experience required",
    "about you",
  ],
} as const;

export function detectLevel(title: string): Seniority {
  const lower = title.toLowerCase();
  for (const entry of LEVELS) {
    if (entry.patterns.some((pattern) => lower.includes(pattern))) return entry.level;
  }
  return "unknown";
}

/**
 * Words that identify a lane, taken from the profile's own track ids and labels,
 * so nothing about a specific industry is baked into the code.
 */
function trackPatterns(profile: Profile): Array<{ track: TrackId; patterns: string[] }> {
  return profile.tracks.map((track) => {
    const words = `${track.id} ${track.label}`
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 3);
    return { track: track.id, patterns: [...new Set(words)] };
  });
}

function detectTrack(profile: Profile, title: string, description: string): TrackId | null {
  const patterns = trackPatterns(profile);
  // Title wins: the posting body mentions every neighbouring function.
  const titleTrack = bestTrack(patterns, title.toLowerCase());
  return titleTrack ?? bestTrack(patterns, description.toLowerCase());
}

function bestTrack(
  patterns: Array<{ track: TrackId; patterns: string[] }>,
  haystack: string,
): TrackId | null {
  let best: { track: TrackId; hits: number } | null = null;
  for (const entry of patterns) {
    const hits = entry.patterns.filter((pattern) => haystack.includes(pattern)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { track: entry.track, hits };
  }
  return best?.track ?? null;
}

/** Weight of a skill tag when scoring description overlap. */
function tagWeight(tag: string, profile: Profile): number {
  if (profile.skill_tags.strong.includes(tag)) return 1;
  if (profile.skill_tags.working.includes(tag)) return 0.55;
  if (profile.skill_tags.leadership.includes(tag)) return 0.45;
  return 0;
}

function domainFit(job: Job, profile: Profile): { value: number; matched: string[] } {
  const haystack = `${job.title} ${job.description}`.toLowerCase();
  const allTags = [
    ...profile.skill_tags.strong,
    ...profile.skill_tags.working,
    ...profile.skill_tags.leadership,
  ];
  const matched: string[] = [];
  let points = 0;
  for (const tag of allTags) {
    const needle = tag.replace(/-/g, " ");
    if (haystack.includes(tag) || haystack.includes(needle)) {
      matched.push(tag);
      points += tagWeight(tag, profile);
    }
  }
  // 7 weighted points is a strong match for this profile; more adds nothing.
  return { value: Math.min(points / 7, 1), matched };
}

/** Pulls experience requirements out of the posting to compare against tenure. */
function requiredYears(description: string): number | null {
  const match = description.match(/(\d{1,2})\s*\+?\s*years?/i);
  if (!match) return null;
  const years = Number(match[1]);
  return years > 0 && years < 40 ? years : null;
}

/** Years from the earliest role on record to now. */
function careerYears(profile: Profile): number {
  const starts = [...profile.roles, ...profile.prior]
    .map((role) => Number(String(role.start).slice(0, 4)))
    .filter((year) => Number.isFinite(year));
  if (starts.length === 0) return 0;
  return new Date().getUTCFullYear() - Math.min(...starts);
}

function seniorityFit(job: Job, profile: Profile): number {
  const level = LEVEL_FIT[detectLevel(job.title)];
  const required = requiredYears(job.description);
  if (required === null) return level;
  const years = careerYears(profile);
  const ratio = years / required;
  // Under-qualified years matter more than over-qualified ones.
  const yearFit = ratio >= 1 ? 1 : Math.max(0, ratio);
  return level * 0.7 + yearFit * 0.3;
}

function recencyFit(job: Job, filters: Filters): number {
  if (!job.postedAt) return 0.5;
  const ageDays = (Date.now() - new Date(job.postedAt).getTime()) / 86_400_000;
  if (Number.isNaN(ageDays)) return 0.5;
  const window = filters.ranking.max_age_days;
  if (ageDays > window) return 0;
  return 1 - ageDays / window;
}

/** Splits a posting into responsibilities and requirements bullets. */
export function extract(description: string): Extraction {
  const lines = description
    .split("\n")
    .map((line) => line.replace(/^[-*\u2022]\s*/, "").trim())
    .filter((line) => line.length > 0);

  const responsibilities: string[] = [];
  const requirements: string[] = [];
  let section: "none" | "responsibilities" | "requirements" = "none";

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isResponsibilityHead = SECTION_HEADS.responsibilities.some(
      (head) => lower.length < 60 && lower.startsWith(head),
    );
    const isRequirementHead = SECTION_HEADS.requirements.some(
      (head) => lower.length < 60 && lower.startsWith(head),
    );
    if (isResponsibilityHead) {
      section = "responsibilities";
      continue;
    }
    if (isRequirementHead) {
      section = "requirements";
      continue;
    }
    if (line.length < 25 || line.length > 400) continue;
    if (section === "responsibilities" && responsibilities.length < 12) {
      responsibilities.push(line);
    } else if (section === "requirements" && requirements.length < 12) {
      requirements.push(line);
    }
  }

  return {
    responsibilities,
    requirements,
    keywords: topKeywords(description),
    seniority: null,
  };
}

const STOPWORDS = new Set(
  ("a about above after again all also an and any are as at be because been before being below " +
    "between both but by can could did do does doing down during each few for from further had " +
    "has have having he her here hers him his how i if in into is it its itself just me more most " +
    "my no nor not now of off on once only or other our out over own same she should so some such " +
    "than that the their theirs them then there these they this those through to too under until " +
    "up very was we were what when where which while who whom why will with would you your " +
    "work working works role team teams company job candidate candidates including etc across " +
    "within using use used help helps ability able strong excellent experience years year " +
    "including ensure ensuring support supporting provide providing develop developing").split(" "),
);

/** Frequency-ranked domain words, used to pick which bullets a job emphasizes. */
function topKeywords(description: string, limit = 40): string[] {
  const counts = new Map<string, number>();
  for (const word of description.toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) ?? []) {
    const clean = word.replace(/[.-]+$/, "");
    if (clean.length < 3 || STOPWORDS.has(clean)) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((entry) => entry[0]);
}

/** Scores one posting against the profile and configured weights. */
export function scoreJob(
  job: Job,
  profile: Profile,
  filters: Filters,
  tier: DomainTier = "core",
): Score {
  const level = detectLevel(job.title);
  const location = classifyLocation(job, filters);
  const domain = domainFit(job, profile);
  const responsibilities = extract(job.description);

  const components: ScoreComponents = {
    titleFit: LEVEL_FIT[level],
    domainFit: domain.value,
    seniorityFit: seniorityFit(job, profile),
    locationFit: location.ok ? (location.kind === "local" ? 1 : 0.75) : 0,
    recency: recencyFit(job, filters),
  };

  const weights = filters.ranking.weights;
  const weighted =
    components.titleFit * weights.title_fit +
    components.domainFit * weights.domain_fit +
    components.seniorityFit * weights.seniority_fit +
    components.locationFit * weights.location_fit +
    components.recency * weights.recency;

  // Zero overlap usually means the text was never fetched, not that the job is
  // wrong. Discount rather than drop, and say so in the reasons.
  const evidence =
    domain.matched.length === 0 ? 0.75 : job.descriptionQuality === "full" ? 1 : 0.92;
  // Adjacent lanes score lower at equal title level so core field roles win.
  const tierMultiplier =
    tier === "adjacent" ? filters.domain.adjacent_score_multiplier : 1;
  const adjusted = weighted * evidence * tierMultiplier;

  const reasons: string[] = [
    tier === "adjacent" ? "adjacent lane" : "core lane",
    `${level} level`,
    location.ok ? location.reason : "location filtered",
    domain.matched.length
      ? `matches ${domain.matched.slice(0, 6).join(", ")}`
      : "no skill overlap found",
  ];
  if (job.descriptionQuality !== "full") {
    reasons.push(`${job.descriptionQuality} description text`);
  }
  const required = requiredYears(job.description);
  if (required !== null) reasons.push(`asks ${required}+ years`);

  return {
    key: job.key,
    score: Math.round(adjusted * 1000) / 10,
    track: detectTrack(profile, job.title, job.description),
    components,
    matchedTags: domain.matched,
    reasons,
    extractions: { ...responsibilities, seniority: level },
  };
}
