import type { ReaderInstance } from "./readerPopup";
import { streamChat, DeepSeekError, type ChatMessage } from "./deepseek";
import { buildFollowUpMessages, buildInitialMessages } from "./prompts";
import { renderMarkdown } from "./markdown";
import { getPref } from "../utils/prefs";

/**
 * The floating panel that lives inside the reader's iframe document.
 *
 * It is mounted on the iframe body (not on Zotero's own selection popup) so
 * that it survives the popup closing, can be scrolled and dragged, and can
 * host a follow-up input.
 */

const PANEL_CLASS = "ha-panel";
const STYLE_ID = "ha-panel-styles";
const MAX_WIDTH = 520;

export interface PanelHandle {
  destroy(): void;
}

let current: PanelHandle | null = null;

export interface OpenPanelOptions {
  reader: ReaderInstance;
  doc: Document;
  selection: string;
  question: string;
  /** Prefill the follow-up box instead of auto-sending. */
  manual?: boolean;
}

/** Close whatever panel is open (used on plugin shutdown). */
export function closePanel(): void {
  current?.destroy();
  current = null;
}

export function openAskPanel(options: OpenPanelOptions): void {
  const { reader, doc, selection, question, manual } = options;

  // One panel at a time keeps things predictable.
  current?.destroy();

  ensureStyles(doc);

  const root = doc.createElement("div");
  root.className = PANEL_CLASS;
  root.setAttribute("data-ha", "panel");

  // ---------- header ----------
  const title = doc.createElement("span");
  title.className = "ha-title";
  title.textContent = "Highlight Ask";

  const spacer = doc.createElement("span");
  spacer.className = "ha-spacer";

  const copyBtn = mkButton(doc, "复制", "复制最近的回答");
  const noteBtn = mkButton(doc, "存为笔记", "把问答保存为该文献的 Zotero 笔记");
  const closeBtn = mkButton(doc, "✕", "关闭");

  const header = doc.createElement("div");
  header.className = "ha-head";
  header.append(title, spacer, copyBtn, noteBtn, closeBtn);

  // ---------- selection preview ----------
  const quoteLabel = doc.createElement("div");
  quoteLabel.className = "ha-quote-label";
  quoteLabel.textContent = "选中内容";

  const quoteBody = doc.createElement("div");
  quoteBody.className = "ha-quote-body";
  quoteBody.textContent = selection;

  const quote = doc.createElement("div");
  quote.className = "ha-quote";
  quote.append(quoteLabel, quoteBody);

  // ---------- conversation ----------
  const convo = doc.createElement("div");
  convo.className = "ha-convo";

  // ---------- follow-up input ----------
  const input = doc.createElement("textarea");
  input.className = "ha-input";
  input.rows = 1;
  input.placeholder = "继续追问…（Enter 发送，Shift+Enter 换行）";

  const sendBtn = mkButton(doc, "发送", "发送追问");
  sendBtn.classList.add("ha-send");

  const inputRow = doc.createElement("div");
  inputRow.className = "ha-input-row";
  inputRow.append(input, sendBtn);

  root.append(header, quote, convo, inputRow);
  if (!doc.body) {
    return;
  }
  doc.body.appendChild(root);

  // ---------- state ----------
  let history: ChatMessage[] = [];
  let abort: AbortController | null = null;
  let lastAnswer = "";
  let busy = false;
  let destroyed = false;

  const handle: PanelHandle = {
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      abort?.abort();
      abort = null;
      root.remove();
      if (current === handle) {
        current = null;
      }
    },
  };
  current = handle;

  // ---------- helpers ----------
  function scrollToBottom() {
    convo.scrollTop = convo.scrollHeight;
  }

  function appendBubble(role: "user" | "assistant", text: string) {
    const wrap = doc.createElement("div");
    wrap.className = `ha-bubble ha-${role}`;
    const body = doc.createElement("div");
    body.className = "ha-bubble-body";
    if (role === "user") {
      body.textContent = text;
    }
    wrap.appendChild(body);
    convo.appendChild(wrap);
    scrollToBottom();
    return { wrap, body };
  }

  function appendError(message: string) {
    const box = doc.createElement("div");
    box.className = "ha-error";
    box.textContent = message;
    convo.appendChild(box);
    scrollToBottom();
  }

  function setBusy(next: boolean) {
    busy = next;
    sendBtn.textContent = next ? "停止" : "发送";
    sendBtn.title = next ? "停止生成" : "发送追问";
    sendBtn.classList.toggle("ha-stop", next);
  }

  // ---------- ask ----------
  async function ask(messages: ChatMessage[], echoQuestion?: string) {
    if (busy) {
      return;
    }
    if (echoQuestion) {
      appendBubble("user", echoQuestion);
    }

    const { wrap: answerWrap, body: answerBody } = appendBubble(
      "assistant",
      "",
    );
    answerBody.classList.add("ha-streaming");
    answerBody.textContent = "思考中…";

    const showReasoning = Boolean(getPref("showReasoning"));
    let reasoningBox: HTMLDetailsElement | null = null;

    const renderReasoning = (text: string) => {
      if (!showReasoning || !text) {
        return;
      }
      if (!reasoningBox) {
        const pre = doc.createElement("div");
        pre.className = "ha-reasoning-body";
        const summary = doc.createElement("summary");
        summary.textContent = "推理过程";
        reasoningBox = doc.createElement("details");
        reasoningBox.className = "ha-reasoning";
        reasoningBox.open = true;
        reasoningBox.append(summary, pre);
        answerWrap.insertBefore(reasoningBox, answerBody);
      }
      reasoningBox.querySelector(".ha-reasoning-body")!.textContent = text;
      scrollToBottom();
    };

    abort = new AbortController();
    setBusy(true);

    try {
      const result = await streamChat({
        messages,
        signal: abort.signal,
        onDelta: (full) => {
          answerBody.classList.remove("ha-streaming");
          answerBody.replaceChildren(renderMarkdown(full, doc));
          scrollToBottom();
        },
        onReasoning: renderReasoning,
      });

      lastAnswer = result.content;
      history = [...messages, { role: "assistant", content: result.content }];

      if (result.usage) {
        const meta = doc.createElement("div");
        meta.className = "ha-meta";
        meta.textContent = `${result.usage.total_tokens} tokens`;
        answerWrap.appendChild(meta);
      }
    } catch (e) {
      const err = e as DeepSeekError;
      if (err?.kind === "aborted") {
        answerBody.classList.remove("ha-streaming");
        answerBody.textContent = lastAnswer || "（已停止）";
      } else {
        answerWrap.remove();
        appendError(err?.message || String(e));
      }
    } finally {
      abort = null;
      setBusy(false);
      if (!destroyed) {
        input.focus();
      }
    }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    input.style.height = "auto";

    if (history.length === 0) {
      const messages = buildInitialMessages(selection, text);
      history = messages;
      void ask(messages, text);
    } else {
      const messages = buildFollowUpMessages(history, text);
      // `history` is updated inside ask() once the answer arrives, so seed it
      // here to keep the visible conversation consistent if the call fails.
      history = messages;
      void ask(messages, text);
    }
  }

  // ---------- events ----------
  closeBtn.addEventListener("click", () => handle.destroy());

  copyBtn.addEventListener("click", () => {
    if (!lastAnswer) {
      flash(copyBtn, "暂无回答");
      return;
    }
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(lastAnswer);
      flash(copyBtn, "已复制");
    } catch (e) {
      Zotero.logError(e as Error);
      flash(copyBtn, "复制失败");
    }
  });

  noteBtn.addEventListener("click", () => {
    void saveNote(reader, selection, history, lastAnswer, noteBtn);
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) {
        submit();
      }
    }
  });

  sendBtn.addEventListener("click", () => {
    if (busy) {
      abort?.abort();
      return;
    }
    submit();
  });

  makeDraggable(doc, root, header);
  positionPanel(root, reader, doc);

  // ---------- kick off ----------
  if (manual) {
    input.value = question;
    input.focus();
  } else {
    const messages = buildInitialMessages(selection, question);
    history = messages;
    void ask(messages, question);
  }
}

