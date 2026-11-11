// Turns one scored job into a tailored resume and cover letter.
//
// Two things happen here: deterministic bullet selection (so the same job always
// starts from the same facts), and optional model rewriting on top of it. A
// deterministic packet can be produced with no credentials at all, which makes
// rendering testable and keeps the tool usable offline.
import type { Profile, ProfileBullet, ProfileProject, ProfileRole } from "./config.ts";
import type { Job, Score } from "./types.ts";
import type { LlmConfig } from "./llm.ts";
import { complete } from "./llm.ts";

/**
 * How many bullets each role may contribute, newest role first. Sized for a
 * two-page resume: a senior record needs the space, and a second page holding one
 * line reads worse than a full one.
 */
const BULLET_BUDGET = [6, 4, 3];
/** Pre-career entries kept on the page; the rest are omitted entirely. */
const PRIOR_ENTRIES = 2;
/**
 * One sentence covering whatever came before this field, supplied by the profile
 * so the generic code carries no one's history.
 */
const PRIOR_FALLBACK = "Earlier career summarised in the profile.";


export interface SelectedRole {
  role: ProfileRole;
  bullets: ProfileBullet[];
}

export interface TailorContext {
  job: Job;
  score: Score;
  profile: Profile;
}

function tokensOf(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) ?? [];
  return new Set(words.map((word) => word.replace(/[.-]+$/, "")));
}

/**
 * Ranks a bullet by how many of the posting's keywords it echoes.
 * Metrics-bearing bullets get a small bonus because they survive screens better.
 */
