import { trimFullText } from "./prompts";
import { getPref } from "../utils/prefs";

/**
 * Full-text retrieval.
 *
 * Zotero already indexes PDF attachments, so the text is usually available from
 * its cache without re-parsing anything — `attachment.getText()` returns the
 * indexed full text. That makes "attach the whole paper" cheap enough to offer
 * as a per-question toggle.
 *
 * Results are cached per item for the lifetime of the session; the index does
 * not change while the user reads.
 */

export interface PaperText {
  text: string;
  /** True when the text was cut down to fit the character budget. */
  truncated: boolean;
  chars: number;
}

const cache = new Map<number, PaperText>();

/** Drop a cached paper, e.g. after its index is rebuilt. */
export function invalidatePaperText(itemID?: number): void {
  if (itemID === undefined) {
    cache.clear();
  } else {
    cache.delete(itemID);
  }
}

/** Collect the candidate items whose indexed text could hold the paper. */
async function candidateItems(itemID: number): Promise<Zotero.Item[]> {
  const item = await Zotero.Items.getAsync(itemID);
  if (!item) {
    return [];
  }
  const out: Zotero.Item[] = [];

  const isPdf = (x: Zotero.Item | null | undefined) =>
    Boolean(x && x.isAttachment?.() && /pdf/i.test(String(x.attachmentContentType || "")));

  if (isPdf(item)) {
    out.push(item);
  } else {
    for (const attID of item.getAttachments?.() || []) {
      const att = await Zotero.Items.getAsync(attID);
      if (isPdf(att)) {
        out.push(att!);
      }
    }
  }
  return out;
}

/**
 * Get the paper's text for the given item (a paper, or one of its PDFs).
 * Returns null when no indexed text is available, so callers can fall back to
 * asking only about the selection.
 */
export async function getPaperText(
  itemID: number,
  maxCharsOverride?: number,
): Promise<PaperText | null> {
  const cached = cache.get(itemID);
  if (cached) {
    return cached;
  }

  const budget =
    maxCharsOverride ?? (Number(getPref("fullTextMaxChars")) || 120000);

  try {
    for (const attachment of await candidateItems(itemID)) {
      let raw = "";
      try {
        // `getText()` (the indexed full text) is implemented on attachments but
        // is not in the type definitions, so reach it through a narrow cast.
        const indexed = attachment as unknown as {
          getText?: () => Promise<string>;
        };
        raw = (await indexed.getText?.()) || "";
      } catch (e) {
        // A missing or unbuilt index is expected, not an error worth surfacing.
        Zotero.debug(
          `[Highlight Ask] getText() failed for item ${attachment.id}: ${
            (e as Error)?.message || e
          }`,
        );
      }
      if (!raw.trim()) {
        continue;
      }

      const { text, truncated } = trimFullText(raw, budget);
      const result: PaperText = { text, truncated, chars: text.length };
      cache.set(itemID, result);
      return result;
    }
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] full-text lookup failed: ${(e as Error)?.message || e}`),
    );
  }

  // Cache the miss too: retrying on every question would be slow and noisy.
  cache.set(itemID, { text: "", truncated: false, chars: 0 });
  return null;
}

/**
 * A short, human-readable note about where the text came from, shown in the
 * panel so the user knows what the answer was actually based on.
 */
export function describePaperText(paper: PaperText | null): string {
  if (!paper || !paper.chars) {
    return "未取到全文（可能还没建立索引）";
  }
  return paper.truncated
    ? `已附带全文（截断至 ${paper.chars.toLocaleString()} 字）`
    : `已附带全文（${paper.chars.toLocaleString()} 字）`;
}