/* ------------------------------------------------------------------ */
/* Note saving                                                         */
/* ------------------------------------------------------------------ */

async function saveNote(
  reader: ReaderInstance,
  selection: string,
  history: ChatMessage[],
  lastAnswer: string,
  btn: HTMLElement,
) {
  if (!lastAnswer) {
    flash(btn, "暂无回答");
    return;
  }
  try {
    const item = await Zotero.Items.getAsync(reader.itemID);
    if (!item) {
      flash(btn, "找不到条目");
      return;
    }

    const parts: string[] = [];
    parts.push("<h1>Highlight Ask 问答</h1>");
    parts.push("<h2>选中内容</h2>");
    parts.push(`<blockquote>${escapeHtml(selection)}</blockquote>`);
    parts.push("<h2>问答</h2>");

    // Walk the stored history so multi-turn sessions are preserved.
    for (const msg of history) {
      if (typeof msg.content !== "string") {
        continue;
      }
      if (msg.role === "user") {
        parts.push(
          `<p><strong>问：</strong>${escapeHtml(stripSelectionEcho(msg.content))}</p>`,
        );
      } else if (msg.role === "assistant") {
        parts.push("<p><strong>答：</strong></p>");
        // Keep the raw Markdown so the answer stays editable in the note.
        parts.push(`<pre>${escapeHtml(msg.content)}</pre>`);
      }
    }

    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    note.parentID = item.id;
    note.setNote(parts.join("\n"));
    await note.saveTx();
    flash(btn, "已保存");
  } catch (e) {
    Zotero.logError(e as Error);
    flash(btn, "保存失败");
  }
}

