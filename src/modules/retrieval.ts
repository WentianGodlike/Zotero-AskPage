/**
 * Retrieval over a document that is too long to send whole.
 *
 * Why this is needed: a 541-page textbook is roughly 400K tokens. The previous
 * approach — keep the first 60% and the last 40% of a 120K-character budget —
 * silently discarded the middle, so asking about chapter 1 while reading
 * chapter 8 could not work; the text was never sent. The model was blamed for
 * a limitation of the input.
 *
 * Two design decisions worth stating:
 *
 *  - **The query is the selected passage, not the question.** Questions are
 *    usually Chinese ("请解释这段内容") while the document is English, so the
 *    question alone retrieves nothing. The selection is in the document's own
 *    language and is by construction about the right topic.
 *  - **Scoring is lexical (BM25), computed locally.** No embedding service, no
 *    index to build, no API cost. It is weaker than a semantic search for
 *    paraphrases, but the query is a verbatim passage from the same document,
 *    which is the easy case for lexical matching.
 */

export interface Chunk {
  /** Character offsets into the source text. */
  start: number;
  end: number;
  text: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * Split text into overlapping chunks.
 *
 * Paragraph boundaries are preferred so a chunk does not begin mid-sentence,
 * and a small overlap keeps a fact that straddles a boundary retrievable from
 * one side or the other.
 */
export function chunkText(
  text: string,
  targetChars = 1200,
  overlapChars = 200,
): Chunk[] {
  const clean = String(text || "");
  if (!clean.trim()) {
    return [];
  }
  if (clean.length <= targetChars) {
    return [{ start: 0, end: clean.length, text: clean }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + targetChars);
    if (end < clean.length) {
      // Prefer to break at a paragraph, then a sentence, then a space.
      const window = clean.slice(start + Math.floor(targetChars * 0.6), end);
      const breakAt = findBreak(window);
      if (breakAt > 0) {
        end = start + Math.floor(targetChars * 0.6) + breakAt;
      }
    }
    chunks.push({ start, end, text: clean.slice(start, end) });
    if (end >= clean.length) {
      break;
    }
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

/** Offset of the best place to end a chunk, relative to `window`. */
function findBreak(window: string): number {
  const para = window.lastIndexOf("\n\n");
  if (para > 0) {
    return para + 2;
  }
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("。"),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentence > 0) {
    return sentence + 2;
  }
  const space = window.lastIndexOf(" ");
  return space > 0 ? space + 1 : -1;
}

/* ------------------------------------------------------------------ */
/* Tokenisation                                                        */
/* ------------------------------------------------------------------ */

// Words that carry no retrieval signal in academic prose.
const STOPWORDS = new Set([
  "the",
  "of",
  "and",
  "to",
  "in",
  "is",
  "are",
  "a",
  "an",
  "for",
  "on",
  "that",
  "this",
  "with",
  "as",
  "by",
  "be",
  "it",
  "or",
  "from",
  "at",
  "we",
  "can",
  "which",
  "these",
  "those",
  "their",
  "there",
  "have",
  "has",
  "not",
  "but",
  "if",
  "then",
  "than",
  "so",
  "such",
  "when",
  "where",
  "will",
  "would",
  "may",
  "also",
  "more",
  "most",
  "other",
  "into",
  "over",
  "between",
  "each",
  "all",
  "any",
  "its",
  "they",
  "them",
  "he",
  "she",
  "his",
  "her",
  "you",
  "your",
  "我们的",
  "这个",
  "那个",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "解释",
  "翻译",
]);

/**
 * Tokenise for lexical scoring.
 *
 * Latin words are lower-cased and lightly stemmed (plural and common suffixes),
 * because the query passage and the retrieved passage need not inflect alike.
 * CJK runs become overlapping bigrams, which is the standard trick for matching
 * Chinese without a segmenter — it also lets a Chinese question match the
 * Chinese notes the reader may have written.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = String(text || "").toLowerCase();

  // Latin words.
  for (const match of lower.matchAll(/[a-z][a-z0-9'-]{1,}/g)) {
    const word = stem(match[0]);
    if (word.length > 1 && !STOPWORDS.has(word)) {
      tokens.push(word);
    }
  }

  // CJK: overlapping bigrams.
  for (const match of lower.matchAll(
    /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g,
  )) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/** Crude suffix stripping — enough to match plurals and verb forms. */
function stem(word: string): string {
  let w = word;
  for (const suffix of [
    "ations",
    "ation",
    "ings",
    "ing",
    "ies",
    "ed",
    "es",
    "s",
  ]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      // Stripping a bare "s" from a word ending in ss/us/is produces a stem
      // that no longer matches its own plural: "classes" stemmed to "class"
      // while "class" stemmed to "clas". Skip those endings so the singular
      // and the plural share a stem.
      if (suffix === "s" && /(ss|us|is)$/.test(w)) {
        break;
      }
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

export interface RetrievalOptions {
  /** How many chunks to return. */
  topK?: number;
  /** Chunks overlapping the selection are skipped: they are already sent. */
  excludeRange?: { start: number; end: number };
  targetChars?: number;
}

/**
 * Rank chunks against a query with BM25.
 *
 * `k1` and `b` are the usual values; they are exposed so tests can pin the
 * ranking rather than the exact scores.
 */
export function rankChunks(
  text: string,
  query: string,
  options: RetrievalOptions = {},
): ScoredChunk[] {
  const { topK = 5, excludeRange, targetChars = 1200 } = options;
  const chunks = chunkText(text, targetChars);
  if (!chunks.length) {
    return [];
  }

  const queryTerms = new Map<string, number>();
  for (const term of tokenize(query)) {
    queryTerms.set(term, (queryTerms.get(term) || 0) + 1);
  }
  if (!queryTerms.size) {
    return [];
  }

  const docTokens = chunks.map((c) => tokenize(c.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgLength =
    docLengths.reduce((a, b) => a + b, 0) / Math.max(1, docLengths.length);

  // Document frequency per query term, for the IDF part of BM25.
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const term of queryTerms.keys()) {
      if (seen.has(term)) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }
  }

  const k1 = 1.5;
  const b = 0.75;
  const N = chunks.length;

  const scored: ScoredChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Skip the passage already being sent.
    if (
      excludeRange &&
      chunk.start < excludeRange.end &&
      chunk.end > excludeRange.start
    ) {
      continue;
    }

    const tokens = docTokens[i];
    const length = docLengths[i] || 1;
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    let score = 0;
    for (const [term, queryCount] of queryTerms) {
      const freq = tf.get(term);
      if (!freq) {
        continue;
      }
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score +=
        idf *
        ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * length) / avgLength))) *
        queryCount;
    }

