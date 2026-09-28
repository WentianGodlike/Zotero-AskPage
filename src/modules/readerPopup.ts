import { QUICK_ACTIONS, resolveTaskPrompt } from "./prompts";
import { askInSidebar, anyViewMounted } from "./sidebar";

/**
 * Reader integration: add buttons to Zotero's text-selection popup.
 *
 * Zotero 7+ exposes `Zotero.Reader.registerEventListener(type, handler, id)`.
 * For `renderTextSelectionPopup` the handler receives:
 *   { reader, doc, params, append }
 * where `append(...elements)` injects nodes into the popup.
 *
 * IMPORTANT: `append` clones nodes into the reader's iframe using a
 * structured clone (`cloneInto` + `cloneFunctions`). Event listeners are NOT
 * preserved by that clone, so a handler attached before `append()` is lost.
 * We therefore append first, then re-find the node in `doc` and attach.
 */

const EVENT_TYPE = "renderTextSelectionPopup";
const BTN_ROW_CLASS = "ha-selection-actions";
/** Injected into the reader document the first time a popup renders. */
const BTN_STYLE_ID = "ha-selection-btn-styles";

/**
 * Zotero's own selection popup has its own styling, but custom sections do not
 * inherit button styles. This is injected eagerly (on first popup render, not
 * when the panel opens) so the buttons look right immediately.
 */
const BTN_CSS = `
.${BTN_ROW_CLASS} {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 2px 4px;
}
.${BTN_ROW_CLASS} .ha-selection-btn {
  font: 12px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff;
  background: #2f6feb;
  border: 0;
  border-radius: 6px;
  padding: 3px 9px;
  margin: 0 1px;
  cursor: pointer;
  white-space: nowrap;
}
.${BTN_ROW_CLASS} .ha-selection-btn:hover { background: #245bd0; }
.${BTN_ROW_CLASS} .ha-selection-btn:active { background: #1d4bb0; }
`;

function ensureButtonStyles(doc: Document) {
  if (doc.getElementById(BTN_STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = BTN_STYLE_ID;
  style.textContent = BTN_CSS;
  (doc.head || doc.documentElement)?.appendChild(style);
}

export interface ReaderInstance {
  itemID: number;
  _iframeWindow?: Window & typeof globalThis;
  _internalReader?: any;
}

type ReaderEventHandler = (event: any) => void;

let handler: ReaderEventHandler | null = null;

export function registerReaderPopup(): void {
  if (handler) {
    return;
  }
  handler = onRenderTextSelectionPopup;
  try {
    Zotero.Reader.registerEventListener(
      EVENT_TYPE,
      handler as any,
      addon.data.config.addonID,
    );
  } catch (e) {
    Zotero.logError(e as any);
    handler = null;
  }
}

export function unregisterReaderPopup(): void {
  // `_unregisterEventListenerByPluginID` runs on shutdown; being explicit here
  // keeps hot-reload during development from stacking handlers.
  if (!handler) {
    return;
  }
  try {
    Zotero.Reader.unregisterEventListener(EVENT_TYPE, handler as any);
  } catch (e) {
    Zotero.logError(e as any);
  }
  handler = null;
}

function onRenderTextSelectionPopup(event: any): void {
  try {
    const { doc, params, append, reader } = event || {};
    if (!doc || typeof append !== "function") {
      return;
    }
    // Only add our row once per popup.
    if (doc.querySelector(`.${BTN_ROW_CLASS}`)) {
      return;
    }

    const selection = getSelectionText(reader, params);
    if (!selection) {
      return;
    }

    ensureButtonStyles(doc);

    const row = doc.createElement("div");
    row.className = BTN_ROW_CLASS;
    for (const action of QUICK_ACTIONS) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "ha-selection-btn";
      btn.textContent = action.label;
      btn.title = action.title;
      // Keep the PDF selection alive while the user moves to click.
      btn.addEventListener("mousedown", (e: Event) => e.stopPropagation());
      row.appendChild(btn);
    }

    append(row);

    // Re-find the *cloned* node and attach real handlers there.
    const mounted =
      (doc.querySelector(`.${BTN_ROW_CLASS}`) as HTMLElement | null) ?? row;
    wireButtons(mounted, reader, selection);
  } catch (e) {
    Zotero.logError(e as any);
  }
}

function wireButtons(
  row: HTMLElement,
  reader: ReaderInstance,
  selection: string,
): void {
  const buttons = Array.from(
    row.querySelectorAll("button"),
  ) as HTMLElement[];
  buttons.forEach((btn, index) => {
    const action = QUICK_ACTIONS[index];
    if (!action) {
      return;
    }
    btn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const doc = row.ownerDocument;
      if (!doc) {
        return;
      }
      const question = resolveTaskPrompt(action);
      const delivered = askInSidebar({
        itemID: reader.itemID,
        selection,
        question,
      });
      if (!delivered) {
        // Distinguish "the pane is not open at all" from "a pane for another
        // item is open" — the fix differs, and a vague message sends the user
        // looking in the wrong place.
        const message = anyViewMounted()
          ? "这个对话属于另一篇文献。请先选中本篇文献，让右侧「AI 助手」显示出来再试。"
          : "右侧还没有打开「AI 助手」面板。展开右侧栏的信息区，让 Highlight Ask 出现后再试。";
        new ztoolkit.ProgressWindow("Highlight Ask", { closeOnClick: true })
          .createLine({ text: message, type: "fail" })
          .show();
      }
      // Dismiss Zotero's own popup so it does not overlap the sidebar.
      dismissSelectionPopup(doc);
    });
  });
}

