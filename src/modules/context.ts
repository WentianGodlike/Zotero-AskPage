import { extractNearby, trimFullText } from "./prompts";
import { getPaperText, type PaperText } from "./fulltext";
import { getPref } from "../utils/prefs";
import { locatePassage, rankChunks, formatRetrieved } from "./retrieval";

/**
 * Assembling what the model gets to see.
 *
 * Four sources, in increasing order of cost:
 *
 *  1. the selected text                      — always
 *  2. the surrounding paragraphs             — cheap, usually decisive
 *  3. the reader's own annotations and notes — free, already in the library
 *  4. full text (or, later, retrieved passages) — expensive
 *
 * (3) was missing for a long time and is the cheapest real improvement
 * available: highlights and comments are exactly where the reader recorded what
 * they considered important, and they are already sitting in Zotero.
 */

/**
 * Filename patterns that mark a PDF as Supporting Information.
 *
 * Taken from the naming conventions publishers actually use, observed in a real
 * library: ACS `ma3c01377_si_001.pdf`, Wiley `advs10440-sup-0001-suppmat.pdf`,
 * Elsevier `1-s2.0-...-main.pdf` for the article itself.
 */
/**
 * Self-declarations: the document says what it is.
 *
 * This is the authoritative signal and it is what publishers actually print on
 * the first page of supporting material:
 *
 *   "Supporting Information for:"
 *   "Supporting Information for Adv. Sci., DOI 10.1002/advs.202411385"
 *   "Supplementary Material"
 *
 * It works for Word documents and HTML too, so it does not care about the file
 * format the way a filename rule has to.
 */
const SI_DECLARATIONS: RegExp[] = [
  // The forms publishers actually print, taken from real files:
  //   "Supporting Information for:"
  //   "Supporting Information for Adv. Sci., DOI 10.1002/advs.202411385"
  //   "Supporting Information"
  //
  // "for" is what separates a declaration from a citation: a paper's abstract
  // routinely says "...are given in the Supporting Information", and a loose
  // match sent the article itself as SI.
  /^\s*supporting\s+information\s*(for\b|$|[:.\u2014-])/im,
  /^\s*supplementary\s+(material|information|data|methods|note|notes)\b/im,
  /^\s*electronic\s+supplementary\s+(material|information)\b/im,
  // A heading, on its own line.
  /^\s*\(?\s*(si|es[im])\s*\)?\s*$/im,
  /this\s+(document|file|pdf)\s+(contains|is)\s+(the\s+)?supplement/i,
];

/**
 * Sanity guard for the front-matter scan.
 *
 * A regular article can legitimately *mention* "Supporting Information" in its
 * abstract or a footnote. Restricting the scan to the first kilobyte and
 * requiring either the declaration near the very start or an explicit
 * supplementary heading keeps that from firing.
 */
export function declaresItselfSupportingInfo(frontMatter: string): boolean {
  const text = String(frontMatter || "").slice(0, 2000);
  if (!text.trim()) {
    return false;
  }
  return SI_DECLARATIONS.some((re) => re.test(text));
}

/**
 * Filename fallback.
 *
 * Used only when the document's own text is unavailable — an unindexed scan, a
 * format Zotero cannot extract. Kept narrow on purpose: it exists to catch the
 * obvious publisher suffixes, not to guess.
 */
const SI_FILENAME_PATTERNS: RegExp[] = [
  /[-_ ]si[-_ ]?\d/i, // ACS: ma3c01377_si_001.pdf
  /supp(mat|lement|lementary|lemental)/i, // Wiley: -suppmat
  /[-_]mmc\d/i, // Elsevier: -mmc1
  /[-_ ]es[im](?![a-z])/i, // RSC: ESI / ESM
];

