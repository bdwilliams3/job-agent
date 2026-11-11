// SQLite persistence. Dedupe, scoring, generated packets, and application state.
import { DatabaseSync } from "node:sqlite";
import type { Extraction, Job, Packet, Score, ScoreComponents, TrackId } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  key                 TEXT PRIMARY KEY,
  company             TEXT NOT NULL,
  tier                INTEGER NOT NULL,
  external_id         TEXT NOT NULL,
  title               TEXT NOT NULL,
  locations           TEXT NOT NULL,
  remote              INTEGER NOT NULL,
  url                 TEXT NOT NULL,
  description         TEXT NOT NULL,
  description_quality TEXT NOT NULL,
  department          TEXT,
  posted_at           TEXT,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS scores (
  key        TEXT PRIMARY KEY,
  score      REAL NOT NULL,
  track      TEXT,
  components TEXT NOT NULL,
  matched    TEXT NOT NULL,
  reasons    TEXT NOT NULL,
  extraction TEXT NOT NULL,
  scored_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packets (
  key        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  markdown   TEXT NOT NULL,
  pdf_path   TEXT,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, kind)
);
CREATE TABLE IF NOT EXISTS applications (
  key        TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  apply_url  TEXT,
  notes      TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company);
`;

interface JobRow {
  key: string;
  company: string;
  tier: number;
  external_id: string;
  title: string;
  locations: string;
  remote: number;
  url: string;
  description: string;
  description_quality: string;
  department: string | null;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  active: number;
}

interface ScoreRow {
  key: string;
  score: number;
  track: string | null;
  components: string;
  matched: string;
  reasons: string;
  extraction: string;
  scored_at: string;
}

function toJob(row: JobRow): Job {
  return {
    key: row.key,
    company: row.company,
    tier: row.tier,
    externalId: row.external_id,
    title: row.title,
    locations: JSON.parse(row.locations) as string[],
    remote: row.remote === 1,
    url: row.url,
    description: row.description,
    descriptionQuality: row.description_quality as Job["descriptionQuality"],
    department: row.department,
    postedAt: row.posted_at,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Inserts or refreshes postings. Returns counts for the scan report. */
  upsertJobs(jobs: Job[]): { inserted: number; updated: number } {
    const now = new Date().toISOString();
    const find = this.db.prepare("SELECT key FROM jobs WHERE key = ?");
    const insert = this.db.prepare(
      `INSERT INTO jobs (key, company, tier, external_id, title, locations, remote,
        url, description, description_quality, department, posted_at,
        first_seen, last_seen, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    // A plain scan only sees listing metadata. Keeping the stored text when the
    // incoming copy is weaker is what stops a rescan from wiping enrichment.
    const update = this.db.prepare(
      `UPDATE jobs SET title = ?, locations = ?, remote = ?, url = ?,
        description = CASE
          WHEN jobs.description_quality <> 'listing' AND ? = 'listing'
          THEN jobs.description ELSE ? END,
        description_quality = CASE
          WHEN jobs.description_quality = 'full' AND ? <> 'full'
          THEN jobs.description_quality ELSE ? END,
        department = ?, posted_at = ?, last_seen = ?, active = 1
       WHERE key = ?`,
    );

    let inserted = 0;
    let updated = 0;
    for (const job of jobs) {
      const locations = JSON.stringify(job.locations);
      const remote = job.remote ? 1 : 0;
      if (find.get(job.key)) {
        update.run(
          job.title, locations, remote, job.url,
          job.descriptionQuality, job.description,
          job.descriptionQuality, job.descriptionQuality,
          job.department, job.postedAt, now, job.key,
        );
        updated++;
      } else {
        insert.run(
          job.key, job.company, job.tier, job.externalId, job.title, locations,
          remote, job.url, job.description, job.descriptionQuality,
          job.department, job.postedAt, now, now,
        );
        inserted++;
      }
    }
    return { inserted, updated };
  }

  /** Marks postings for a company that did not appear in the latest scan. */
  retireMissing(company: string, seenKeys: string[]): void {
    if (seenKeys.length === 0) return;
    const placeholders = seenKeys.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE jobs SET active = 0
         WHERE company = ? AND key NOT IN (${placeholders})`,
      )
      .run(company, ...seenKeys);
  }

  listJobs(options: { activeOnly?: boolean; company?: string } = {}): Job[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.activeOnly !== false) clauses.push("active = 1");
    if (options.company) {
      clauses.push("company = ?");
      params.push(options.company);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY tier ASC, company ASC`)
      .all(...params) as unknown as JobRow[];
    return rows.map(toJob);
  }

  getJob(key: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE key = ?").get(key) as
      | JobRow
      | undefined;
    return row ? toJob(row) : null;
  }

  saveScores(scores: Score[]): void {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO scores (key, score, track, components, matched, reasons, extraction, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         score = excluded.score, track = excluded.track,
         components = excluded.components, matched = excluded.matched,
         reasons = excluded.reasons, extraction = excluded.extraction,
         scored_at = excluded.scored_at`,
    );
    for (const score of scores) {
      statement.run(
        score.key,
        score.score,
        score.track,
        JSON.stringify(score.components),
        JSON.stringify(score.matchedTags),
        JSON.stringify(score.reasons),
        JSON.stringify(score.extractions),
        now,
      );
    }
  }

  /** Highest-scoring jobs joined with their posting, optionally filtered. */
  ranked(options: { limit?: number; minScore?: number; company?: string } = {}): Array<{
    job: Job;
    score: Score;
  }> {
    const clauses: string[] = ["j.active = 1", "s.key IS NOT NULL"];
    const params: Array<string | number> = [];
    if (typeof options.minScore === "number") {
      clauses.push("s.score >= ?");
      params.push(options.minScore);
    }
    if (options.company) {
      clauses.push("j.company = ?");
      params.push(options.company);
    }
    const limit = options.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT j.*, s.score AS s_score, s.track AS s_track,
                s.components AS s_components, s.matched AS s_matched,
                s.reasons AS s_reasons, s.extraction AS s_extraction,
                s.scored_at AS s_scored_at
         FROM jobs j JOIN scores s ON s.key = j.key
         WHERE ${clauses.join(" AND ")}
         ORDER BY s.score DESC, j.tier ASC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<
      JobRow & {
        s_score: number;
        s_track: string | null;
        s_components: string;
        s_matched: string;
        s_reasons: string;
        s_extraction: string;
        s_scored_at: string;
      }
    >;
    return rows.map((row) => ({
      job: toJob(row),
      score: {
        key: row.key,
        score: row.s_score,
        track: row.s_track as TrackId | null,
        components: JSON.parse(row.s_components) as ScoreComponents,
        matchedTags: JSON.parse(row.s_matched) as string[],
        reasons: JSON.parse(row.s_reasons) as string[],
        extractions: JSON.parse(row.s_extraction) as Extraction,
      },
    }));
  }

  savePacket(packet: Packet): void {
    this.db
      .prepare(
        `INSERT INTO packets (key, kind, markdown, pdf_path, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, kind) DO UPDATE SET
           markdown = excluded.markdown, pdf_path = excluded.pdf_path,
           model = excluded.model, created_at = excluded.created_at`,
      )
      .run(
        packet.key, packet.kind, packet.markdown, packet.pdfPath,
        packet.model, packet.createdAt,
      );
  }

  getPacket(key: string, kind: Packet["kind"]): Packet | null {
    const row = this.db
      .prepare("SELECT * FROM packets WHERE key = ? AND kind = ?")
      .get(key, kind) as
      | {
          key: string;
          kind: string;
          markdown: string;
          pdf_path: string | null;
          model: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      key: row.key,
      kind: row.kind as Packet["kind"],
      markdown: row.markdown,
      pdfPath: row.pdf_path,
      model: row.model,
      createdAt: row.created_at,
    };
  }

  setApplication(key: string, status: string, applyUrl: string | null, notes?: string): void {
    this.db
      .prepare(
        `INSERT INTO applications (key, status, apply_url, notes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           status = excluded.status, apply_url = excluded.apply_url,
           notes = COALESCE(excluded.notes, applications.notes),
           updated_at = excluded.updated_at`,
      )
      .run(key, status, applyUrl, notes ?? null, new Date().toISOString());
  }

  /** Status per job key, so a view can tell what was already sent. */
  applicationStatuses(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT key, status FROM applications")
      .all() as unknown as Array<{ key: string; status: string }>;
    return new Map(rows.map((row) => [row.key, row.status]));
  }

  stats(): {
    jobs: number;
    activeJobs: number;
    scored: number;
    packets: number;
    byCompany: Array<{ company: string; count: number }>;
  } {
    const count = (sql: string, ...params: string[]) =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;
    return {
      jobs: count("SELECT COUNT(*) AS n FROM jobs"),
      activeJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE active = 1"),
      scored: count("SELECT COUNT(*) AS n FROM scores"),
      packets: count("SELECT COUNT(*) AS n FROM packets"),
      byCompany: this.db
        .prepare(
          "SELECT company, COUNT(*) AS count FROM jobs WHERE active = 1 GROUP BY company ORDER BY count DESC",
        )
        .all() as unknown as Array<{ company: string; count: number }>,
    };
  }
}