/** The first user message embeds the selection; don't repeat it in the note. */
function stripSelectionEcho(content: string): string {
  const idx = content.lastIndexOf("问题：");
  return idx >= 0 ? content.slice(idx + 3).trim() : content;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function flash(btn: HTMLElement, text: string) {
  const original = btn.dataset.haLabel || btn.textContent || "";
  btn.dataset.haLabel = original;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function mkButton(doc: Document, label: string, title: string): HTMLElement {
  const btn = doc.createElement("button");
  btn.className = "ha-btn";
  btn.type = "button";
  btn.textContent = label;
  btn.title = title;
  return btn;
}

function positionPanel(
  panel: HTMLElement,
  reader: ReaderInstance,
  doc: Document,
) {
  const win = doc.defaultView || reader._iframeWindow;
  const viewportW = win?.innerWidth || 900;
  const viewportH = win?.innerHeight || 700;

  let left = viewportW - MAX_WIDTH - 24;
  let top = 72;

  // Prefer to sit near the selection, clamped into the viewport.
  try {
    const sel = reader._iframeWindow?.getSelection?.();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        left = Math.min(rect.left, viewportW - MAX_WIDTH - 16);
        top = rect.bottom + 12;
      }
    }
  } catch {
    /* fall back to the default position */
  }

  left = Math.max(12, left);
  top = Math.max(12, Math.min(top, viewportH - 240));

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function makeDraggable(doc: Document, panel: HTMLElement, handle: HTMLElement) {
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    originLeft = panel.offsetLeft;
    originTop = panel.offsetTop;
    handle.classList.add("ha-dragging");
    e.preventDefault();
  });

  doc.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) {
      return;
    }
    const win = doc.defaultView;
    const maxLeft = (win?.innerWidth || 9999) - 80;
    const maxTop = (win?.innerHeight || 9999) - 40;
    panel.style.left = `${Math.max(-40, Math.min(originLeft + (e.clientX - startX), maxLeft))}px`;
    panel.style.top = `${Math.max(0, Math.min(originTop + (e.clientY - startY), maxTop))}px`;
  });

  doc.addEventListener("mouseup", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove("ha-dragging");
  });
}

/** Injected once per reader document. */
function ensureStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  const host = doc.head || doc.documentElement;
  host?.appendChild(style);
}

