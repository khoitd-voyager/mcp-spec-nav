import {
  snapshot,
  resolveFunction,
  coverageOf,
  renderCoverage,
  fileMatcher,
  flags,
  span,
  sortKey,
  StaleIdError,
  FnRecord,
  Indexed,
  Snapshot,
} from "./catalog.js";
import { uniqueTokens, calleeNames, calleeKey, BODY_NOISE } from "./search.js";
import { CHAR_BUDGET, decodeCursor, encodeCursor, paramsHash, takePage } from "./paging.js";

/**
 * Functions that behave alike, whatever they are called.
 *
 * Name-based search cannot find `computeDeliveryCharge` from "shipping fee"
 * unless someone wrote one of those words down. What a function *does* is
 * better told by what it calls and the vocabulary of its body: two functions
 * that both call `haversine`, `roundTo` and `lookupZoneRate` are doing the
 * same job. So each function is a pair of feature sets — the names it calls,
 * and the words of its body (syntax and its own name removed) — compared by
 * cosine similarity with rare features weighted up (IDF): sharing a call to
 * `lookupZoneRate` says far more than sharing a call to `push`.
 *
 * Still lexical: two implementations of one idea written with nothing in
 * common will not meet. But it needs no shared *name*, which is the gap
 * spec_nav_find_functions leaves.
 */

interface Index {
  key: string;
  fns: Indexed[];
  /** feature → function indices. A call is the feature "()name", a word is itself. */
  postings: Map<string, number[]>;
  idf: Map<string, number>;
  norm: Float64Array;
}

let cached: Index | undefined;

/** A call says more about behaviour than a word in passing: its weight is scaled up. */
const CALL_WEIGHT = 1.5;
const isCall = (f: string) => f.startsWith("()");
const weightOf = (f: string, idf: number) => (isCall(f) ? CALL_WEIGHT * idf : idf);

/** The words of a function that describe behaviour: body words minus syntax and its own name. */
function behaviourWords(ix: Indexed): string[] {
  const own = new Set(ix.search.name);
  return (ix.search.body ?? []).filter((w) => !BODY_NOISE.has(w) && !own.has(w));
}

function features(callees: string[], words: string[]): string[] {
  return [...new Set([...callees.map((c) => "()" + c), ...words])];
}

function buildIndex(snap: Snapshot, key: string): Index {
  if (cached?.key === key) return cached;
  const fns: Indexed[] = [];
  for (const fc of snap.files) for (const f of fc.functions) fns.push(f);
  const postings = new Map<string, number[]>();
  const feats: string[][] = [];
  fns.forEach((f, i) => {
    const fs = features(f.callees, behaviourWords(f));
    feats.push(fs);
    for (const x of fs) (postings.get(x) ?? postings.set(x, []).get(x)!).push(i);
  });
  const n = Math.max(fns.length, 1);
  const idf = new Map<string, number>();
  for (const [k, list] of postings) idf.set(k, Math.log(1 + n / list.length));
  const norm = new Float64Array(fns.length);
  feats.forEach((fs, i) => {
    norm[i] = Math.sqrt(fs.reduce((a, x) => a + weightOf(x, idf.get(x)!) ** 2, 0));
  });
  cached = { key, fns, postings, idf, norm };
  return cached;
}

export interface SimilarArgs {
  id?: string;
  file?: string;
  name?: string;
  line?: number;
  /** A draft, or a function from elsewhere: compared without being catalogued. */
  code?: string;
  services?: string[];
  inFile?: string;
  language?: string;
  limit?: number;
  minScore?: number;
  cursor?: string;
  format?: "text" | "json";
}

/**
 * Cosine similarity, IDF-weighted, of a query's features against every
 * function sharing at least one. A feature the repo has never seen still
 * counts toward the query's norm: it is something the candidates lack.
 */
function cosine(query: string[], index: Index): Map<number, { score: number; shared: string[] }> {
  const maxIdf = Math.log(1 + Math.max(index.fns.length, 1));
  const qNorm = Math.sqrt(query.reduce((a, f) => a + weightOf(f, index.idf.get(f) ?? maxIdf) ** 2, 0));
  const out = new Map<number, { score: number; shared: string[] }>();
  if (!qNorm) return out;
  for (const f of query) {
    const list = index.postings.get(f);
    if (!list) continue;
    const w = weightOf(f, index.idf.get(f)!) ** 2;
    for (const i of list) {
      const e = out.get(i) ?? out.set(i, { score: 0, shared: [] }).get(i)!;
      e.score += w;
      e.shared.push(f);
    }
  }
  for (const [i, e] of out) e.score = index.norm[i] ? e.score / (qNorm * index.norm[i]) : 0;
  return out;
}

