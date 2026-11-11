# job-agent

Scrapes real job postings from company ATS platforms, scores them against your
experience, and generates a tailored resume and cover letter per job. It is not tied to an
industry: the field it targets comes from `config/filters.yaml`, so the same tool works for
security, legal, healthcare, entertainment, or anything else with a careers page.

Target market is whatever `config/filters.yaml` says it is: the filters decide which
locations, title levels, and field terms count.

## Getting started

Requires Node 22.18+ (the CLI runs TypeScript directly, no build step) and Chrome or
Chromium for PDFs. No API key is needed until you tailor.

```bash
npm install
cp profile/experience.example.yaml profile/experience.yaml   # your history
cp config/filters.example.yaml      config/filters.yaml      # your market
cp config/companies.example.yaml    config/companies.yaml    # who to watch

node cli.ts doctor                 # adapters, renderer, and model reach
node cli.ts scan                   # first scan, a couple of minutes
node cli.ts rank --limit 10        # what came back
node cli.ts tailor --limit 1 --no-model   # render a packet, no API key needed
```

That is the whole loop. `scan` stores postings, `rank` filters and scores them, `queue`
prints what is worth applying to, and `tailor <job-key>` writes a resume and cover letter.
`tailor` needs a model provider (see below); pass `--no-model` to render the deterministic
draft with no API key at all.
The three files you copied are gitignored, so your history and target list stay local;
the `*.example.yaml` versions are the ones that ship.

Nothing here is specific to one person or industry: the example profile is placeholder
text, the example filters use a fictional city and generic field terms, and the example
companies file ships one real public board so the first scan returns something. The posts
Amazon, Google and Netflix expose are reachable through their adapters; add them to your
own companies file if you want them.

## Why these sources

LinkedIn and Indeed are excluded. Every posting is read straight from the ATS the
company actually uses, which means the data is the same thing the recruiter sees:

| Adapter | Endpoint | Used by |
|---|---|---|
| `workday` | `POST /wday/cxs/{tenant}/{site}/jobs` | Most large enterprises |
| `oraclehcm` | `recruitingCEJobRequisitions` | Employers on Oracle Recruiting Cloud |
| `eightfold` | `GET /api/pcsx/search` | Employers on Eightfold |
| `greenhouse` | `boards-api.greenhouse.io` | Startups through mid-size companies |
| `ashby` | `posting-api.job-board` | Smaller startups |
| `amazon` | `amazon.jobs/en/search.json` | Amazon only |
| `google` | `about/careers` results HTML (no API) | Google only |
| `netflix` | `explore.jobs.netflix.net/api/apply/v2/jobs` | Netflix only |

`node cli.ts doctor` checks every adapter against the live endpoint.

## Pipeline

```
scan  ->  prefilter  ->  score  ->  rank  ->  tailor  ->  PDF + apply URL
```

- **scan** pulls postings from each company's ATS, dedupes across search terms, and
  stores them in SQLite (`out/jobs.db`).
- **prefilter** drops titles outside your level words, postings outside the targeted
  field, out-of-region locations, and per-location duplicates. Descriptions are
  deliberately ignored for core titles: every large employer mentions adjacent functions
  in its boilerplate, so scanning the body let other people's jobs through. Body text is
  only consulted to justify an adjacent-title match.
- **score** is deterministic and free. Title level, skill overlap, seniority, location,
  and recency each contribute to a 0-100 score. No model calls, so re-filtering is instant.
- **tailor** selects the resume bullets that best answer the posting, then asks a model
  to tighten them. The deterministic result is written first and is usable on its own.

## Commands

```bash
node cli.ts doctor                        # verify adapters, model, renderer
node cli.ts scan                          # refresh all companies
node cli.ts scan --company "Example Bank" --enrich   # one company, full descriptions
node cli.ts rank --limit 20               # score and print the best matches
node cli.ts show <job-key>                # one posting in full
node cli.ts tailor <job-key>              # resume + cover letter, PDFs
node cli.ts tailor --limit 3 --no-model   # deterministic only, no API cost
node cli.ts queue --min-score 65          # what to apply to, with apply URLs
node cli.ts stats                         # what is stored
```

Submit mode is deliberately semi-automatic: the tool produces the packet and the apply
URL, and you click submit. `config/filters.yaml` has an `auto_submit` flag reserved for
later; nothing acts on it yet.

### Long scans

