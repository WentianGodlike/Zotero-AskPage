import {
  streamChat,
  DeepSeekError,
  makeAbortController,
  canAbort,
  type ChatMessage,
} from "./deepseek";
import { buildFollowUpMessages, buildInitialMessages } from "./prompts";
import { renderMarkdown, type RenderOptions } from "./markdown";
import { installKatexStyles, renderMathInto } from "./katex";
import {
  captureGeometry,
  describeGeometry,
  locateSelection,
  renderPendingCapture,
  takePendingOutcome,
  takePendingCapture,
} from "./screenshot";
import { ensureDir, pluginRootDir } from "./storage";
import { getPref } from "../utils/prefs";
import { getPaperText, describePaperText, type PaperText } from "./fulltext";
import { buildContext, bundleSize, type ContextBundle } from "./context";
import {
  appendTurn,
  loadLatestSession,
  makeSessionId,
  persistSession,
  type Session,
} from "./notes";
import { logRequest } from "./requestLog";

/**
 * The conversation UI.
 *
 * Deliberately host-agnostic: it renders into whatever element it is given and
 * never assumes a floating panel. The reader sidebar is the primary host; a
 * floating panel reuses the exact same code, so the two can never drift.
 *
 * Everything the caller must supply is in `ChatViewOptions`; the view owns the
 * message list, streaming, context assembly and archiving from there.
 */

const STYLE_ID_PREFIX = "ha-chat-styles";

export interface ChatViewHooks {
  /** Called after each turn is archived, so the host can show a summary. */
  onTurnArchived?: (session: Session) => void;
  /** Called when the view wants a short status message shown. */
  onStatus?: (message: string, kind?: "info" | "error") => void;
}

export interface ChatViewOptions {
  /** Element the chat is rendered into. It is emptied first. */
  container: HTMLElement;
  /** Document owning `container`, for element creation and clipboard access. */
  doc: Document;
  /** The paper's Zotero item id. */
  itemID: number;
  /** Seed selection, e.g. from the reader's selection popup. */
  selection?: string;
  /** Seed question; when present the first request fires immediately. */
  question?: string;
  /** Rather than sending, prefill the input with `question`. */
  manual?: boolean;
  hooks?: ChatViewHooks;
}

export interface ChatView {
  /** Ask a new question (used by the reader selection popup). */
  ask(selection: string, question: string): void;
  /** Put a question in the input box without sending it. */
  prefill(question: string): void;
  /** Re-run the most recent question (after a failure). */
  retry(): void;
  /** Tear down: aborts any in-flight request and clears the container. */
  destroy(): void;
  /** True when a request is currently streaming. */
  readonly busy: boolean;
}

