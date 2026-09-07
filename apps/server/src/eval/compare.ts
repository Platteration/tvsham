/**
 * Compare two eval runs written by `run.ts`.
 *
 *   npx tsx src/eval/compare.ts results-claude-opus-5-*.json results-claude-sonnet-5-*.json
 *
 * The question this answers is the one that decides FIRST_PASS_MODEL: does the
 * cheaper model get the same clips right, and when it is wrong, is it obviously
 * unsure? Clips where the two disagree are listed, because those are the ones
 * worth watching again yourself.
 */
import { promises as fs } from "node:fs";
import { formatReport, summarise, type ScoredClip } from "./score.js";

async function read(path: string): Promise<ScoredClip[]> {
  const parsed = JSON.parse(await fs.readFile(path, "utf8")) as ScoredClip[];
  if (!Array.isArray(parsed)) throw new Error(`${path} is not an eval result file`);
  return parsed;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export interface Disagreement {
  file: string;
  a: ScoredClip;
  b: ScoredClip;
}

/** Clips the two runs scored differently, keyed by file name. */
export function disagreements(a: ScoredClip[], b: ScoredClip[]): Disagreement[] {
  const byFile = new Map(b.map((c) => [c.label.file, c]));
  const out: Disagreement[] = [];
  for (const first of a) {
    const second = byFile.get(first.label.file);
    if (second && second.verdict !== first.verdict) {
      out.push({ file: first.label.file, a: first, b: second });
    }
  }
  return out;
}

/**
 * Whether the cheaper run's confidence can be used as an escalation threshold:
 * it has to be meaningfully lower when it is wrong than when it is right.
 */
export function calibrationGap(run: ScoredClip[]): number {
  const s = summarise(run);
  return s.meanConfidenceCorrect - s.meanConfidenceWrong;
}

export function formatComparison(a: ScoredClip[], b: ScoredClip[], nameA: string, nameB: string): string {
  const sa = summarise(a);
  const sb = summarise(b);
  const gap = calibrationGap(b);
  const lines = [
    formatReport(a, nameA),
    "",
    formatReport(b, nameB),
    "",
    `Difference: ${nameB} is ${pct(Math.abs(sb.accuracy - sa.accuracy))} ${sb.accuracy >= sa.accuracy ? "better" : "worse"} than ${nameA}.`,
    `Calibration gap for ${nameB}: ${pct(gap)} between confidence when right and when wrong.`,
    gap < 0.1
      ? `  Too small to threshold on. A cheap first pass would hand back wrong answers with high confidence, so leave FIRST_PASS_MODEL unset.`
      : `  Wide enough to threshold on. A first pass on ${nameB} should escalate the clips it gets wrong.`,
  ];

  const diff = disagreements(a, b);
  if (diff.length > 0) {
    lines.push("", `Clips they scored differently (${diff.length}):`);
    for (const d of diff) {
      lines.push(
        `  ${d.file.padEnd(28)} ${nameA}: ${d.a.verdict} (${Math.round(d.a.confidence * 100)}%)  ${nameB}: ${d.b.verdict} (${Math.round(d.b.confidence * 100)}%)`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [pathA, pathB] = process.argv.slice(2);
  if (!pathA || !pathB) throw new Error("Usage: compare.ts <results-a.json> <results-b.json>");
  const [a, b] = await Promise.all([read(pathA), read(pathB)]);
  console.log(formatComparison(a, b, pathA, pathB));
}

// Only run when invoked directly, so the helpers above stay importable.
if (process.argv[1]?.endsWith("compare.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
