// Markdown to print-ready HTML to PDF. One page, ATS-friendly, no columns or
// graphics, because both ATS parsers and human screens cost nothing to
// satisfy at the same time.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { marked } from "marked";
import { htmlToPdf, measureHtmlHeight } from "./util/chrome.ts";

const PAGE_MARGIN_Y_IN = 0.45;
const PAGE_MARGIN_X_IN = 0.55;

/** Letter height minus vertical margins, in CSS pixels at 96dpi. */
export const PAGE_CONTENT_PX = Math.floor((11 - PAGE_MARGIN_Y_IN * 2) * 96);

/** Resumes may run two pages; anything past that is a trimming problem. */
export const MAX_RESUME_PAGES = 2;

/** Letter width minus horizontal margins, in CSS pixels at 96dpi. */
const PAGE_CONTENT_WIDTH_PX = Math.floor((8.5 - PAGE_MARGIN_X_IN * 2) * 96);

const CSS = `
@page { size: Letter; margin: 0.45in 0.55in; }
* { box-sizing: border-box; }
body {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 9.6pt;
  line-height: 1.22;
  color: #111;
  margin: 0;
}
h1 { font-size: 17pt; margin: 0 0 3pt; letter-spacing: -0.01em; }
h1 + p { margin: 0 0 2pt; font-size: 10pt; color: #333; }
h1 + p + p { margin: 0 0 7pt; font-size: 9.2pt; color: #444; }
h1 + p + p + h2 { margin-top: 0; }
h2 {
  font-size: 10pt;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  margin: 7pt 0 2.5pt;
  padding-bottom: 2pt;
  border-bottom: 0.7pt solid #999;
}
h3 { font-size: 10.2pt; margin: 7pt 0 1pt; }
h3 + p { margin: 0 0 3pt; font-size: 9.3pt; color: #444; }
p { margin: 0 0 4pt; }
ul { margin: 0 0 4pt; padding-left: 13pt; }
li { margin: 0 0 1pt; }
strong { font-weight: 600; }
a { color: inherit; text-decoration: none; }
code { font-family: Menlo, monospace; font-size: 9pt; }
hr { border: none; border-top: 0.7pt solid #ccc; margin: 8pt 0; }
`;

/** Renders markdown to a standalone HTML document sized for print. */
export function markdownToHtml(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${CSS}</style></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Writes the markdown next to the PDF so a packet can be edited by hand and
 * re-rendered without regenerating it through the model.
 */
export interface RenderOptions {
  /** Page budget for this document. Cover letters stay at one. */
  maxPages?: number;
}

export interface RenderResult {
  markdownPath: string;
  pdfPath: string;
  pages: number;
  contentHeightPx: number;
  maxPages: number;
  /** False when the content exceeds its page budget. */
  fitsPageBudget: boolean;
}

export async function renderPacket(
  markdown: string,
  basePath: string,
  title: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const maxPages = options.maxPages ?? 1;
  await mkdir(dirname(basePath), { recursive: true });
  const markdownPath = `${basePath}.md`;
  const pdfPath = `${basePath}.pdf`;
  const html = markdownToHtml(markdown, title);

  const contentHeightPx = await measureHtmlHeight(html, PAGE_CONTENT_WIDTH_PX);
  await writeFile(markdownPath, markdown, "utf8");
  await htmlToPdf(html, pdfPath);
  const pages = await countPdfPages(pdfPath);

  return {
    markdownPath,
    pdfPath,
    pages,
    contentHeightPx,
    maxPages,
    fitsPageBudget: contentHeightPx <= PAGE_CONTENT_PX * maxPages && pages <= maxPages,
  };
}

/**
 * Counts pages by reading the PDF page tree. Chrome clips rather than errors when
 * content overflows, so this is the only way to know a resume actually fit.
 */
export async function countPdfPages(pdfPath: string): Promise<number> {
  const bytes = await readFile(pdfPath, "latin1");
  const matches = bytes.match(/\/Type\s*\/Page[^s]/g);
  return matches?.length ?? 0;
}