export function createChatView(options: ChatViewOptions): ChatView {
  const { container, doc, itemID, hooks } = options;
  let seedSelection = (options.selection || "").trim();
  let seedQuestion = options.question || "";

  ensureStyles(doc);
  container.replaceChildren();

  /* ---------------------------------------------------------------- */
  /* DOM                                                               */
  /* ---------------------------------------------------------------- */

  const root = doc.createElement("div");
  root.className = "ha-chat";

  const head = doc.createElement("div");
  head.className = "ha-chat-head";

  const title = doc.createElement("span");
  title.className = "ha-chat-title";
  title.textContent = "Highlight Ask";

  const spacer = doc.createElement("span");
  spacer.className = "ha-chat-spacer";

  const fullTextBtn = mkButton(doc, "全文", "把论文全文一起发给模型（更准，但更贵）");
  fullTextBtn.classList.add("ha-chat-toggle");
  let wantFullText = Boolean(getPref("sendFullText"));

  const copyBtn = mkButton(doc, "复制", "复制最近的回答");
  const clearBtn = mkButton(doc, "清空", "开始一段新对话（已存档的内容不受影响）");
  // Development aid: crop the current selection and save it, so the geometry
  // can be checked by eye before wiring screenshots into the ask flow.
  const shotBtn = mkButton(doc, "截图预览", "把当前选中区域裁成 PNG 存到数据目录");
  shotBtn.classList.add("ha-chat-ghost");
  shotBtn.hidden = !getPref("debugScreenshot");

  head.append(title, spacer, fullTextBtn, shotBtn, copyBtn, clearBtn);

  const contextLine = doc.createElement("div");
  contextLine.className = "ha-chat-context";

  // Selection preview: only shown once something is selected, so the empty
  // state is not dominated by an empty box.
  const quoteLabel = doc.createElement("div");
  quoteLabel.className = "ha-chat-quote-label";
  quoteLabel.textContent = "选中内容";
  const quoteBody = doc.createElement("div");
  quoteBody.className = "ha-chat-quote-body";
  const quote = doc.createElement("div");
  quote.className = "ha-chat-quote";
  quote.append(quoteLabel, quoteBody);
  quote.hidden = true;

  const convo = doc.createElement("div");
  convo.className = "ha-chat-convo";

  // Inline feedback for actions with no visible result (capture, save).
  const hint = doc.createElement("div");
  hint.className = "ha-chat-hint";
  hint.hidden = true;

  const empty = doc.createElement("div");
  empty.className = "ha-chat-empty";
  empty.append(
    textBlock(doc, "在 PDF 里划选一段文字，然后点「解释这段」等按钮。"),
    textBlock(doc, "也可以直接在下面输入问题。"),
  );
  convo.appendChild(empty);

  const input = doc.createElement("textarea");
  input.className = "ha-chat-input";
  input.rows = 2;
  input.placeholder = "问点什么…（Enter 发送，Shift+Enter 换行）";

  const sendBtn = mkButton(doc, "发送", "发送");
  sendBtn.classList.add("ha-chat-send");

  const inputRow = doc.createElement("div");
  inputRow.className = "ha-chat-input-row";
  inputRow.append(input, sendBtn);

  root.append(head, quote, contextLine, convo, hint, inputRow);
  container.appendChild(root);

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  let history: ChatMessage[] = [];
  let abort: AbortController | null = null;
  let busy = false;
  let destroyed = false;
  let lastAnswer = "";
  /** Everything needed to re-issue the last request. */
  let lastQuestion: { text: string; echo: string; messages: ChatMessage[] } | null =
    null;

  let paperText: PaperText | null = null;
  let paperTextResolved = false;

  /**
   * The window that holds the page canvas and the selection.
   *
   * The panel renders inside the reader's own document in the sidebar case, so
   * `doc.defaultView` already is that window; a floating host would differ.
   */
  function readerWindowRef(): Window | null {
    try {
      return doc.defaultView;
    } catch {
      return null;
    }
  }

  const session: Session = {
    id: makeSessionId(itemID),
    itemID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
  };

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function scrollToBottom() {
    convo.scrollTop = convo.scrollHeight;
  }

  /**
   * Math renderer passed to the Markdown pipeline.
   *
   * Returns false when there is nothing to render, which makes the pipeline
   * fall back to showing the LaTeX source rather than an empty box.
   */
  const renderMath: NonNullable<RenderOptions["renderMath"]> = (
    container,
    latex,
    display,
  ) => {
    container.classList.toggle("ha-math-display", display);
    return renderMathInto(doc, container, latex, display);
  };

  /** Markdown options used everywhere in this view. */
  const mdOptions: RenderOptions = { renderMath };

  function removeEmptyState() {
    empty.remove();
  }

  function appendBubble(role: "user" | "assistant", text: string) {
    removeEmptyState();
    const wrap = doc.createElement("div");
    wrap.className = `ha-chat-bubble ha-chat-${role}`;
    const body = doc.createElement("div");
    body.className = "ha-chat-bubble-body";
    if (role === "user") {
      body.textContent = text;
    }
    wrap.appendChild(body);
    convo.appendChild(wrap);
    scrollToBottom();
    return { wrap, body };
  }

  function appendError(message: string, canRetry: boolean) {
    removeEmptyState();
    const box = doc.createElement("div");
    box.className = "ha-chat-error";
    box.textContent = message;
    if (canRetry) {
      const retryBtn = mkButton(doc, "重试", "用同样的问题再试一次");
      retryBtn.classList.add("ha-chat-retry");
      retryBtn.addEventListener("click", () => {
        box.remove();
        retry();
      });
      box.appendChild(retryBtn);
    }
    convo.appendChild(box);
    scrollToBottom();
  }

  function setBusy(next: boolean) {
    busy = next;
    // Only advertise "stop" when the environment can actually abort.
    const stoppable = next && canAbort();
    sendBtn.textContent = next ? (stoppable ? "停止" : "生成中…") : "发送";
    sendBtn.title = stoppable ? "停止生成" : next ? "正在生成" : "发送";
    sendBtn.classList.toggle("ha-chat-stop", stoppable);
    input.disabled = next;
  }

  function setQuote(text: string) {
    const value = (text || "").trim();
    quoteBody.textContent = value;
    quote.hidden = !value;
  }

  function paintFullTextBtn() {
    fullTextBtn.classList.toggle("ha-chat-on", wantFullText);
    fullTextBtn.title = wantFullText
      ? "已附带全文，点击关闭"
      : "把论文全文一起发给模型（更准，但更贵）";
  }

  function paintContextLine() {
    const bits = ["选中片段"];
    if (getPref("sendNearby") && paperText?.text) {
      bits.push("相邻段落");
    }
    if (getPref("sendAnnotations")) {
      bits.push("我的标注/笔记");
    }
    if (wantFullText) {
      bits.push(`全文（${describePaperText(paperText)}）`);
    }
    contextLine.textContent = `上下文：${bits.join(" + ")}`;
    // Warn when the full text was cut: the reader should know that the middle
    // of the document is not being sent.
    contextLine.classList.toggle(
      "ha-chat-warn",
      wantFullText && (!paperText?.chars || paperText.truncated),
    );
    if (wantFullText && paperText?.truncated) {
      contextLine.textContent += "（中间部分已截断）";
    }
    // Show the size, because the gap between "selection" and "whole book" is a
    // factor of ~50 in cost and only the reader can judge if it is worth it.
    if (lastContext) {
      const { tokens } = bundleSize(lastContext);
      if (tokens > 0) {
        contextLine.textContent += ` · 约 ${tokens.toLocaleString()} tokens`;
      }
    }
  }

  function providerKey(): string {
    try {
      return String(getPref("provider") || "deepseek");
    } catch {
      return "deepseek";
    }
  }

  function modelName(): string {
    try {
      return String(getPref("model") || "");
    } catch {
      return "";
    }
  }

  function usedFullTextChars(): number {
    return wantFullText && paperText ? paperText.chars : 0;
  }

  /** Latest assembled context, for the status line and for asking. */
  let lastContext: ContextBundle | null = null;

  /**
   * Assemble what to send.
   *
   * Async because annotations and notes live in the library. Kept separate from
   * the ask path so the status line can be accurate about what was included.
   */
  async function assembleContext(): Promise<{
    nearby?: string;
    fullText?: string;
    annotations?: string;
    notes?: string[];
    supportingInfo?: Array<{ name: string; text: string }>;
    title?: string;
  }> {
    const bundle = await buildContext({
      itemID,
      selection: seedSelection,
      fullText: wantFullText,
      paperText,
    });
    lastContext = bundle;
    paintContextLine();
    return {
      nearby: bundle.nearby,
      fullText: bundle.fullText,
      annotations: bundle.annotations.length
        ? formatAnnotationsForPrompt(bundle)
        : undefined,
      notes: bundle.notes.length ? bundle.notes : undefined,
      supportingInfo: bundle.supportingInfo.length
        ? bundle.supportingInfo.map((d) => ({ name: d.name, text: d.text }))
        : undefined,
      title: session.title,
    };
  }

  /** Render the annotation list for the prompt. */
  function formatAnnotationsForPrompt(bundle: ContextBundle): string {
    // Imported lazily to keep the module graph flat.
    return bundle.annotations
      .slice(0, 40)
      .map((a) => {
        const page = a.page ? `（第 ${a.page} 页）` : "";
        const bits: string[] = [];
        if (a.text) bits.push(`高亮：${a.text}`);
        if (a.comment) bits.push(`批注：${a.comment}`);
        return `- ${page}${bits.join(" / ")}`;
      })
      .join("\n");
  }

  /* ---------------------------------------------------------------- */
  /* Paper text and prior conversation                                 */
  /* ---------------------------------------------------------------- */

  async function loadPaperText() {
    if (paperTextResolved) {
      return;
    }
    paperTextResolved = true;
    try {
      paperText = await getPaperText(itemID);
      try {
        const item = await Zotero.Items.getAsync(itemID);
        session.title = item?.getField?.("title") || undefined;
      } catch {
        /* the title is optional grounding */
      }
    } catch (e) {
      Zotero.debug(
        `[Highlight Ask] paper text unavailable: ${(e as Error)?.message || e}`,
      );
    }
    paintContextLine();
  }

  /**
   * Restore the most recent archived conversation for this paper.
   *
   * Reading the JSON mirror rather than parsing note HTML keeps this simple and
   * avoids re-deriving structure from markup.
   */
  async function loadPreviousSession() {
    try {
      const previous = await loadLatestSession(itemID);
      if (!previous || !previous.turns.length) {
        return;
      }
      session.noteItemID = previous.noteItemID;
      session.title ||= previous.title;

      for (const turn of previous.turns) {
        if (turn.question) {
          appendBubble("user", turn.question);
        }
        if (turn.answer) {
          const { body } = appendBubble("assistant", "");
          body.replaceChildren(renderMarkdown(turn.answer, doc, mdOptions));
          const meta = doc.createElement("div");
          meta.className = "ha-chat-meta";
          meta.textContent = turn.model ? `${turn.model}` : "";
          if (meta.textContent) {
            body.parentElement!.appendChild(meta);
          }
        }
        // Rebuild model context so follow-ups stay coherent.
        history.push({ role: "user", content: turn.question });
        history.push({ role: "assistant", content: turn.answer });
      }

      lastAnswer =
        previous.turns[previous.turns.length - 1]?.answer || lastAnswer;
      seedSelection =
        previous.turns[previous.turns.length - 1]?.selection || seedSelection;
      setQuote(seedSelection);

      const notice = doc.createElement("div");
      notice.className = "ha-chat-restored";
      notice.textContent = `已载入 ${previous.turns.length} 轮历史对话`;
      convo.insertBefore(notice, convo.firstChild);
      scrollToBottom();
    } catch (e) {
      Zotero.debug(
        `[Highlight Ask] could not restore history: ${(e as Error)?.message || e}`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Asking                                                            */
  /* ---------------------------------------------------------------- */

  async function ask(
    messages: ChatMessage[],
    echoQuestion: string,
    record?: { text: string },
  ) {
    if (busy || destroyed) {
      return;
    }
    if (echoQuestion) {
      appendBubble("user", echoQuestion);
    }

    const { wrap: answerWrap, body: answerBody } = appendBubble("assistant", "");
    answerBody.classList.add("ha-chat-streaming");
    answerBody.textContent = "思考中…";

    const showReasoning = Boolean(getPref("showReasoning"));
    let reasoningBox: HTMLDetailsElement | null = null;
    let reasoningText = "";

    const renderReasoning = (text: string) => {
      reasoningText = text;
      if (!showReasoning || !text) {
        return;
      }
      if (!reasoningBox) {
        const pre = doc.createElement("div");
        pre.className = "ha-chat-reasoning-body";
        const summary = doc.createElement("summary");
        summary.textContent = "推理过程";
        reasoningBox = doc.createElement("details");
        reasoningBox.className = "ha-chat-reasoning";
        reasoningBox.open = true;
        reasoningBox.append(summary, pre);
        answerWrap.insertBefore(reasoningBox, answerBody);
      }
      reasoningBox.querySelector(".ha-chat-reasoning-body")!.textContent = text;
      scrollToBottom();
    };

    // Zotero's plugin sandbox has no AbortController. Without one the request
    // still runs; only cancellation is unavailable.
    const abortHandle = makeAbortController();
    abort = abortHandle?.controller ?? null;
    setBusy(true);

    const startedAt = Date.now();
    let firstTokenMs: number | undefined;

    try {
      const result = await streamChat({
        messages,
        signal: abortHandle?.signal,
        onDelta: (full) => {
          firstTokenMs ??= Date.now() - startedAt;
          answerBody.classList.remove("ha-chat-streaming");
          answerBody.replaceChildren(renderMarkdown(full, doc, mdOptions));
          scrollToBottom();
        },
        onReasoning: renderReasoning,
      });

      lastAnswer = result.content;
      history = [...messages, { role: "assistant", content: result.content }];
      lastQuestion = null;

      if (result.usage) {
        const meta = doc.createElement("div");
        meta.className = "ha-chat-meta";
        meta.textContent = `${result.usage.total_tokens} tokens`;
        answerWrap.appendChild(meta);
      }

      void archiveTurn({
        question: record?.text || echoQuestion,
        answer: result.content,
        reasoning: reasoningText || undefined,
        selection: seedSelection,
        tokens: result.usage?.total_tokens,
      });

      void logRequest({
        ts: new Date().toISOString(),
        sessionId: session.id,
        itemID,
        provider: providerKey(),
        model: modelName(),
        firstTokenMs,
        totalMs: Date.now() - startedAt,
        promptTokens: result.usage?.prompt_tokens,
        completionTokens: result.usage?.completion_tokens,
        totalTokens: result.usage?.total_tokens,
        selectionChars: seedSelection.length,
        questionChars: (record?.text || echoQuestion).length,
        fullTextChars: usedFullTextChars(),
        hasReasoning: Boolean(reasoningText),
      });
    } catch (e) {
      const err = e as DeepSeekError;
      if (err?.kind === "aborted") {
        answerBody.classList.remove("ha-chat-streaming");
        answerBody.textContent = lastAnswer || "（已停止）";
      } else {
        answerWrap.remove();
        // Keep the failed request so the retry button can re-issue it.
        lastQuestion = record
          ? { text: record.text, echo: echoQuestion, messages }
          : null;
        appendError(err?.message || String(e), Boolean(err?.retryable));
      }

      void logRequest({
        ts: new Date().toISOString(),
        sessionId: session.id,
        itemID,
        provider: providerKey(),
        model: modelName(),
        firstTokenMs,
        totalMs: Date.now() - startedAt,
        selectionChars: seedSelection.length,
        questionChars: (record?.text || echoQuestion).length,
        fullTextChars: usedFullTextChars(),
        error: err?.message || String(e),
        errorKind: err?.kind,
      });
    } finally {
      abort = null;
      setBusy(false);
      if (!destroyed) {
        input.focus();
      }
    }
  }

  async function archiveTurn(turn: {
    question: string;
    answer: string;
    reasoning?: string;
    selection: string;
    tokens?: number;
  }) {
    try {
      const updated = appendTurn(session, {
        ...turn,
        ts: new Date().toISOString(),
        model: modelName(),
      });
      session.turns = updated.turns;
      session.updatedAt = updated.updatedAt;
      await persistSession(session);
      hooks?.onTurnArchived?.(session);
    } catch (e) {
      Zotero.debug(
        `[Highlight Ask] archiving failed: ${(e as Error)?.message || e}`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public actions                                                    */
  /* ---------------------------------------------------------------- */

  function submit() {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    resizeInput();

    if (history.length === 0) {
      void assembleContext().then((ctx) => {
        const messages = buildInitialMessages(seedSelection, text, ctx);
        history = messages;
        void ask(messages, text, { text });
      });
    } else {
      const messages = buildFollowUpMessages(history, text);
      history = messages;
      void ask(messages, text, { text });
    }
  }

  function retry() {
    if (busy || !lastQuestion) {
      return;
    }
    const pending = lastQuestion;
    lastQuestion = null;
    void ask(pending.messages, pending.echo, { text: pending.text });
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function destroy() {
    destroyed = true;
    abort?.abort();
    abort = null;
    container.replaceChildren();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  fullTextBtn.addEventListener("click", () => {
    wantFullText = !wantFullText;
    paintFullTextBtn();
    paintContextLine();
    if (wantFullText && !paperText?.chars) {
      void loadPaperText();
    }
  });

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

  clearBtn.addEventListener("click", () => {
    // Archiving is already done per turn, so this only resets the view.
    history = [];
    lastAnswer = "";
    lastQuestion = null;
    convo.replaceChildren(empty);
    convo.appendChild(empty);
    session.turns = [];
    session.id = makeSessionId(itemID);
    session.noteItemID = undefined;
    hooks?.onStatus?.("已开始新对话");
  });

  shotBtn.addEventListener("click", () => {
    void (async () => {
      // Preferred source: geometry resolved while the selection was still live,
      // i.e. when the reader's selection popup rendered. Clicking into the
      // sidebar clears the PDF selection, so a live lookup here finds nothing —
      // which is exactly why the first attempts failed.
      // The stash is the whole story: it either holds a resolved region or the
      // reason one could not be resolved.
      const outcome = takePendingOutcome();
      if (outcome) {
        if (!outcome.ok) {
          showHint(
            `截图失败于「${labelForStep(outcome.step)}」这一步。${outcome.detail}`,
          );
          flash(shotBtn, "截不到");
          return;
        }
        const shot = renderPendingCapture(outcome);
        if (!shot) {
          showHint(`几何已解析，但裁剪失败。${outcome.detail}`);
          flash(shotBtn, "裁剪失败");
          return;
        }
        const path = await saveShot(shot.dataUrl);
        flash(shotBtn, `${shot.width}×${shot.height}`);
        showHint(
          `已保存 ${shot.width}×${shot.height} 到：${path ?? "（未能写盘）"}\n${outcome.detail}`,
          path ? "ok" : "warn",
        );
        return;
      }

      // Fallback for a selection made without the popup appearing.
      const located = locateSelection(readerWindowRef());
      const report = describeGeometry(located.selection);
      Zotero.debug(
        `[Highlight Ask] capture geometry: ${report.text} (via ${located.source})`,
      );
      if (!report.ok) {
        showHint(
          `截图失败：没有缓存几何，也没有找到${labelForMissing(report.missing)}。` +
            `${report.text}（选区来源：${located.source}）\n` +
            "请先用鼠标划选文字（等划线弹窗出现），再点截图预览。",
        );
        flash(shotBtn, "截不到");
        return;
      }
      const geometry = captureGeometry(located.selection);
      if (!geometry.ok) {
        showHint(
          `没有缓存几何，实时解析也失败于「${labelForStep(geometry.step)}」。` +
            `${geometry.detail}（选区来源：${located.source}）`,
        );
        flash(shotBtn, "定位失败");
        return;
      }
      const shot = renderPendingCapture(geometry);
      if (!shot) {
        showHint(`找到选区但裁剪失败。${report.text}`);
        flash(shotBtn, "裁剪失败");
        return;
      }
      const path = await saveShot(shot.dataUrl);
      flash(shotBtn, `${shot.width}×${shot.height}`);
      showHint(`已保存 ${shot.width}×${shot.height} 到：${path ?? "（未能写盘）"}`, "ok");
    })();
  });

  /** Write a captured PNG into the data directory and return its path. */
  async function saveShot(dataUrl: string): Promise<string | null> {
    try {
      const dir = `${pluginRootDir()}/debug`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = `${dir}/capture-${stamp}.png`;
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      await ensureDir(dir);
      await IOUtils.write(file, bytes);
      Zotero.debug(`[Highlight Ask] capture saved: ${file}`);
      return file;
    } catch (e) {
      Zotero.logError(
        new Error(
          `[Highlight Ask] could not save capture: ${(e as Error)?.message || e}`,
        ),
      );
      return null;
    }
  }


  /** Name the geometry step that failed, in the user's terms. */
  function labelForStep(step: string): string {
    switch (step) {
      case "selection":
        return "读取选区";
      case "textLayer":
        return "查找文字层";
      case "canvas":
        return "查找页面画布";
      case "layerBox":
        return "测量文字层";
      case "rects":
        return "测量选区矩形";
      case "clamp":
        return "裁剪范围";
      default:
        return step;
    }
  }

  /** Explain which lookup failed, in the user's terms. */
  function labelForMissing(kind: string | undefined): string {
    switch (kind) {
      case "selection":
        return "选中内容";
      case "textLayer":
        return "页面的文字层（textLayer）";
      case "canvas":
        return "页面的画布（canvasWrapper）";
      case "rects":
        return "可用的选区矩形";
      default:
        return "所需元素";
    }
  }

  /** Show a short, dismissible note above the input. */
  function showHint(message: string, kind: "info" | "ok" | "warn" = "warn") {
    hint.textContent = message;
    hint.className = `ha-chat-hint ha-chat-hint-${kind}`;
    hint.hidden = false;
  }

  input.addEventListener("input", resizeInput);
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
      if (!abort) {
        flash(sendBtn, "无法中断");
        return;
      }
      abort.abort();
      return;
    }
    submit();
  });

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  paintFullTextBtn();
  paintContextLine();
  setQuote(seedSelection);
  // Fetch Zotero's KaTeX stylesheet once; until it lands, math still renders
  // (with the fallback chip styling) rather than breaking.
  void installKatexStyles(doc, rootURI);
  void loadPaperText().then(() => loadPreviousSession());

  if (options.manual && seedQuestion) {
    input.value = seedQuestion;
    input.focus();
  } else if (seedQuestion) {
    void assembleContext().then((ctx) => {
      const messages = buildInitialMessages(seedSelection, seedQuestion, ctx);
      history = messages;
      void ask(messages, seedQuestion, { text: seedQuestion });
    });
  }

  return {
    ask(selection: string, question: string) {
      seedSelection = (selection || "").trim();
      setQuote(seedSelection);
      if (history.length) {
        const messages = buildFollowUpMessages(
          history,
          `${question}\n\n（新选中的片段：\n"""\n${seedSelection}\n"""\n）`,
        );
        history = messages;
        void ask(messages, question, { text: question });
        return;
      }
      // First question of this session: assemble the full context first.
      void assembleContext().then((ctx) => {
        const messages = buildInitialMessages(seedSelection, question, ctx);
        history = messages;
        void ask(messages, question, { text: question });
      });
    },
    prefill(question: string) {
      input.value = question;
      input.focus();
    },
    retry,
    destroy,
    get busy() {
      return busy;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function textBlock(doc: Document, text: string): HTMLElement {
  const p = doc.createElement("p");
  p.textContent = text;
  return p;
}

function mkButton(doc: Document, label: string, title: string): HTMLElement {
  const btn = doc.createElement("button");
  btn.className = "ha-chat-btn";
  btn.type = "button";
  btn.textContent = label;
  btn.title = title;
  return btn;
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
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Injected once per document. Class names are prefixed `ha-chat-` so the
 * sidebar and a floating panel can coexist without collisions.
 */
export function ensureStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID_PREFIX)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID_PREFIX;
  style.textContent = CSS;
  (doc.head || doc.documentElement)?.appendChild(style);
}

const CSS = `
.ha-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--fill-primary, #1f2329);
  font: 13px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.ha-chat * { box-sizing: border-box; }

.ha-chat-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--fill-quinary, #e8ebf0);
}
.ha-chat-title { font-weight: 700; font-size: 12px; color: #2f6feb; }
.ha-chat-spacer { flex: 1; }

.ha-chat-btn {
  border: 0;
  background: var(--fill-quinary, #eceff4);
  color: var(--fill-secondary, #374151);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.ha-chat-btn:hover { background: var(--fill-quaternary, #dfe4ec); }
/* Development-only button (截图预览): visually secondary. */
.ha-chat-btn.ha-chat-ghost {
  background: transparent;
  border: 1px dashed var(--fill-quaternary, #c9d0da);
  color: var(--fill-secondary, #6b7280);
  font-size: 11px;
}
.ha-chat-btn.ha-chat-ghost:hover { background: var(--fill-quinary, #eef0f4); }
.ha-chat-toggle.ha-chat-on { background: #2f6feb; color: #fff; }
.ha-chat-send {
  background: #2f6feb;
  color: #fff;
  padding: 6px 14px;
  font-size: 12.5px;
}
.ha-chat-send:hover { background: #245bd0; }
.ha-chat-send.ha-chat-stop { background: #d9534f; }

.ha-chat-quote {
  flex: 0 0 auto;
  max-height: 88px;
  overflow: auto;
  padding: 6px 10px;
  border-bottom: 1px solid var(--fill-quinary, #eef0f4);
}
.ha-chat-quote-label { font-size: 11px; color: #8a93a0; margin-bottom: 2px; }
.ha-chat-quote-body {
  font-size: 12px;
  color: var(--fill-secondary, #5b6472);
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 3px solid #d5dbe5;
  padding-left: 8px;
}

.ha-chat-context {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 11px;
  color: #8a93a0;
  border-bottom: 1px solid var(--fill-quinary, #eef0f4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ha-chat-context.ha-chat-warn { color: #b45309; }

.ha-chat-convo {
  flex: 1 1 auto;
  overflow: auto;
  padding: 10px;
  min-height: 80px;
}

.ha-chat-empty { color: #9aa3b0; font-size: 12px; }
.ha-chat-empty p { margin: 0 0 8px; }

.ha-chat-restored {
  font-size: 11px;
  color: #9aa3b0;
  text-align: center;
  margin-bottom: 10px;
}

.ha-chat-bubble { margin-bottom: 10px; }
.ha-chat-user .ha-chat-bubble-body {
  background: var(--fill-quinary, #eef3ff);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--fill-primary, #22315a);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
}
.ha-chat-assistant .ha-chat-bubble-body { padding: 0 2px; }
.ha-chat-bubble-body.ha-chat-streaming { color: #8a93a0; }

.ha-chat-error {
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
.ha-chat-retry { margin-top: 8px; }

.ha-chat-meta { font-size: 11px; color: #9aa3b0; margin: -6px 0 10px; }

/* Inline feedback for actions that otherwise produce no visible result. */
.ha-chat-hint {
  flex: 0 0 auto;
  padding: 6px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-all;
  border-top: 1px solid var(--fill-quinary, #eef0f4);
  background: var(--fill-quinary, #fbfbfd);
  color: #8a5a00;
}
.ha-chat-hint-ok { color: #15803d; }
.ha-chat-hint-info { color: #6b7280; }

.ha-chat-reasoning {
  background: var(--fill-quinary, #f8f9fb);
  border: 1px dashed #dde2ea;
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 10px;
  font-size: 12px;
  color: #6b7280;
}
.ha-chat-reasoning > summary { cursor: pointer; font-size: 11.5px; user-select: none; }
.ha-chat-reasoning-body {
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 6px;
  max-height: 200px;
  overflow: auto;
}

.ha-chat-input-row {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
  align-items: flex-end;
  padding: 8px;
  border-top: 1px solid var(--fill-quinary, #eef0f4);
}
.ha-chat-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--fill-quaternary, #dde2ea);
  border-radius: 8px;
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  outline: none;
  max-height: 160px;
  background: var(--material-background, #fff);
  color: inherit;
}
.ha-chat-input:focus { border-color: #2f6feb; }

/* ---- markdown ---- */
.ha-chat .ha-md p { margin: 0 0 8px; }
.ha-chat .ha-md p:last-child { margin-bottom: 0; }
.ha-chat .ha-md h3, .ha-chat .ha-md h4,
.ha-chat .ha-md h5, .ha-chat .ha-md h6 { margin: 12px 0 6px; font-size: 13.5px; }
.ha-chat .ha-md ul, .ha-chat .ha-md ol { margin: 0 0 8px; padding-left: 20px; }
.ha-chat .ha-md li { margin-bottom: 3px; }
.ha-chat .ha-md blockquote {
  margin: 0 0 8px;
  padding: 4px 10px;
  border-left: 3px solid #d5dbe5;
  color: var(--fill-secondary, #5b6472);
}
.ha-chat .ha-md hr { border: 0; border-top: 1px solid #eef0f4; margin: 10px 0; }
.ha-chat .ha-md a { color: #2f6feb; text-decoration: none; }
.ha-chat .ha-md strong { font-weight: 700; }

.ha-chat .ha-md-inline-code {
  background: #f2f4f8;
  border-radius: 4px;
  padding: 0 4px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  color: #b1305a;
}
.ha-chat .ha-code {
  position: relative;
  background: var(--fill-quinary, #f7f8fa);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 0 0 8px;
  overflow: auto;
}
.ha-chat .ha-code pre { margin: 0; }
.ha-chat .ha-code code {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  white-space: pre;
}
.ha-chat .ha-code-lang { position: absolute; top: 4px; right: 8px; font-size: 10px; color: #a8b0bd; }

/* ---- math: our own layout classes on top of Zotero's KaTeX CSS ---- */
.ha-chat .katex { font-size: 1.06em; }
.ha-chat .mfrac {
  display: inline-flex;
  flex-direction: column;
  vertical-align: middle;
  text-align: center;
  margin: 0 .18em;
}
.ha-chat .mfrac-num {
  border-bottom: 1px solid currentColor;
  padding: 0 .25em .05em;
}
.ha-chat .mfrac-den { padding: .05em .25em 0; }
.ha-chat .msqrt { white-space: nowrap; }
.ha-chat .msqrt-inner {
  border-top: 1px solid currentColor;
  padding: 0 .18em;
  margin-left: .08em;
}
/* Accents: the combining mark rides on the base character; KaTeX's own
   .accent/.accent-body rules from Zotero's stylesheet do the fine positioning. */
.ha-chat .accent { position: relative; display: inline-block; }
.ha-chat .accent-body { display: inline-block; }
.ha-chat .mop { font-style: normal; padding: 0 .12em; }

.ha-chat .mtext { font-style: normal; }
/* Inline math keeps a light chip so it stands out from prose. */
.ha-chat .ha-math-inline.ha-math-rendered {
  background: none;
  border: 0;
  padding: 0;
  font-family: inherit;
  color: inherit;
}
/* Display math gets breathing room. */
.ha-chat .ha-math-display { display: block; text-align: center; }
.ha-chat .ha-math-block.ha-math-rendered {
  background: none;
  border: 0;
  color: inherit;
  font-family: inherit;
}

.ha-chat .ha-math-inline {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12.2px;
  background: #f3f0fb;
  border-radius: 4px;
  padding: 0 4px;
  color: #5b3fa8;
}
.ha-chat .ha-math-block {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12.2px;
  background: #f3f0fb;
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
