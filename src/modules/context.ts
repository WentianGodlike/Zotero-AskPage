import { extractNearby, trimFullText } from "./prompts";
import { getPaperText, type PaperText } from "./fulltext";
import { getPref } from "../utils/prefs";

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
  /** Human-readable summary of what was actually included. */
  summary: string[];
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
      x && x.isAttachment?.() && /pdf/i.test(String(x.attachmentContentType || "")),
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
          color: anyA.annotationColor ? String(anyA.annotationColor) : undefined,
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
export async function getNotes(itemID: number, maxCharsPerNote = 4000): Promise<string[]> {
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
    Zotero.debug(`[Highlight Ask] notes unavailable: ${(e as Error)?.message || e}`);
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

export interface BuildContextOptions {
  itemID: number;
  selection: string;
  /** Attach the whole paper (or as much as fits). */
  fullText?: boolean;
  /** Attach the reader's annotations and notes. */
  annotations?: boolean;
  /** Already-fetched paper text, to avoid a second lookup. */
  paperText?: PaperText | null;
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
  const wantFullText = options.fullText ?? Boolean(getPref("sendFullText"));
  const wantAnnotations =
    options.annotations ?? Boolean(getPref("sendAnnotations"));

  let paperText = options.paperText ?? null;
  if (!paperText && (wantFullText || Boolean(getPref("sendNearby")))) {
    paperText = await getPaperText(itemID);
  }

  const bundle: ContextBundle = {
    selection,
    annotations: [],
    notes: [],
    fullTextTruncated: false,
    summary: [],
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

  if (wantFullText && paperText?.chars) {
    bundle.fullText = paperText.text;
    bundle.fullTextTruncated = paperText.truncated;
    bundle.summary.push(
      paperText.truncated ? "全文（已截断）" : "全文",
    );
  }

  return bundle;
}

/** Re-export for callers that only need the trimming helper. */
export { trimFullText };
