import { QUICK_ACTIONS, resolveTaskPrompt } from "./prompts";
import { askInSidebar, anyViewMounted } from "./sidebar";
import {
  captureGeometry,
  searchSelectionDeep,
  stashPendingCapture,
} from "./screenshot";

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
/* The reader constrains this popup to 198px wide (see .selection-popup in
   reader.css). Forcing a larger width with min-width does not widen it — the
   content simply overflows and the send button ends up outside the popup. So
   the row is built to live inside that width: the input takes the whole first
   line, the button wraps under it.
   No backticks in this block: it is inside a template literal. */
.${BTN_ROW_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  padding: 4px 0 2px;
  max-width: 100%;
  box-sizing: border-box;
}

/* Preset actions, wrapping as needed inside the popup. */
.${BTN_ROW_CLASS} .ha-ask-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
}
.${BTN_ROW_CLASS} .ha-selection-btn {
  flex: 0 1 auto;
  font: 12px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff;
  background: #2f6feb;
  border: 0;
  border-radius: 6px;
  padding: 4px 8px;
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
}
.${BTN_ROW_CLASS} .ha-selection-btn:hover { background: #245bd0; }
.${BTN_ROW_CLASS} .ha-selection-btn:active { background: #1d4bb0; }

/* Free-form question. The input takes a full line; the send button wraps below
   when there is not room beside it. */
.${BTN_ROW_CLASS} .ha-ask-form {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: flex-start;
  width: 100%;
  max-width: 100%;
}
.${BTN_ROW_CLASS} .ha-ask-input {
  flex: 1 1 100%;
  /* No min-width: the parent is capped at 198px, so a floor here would push the
     button out of the popup instead of widening it. */
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  font: 12px/1.45 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fill-primary, #1f2329);
  background: var(--material-background, #fff);
  border: 1px solid var(--fill-quaternary, #c9d0da);
  border-radius: 6px;
  padding: 4px 8px;
  margin: 0;
  /* Two lines reserved, as requested: the field does not grow while typing and
     the popup height stays stable. */
  height: 3.2em;
  resize: none;
  overflow-y: auto;
  /* A textarea carries its own font and margin from the UA sheet. */
  font-family: inherit;
  vertical-align: top;
}
.${BTN_ROW_CLASS} .ha-ask-input::placeholder { color: #9aa3b0; }
.${BTN_ROW_CLASS} .ha-ask-input:focus {
  outline: none;
  border-color: #2f6feb;
  box-shadow: 0 0 0 2px rgba(47, 111, 235, 0.18);
}
.${BTN_ROW_CLASS} .ha-ask-send {
  flex: 0 0 auto;
  margin-inline-start: auto;
  font: 12px/1.45 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff;
  background: #2f6feb;
  border: 0;
  border-radius: 6px;
  padding: 5px 12px;
  margin-block: 0;
  margin-inline-end: 0;
  cursor: pointer;
  white-space: nowrap;
}
.${BTN_ROW_CLASS} .ha-ask-send:hover { background: #245bd0; }
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

    // Resolve the crop region now, while the selection is alive.
    //
    // Clicking into the sidebar clears the PDF selection, so the reader has a
    // live selection at this moment and none by the time a button is pressed.
    // Stashing the geometry here is what makes a screenshot possible at all.
    stashCaptureFromReader(reader);

    ensureButtonStyles(doc);

    const row = doc.createElement("div");
    row.className = BTN_ROW_CLASS;

    // Presets keep their own line; the input gets the full width below them.
    const actions = doc.createElement("div");
    actions.className = "ha-ask-actions";
    for (const action of QUICK_ACTIONS) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "ha-selection-btn";
      btn.textContent = action.label;
      btn.title = action.title;
      // Marked explicitly: `wireButtons` used to match buttons to QUICK_ACTIONS
      // by index, so any extra button in the row would shift every binding.
      btn.dataset.haAction = action.id;
      // Keep the PDF selection alive while the user moves to click.
      btn.addEventListener("mousedown", (e: Event) => e.stopPropagation());
      actions.appendChild(btn);
    }
    row.appendChild(actions);

    const form = doc.createElement("div");
    form.className = "ha-ask-form";

    // A textarea rather than an input: two lines are reserved so a longer
    // question stays readable while typing, and `rows` keeps the popup height
    // stable instead of growing with the text.
    const input = doc.createElement("textarea") as HTMLTextAreaElement;
    input.rows = 2;
    input.className = "ha-ask-input";
    // Explains the feature on hover and doubles as the visible hint that this
    // row accepts free-form questions, not just the three presets.
    input.placeholder = "或直接提问，回车发送";
    input.title = "输入问题后回车：会带上这段划线一起发给 AI";
    // Keep the PDF selection alive while typing, and stop the reader from
    // treating keystrokes as shortcuts.
    for (const type of ["mousedown", "mouseup", "click", "keydown", "keyup"]) {
      input.addEventListener(type, (e: Event) => e.stopPropagation());
    }
    form.appendChild(input);

    const send = doc.createElement("button");
    send.type = "button";
    send.className = "ha-ask-send";
    send.textContent = "提问";
    send.dataset.haSend = "1";
    form.appendChild(send);

    row.appendChild(form);
    append(row);

    // Re-find the *cloned* node and attach real handlers there.
    const mounted =
      (doc.querySelector(`.${BTN_ROW_CLASS}`) as HTMLElement | null) ?? row;
    wireButtons(mounted, reader, selection);
    wireAskForm(mounted, reader, selection);
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
    row.querySelectorAll("[data-ha-action]"),
  ) as HTMLElement[];
  for (const pair of matchActionsToButtons(QUICK_ACTIONS, buttons)) {
    pair.button.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      askAndReport(
        reader,
        selection,
        resolveTaskPrompt(pair.action),
        row.ownerDocument,
      );
    });
  }
}

/**
 * Pair preset actions with their buttons by id.
 *
 * Deliberately not by index. The row also holds the free-form input and its
 * send button, so `querySelectorAll("button")[i]` would drift out of step with
 * `QUICK_ACTIONS` the moment anything is added — and the failure is silent:
 * each button would run a different action than its label says.
 */
export function matchActionsToButtons<
  T extends { id: string },
  B extends { dataset: { haAction?: string } },
>(actions: readonly T[], buttons: readonly B[]): Array<{ action: T; button: B }> {
  const out: Array<{ action: T; button: B }> = [];
  for (const button of buttons) {
    const id = button.dataset?.haAction;
    if (!id) {
      continue;
    }
    const action = actions.find((a) => a.id === id);
    if (action) {
      out.push({ action, button });
    }
  }
  return out;
}

/**
 * Send a question for the selected passage, or explain why it could not be sent.
 *
 * Shared by the preset buttons and the free-form field: both need the same
 * failure diagnosis, and duplicating it is how the two paths drift apart.
 */
function askAndReport(
  reader: ReaderInstance,
  selection: string,
  question: string,
  doc: Document | null,
): void {
  const delivered = askInSidebar({
    itemID: reader.itemID,
    selection,
    question,
  });
  if (!delivered) {
    // Distinguish "the pane is not open at all" from "a pane for another item
    // is open" — the fix differs, and a vague message sends the user looking in
    // the wrong place.
    const message = anyViewMounted()
      ? "这个对话属于另一篇文献。请先选中本篇文献，让右侧面板显示出来再试。"
      : "右侧还没有打开面板。展开右侧栏的信息区，让 AskPage 出现后再试。";
    new ztoolkit.ProgressWindow("AskPage", { closeOnClick: true })
      .createLine({ text: message, type: "fail" })
      .show();
  }
  // Dismiss Zotero's own popup so it does not overlap the sidebar.
  if (doc) {
    dismissSelectionPopup(doc);
  }
}

/**
 * Wire the free-form question field.
 *
 * The preset buttons cover the common cases, but the question a passage raises
 * is often specific ("隐式正则化与显式正则化的区别"). Typing it here keeps the
 * selection and the question together, instead of asking about the passage and
 * then re-explaining what is being asked about in the sidebar.
 *
 * Attached after `append()`, on the cloned node: the reader's `cloneInto` does
 * not carry event listeners across, which is the same constraint the preset
 * buttons work under.
 */
function wireAskForm(
  row: HTMLElement,
  reader: ReaderInstance,
  selection: string,
): void {
  const input = row.querySelector(".ha-ask-input") as HTMLInputElement | null;
  const send = row.querySelector("[data-ha-send]") as HTMLElement | null;
  if (!input || !send) {
    return;
  }

  const submit = () => {
    const question = (input.value || "").trim();
    if (!question) {
      input.focus();
      return;
    }
    // The seed question makes the sidebar send immediately, so one Enter here
    // is the whole interaction.
    askAndReport(reader, selection, question, row.ownerDocument);
  };

  send.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    submit();
  });

  input.addEventListener("keydown", (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" && !(e as KeyboardEvent).shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (key === "Escape") {
      e.stopPropagation();
      input.blur();
    }
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
 * Resolve and stash the crop geometry for the reader's current selection.
 *
 * Uses the reader's own iframe window, which is the same reference Zotero hands
 * the built-in selection popup — the one path known to hold the selection.
 */
function stashCaptureFromReader(reader: ReaderInstance): void {
  // Always stash an outcome, failures included: this handler is the only place
  // that runs while the selection is still alive, so it is also the only place
  // that can report *why* a capture is impossible.
  //
  // The reader's `_iframeWindow` is `reader.html` (the React shell), and the PDF
  // viewer sits deeper inside it, so the selection is searched for across the
  // whole frame subtree. The trace is carried into the failure message: previous
  // attempts failed because the nesting was assumed instead of observed.
  const itemID = reader?.itemID;
  try {
    const win = reader?._iframeWindow;
    if (!win) {
      stashPendingCapture(
        { ok: false, step: "selection", detail: "reader 没有 _iframeWindow" },
        itemID,
      );
      return;
    }

    const search = searchSelectionDeep(win as unknown as Window);
    if (!search.selection) {
      stashPendingCapture(
        {
          ok: false,
          step: "selection",
          detail: `弹窗时各 frame 均无选区。探测：${search.trace}`,
        },
        itemID,
      );
      return;
    }

    const outcome = captureGeometry(search.selection);
    stashPendingCapture(
      outcome.ok ? outcome : { ...outcome, detail: `${outcome.detail}｜探测：${search.trace}` },
      itemID,
    );
  } catch (e) {
    stashPendingCapture(
      { ok: false, step: "selection", detail: `异常: ${(e as Error)?.message || e}` },
      itemID,
    );
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