/** Does the filename unmistakably mark this as supporting material? */
export function looksLikeSupportingFilename(name: string): boolean {
  // Keep the extension: `SI.pdf` relies on it to mark the end of the token.
  const base = String(name || "")
    .replace(/^.*[\\/]/, "")
    .toLowerCase();
  if (!base || base === ".pdf") {
    return false;
  }
  return SI_FILENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Decide whether an attachment is Supporting Information.
 *
 * Content first, filename second — documented in that order because the
 * filename heuristic is exactly the kind of guess this project keeps getting
 * burned by. `frontMatter` is the first part of the document's extracted text.
 */
export function isSupportingInfo(attachment: {
  name: string;
  frontMatter?: string;
}): { yes: boolean; why: "declared" | "filename" | "no" } {
  if (
    attachment.frontMatter &&
    declaresItselfSupportingInfo(attachment.frontMatter)
  ) {
    return { yes: true, why: "declared" };
  }
  if (looksLikeSupportingFilename(attachment.name)) {
    return { yes: true, why: "filename" };
  }
  return { yes: false, why: "no" };
}

export interface SupportingInfoDoc {
  itemID: number;
  name: string;
  text: string;
  chars: number;
  truncated: boolean;
  /** How it was identified, for the debug log and the panel status line. */
  why: "declared" | "filename";
}

export interface Annotation {
  text: string;
  comment: string;
  page?: string;
  color?: string;
}

export interface ContextBundle {
  selection: string;
  nearby?: string;
  annotations: Annotation[];
  notes: string[];
  fullText?: string;
  fullTextTruncated: boolean;
  /** Supporting Information documents attached to the same item. */
  supportingInfo: SupportingInfoDoc[];
  /**
   * Passages retrieved from a document too long to send whole.
   *
   * Full text was previously truncated head-and-tail, which silently discarded
   * the middle — so asking about chapter 1 while reading chapter 8 was
   * impossible, and the model was blamed for it.
   */
  retrieved?: string;
  /** Human-readable summary of what was actually included. */
  summary: string[];
  /**
   * Rough size of what will be sent, per source.
   *
   * Deliberately visible: the difference between "selection only" and "whole
   * book" is a factor of ~50 in cost, and the reader is the only one who can
   * judge whether that is worth it for a given question.
   */
  sizes: Array<{ label: string; chars: number }>;
}

/**
 * The PDF attachments that belong to `itemID`.
 *
 * `itemID` may be the paper or the attachment itself, since the reader reports
 * the attachment while the item pane usually shows the parent.
 */
async function pdfAttachments(itemID: number): Promise<Zotero.Item[]> {
  const item = await Zotero.Items.getAsync(itemID);
  if (!item) {
    return [];
  }
  const isPdf = (x: Zotero.Item | null | undefined) =>
    Boolean(
      x &&
      x.isAttachment?.() &&
      /pdf/i.test(String(x.attachmentContentType || "")),
    );

  if (isPdf(item)) {
    return [item];
  }
  const out: Zotero.Item[] = [];
  for (const attID of item.getAttachments?.() || []) {
    const att = await Zotero.Items.getAsync(attID);
    if (isPdf(att)) {
      out.push(att!);
    }
  }
  return out;
}

/**
 * Collect the reader's annotations on this paper.
 *
 * Both the highlight text and the comment are kept: the comment is where the
 * reader's own reasoning lives, which is what makes this worth sending.
 */
export async function getAnnotations(itemID: number): Promise<Annotation[]> {
  try {
    const out: Annotation[] = [];
    for (const attachment of await pdfAttachments(itemID)) {
      // `getAnnotations` returns ids unless `asIDs` is false.
      const annotations: Zotero.Item[] =
        (attachment as any).getAnnotations?.(false, false) || [];
      for (const a of annotations) {
        const anyA = a as any;
        const text = String(anyA.annotationText || "").trim();
        const comment = String(anyA.annotationComment || "").trim();
        if (!text && !comment) {
          continue;
        }
        out.push({
          text,
          comment,
          page: anyA.annotationPageLabel
            ? String(anyA.annotationPageLabel)
            : undefined,
          color: anyA.annotationColor
            ? String(anyA.annotationColor)
            : undefined,
        });
      }
    }
    return out;
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] annotations unavailable: ${(e as Error)?.message || e}`,
    );
    return [];
  }
}

/**
 * Collect the reader's own notes, stripped of markup.
 *
 * Notes attached to the paper and to its PDFs are both included, because
 * annotating in the reader commonly creates notes on the attachment.
 */
export async function getNotes(
  itemID: number,
  maxCharsPerNote = 4000,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<number>();

  const collect = async (parent: Zotero.Item | null | undefined) => {
    if (!parent) {
      return;
    }
    for (const noteID of parent.getNotes?.() || []) {
      if (seen.has(noteID)) {
        continue;
      }
      seen.add(noteID);
      try {
        const note = await Zotero.Items.getAsync(noteID);
        const html = String((note as any)?.getNote?.() || "");
        const text = htmlToText(html).trim();
        if (text) {
          out.push(
            text.length > maxCharsPerNote
              ? `${text.slice(0, maxCharsPerNote)}…`
              : text,
          );
        }
      } catch {
        /* a broken note should not lose the others */
      }
    }
  };

  try {
    const item = await Zotero.Items.getAsync(itemID);
    await collect(item);
    for (const attachment of await pdfAttachments(itemID)) {
      await collect(attachment);
    }
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] notes unavailable: ${(e as Error)?.message || e}`,
    );
  }
  return out;
}

