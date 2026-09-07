/**
 * Scoring for the recognition eval. Pure, so the rules that decide "right" are
 * testable without spending anything on the API.
 */
import type { Identification, MediaKind } from "@tvsham/shared";

/** What a clip is actually of, written by hand in labels.json. */
export interface ClipLabel {
  /** File name inside the clips directory. */
  file: string;
  kind: MediaKind;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Free-text note for whoever reads the report ("dark scene, no dialogue"). */
  note?: string;
}

export type Verdict =
  /** Everything the label asked for, including the episode. */
  | "correct"
  /** Right title, wrong or missing episode. Useful on its own, so counted apart. */
  | "title_only"
  /** Named something else. */
  | "wrong"
  /** Declined to guess. Not a wrong answer, but not an answer either. */
  | "abstained";

export interface ScoredClip {
  label: ClipLabel;
  identification: Identification;
  verdict: Verdict;
  confidence: number;
  /** Seconds the whole pipeline took for this clip. */
  seconds: number;
}

/**
 * Titles are compared loosely on purpose: "The Office" and "Office, The" are the
 * same show, and a model that answers "Inception (2010)" is not wrong.
 */
export function normaliseTitle(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .replace(/ (the|a|an)$/, "")
    .trim();
}

export function titlesMatch(expected: string, actual: string): boolean {
  const a = normaliseTitle(expected);
  const b = normaliseTitle(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  // One title may extend the other ("Breaking Bad" vs "Breaking Bad: Ozymandias"),
  // but only on a word boundary: "Heat" must not match "Heathers".
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 4) return false;
  return longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`) || longer.includes(` ${shorter} `);
}

/** Kinds that are close enough not to count as a different answer. */
function kindsAgree(expected: MediaKind, actual: MediaKind): boolean {
  if (expected === actual) return true;
  const tv = new Set<MediaKind>(["tv_show", "tv_episode"]);
  const shortVideo = new Set<MediaKind>(["youtube", "short_form"]);
  return (tv.has(expected) && tv.has(actual)) || (shortVideo.has(expected) && shortVideo.has(actual));
}

export function score(label: ClipLabel, id: Identification, minConfidence: number): Verdict {
  if (id.kind === "unknown" || id.confidence < minConfidence) return "abstained";
  if (!kindsAgree(label.kind, id.kind) || !titlesMatch(label.title, id.title)) return "wrong";
  const wantsEpisode = label.season !== undefined || label.episode !== undefined;
  if (!wantsEpisode) return "correct";
  const sameSeason = label.season === undefined || id.episode?.season === label.season;
  const sameEpisode = label.episode === undefined || id.episode?.number === label.episode;
  return sameSeason && sameEpisode ? "correct" : "title_only";
}

export interface Summary {
  total: number;
  correct: number;
  titleOnly: number;
  wrong: number;
  abstained: number;
  /** Correct out of everything, the number that matters. */
  accuracy: number;
  /** Correct out of the clips it was willing to answer. */
  precision: number;
  /**
   * Mean confidence when right and when wrong. A model whose wrong answers are
   * as confident as its right ones cannot be thresholded, which is the thing to
   * know before turning on a cheaper first pass.
   */
  meanConfidenceCorrect: number;
  meanConfidenceWrong: number;
  medianSeconds: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

export function summarise(scored: ScoredClip[]): Summary {
  const by = (v: Verdict) => scored.filter((s) => s.verdict === v);
  const correct = by("correct");
  const titleOnly = by("title_only");
  const wrong = by("wrong");
  const abstained = by("abstained");
  const answered = scored.length - abstained.length;
  return {
    total: scored.length,
    correct: correct.length,
    titleOnly: titleOnly.length,
    wrong: wrong.length,
    abstained: abstained.length,
    accuracy: scored.length === 0 ? 0 : correct.length / scored.length,
    precision: answered === 0 ? 0 : correct.length / answered,
    meanConfidenceCorrect: mean(correct.map((s) => s.confidence)),
    meanConfidenceWrong: mean([...wrong, ...titleOnly].map((s) => s.confidence)),
    medianSeconds: median(scored.map((s) => s.seconds)),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** A short report meant to be read in a terminal. */
export function formatReport(scored: ScoredClip[], label: string): string {
  const s = summarise(scored);
  const rows = scored.map((c) => {
    const mark = { correct: "✓", title_only: "~", wrong: "✗", abstained: "-" }[c.verdict];
    const got = c.identification.kind === "unknown" ? "(no answer)" : c.identification.title;
    return `  ${mark} ${c.label.file.padEnd(28)} ${String(Math.round(c.confidence * 100)).padStart(3)}%  ${got}`;
  });
  return [
    `${label}: ${s.correct}/${s.total} correct (${pct(s.accuracy)})`,
    ...rows,
    "",
    `  accuracy            ${pct(s.accuracy)}`,
    `  precision when it answers  ${pct(s.precision)}`,
    `  right title, wrong episode ${s.titleOnly}`,
    `  wrong               ${s.wrong}`,
    `  no answer           ${s.abstained}`,
    `  mean confidence     ${pct(s.meanConfidenceCorrect)} when right, ${pct(s.meanConfidenceWrong)} when wrong`,
    `  median time         ${s.medianSeconds.toFixed(1)}s per clip`,
  ].join("\n");
}