    if (score > 0) {
      scored.push({ ...chunk, score });
    }
  }

  scored.sort((a, b2) => b2.score - a.score || a.start - b2.start);
  return scored.slice(0, topK);
}

/**
 * Find where a passage sits in the full text.
 *
 * Used to exclude the selection from retrieval results, and to search outward
 * from where the reader is.
 */
export function locatePassage(
  text: string,
  passage: string,
): { start: number; end: number } | null {
  const needle = String(passage || "").trim();
  if (needle.length < 16) {
    return null;
  }
  const direct = text.indexOf(needle);
  if (direct >= 0) {
    return { start: direct, end: direct + needle.length };
  }
  // The text layer inserts line breaks, so compare on a whitespace-collapsed
  // form and map back by walking the original.
  const collapsed = needle.replace(/\s+/g, " ").slice(0, 120);
  const haystack = text.replace(/\s+/g, " ");
  const at = haystack.indexOf(collapsed);
  if (at < 0) {
    return null;
  }
  // Approximate offsets in the original string.
  let seen = 0;
  let start = -1;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    if (seen === at && start < 0) {
      start = i;
    }
    if (seen >= at + collapsed.length) {
      end = i;
      break;
    }
    if (!/\s/.test(text[i]) || (i > 0 && !/\s/.test(text[i - 1]))) {
      seen++;
    }
  }
  return start >= 0 ? { start, end } : null;
}

/**
 * Assemble the retrieved context for a question.
 *
 * Returns the passages in document order — reading a derivation in the order
 * the author wrote it is easier than in relevance order — with a header giving
 * each passage's position so the model can attribute what it quotes.
 */
export function formatRetrieved(
  chunks: ScoredChunk[],
  totalChars: number,
): string {
  if (!chunks.length) {
    return "";
  }
  const ordered = [...chunks].sort((a, b) => a.start - b.start);
  return ordered
    .map((c) => {
      const percent = Math.round((c.start / Math.max(1, totalChars)) * 100);
      return `【全文约 ${percent}% 处】\n${c.text.trim()}`;
    })
    .join("\n\n");
}