function bulletScore(
  bullet: ProfileBullet,
  jobTokens: Set<string>,
  matchedTags: string[],
): number {
  const haystack = `${bullet.text} ${bullet.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of jobTokens) {
    if (haystack.includes(token)) score += 1;
  }
  for (const tag of matchedTags) {
    if (bullet.tags.includes(tag)) score += 3;
  }
  if (bullet.metrics) score += 1.5;
  return score;
}

/** Picks the bullets per role that best answer this posting. */
export function selectBullets(context: TailorContext): SelectedRole[] {
  const { job, score, profile } = context;
  const jobTokens = tokensOf(`${job.title} ${job.description}`);
  const selected: SelectedRole[] = [];

  profile.roles.forEach((role, index) => {
    const budget = BULLET_BUDGET[Math.min(index, BULLET_BUDGET.length - 1)];
    const ranked = role.bullets
      .map((bullet) => ({ bullet, value: bulletScore(bullet, jobTokens, score.matchedTags) }))
      .sort((a, b) => b.value - a.value);

    const chosen: ProfileBullet[] = [];
    const lead = role.bullets.find((bullet) => bullet.id === role.lead_bullet);
    if (lead) chosen.push(lead);
    for (const entry of ranked) {
      if (chosen.length >= budget) break;
      if (entry.bullet === lead) continue;
      if (entry.value <= 0 && chosen.length >= 2) continue;
      chosen.push(entry.bullet);
    }
    if (chosen.length > 0) selected.push({ role, bullets: chosen });
  });

  return selected;
}

/**
 * Projects answering this posting, best tag overlap first. Empty when nothing
 * overlaps, so an unrelated project never pads the page.
 */
export function selectProjects(context: TailorContext, limit = 3): ProfileProject[] {
  const { job, score, profile } = context;
  const jobTokens = tokensOf(`${job.title} ${job.description}`);
  return profile.projects
    .map((project) => {
      const haystack = `${project.name} ${project.text}`.toLowerCase();
      let tokens = 0;
      for (const token of jobTokens) if (haystack.includes(token)) tokens += 1;
      // Tag overlap is the stronger signal: a project tagged for this lane beats one
      // that merely mentions the same word in passing.
      const tags = score.matchedTags.filter((tag) => project.tags.includes(tag)).length;
      return { project, tags, tokens };
    })
    .filter((entry) => entry.tags > 0 || entry.tokens >= 2)
    .sort((a, b) => b.tags - a.tags || b.tokens - a.tokens)
    .slice(0, limit)
    .map((entry) => entry.project);
}

function formatPeriod(start: string, end: string): string {
  const year = (value: string) => value.slice(0, 4);
  const endLabel = end === "present" ? "Present" : year(end);
  return `${year(start)} - ${endLabel}`;
}

function skillLine(profile: Profile, score: Score): string {
  const matched = score.matchedTags;
  const strong = profile.skill_tags.strong.filter((tag) => matched.includes(tag));
  const rest = profile.skill_tags.strong.filter((tag) => !matched.includes(tag));
  const ordered = [...strong, ...rest].slice(0, 14);
  return ordered.map((tag) => tag.replace(/-/g, " ")).join(" | ");
}

/**
 * Builds the resume without a model. Used as the packet body when no credential
 * is present, and as the input the model is asked to improve rather than replace.
 */
export function buildResumeDraft(context: TailorContext): string {
  const { job, score, profile } = context;
  const selected = selectBullets(context);
  const lines: string[] = [];

  lines.push(`# ${profile.name}`);
  lines.push(`${profile.headline}`);
  // Blank line keeps these as separate paragraphs; markdown joins adjacent lines.
  lines.push("");
  lines.push(`${profile.contact.email} | ${profile.contact.phone} | ${profile.location}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(profile.summary.trim());
  lines.push("");

  lines.push("## Core Skills");
  lines.push(skillLine(profile, score));
  lines.push("");

  lines.push("## Experience");
  for (const { role, bullets } of selected) {
    lines.push(`### ${role.company} — ${role.title}`);
    lines.push(`${formatPeriod(role.start, role.end)}${role.location ? ` | ${role.location}` : ""}`);
    for (const bullet of bullets) lines.push(`- ${bullet.text.trim()}`);
    lines.push("");
  }

  const projects = selectProjects(context);
  if (projects.length > 0) {
    lines.push("## Selected Projects");
    for (const project of projects) {
      lines.push(`- **${project.name}** — ${project.text.trim()}`);
    }
    lines.push("");
  }

  if (profile.prior.length > 0) {
    lines.push("## Earlier Career");
    const roles = profile.prior
      .slice(0, PRIOR_ENTRIES)
      .map((prior) => `${prior.company} (${prior.title}, ${formatPeriod(prior.start, prior.end)})`)
      .join("; ");
    lines.push(
      `Earlier career: ${roles}. ${profile.prior_line ?? PRIOR_FALLBACK}`,
    );
  }

  if (profile.certifications.length > 0) {
    lines.push("");
    lines.push("## Certifications");
    lines.push(profile.certifications.join(", "));
  }
  if (profile.education.length > 0) {
    lines.push("");
    lines.push("## Education");
    lines.push(profile.education.join("\n"));
  }

  lines.push("");
  lines.push(`<!-- tailored for ${job.company} ${job.key} -->`);
  return lines.join("\n");
}

const SYSTEM = [
  "You write resume and cover-letter copy for a professional applying to a specific job.",
  "Absolute rules:",
  "- Never invent employers, titles, dates, degrees, certifications, or numbers.",
  "- Every metric must come from the supplied source bullets. Copy numbers exactly.",
  "- Do not add skills that the source material does not evidence.",
  "- Write in plain, specific English. No buzzwords, no 'passionate', no 'synergy'.",
  "- Match the job's vocabulary only where the source material genuinely supports it.",
].join("\n");

/**
 * The profile as the model sees it: career material only. Contact details and form
 * answers are dropped, since a packet has no reason to send them to a model.
 */
function promptProfile(context: TailorContext): string {
  const { profile } = context;
  const material = {
    name: profile.name,
    headline: profile.headline,
    location: profile.location,
    summary: profile.summary.trim(),
    skill_tags: profile.skill_tags,
    roles: profile.roles,
    prior: profile.prior,
    projects: selectProjects(context, 4),
    education: profile.education,
    certifications: profile.certifications,
  };
  return JSON.stringify(material, null, 2).slice(0, 12_000);
}