const CSS = `
.${PANEL_CLASS} {
  position: absolute;
  z-index: 100000;
  width: ${MAX_WIDTH}px;
  max-width: calc(100vw - 24px);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #1f2329;
  border: 1px solid #d8dce3;
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, .3);
  font: 13px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}
.${PANEL_CLASS} * { box-sizing: border-box; }

.ha-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: #f7f8fa;
  border-bottom: 1px solid #e8ebf0;
  cursor: move;
  user-select: none;
  flex: 0 0 auto;
}
.ha-head.ha-dragging { cursor: grabbing; }
.ha-title { font-weight: 700; color: #2f6feb; font-size: 12px; letter-spacing: .3px; }
.ha-spacer { flex: 1; }

.ha-btn {
  border: 0;
  background: #eceff4;
  color: #374151;
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.ha-btn:hover { background: #dfe4ec; }
.ha-send { background: #2f6feb; color: #fff; padding: 6px 14px; }
.ha-send:hover { background: #245bd0; }
.ha-send.ha-stop { background: #d9534f; }
.ha-send.ha-stop:hover { background: #c9302c; }

.ha-quote {
  flex: 0 0 auto;
  max-height: 96px;
  overflow: auto;
  padding: 8px 12px;
  background: #fbfbfd;
  border-bottom: 1px solid #eef0f4;
}
.ha-quote-label {
  font-size: 11px;
  color: #8a93a0;
  margin-bottom: 2px;
  user-select: none;
}
.ha-quote-body {
  font-size: 12px;
  color: #5b6472;
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 3px solid #d5dbe5;
  padding-left: 8px;
}

.ha-convo {
  flex: 1 1 auto;
  overflow: auto;
  padding: 10px 12px;
  min-height: 72px;
}

.ha-bubble { margin-bottom: 10px; }
.ha-bubble.ha-user .ha-bubble-body {
  background: #eef3ff;
  border: 1px solid #dbe5ff;
  border-radius: 8px;
  padding: 6px 10px;
  color: #22315a;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
}
.ha-bubble.ha-assistant .ha-bubble-body { padding: 0 2px; }
.ha-bubble-body.ha-streaming { color: #8a93a0; }

.ha-error {
  background: #fff4f4;
  border: 1px solid #ffd9d9;
  color: #a12a2a;
  border-radius: 8px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 10px;
  font-size: 12.5px;
}

.ha-meta {
  font-size: 11px;
  color: #9aa3b0;
  margin: -6px 0 10px;
  user-select: none;
}

.ha-reasoning {
  background: #f8f9fb;
  border: 1px dashed #dde2ea;
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 10px;
  font-size: 12px;
  color: #6b7280;
}
.ha-reasoning > summary {
  cursor: pointer;
  color: #8a93a0;
  user-select: none;
  font-size: 11.5px;
}
.ha-reasoning-body {
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
}

.ha-input-row {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 8px 10px;
  border-top: 1px solid #eef0f4;
  background: #fcfcfd;
}
.ha-input {
  flex: 1;
  resize: none;
  border: 1px solid #dde2ea;
  border-radius: 8px;
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: #1f2329;
  outline: none;
  max-height: 120px;
  background: #fff;
}
.ha-input:focus { border-color: #2f6feb; }

/* ---- markdown ---- */
.ha-md p { margin: 0 0 8px; }
.ha-md p:last-child { margin-bottom: 0; }
.ha-md h3, .ha-md h4, .ha-md h5, .ha-md h6 {
  margin: 12px 0 6px;
  font-size: 13.5px;
  color: #111827;
}
.ha-md ul, .ha-md ol { margin: 0 0 8px; padding-left: 20px; }
.ha-md li { margin-bottom: 3px; }
.ha-md blockquote {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 3px solid #d5dbe5;
  color: #5b6472;
  background: #fafbfc;
}
.ha-md hr { border: 0; border-top: 1px solid #eef0f4; margin: 10px 0; }
.ha-md a { color: #2f6feb; text-decoration: none; }
.ha-md a:hover { text-decoration: underline; }
.ha-md strong { color: #111827; }

.ha-md-inline-code {
  background: #f2f4f8;
  border: 1px solid #e6eaf1;
  border-radius: 4px;
  padding: 0 4px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  color: #b1305a;
}

.ha-code {
  position: relative;
  background: #f7f8fa;
  border: 1px solid #e8ebf0;
  border-radius: 8px;
  padding: 8px 10px;
  margin: 0 0 8px;
  overflow: auto;
}
.ha-code pre { margin: 0; }
.ha-code code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  color: #24292f;
  white-space: pre;
}
.ha-code-lang {
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 10px;
  color: #a8b0bd;
  user-select: none;
}

/* Math is shown as LaTeX source in a monospace chip. */
.ha-math-inline {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12.2px;
  background: #f3f0fb;
  border: 1px solid #e4dcf7;
  border-radius: 4px;
  padding: 0 4px;
  color: #5b3fa8;
}
.ha-math-block {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12.2px;
  background: #f3f0fb;
  border: 1px solid #e4dcf7;
  border-radius: 8px;
  padding: 8px 10px;
  margin: 0 0 8px;
  color: #5b3fa8;
  white-space: pre-wrap;
  word-break: break-word;
  text-align: center;
  overflow-x: auto;
}
`;