/**
 * Zotero's selection popup closes on its own once focus moves, but hiding it
 * eagerly avoids a visual overlap with the panel we just opened.
 */
function dismissSelectionPopup(doc: Document): void {
  try {
    const popup = doc.querySelector(".selection-popup") as HTMLElement | null;
    if (popup) {
      popup.style.display = "none";
    }
  } catch {
    /* ignore */
  }
}

/**
 * Read the selected text. Zotero puts it on `params.annotation.text`; the live
 * DOM selection is a useful fallback but can be cleared by the time we run.
 */
function getSelectionText(reader: ReaderInstance, params: any): string {
  const fromParams = params?.annotation?.text;
  if (fromParams && String(fromParams).trim()) {
    return normalizeSelection(String(fromParams));
  }
  try {
    const win = reader?._iframeWindow;
    const sel = win?.getSelection?.();
    const text = sel?.toString();
    if (text && text.trim()) {
      return normalizeSelection(text);
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * PDF text extraction inserts hard line breaks at every visual line, often
 * hyphenates, and can drag in invisible junk. Join lines so the model sees
 * prose instead of fragments, but keep blank lines as paragraph separators.
 *
 * Three classes of noise are handled explicitly, all observed in real PDFs:
 *  1. Soft hyphenation across a line break: "hyphen-\nation" -> "hyphenation".
 *  2. LaTeX `latexit` blobs. Many arXiv preprints embed the source of every
 *     equation as invisible text alongside a multi-KB base64 payload. Selecting
 *     across such a region would otherwise blow up the request with thousands
 *     of characters of garbage.
 *  3. Zero-width and bidi-control characters, which carry no meaning but
 *     confuse the model and inflate the token count.
 */
export function normalizeSelection(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");

  // 2. Drop LaTeX source blobs that some publishers hide in the text layer.
  text = text.replace(/latexit\s+sha1_base64\s*=\s*"[^"]*"\s*/gi, " ");
  text = text.replace(/<latexit[^>]*>/gi, " ");
  text = text.replace(/[A-Za-z0-9+/]{120,}={0,2}/g, " ");

  // 3. Strip invisible formatting characters.
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");

  const lines = text.split("\n");
  const out: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      out.push(buffer);
      buffer = "";
    }
  };

  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (!buffer) {
      buffer = trimmed;
      continue;
    }
    // 1. Join a hyphenated line break: "hyphen-\nation" -> "hyphenation".
    if (/[A-Za-z]-$/.test(buffer) && /^[a-z]/.test(trimmed)) {
      buffer = buffer.slice(0, -1) + trimmed;
    } else {
      buffer += ` ${trimmed}`;
    }
  }
  flush();

  return out.join("\n\n").trim();
}