function jobBrief(job: Job, score: Score): string {
  const parts = [
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.locations.join(" | ")}`,
    `Apply URL: ${job.url}`,
  ];
  if (score.extractions.responsibilities.length) {
    parts.push(
      "Posting responsibilities:\n" +
        score.extractions.responsibilities.map((line) => `- ${line}`).join("\n"),
    );
  }
  if (score.extractions.requirements.length) {
    parts.push(
      "Posting requirements:\n" +
        score.extractions.requirements.map((line) => `- ${line}`).join("\n"),
    );
  }
  if (job.description.trim()) {
    parts.push(`Full posting text:\n${job.description.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

/** Asks the model to tighten the deterministic draft against the posting. */
export async function generateResume(
  context: TailorContext,
  llm: LlmConfig,
): Promise<string> {
  const draft = buildResumeDraft(context);
  const prompt = [
    jobBrief(context.job, context.score),
    `Candidate source material:\n${promptProfile(context)}`,
    `Draft resume to improve:\n${draft}`,
    [
      "Produce the final resume as markdown.",
      "Keep the same section order and the same employers, titles, and date ranges.",
      "Reword bullets so they answer this posting directly, keeping every number intact.",
      "Lead each role with its strongest bullet. Use up to 6 bullets for the current",
      "role, 4 for the next, and 3 for the one after; drop a bullet rather than pad it.",
      "Two pages is the right length for this record, so use the second page for real",
      "content instead of compressing. Keep the Projects section, rewording each entry",
      "to answer this posting without adding claims it does not support.",
      "Do not add a header, preamble, or commentary.",
    ].join("\n"),
  ].join("\n\n");

  return (await complete(llm, prompt, SYSTEM)).trim();
}

/** Models sometimes glue the sign-off onto the closing sentence. */
function tidySignoff(letter: string): string {
  return letter
    .replace(/\s*Sincerely,\s*/i, "\n\nSincerely,\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Asks the model for a cover letter grounded in the same facts. */
export async function generateCover(
  context: TailorContext,
  llm: LlmConfig,
): Promise<string> {
  const selected = selectBullets(context);
  const evidence = selected
    .flatMap((entry) => entry.bullets.map((bullet) => `- ${bullet.text.trim()}`))
    .join("\n");
  const prompt = [
    jobBrief(context.job, context.score),
    `Candidate: ${context.profile.name}, ${context.profile.headline}`,
    `Location: ${context.profile.location}`,
    `Contact: ${context.profile.contact.email} | ${context.profile.contact.phone}`,
    ...(context.profile.certifications.length
      ? [`Certifications: ${context.profile.certifications.join("; ")}`]
      : []),
    `Background:\n${context.profile.summary.trim()}`,
    `Evidence available from the resume:\n${evidence}`,
    [
      "Write a cover letter in markdown, first person, warm and direct, 280-320 words.",
      "Sound like a person speaking to a hiring manager: contractions are fine, vary",
      "sentence length, one idea per sentence, no corporate register.",
      "Structure it in four short parts, as prose paragraphs:",
      "1. Open by introducing the candidate in two or three short sentences: who they",
      "   are, the through-line of their career, and the one thing they have done that",
      "   maps onto the work this posting describes. Then, in a sentence of its own, say",
      "   why this company and this role interest them, naming something concrete from the",
      "   posting (the team, the mandate, what they are building) and why it appeals.",
      "   No flattery, no superlatives about the company, no 'I am writing to apply for'.",
      "2. Give two or three achievements that back the opening claim, with the real",
      "   numbers from the evidence, chosen because they answer this posting.",
      "3. One sentence on how they work or what they would focus on in this role.",
      "4. Close with a direct statement of interest in joining, then sign off:",
      "   'Sincerely,' on its own line, a blank line, then the candidate's name.",
      "Name the company and the role once each. Do not restate the resume line by line,",
      "do not invent facts or numbers, and do not use phrases like 'passionate' or 'synergy'.",
      "Start with 'Dear Hiring Team,' on its own line and output only the letter.",
    ].join("\n"),
  ].join("\n\n");

  return tidySignoff((await complete(llm, prompt, SYSTEM)).trim());
}
