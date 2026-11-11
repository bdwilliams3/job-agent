// Google Careers adapter. There is no JSON API: each results page embeds the
// postings as server-rendered cards, including title, locations, and the
// qualification text, which is enough to filter and score.
import { getText } from "../util/http.ts";
import { htmlToText } from "../util/text.ts";
import type { CompanySource, Job } from "../types.ts";

const RESULTS = "https://www.google.com/about/careers/applications/jobs/results/";
const PAGE_SIZE = 20;

export interface GoogleScanOptions {
  query: string;
  maxJobs: number;
}

interface GoogleCard {
  id: string;
  title: string;
  locations: string[];
  text: string;
}

function firstMatch(value: string, pattern: RegExp): string | null {
  const match = value.match(pattern);
  return match ? match[1].trim() : null;
}

/** Pulls the job cards out of one results page. */
function parseCards(html: string): GoogleCard[] {
  const cards: GoogleCard[] = [];
  for (const block of html.split('<li class="lLd3Je"').slice(1)) {
    const id = firstMatch(block, /jsdata="Aiqs8c;(\d+);/);
    const title = firstMatch(block, /<h3 class="QJPWVe">([\s\S]*?)<\/h3>/);
    if (!id || !title) continue;
    const locations = [...block.matchAll(/place<\/i><span[^>]*>([\s\S]*?)<\/span>/g)].map(
      (match) => htmlToText(match[1]),
    );
    cards.push({ id, title: htmlToText(title), locations, text: htmlToText(block) });
  }
  return cards;
}

/** Lists postings matching one keyword, newest first. */
export async function scanGoogle(
  company: CompanySource,
  options: GoogleScanOptions,
): Promise<Job[]> {
  const seen = new Map<string, GoogleCard>();
  for (let page = 1; seen.size < options.maxJobs; page++) {
    const url = `${RESULTS}?q=${encodeURIComponent(options.query)}&hl=en&page=${page}`;
    const cards = parseCards(await getText(url));
    const before = seen.size;
    for (const card of cards) if (!seen.has(card.id)) seen.set(card.id, card);
    if (cards.length < PAGE_SIZE || seen.size === before) break;
  }

  return [...seen.values()].slice(0, options.maxJobs).map((card) => {
    const locations = card.locations.length > 0 ? card.locations : [];
    return {
      key: `${company.name}:${card.id}`,
      company: company.name,
      tier: company.tier,
      externalId: card.id,
      title: card.title,
      locations,
      remote: locations.some((entry) => /remote/i.test(entry)),
      url: `${RESULTS}${card.id}`,
      // The card carries the role summary and minimum qualifications, not the
      // full posting body.
      description: card.text,
      descriptionQuality: "partial" as const,
      department: null,
      postedAt: null,
    };
  });
}