/**
 * Turn note HTML into readable text.
 *
 * Deliberately crude but regex-only: notes contain a small, known subset of
 * markup (paragraphs, headings, lists, emphasis), and running a parser for this
 * would be more code for no benefit.
 */
export function htmlToText(html: string): string {
  return decodeBasicEntities(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      // Block tags each contribute a trailing newline; collapse the one at the
      // very end so callers get clean text.
      .trim(),
  );
}

function decodeBasicEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[body] ?? m;
  });
}

/**
 * Annotations and notes as prompt-ready text.
 *
 * Annotations are capped: a heavily annotated book can hold hundreds, and
 * sending all of them would crowd out the passage the reader actually asked
 * about. The cap is generous enough to cover a chapter's worth.
 */
export function formatAnnotations(
  annotations: Annotation[],
  maxItems = 40,
  maxChars = 8000,
): string {
  if (!annotations.length) {
    return "";
  }
  const lines: string[] = [];
  let used = 0;
  for (const a of annotations.slice(0, maxItems)) {
    const page = a.page ? `（第 ${a.page} 页）` : "";
    const parts: string[] = [];
    if (a.text) {
      parts.push(`高亮：${a.text}`);
    }
    if (a.comment) {
      parts.push(`批注：${a.comment}`);
    }
    const line = `- ${page}${parts.join(" / ")}`;
    if (used + line.length > maxChars) {
      break;
    }
    used += line.length;
    lines.push(line);
  }
  if (lines.length < annotations.length) {
    lines.push(`（另有 ${annotations.length - lines.length} 条标注未列出）`);
  }
  return lines.join("\n");
}

/**
 * Text of any Supporting Information attached to this item.
 *
 * SI is where the extended derivations, extra figures and full parameter tables
 * live, and questions about a paper's maths very often land there. It is
 * attached as an ordinary sibling PDF, so it is found by filename rather than
 * by any Zotero-level marker.
 */
