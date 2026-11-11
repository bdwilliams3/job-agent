// Headless Chrome: PDF rendering and SPA page dumping. The only heavy dependency.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((entry): entry is string => Boolean(entry));

let binaryLookup: Promise<string> | null = null;

/**
 * Resolved once per process. The probe is cached as a promise because
 * enrichment asks for it from several workers at the same instant.
 */
function chromeBinary(): Promise<string> {
  binaryLookup ??= findChromeBinary().catch((error: unknown) => {
    binaryLookup = null; // a transient probe failure must not poison later calls
    throw error;
  });
  return binaryLookup;
}

async function findChromeBinary(): Promise<string> {
  for (const candidate of CANDIDATES) {
    try {
      await run(candidate, ["--version"], { timeout: 15_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    "no Chrome binary found; set CHROME_BIN to a Chrome/Chromium executable",
  );
}

const COMMON_FLAGS = [
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
];

/** Renders HTML to a PDF using Chrome's print pipeline. */
export async function htmlToPdf(html: string, pdfPath: string): Promise<void> {
  const binary = await chromeBinary();
  const dir = await mkdtemp(join(tmpdir(), "job-agent-"));
  const htmlPath = join(dir, "input.html");
  try {
    await writeFile(htmlPath, html, "utf8");
    await run(
      binary,
      [
        ...COMMON_FLAGS,
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        htmlPath,
      ],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Renders HTML and reports document height in CSS pixels.
 *
 * Chrome clips content that overflows a page in print mode rather than
 * paginating when the overflow is small, and a clipped resume silently loses
 * bullets. Measuring height first is how that gets caught.
 */
export async function measureHtmlHeight(html: string, widthPx: number): Promise<number> {
  const binary = await chromeBinary();
  const dir = await mkdtemp(join(tmpdir(), "job-agent-measure-"));
  const htmlPath = join(dir, "measure.html");
  // scrollHeight reports the viewport when content is shorter than the window,
  // so the bottom edge of the final block is what actually measures content.
  const probe = html.replace(
    "</body>",
    `<script>
      const blocks = [...document.body.children].filter(
        (el) => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE',
      );
      const last = blocks[blocks.length - 1];
      document.title = String(Math.ceil(last ? last.getBoundingClientRect().bottom : 0));
    </script></body>`,
  );
  try {
    await writeFile(htmlPath, probe, "utf8");
    const { stdout } = await run(
      binary,
      [
        ...COMMON_FLAGS,
        // Width must match the print content box, otherwise line wrapping (and
        // therefore height) differs from what the PDF will do.
        `--window-size=${widthPx},900`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        htmlPath,
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const title = stdout.match(/<title>([0-9]+)<\/title>/)?.[1];
    if (!title) throw new Error("could not measure rendered height");
    return Number(title);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface DumpDomOptions {
  /** Fake-time budget for the page; the description must render inside it. */
  waitMs?: number;
  /** Hard cap. Chrome is killed when it trips, so a stalled page frees its slot. */
  timeoutMs?: number;
}

/**
 * Returns the rendered DOM of a JavaScript-heavy page.
 * Used only for Oracle HCM postings, whose REST API withholds the description.
 */
export async function dumpDom(
  url: string,
  options: DumpDomOptions = {},
): Promise<string> {
  const binary = await chromeBinary();
  const { stdout } = await run(
    binary,
    [
      ...COMMON_FLAGS,
      `--virtual-time-budget=${options.waitMs ?? 10_000}`,
      "--dump-dom",
      url,
    ],
    { timeout: options.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}
