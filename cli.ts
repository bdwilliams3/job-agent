#!/usr/bin/env node
// Job agent CLI. Run `node cli.ts help` for the command list.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadCompanies, loadFilters, loadProfile } from "./src/config.ts";
import type { CompanySource } from "./src/types.ts";
import { enrichJob, scanCompany } from "./src/sources/index.ts";
import type { ScanContext } from "./src/sources/index.ts";
import { prefilter, worthEnriching } from "./src/prefilter.ts";
import { scoreJob } from "./src/match.ts";
import { Store } from "./src/store.ts";
import type { Job } from "./src/types.ts";
import { ping, resolveLlmConfig } from "./src/llm.ts";
import { measureHtmlHeight } from "./src/util/chrome.ts";
import {
  buildResumeDraft,
  generateCover,
  generateResume,
} from "./src/tailor.ts";
import type { TailorContext } from "./src/tailor.ts";
import { MAX_RESUME_PAGES, PAGE_CONTENT_PX, renderPacket } from "./src/render.ts";

const ROOT = import.meta.dirname;
const PATHS = {
  companies: join(ROOT, "config/companies.yaml"),
  filters: join(ROOT, "config/filters.yaml"),
  profile: join(ROOT, "profile/experience.yaml"),
  db: join(ROOT, "out/jobs.db"),
  packets: join(ROOT, "out/packets"),
};

const HELP = `job-agent

  node cli.ts scan   [--company NAME] [--enrich] [--terms a,b] [--max N]
                     [--width N] [--job-timeout SECONDS]
  node cli.ts rank   [--limit N] [--min-score N] [--company NAME]
  node cli.ts show     <job-key>
  node cli.ts tailor   [job-key] [--limit N] [--no-model] [--provider P] [--model M]
  node cli.ts queue    [--min-score N] [--limit N]
  node cli.ts doctor [--provider P] [--model M]
  node cli.ts stats

  Options:
    --company NAME   restrict to one company, e.g. "Example Bank"
    --enrich         fetch full descriptions for prefiltered jobs (slower)
    --terms a,b      search terms for keyword adapters (default: filters.domain.strong)
    --max N          max postings per company per term (default 200)
    --width N        concurrent detail fetches (default 4 for Oracle HCM, 6 otherwise)
    --job-timeout S  give up on one posting after S seconds (default 60)
    --limit N        max rows to print (default 30)
    --min-score N    minimum score 0..100 (default 0)
`;

/**
 * Detail fetches in flight per company. Oracle HCM renders a page in headless
 * Chrome per posting, which costs a whole core for several seconds, so it gets
 * a narrower window than the plain HTTP adapters.
 */
function enrichWidth(company: CompanySource): number {
  return company.adapter === "oraclehcm" ? 4 : 6;
}

/** Postings written per batch while enriching, so an abort loses almost nothing. */
const ENRICH_BATCH = 25;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(name, next);
        index++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function flagList(args: Args, name: string, fallback: string[]): string[] {
  const raw = flagString(args, name);
  return raw ? raw.split(",").map((entry) => entry.trim()) : fallback;
}

async function openStore(): Promise<Store> {
  await mkdir(dirname(PATHS.db), { recursive: true });
  return new Store(PATHS.db);
}

/**
 * Rejects when the work has not settled within `timeoutMs`. The loser keeps
 * running in the background, but the scan stops waiting on it.
 */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Streams enrichment progress to stderr. stdout stays a per-company summary, so
 * piping the summary through tail cannot hide the fact that a long scan is
 * still working.
 */
function reportEnrichProgress(
  label: string,
  done: number,
  total: number,
  failed: number,
  startedAt: number,
): void {
  const elapsed = (performance.now() - startedAt) / 1000;
  const perJob = done > 0 ? elapsed / done : 0;
  const left = Math.round(perJob * (total - done));
  process.stderr.write(
    `  ${label} ${done}/${total} fetched` +
      (failed ? `, ${failed} failed` : "") +
      `, ${Math.round(elapsed)}s in, ~${left}s left\n`,
  );
}