export async function getSupportingInfo(
  itemID: number,
): Promise<SupportingInfoDoc[]> {
  const out: SupportingInfoDoc[] = [];
  try {
    const budget = Number(getPref("siMaxChars")) || 200000;
    const attachments = await pdfAttachments(itemID);
    // Only meaningful when there is more than one document: a lone PDF is the
    // article, whatever its name says.
    const multiple = attachments.length > 1;

    for (const attachment of attachments) {
      const name = String(
        (attachment as any).attachmentFilename ||
          (attachment as any).getField?.("title") ||
          "",
      );

      // Reading the text serves both purposes: it is what identifies SI (by its
      // own declaration) and what gets sent. `attachmentText` is the supported
      // accessor — an earlier version called `getText()`, which does not exist
      // on Zotero.Item, so the optional call silently produced nothing and SI
      // detection fell back to filenames for every document.
      let raw = "";
      try {
        raw = (await (attachment as any).attachmentText) || "";
      } catch (e) {
        Zotero.debug(
          `[Highlight Ask] attachmentText failed for SI candidate ${attachment.id}: ${
            (e as Error)?.message || e
          }`,
        );
      }

      const verdict = isSupportingInfo({
        name,
        frontMatter: raw.slice(0, 2000),
      });

      // The filename fallback only applies when there really are sibling
      // documents; otherwise "supp" in a lone filename means nothing.
      const byDeclaration = verdict.why === "declared";
      const byFilename = verdict.why === "filename" && multiple;
      if ((!byDeclaration && !byFilename) || !raw.trim()) {
        continue;
      }

      Zotero.debug(
        `[Highlight Ask] SI detected by ${verdict.why}: ${name || attachment.id}`,
      );
      const { text, truncated } = trimFullText(raw, budget);
      out.push({
        itemID: attachment.id,
        name: name || `SI-${attachment.id}`,
        text,
        chars: text.length,
        truncated,
        why: byDeclaration ? "declared" : "filename",
      });
    }
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] SI lookup failed: ${(e as Error)?.message || e}`,
    );
  }
  return out;
}

export interface BuildContextOptions {
  itemID: number;
  selection: string;
  /** Attach the whole paper (or as much as fits). */
  fullText?: boolean;
  /** Attach the reader's annotations and notes. */
  annotations?: boolean;
  /** Already-fetched paper text, to avoid a second lookup. */
  paperText?: PaperText | null;
  /**
   * Untruncated document text, used as the retrieval corpus.
   *
   * `paperText` may be trimmed to the budget; searching the trimmed version
   * would miss exactly the parts that were cut.
   */
  rawText?: string;
}

/**
 * Assemble everything that will be sent for a question.
 *
 * Only the sources that are switched on are fetched, so a plain question about
 * a selection does not pay for a full-text lookup.
 */
export async function buildContext(
  options: BuildContextOptions,
): Promise<ContextBundle> {
  const { itemID, selection } = options;
  const fullTextRequested =
    options.fullText ?? Boolean(getPref("sendFullText"));
  const wantAnnotations =
    options.annotations ?? Boolean(getPref("sendAnnotations"));

  // The document is fetched when any source needs it. Retrieval needs the
  // untruncated text, which `getPaperText` keeps in `raw`.
  const needsDocument =
    fullTextRequested ||
    Boolean(getPref("sendNearby")) ||
    Boolean(getPref("retrievePassages")) ||
    Boolean(options.rawText);
  let paperText = options.paperText ?? null;
  if (!paperText && needsDocument) {
    paperText = await getPaperText(itemID);
  }

  const bundle: ContextBundle = {
    selection,
    annotations: [],
    notes: [],
    fullTextTruncated: false,
    supportingInfo: [],
    summary: [],
    sizes: [],
  };

  if (getPref("sendNearby")) {
    const nearby = extractNearby(paperText?.text || "", selection);
    if (nearby) {
      bundle.nearby = nearby;
      bundle.summary.push("相邻段落");
    }
  }

  if (wantAnnotations) {
    bundle.annotations = await getAnnotations(itemID);
    bundle.notes = await getNotes(itemID);
    if (bundle.annotations.length) {
      bundle.summary.push(`标注 ${bundle.annotations.length} 条`);
    }
    if (bundle.notes.length) {
      bundle.summary.push(`笔记 ${bundle.notes.length} 篇`);
    }
  }

  if (getPref("sendSI")) {
    // Supporting Information: where the extended derivations and parameter
    // tables live. The toggle and the collector both existed from the start,
    // but the two were never connected — the feature silently sent nothing
    // while every other link in the chain (settings switch, prompt wording,
    // renderer, size accounting) was in place and advertised.
    bundle.supportingInfo = await getSupportingInfo(itemID);
    if (bundle.supportingInfo.length) {
      bundle.summary.push(`SI ${bundle.supportingInfo.length} 份`);
    }
  }

  const retrievalOn =
    getPref("retrievePassages") &&
    Boolean(paperText?.chars) &&
    Boolean(options.rawText);
  const overBudget = Boolean(paperText?.truncated);

  // Decide between sending the document and searching it.
  //
  // Sending a truncated document is the worst of both: full cost, minus the
  // middle. So when the text does not fit, retrieval replaces it — the reader
  // keeps the ability to ask about any chapter while paying for a few passages
  // instead of a whole book. `sendFullText` still forces the document through
  // when the reader explicitly wants it.
  // `alwaysRetrieve` lets the reader prefer a few focused passages over the
  // whole document even when the document would fit: 35K tokens versus 3K for
  // the same question, and the retrieved passages are the relevant ones.
  const preferRetrieval = Boolean(getPref("alwaysRetrieve"));
  const wantFullText =
    fullTextRequested && !overBudget && !(preferRetrieval && retrievalOn);

  if (wantFullText && paperText?.chars) {
    bundle.fullText = paperText.text;
    bundle.fullTextTruncated = false;
    bundle.summary.push("全文");
  }

  // Search when the document did not fit, or when it was not requested at all
  // but the reader asked about a long document anyway.
  if (retrievalOn && !wantFullText) {
    const raw = options.rawText ?? "";
    const exclude = locatePassage(raw, selection) ?? undefined;
    const hits = rankChunks(raw, selection, {
      topK: Number(getPref("retrieveTopK")) || 5,
      excludeRange: exclude,
    });
    if (hits.length) {
      bundle.retrieved = formatRetrieved(hits, raw.length);
      bundle.summary.push(`检索 ${hits.length} 段`);
      Zotero.debug(
        `[Highlight Ask] retrieved ${hits.length} passage(s) from ${raw.length} chars` +
          ` (overBudget=${overBudget}, fullTextRequested=${fullTextRequested})`,
      );
    } else if (overBudget) {
      bundle.summary.push("检索无命中");
    }
  }

  if (fullTextRequested && overBudget) {
    // Be explicit rather than silently sending less than asked for.
    const note = bundle.retrieved
      ? preferRetrieval
        ? "按设置改为检索相关段落"
        : "全文过长，改为检索相关段落"
      : "全文过长，未能检索到相关段落";
    bundle.summary.push(note);
  }

  // Rough per-source sizes, so the panel can show what a question will cost.
  const sizes: Array<{ label: string; chars: number }> = [
    { label: "选中片段", chars: selection.length },
  ];
  if (bundle.nearby) {
    sizes.push({ label: "相邻段落", chars: bundle.nearby.length });
  }
  if (bundle.annotations.length) {
    sizes.push({
      label: `标注 ${bundle.annotations.length} 条`,
      chars: formatAnnotations(bundle.annotations).length,
    });
  }
  if (bundle.notes.length) {
    sizes.push({
      label: `笔记 ${bundle.notes.length} 篇`,
      chars: bundle.notes.reduce((n, x) => n + x.length, 0),
    });
  }
  for (const doc of bundle.supportingInfo) {
    sizes.push({ label: `SI：${doc.name}`, chars: doc.chars });
  }
  if (bundle.retrieved) {
    sizes.push({ label: "检索到的段落", chars: bundle.retrieved.length });
  }
  if (bundle.fullText) {
    sizes.push({ label: "全文", chars: bundle.fullText.length });
  }
  bundle.sizes = sizes;

  return bundle;
}

/** Total estimated tokens for a bundle, and a per-source breakdown. */
export function bundleSize(bundle: ContextBundle): {
  tokens: number;
  parts: Array<{ label: string; tokens: number }>;
} {
  const parts = bundle.sizes.map((s) => ({
    label: s.label,
    tokens: Math.round(s.chars / 3),
  }));
  return {
    tokens: parts.reduce((n, p) => n + p.tokens, 0),
    parts,
  };
}