export async function similarFunctions(args: SimilarArgs): Promise<{ text: string; isError?: boolean }> {
  let subject: { rec?: FnRecord; callees: string[]; words: string[]; label: string };
  if (args.code) {
    // A draft's own name is kept as features: it is the author's statement
    // of what the code is for (`calculateStorageFee`), which is exactly what
    // an existing implementation's body tends to share.
    const own = args.code.match(/\b(?:function|def|func|fun|fn|sub)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u)?.[1];
    subject = {
      callees: [...new Set(calleeNames(args.code, own).map(calleeKey))],
      words: uniqueTokens(args.code).filter((w) => !BODY_NOISE.has(w)),
      label: own ? `the code you passed (${own})` : "the code you passed",
    };
  } else {
    let r: { ix: Indexed };
    try {
      r = await resolveFunction({ id: args.id, file: args.file, name: args.name, line: args.line });
    } catch (err) {
      if (err instanceof StaleIdError) return { text: err.message, isError: true };
      throw err;
    }
    subject = { rec: r.ix.rec, callees: r.ix.callees, words: behaviourWords(r.ix), label: r.ix.rec.name };
  }
  if (subject.callees.length + subject.words.length < 3) {
    throw new Error(
      `${subject.label} has too little in it to compare (${subject.callees.length} calls, ${subject.words.length} words). ` +
        `Similarity needs a function body with some calls or domain words; use spec_nav_find_functions for a name search.`,
    );
  }

  const snap = await snapshot(args.services);
  const index = buildIndex(snap, `${snap.fingerprint}|${(args.services ?? []).join(",")}`);
  const scores = cosine(features(subject.callees, subject.words), index);
  const fileOk = fileMatcher(args.inFile);
  const minScore = args.minScore ?? 0.2;

  type Hit = { rec: FnRecord; score: number; sharedCalls: string[]; sharedWords: string[] };
  const hits: Hit[] = [];
  const byIdf = (a: string, b: string) => index.idf.get(b)! - index.idf.get(a)!;
  for (const [i, e] of scores) {
    const ix = index.fns[i];
    if (subject.rec && ix.rec.id === subject.rec.id) continue;
    if (e.score < minScore) continue;
    if (!fileOk(ix.rec.file)) continue;
    if (args.language && ix.rec.language !== args.language.toLowerCase()) continue;
    const shared = [...e.shared].sort(byIdf);
    hits.push({
      rec: ix.rec,
      score: Math.round(e.score * 1000) / 1000,
      sharedCalls: shared.filter(isCall).map((f) => f.slice(2)).slice(0, 8),
      sharedWords: shared.filter((f) => !isCall(f)).slice(0, 10),
    });
  }
  hits.sort((a, b) => b.score - a.score || (sortKey(a.rec) < sortKey(b.rec) ? -1 : 1));

  const qHash = paramsHash({ ...args, cursor: undefined, format: undefined, limit: undefined });
  const cur = decodeCursor(args.cursor, "similar", qHash, snap.fingerprint);
  const start = typeof cur.position === "number" ? cur.position : 0;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const page = takePage(hits, start, limit, CHAR_BUDGET - 3000, (h, i) => {
    const r = h.rec;
    return [
      `#${i + 1}  similarity ${h.score}  ${r.file}:${span(r)}  (service ${r.service}, ${r.language})`,
      `    [${flags(r)}] ${r.name}`,
      `    sig: ${r.signature}`,
      `    id:  ${r.id}`,
      ...(h.sharedCalls.length ? [`    both call: ${h.sharedCalls.join(", ")}`] : []),
      ...(h.sharedWords.length ? [`    shared words: ${h.sharedWords.join(", ")}`] : []),
      ...(r.doc ? [`    doc: ${r.doc.replace(/\s+/g, " ")}${r.docTruncated ? " [truncated]" : ""}`] : []),
    ].join("\n");
  });
  const complete = page.end >= hits.length;
  const nextCursor = complete ? undefined : encodeCursor({ t: "similar", q: qHash, p: page.end, f: cur.fingerprint });
  const coverage = coverageOf(snap);

  if (args.format === "json") {
    return {
      text: JSON.stringify({
        subject: subject.rec ? { id: subject.rec.id, name: subject.rec.name } : { code: true, label: subject.label },
        features: { calls: subject.callees.length, words: subject.words.length },
        functionsCompared: index.fns.length,
        totalCandidates: hits.length,
        minScore,
        complete,
        nextCursor,
        coverage,
        candidates: hits.slice(start, page.end).map((h) => ({ ...h.rec, similarity: h.score, sharedCalls: h.sharedCalls, sharedWords: h.sharedWords })),
      }),
    };
  }
  return {
    text: [
      `similar to: ${subject.label} — ${subject.callees.length} distinct calls, ${subject.words.length} body words`,
      `BEHAVIOURAL CANDIDATES by shared calls and body vocabulary (rare ones weigh more; calls weigh 1.5×), candidates' own names ignored: ` +
        `${hits.length} of ${index.fns.length} functions scored ≥ ${minScore}. High similarity means the code ` +
        `looks alike, not that it is interchangeable — read both before reusing or merging.`,
      hits.length
        ? `showing ${start + 1}-${page.end}` + (complete ? " — no further candidates" : ` — MORE: call again with cursor="${nextCursor}"`)
        : "no candidates — lower minScore, or describe the behaviour to spec_nav_find_functions",
      ...renderCoverage(coverage),
      "",
      ...page.rendered,
    ].join("\n"),
  };
}