/** Fetches full descriptions with a bounded window, reporting as it goes. */
async function enrichAll(
  company: CompanySource,
  jobs: Job[],
  options: {
    width: number;
    timeoutMs: number;
    onResult?: (job: Job) => void;
  },
): Promise<Array<{ job: Job; error: string | null }>> {
  const startedAt = performance.now();
  const results: Array<{ job: Job; error: string | null }> = new Array(jobs.length);
  const step = Math.max(1, Math.ceil(jobs.length / 10));
  let cursor = 0;
  let done = 0;
  let failed = 0;

  function finish(index: number, job: Job, error: string | null): void {
    results[index] = { job, error };
    options.onResult?.(job);
    done++;
    if (error) failed++;
    if (done === jobs.length || done % step === 0) {
      reportEnrichProgress(`${company.name}:`, done, jobs.length, failed, startedAt);
    }
  }

  const workers = Array.from({ length: Math.min(options.width, jobs.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        const detail = await withTimeout(
          enrichJob(company, job, { timeoutMs: options.timeoutMs }),
          options.timeoutMs,
          `${job.key} detail fetch`,
        );
        finish(index, detail, null);
      } catch (error) {
        finish(index, job, error instanceof Error ? error.message : String(error));
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function commandScan(args: Args): Promise<void> {
  const [{ companies }, filters] = await Promise.all([
    loadCompanies(PATHS.companies),
    loadFilters(PATHS.filters),
  ]);
  const only = flagString(args, "company");
  const enrich = args.flags.get("enrich") === true;
  const max = flagNumber(args, "max", 200);
  // Search terms default to the field terms in filters.yaml, so scanning follows
  // whatever industry the user configured.
  const terms = flagList(args, "terms", filters.domain.strong.slice(0, 4));
  const timeoutMs = flagNumber(args, "job-timeout", 60) * 1000;
  const widthOption = args.flags.has("width") ? flagNumber(args, "width", 0) : null;
  if (timeoutMs <= 0) throw new Error("--job-timeout must be a positive number of seconds");
  if (widthOption !== null && widthOption < 1) throw new Error("--width must be at least 1");

  const targets = only
    ? companies.filter((entry) => entry.name.toLowerCase() === only.toLowerCase())
    : companies;
  if (targets.length === 0) throw new Error(`no company matched "${only}"`);

  const store = await openStore();
  const context: ScanContext = { terms, maxJobsPerCompany: max };
  let totalKept = 0;

  try {
    for (const company of targets) {
      const label = `${company.name} (${company.adapter})`;
      process.stderr.write(`${label} scanning...\n`);
      let scanned: Awaited<ReturnType<typeof scanCompany>>;
      try {
        scanned = await scanCompany(company, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`${label} FAILED: ${message}`);
        continue;
      }
      // Everything is stored; filtering happens at rank time so that changing
      // config/filters.yaml never requires another scan.
      const candidates = scanned.filter((job) => worthEnriching(job, filters));
      const width = widthOption ?? enrichWidth(company);
      let failures = 0;
      let inserted = 0;
      let updated = 0;

      if (enrich) {
        // Write results as they land, so a stuck scan or an interrupted run
        // keeps the postings already fetched instead of starting over.
        const candidateKeys = new Set(candidates.map((job) => job.key));
        let batch: Job[] = [];
        const flush = () => {
          if (batch.length === 0) return;
          const counts = store.upsertJobs(batch);
          inserted += counts.inserted;
          updated += counts.updated;
          batch = [];
        };
        process.stderr.write(
          candidates.length === 0
            ? `  ${label} nothing to fetch\n`
            : `  ${label} ${candidates.length} to fetch, ${width} at a time, ` +
                `${Math.round(timeoutMs / 1000)}s cap each\n`,
        );
        const enriched = await enrichAll(company, candidates, {
          width,
          timeoutMs,
          onResult: (job) => {
            batch.push(job);
            if (batch.length >= ENRICH_BATCH) flush();
          },
        });
        flush();
        failures = enriched.filter((entry) => entry.error).length;
        const rest = store.upsertJobs(
          scanned.filter((job) => !candidateKeys.has(job.key)),
        );
        inserted += rest.inserted;
        updated += rest.updated;
      } else {
        const counts = store.upsertJobs(scanned);
        inserted = counts.inserted;
        updated = counts.updated;
      }

      totalKept += scanned.length;
      console.log(
        `${label} ${scanned.length} scanned, ${candidates.length} enrichable, ` +
          `${inserted} new, ${updated} refreshed` +
          (failures ? `, ${failures} detail failures` : ""),
      );
    }
    console.log(`\ntotal stored this run: ${totalKept}`);
  } finally {
    store.close();
  }
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 5);
  return "#".repeat(filled) + ".".repeat(20 - filled);
}

/**
 * Single ranking path shared by `rank` and `queue`.
 * Filters live in YAML and change after a scan, so every read re-applies them
 * and re-scores rather than trusting whatever was last written to the store.
 */
async function computeRanked(options: {
  store: Store;
  profile: Awaited<ReturnType<typeof loadProfile>>;
  filters: Awaited<ReturnType<typeof loadFilters>>;
  company?: string;
  minScore: number;
  limit: number;
}): Promise<{ rows: Array<{ job: Job; score: ReturnType<typeof scoreJob> }>; stored: number; passed: number }> {
  const stored = options.store.listJobs({ company: options.company });
  const filtered = prefilter(stored, options.filters);
  const scores = filtered.kept.map((entry) =>
    scoreJob(entry.job, options.profile, options.filters, entry.tier),
  );
  options.store.saveScores(scores);

  const rows = scores
    .map((score) => ({
      score,
      job: filtered.kept.find((entry) => entry.job.key === score.key)?.job as Job,
    }))
    .filter((entry) => entry.score.score >= options.minScore)
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, options.limit);

  return { rows, stored: stored.length, passed: filtered.kept.length };
}

async function commandRank(args: Args): Promise<void> {
  const [{ companies }, filters, profile] = await Promise.all([
    loadCompanies(PATHS.companies),
    loadFilters(PATHS.filters),
    loadProfile(PATHS.profile),
  ]);
  const limit = flagNumber(args, "limit", 30);
  const minScore = flagNumber(args, "min-score", 0);
  const only = flagString(args, "company");

  const store = await openStore();
  try {
    const { rows: ranked, stored, passed } = await computeRanked({
      store,
      profile,
      filters,
      company: only,
      minScore,
      limit,
    });
    if (stored === 0) {
      console.log("no jobs stored; run: node cli.ts scan");
      return;
    }

    console.log(
      `${passed} of ${stored} stored postings passed filters\n`,
    );
    for (const { score, job } of ranked) {
      const level = score.extractions.seniority ?? "?";
      console.log(
        `${score.score.toFixed(1).padStart(5)} ${scoreBar(score.score)} ${job.company}`,
      );
      console.log(`      ${job.title}`);
      console.log(
        `      ${job.locations.slice(0, 2).join(" | ")}  [${level}] ${score.track ?? "-"}`,
      );
      console.log(`      ${score.reasons.slice(0, 4).join("; ")}`);
      console.log(`      ${job.key}  ${job.url}`);
      console.log("");
    }
    console.log(
      `${ranked.length} shown of ${passed} scored; top score ` +
        `${ranked[0]?.score.score.toFixed(1) ?? "n/a"}`,
    );
  } finally {
    store.close();
  }
}

async function commandShow(args: Args): Promise<void> {
  const key = args.positional[0];
  if (!key) throw new Error("usage: node cli.ts show <job-key>");
  const store = await openStore();
  try {
    const job = store.getJob(key);
    if (!job) throw new Error(`no job with key ${key}`);
    const filtered = store.ranked({ limit: 1 }).find((row) => row.job.key === key);
    console.log(`${job.company} - ${job.title}`);
    console.log(job.locations.join(" | "));
    console.log(job.url);
    console.log(`posted: ${job.postedAt ?? "unknown"}  quality: ${job.descriptionQuality}`);
    if (filtered) {
      console.log(`score: ${filtered.score.score.toFixed(1)}`);
      console.log(`why: ${filtered.score.reasons.join("; ")}`);
    }
    console.log("\n--- description ---\n");
    console.log(job.description || "(none captured)");
  } finally {
    store.close();
  }
}

/** Filesystem-safe fragment for a packet path. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function tailorOne(
  key: string,
  options: { useModel: boolean; provider?: string; model?: string },
): Promise<void> {
  const [, filters, profile] = await Promise.all([
    loadCompanies(PATHS.companies),
    loadFilters(PATHS.filters),
    loadProfile(PATHS.profile),
  ]);
  const store = await openStore();
  try {
    const job = store.getJob(key);
    if (!job) throw new Error(`no job with key ${key}`);

    const tier = prefilter([job], filters).kept[0]?.tier ?? "core";
    const score = scoreJob(job, profile, filters, tier);
    const context: TailorContext = { job, score, profile };
    const slug = `${slugify(job.company)}--${slugify(job.title)}`;
    const basePath = join(PATHS.packets, slug);

    let resumeMarkdown = buildResumeDraft(context);
    let coverMarkdown: string | null = null;
    let model = "deterministic";
    const warnings: string[] = [];

    if (options.useModel) {
      const llm = resolveLlmConfig({
        provider: options.provider,
        model: options.model,
      });
      model = `${llm.provider}/${llm.model}`;
      resumeMarkdown = await generateResume(context, llm);
      coverMarkdown = await generateCover(context, llm);
      if (job.descriptionQuality !== "full") {
        warnings.push(
          "posting text was " +
            job.descriptionQuality +
            "; re-run scan with --enrich for a better fit",
        );
      }
    }

    const resume = await renderPacket(
      resumeMarkdown,
      `${basePath}-resume`,
      `${profile.name} - Resume - ${job.company}`,
      { maxPages: MAX_RESUME_PAGES },
    );
    store.savePacket({
      key,
      kind: "resume",
      markdown: resumeMarkdown,
      pdfPath: resume.pdfPath,
      model,
      createdAt: new Date().toISOString(),
    });

    if (!resume.fitsPageBudget) {
      warnings.push(
        `resume overflows ${resume.maxPages} pages (${resume.contentHeightPx}px of ` +
          `${PAGE_CONTENT_PX * resume.maxPages}px, ${resume.pages} pages); trim experience.yaml`,
      );
    }

    let coverPath: string | null = null;
    if (coverMarkdown) {
      const cover = await renderPacket(
        coverMarkdown,
        `${basePath}-cover`,
        `${profile.name} - Cover Letter - ${job.company}`,
      );
      coverPath = cover.pdfPath;
      store.savePacket({
        key,
        kind: "cover",
        markdown: coverMarkdown,
        pdfPath: cover.pdfPath,
        model,
        createdAt: new Date().toISOString(),
      });
    }

    // Re-tailoring a packet must not reset a submitted application to packet_ready.
    if (store.applicationStatuses().get(key) !== "submitted") {
      store.setApplication(key, "packet_ready", job.url);
    }
    console.log(`${job.company} - ${job.title}`);
    console.log(`  score    ${score.score.toFixed(1)}`);
    console.log(`  model    ${model}`);
    console.log(
      `  resume   ${resume.pdfPath} (${resume.pages} pages, ${resume.contentHeightPx}px)`,
    );
    if (coverPath) console.log(`  cover    ${coverPath}`);
    console.log(`  apply    ${job.url}`);
    for (const warning of warnings) console.log(`  warning  ${warning}`);
  } finally {
    store.close();
  }
}

async function commandTailor(args: Args): Promise<void> {
  const key = args.positional[0];
  const useModel = args.flags.get("no-model") !== true;
  const options = {
    useModel,
    provider: flagString(args, "provider"),
    model: flagString(args, "model"),
  };

  if (key) return tailorOne(key, options);

  // No key given: tailor the top-ranked jobs.
  const limit = flagNumber(args, "limit", 3);
  const store = await openStore();
  let keys: string[];
  try {
    keys = store.ranked({ limit }).map((entry) => entry.job.key);
  } finally {
    store.close();
  }
  if (keys.length === 0) {
    console.log("nothing ranked yet; run: node cli.ts rank");
    return;
  }
  for (const current of keys) {
    await tailorOne(current, options);
    console.log("");
  }
}

async function commandQueue(args: Args): Promise<void> {
  const minScore = flagNumber(args, "min-score", 60);
  const limit = flagNumber(args, "limit", 20);
  const only = flagString(args, "company");
  const [, filters, profile] = await Promise.all([
    loadCompanies(PATHS.companies),
    loadFilters(PATHS.filters),
    loadProfile(PATHS.profile),
  ]);
  const store = await openStore();
  try {
    const { rows } = await computeRanked({
      store,
      profile,
      filters,
      company: only,
      minScore,
      limit,
    });
    if (rows.length === 0) {
      console.log(`no jobs at or above ${minScore}; run scan then rank`);
      return;
    }
    console.log(`${rows.length} jobs ready to apply, highest score first\n`);
    const statuses = store.applicationStatuses();
    for (const { job, score } of rows) {
      const packet = store.getPacket(job.key, "resume");
      // A submitted application stays visible but must never read as "to do".
      const state =
        statuses.get(job.key) === "submitted"
          ? "submitted"
          : packet
            ? "packet ready"
            : "needs tailor";
      console.log(
        `${score.score.toFixed(1).padStart(5)}  ${state.padEnd(12)} ${job.company}`,
      );
      console.log(`        ${job.title}`);
      console.log(`        ${job.url}`);
      if (packet?.pdfPath) console.log(`        ${packet.pdfPath}`);
      console.log("");
    }
    console.log(
      "next: node cli.ts tailor <job-key>  then open the apply URL with the PDFs",
    );
  } finally {
    store.close();
  }
}

async function commandDoctor(args: Args): Promise<void> {
  const [{ companies }, filters] = await Promise.all([
    loadCompanies(PATHS.companies),
    loadFilters(PATHS.filters),
  ]);
  console.log("source adapters");
  for (const company of companies) {
    process.stdout.write(`  ${company.name.padEnd(20)} ${company.adapter.padEnd(12)} `);
    try {
      const jobs = await scanCompany(company, {
        terms: filters.domain.strong.slice(0, 1),
        maxJobsPerCompany: 3,
      });
      console.log(`ok (${jobs.length} postings)`);
    } catch (error) {
      console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\nmodel");
  try {
    const llm = resolveLlmConfig({
      provider: flagString(args, "provider"),
      model: flagString(args, "model"),
    });
    console.log(`  ${llm.provider}/${llm.model}: ${await ping(llm)}`);
  } catch (error) {
    console.log(`  unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\nrenderer");
  try {
    const height = await measureHtmlHeight("<html><body><p>probe</p></body></html>", 710);
    console.log(`  chrome ok (measured ${height}px)`);
  } catch (error) {
    console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandStats(): Promise<void> {
  const store = await openStore();
  try {
    const stats = store.stats();
    console.log(
      `jobs: ${stats.jobs} (${stats.activeJobs} active)  scored: ${stats.scored}  packets: ${stats.packets}\n`,
    );
    for (const row of stats.byCompany) {
      console.log(`  ${row.company.padEnd(22)} ${row.count}`);
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "scan":
      return commandScan(args);
    case "rank":
      return commandRank(args);
    case "show":
      return commandShow(args);
    case "tailor":
      return commandTailor(args);
    case "queue":
      return commandQueue(args);
    case "doctor":
      return commandDoctor(args);
    case "stats":
      return commandStats();
    case "help":
    default:
      console.log(HELP);
  }
}

await main();