`--enrich` costs about 3-6 seconds per posting that needs a second request. Oracle HCM
tenants are the slow part: one headless Chrome render per posting, so a full enriched
scan can run into ten minutes. That is expected, not a hang.

Progress goes to stderr, one line per 10% of a company's postings, with an ETA. The
per-company summary stays on stdout, so you can keep it readable while progress streams:

```bash
node cli.ts scan --enrich > out/scan.log 2>&1 &   # run detached
 tail -3 out/scan.log                             # poll cheaply
```

Rows are written in batches of 25 as descriptions arrive, so interrupting a scan keeps
what was already fetched. Each posting is abandoned after `--job-timeout` seconds
(default 60) and counted as a detail failure rather than retried forever; `--width`
controls how many detail fetches run at once (default 4 for Oracle HCM, 6 otherwise).

## Generated files

`out/packets/<company>--<title>-resume.{md,pdf}` and `-cover.{md,pdf}`. The markdown is
kept next to the PDF so a packet can be edited by hand and re-rendered without another
model call.

Resumes render to a two-page budget by default, cover letters to one. Chrome clips
content that only slightly overflows rather than paginating, which silently loses
bullets, so the renderer measures the laid-out height at the true print width and warns
when the document exceeds its page budget. Budgets live in `src/render.ts` as
`MAX_RESUME_PAGES` and per-call `maxPages`.

## Configuration

Three files are yours and stay out of git. Each ships as a template in the repo:

| Your file (gitignored) | Template | Holds |
|---|---|---|
| `profile/experience.yaml` | `experience.example.yaml` | Career record: roles, bullets, ids, tags, metrics, projects, contact and form answers |
| `config/filters.yaml` | `filters.example.yaml` | Locations, level words, field terms, scoring weights |
| `config/companies.yaml` | `companies.example.yaml` | Target employers and how to reach each ATS |

`profile/experience.yaml` is the source of truth for tailoring: every bullet has an `id`
and `tags`, selection is by tag overlap, and the model is told never to invent employers,
dates, or numbers, so its numbers are the only numbers that can appear.

`profile/experience.yaml`'s `contact` block takes `email`, `phone`, and optional
`linkedin`, `github`, `website`. The links are stripped of their scheme and printed under the
contact line in the resume header, and they are what you paste into the matching form fields
when applying.

The profile can also list `projects` (name, one-line text, tags, optional
URL). They are selected per posting by tag overlap and rendered as "Selected Projects", so
a project only appears when it answers the job.

`config/filters.yaml` holds two things that make the tool industry-agnostic: `titles`
(the level words you want, and the ones to exclude) and `domain` (strong terms that define
your field, plus adjacent terms that count only with enough body-text support).

### Adding a company

Find the ATS from its careers page, then add one entry. For Workday, the tenant and site
appear in the careers page HTML (`{tenant}.wd{N}.myworkdayjobs.com/.../{site}`).
Unresolved firms sit in the `pending` list at the bottom of the config.

## Model providers

Picked from the environment, no config needed. First key found wins:

```bash
DEEPSEEK_API_KEY=...   # default, deepseek-chat
OPENAI_API_KEY=...     # gpt-5.4-mini
GEMINI_API_KEY=...     # gemini-2.5-pro
```

Override with `JOB_AGENT_PROVIDER`, `JOB_AGENT_MODEL`, or `--provider`/`--model`.
Only `tailor` needs a model; scan, rank, and `tailor --no-model` work offline.

Chrome or Chromium is required for PDFs and for Oracle HCM descriptions (those tenants
reject their own details API). Set `CHROME_BIN` if it is not in a standard place.

## Known limitations

- **Management-level supply is thin.** A full scan of a couple of dozen employers typically
  yields a few dozen postings that pass every filter. That is the market, not a bug in the
  scraper. Broadening `config/filters.yaml` is the lever, not more companies.
- **Some Oracle HCM tenants render, not fetch.** Where the requisition-details resource is
  blocked, full text comes from headless Chrome per shortlisted job: about 6 seconds and
  most of a core each. That is why enriched scans are slow and why those postings are
  marked `partial` in the database.
- **Keyword search is fuzzy.** Oracle and Workday treat the search term loosely, so a
  scan returns neighbouring functions too. The prefilter absorbs the noise, but recall is
  imperfect; add terms.
- **Some Eightfold tenants** return 403 to unauthenticated calls and have to stay in
  `pending` until an adapter workaround exists.
- Scores are a heuristic, not a judgment. Read `rank` output before applying.
