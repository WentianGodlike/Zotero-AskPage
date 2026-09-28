/**
 * Tiny Markdown → DOM renderer.
 *
 * Design notes:
 * - Everything is built with `createElement` + `textContent`; we never touch
 *   `innerHTML`, so model output can never inject markup or scripts.
 * - Math (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`) is protected *before*
 *   inline parsing, otherwise `$a*b*c$` or `x_i_j` would be mangled by the
 *   emphasis rules. This matters a lot for this plugin's use case.
 * - Model output is frequently *incomplete* while streaming (an unclosed code
 *   fence, a dangling `$`), so every rule must degrade gracefully.
 */

export interface RenderOptions {
  /** Applied to the root container. */
  className?: string;
  /**
   * Render math into the given container instead of showing the LaTeX source.
   * Returning false (or omitting this) falls back to a monospace chip, which
   * keeps formulas readable even when the math stylesheet is unavailable.
   */
  renderMath?: (container: HTMLElement, latex: string, display: boolean) => boolean;
}

const MATH_PLACEHOLDER_PREFIX = "\u0000MATH";

export function renderMarkdown(
  markdown: string,
  doc: Document,
  options: RenderOptions = {},
): HTMLElement {
  const root = doc.createElement("div");
  root.className = options.className || "ha-md";
  const renderMath = options.renderMath;

  const mathStore: string[] = [];
  const codeStore: { lang: string; code: string }[] = [];

  // ---- 1. Lift fenced code blocks out of the document -------------------
  const lines = String(markdown ?? "").split("\n");
  type Block =
    | { kind: "text"; lines: string[] }
    | { kind: "code"; index: number }
    | { kind: "math"; index: number };

  const blocks: Block[] = [];
  let pending: string[] = [];

  const flushText = () => {
    if (pending.length) {
      blocks.push({ kind: "text", lines: pending });
      pending = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushText();
      const marker = fence[1][0].repeat(3);
      const lang = fence[2] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // Unterminated fence while streaming: keep what we have.
      codeStore.push({ lang, code: body.join("\n") });
      blocks.push({ kind: "code", index: codeStore.length - 1 });
      continue;
    }

    // Display math on its own line: $$ ... $$ (possibly multi-line)
    const trimmed = line.trim();
    if (trimmed.startsWith("$$")) {
      const sameLineEnd = trimmed.length > 4 && trimmed.endsWith("$$");
      if (sameLineEnd) {
        flushText();
        mathStore.push(trimmed.slice(2, -2).trim());
        blocks.push({ kind: "math", index: mathStore.length - 1 });
        continue;
      }
      flushText();
      const body: string[] = [trimmed.slice(2)];
      let closed = false;
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.trim().endsWith("$$")) {
          body.push(cur.trim().slice(0, -2));
          closed = true;
          break;
        }
        body.push(cur);
        i++;
      }
      if (!closed) {
        // No closing delimiter yet (streaming) — just show the math.
        body.push("");
      }
      mathStore.push(body.join("\n").trim());
      blocks.push({ kind: "math", index: mathStore.length - 1 });
      continue;
    }

    pending.push(line);
  }
  flushText();

  // ---- 2. Render blocks -------------------------------------------------
  for (const block of blocks) {
    if (block.kind === "code") {
      const { lang, code } = codeStore[block.index];
      root.appendChild(buildCodeBlock(doc, lang, code));
      continue;
    }
    if (block.kind === "math") {
      const latex = mathStore[block.index];
      const el = doc.createElement("div");
      // The source stays in the class list so the CSS can style the fallback
      // state; a successful render replaces the text content below.
      el.className = "ha-math-block";
      if (!renderMath || !renderMath(el, latex, true)) {
        el.textContent = latex;
      }
      root.appendChild(el);
      continue;
    }
    renderTextBlock(doc, root, block.lines, mathStore, renderMath);
  }

  return root;
}

function buildCodeBlock(doc: Document, lang: string, code: string): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "ha-code";
  if (lang) {
    const label = doc.createElement("span");
    label.className = "ha-code-lang";
    label.textContent = lang;
    wrap.appendChild(label);
  }
  const pre = doc.createElement("pre");
  const codeEl = doc.createElement("code");
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrap.appendChild(pre);
  return wrap;
}

/** Render one run of non-fenced lines: headings, lists, quotes, paragraphs. */
function renderTextBlock(
  doc: Document,
  root: HTMLElement,
  lines: string[],
  mathStore: string[],
  renderMath?: RenderOptions["renderMath"],
): void {
  let list: HTMLElement | null = null;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (list) {
      root.appendChild(list);
      list = null;
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) {
      closeList();
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // h1 -> h3, keeps panel sane
      const el = doc.createElement(`h${level}`);
      appendInline(doc, el, heading[2], mathStore, renderMath);
      root.appendChild(el);
      continue;
    }

    // Horizontal rule: three or more of the same marker, nothing else.
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      root.appendChild(doc.createElement("hr"));
      continue;
    }

    // Blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      const el = doc.createElement("blockquote");
      appendInline(doc, el, quote[1], mathStore, renderMath);
      root.appendChild(el);
      continue;
    }

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        list = doc.createElement("ul");
        listType = "ul";
      }
      const li = doc.createElement("li");
      appendInline(doc, li, ul[1], mathStore, renderMath);
      list!.appendChild(li);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        list = doc.createElement("ol");
        listType = "ol";
      }
      const li = doc.createElement("li");
      appendInline(doc, li, ol[1], mathStore, renderMath);
      list!.appendChild(li);
      continue;
    }

    // Paragraph
    closeList();
    const p = doc.createElement("p");
    appendInline(doc, p, line, mathStore, renderMath);
    root.appendChild(p);
  }

  closeList();
}

/**
 * Parse inline markup into `parent`. Handles `code`, math, bold, italic,
 * strikethrough and bare links.
 */
function appendInline(
  doc: Document,
  parent: HTMLElement,
  text: string,
  mathStore: string[],
  renderMath?: RenderOptions["renderMath"],
): void {
  // Protect inline math first so emphasis rules cannot chew through it.
  const protectedText = text.replace(
    /(\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([^)]*\\\)|\\\[[^\]]*\\\])/g,
    (match) => {
      let inner = match;
      if (match.startsWith("$$") && match.endsWith("$$")) {
        inner = match.slice(2, -2);
      } else if (match.startsWith("$") && match.endsWith("$")) {
        inner = match.slice(1, -1);
      } else if (match.startsWith("\\(")) {
        inner = match.slice(2, -2);
      } else if (match.startsWith("\\[")) {
        inner = match.slice(2, -2);
      }
      mathStore.push(inner);
      return `${MATH_PLACEHOLDER_PREFIX}${mathStore.length - 1}\u0000`;
    },
  );

  // Tokenize: inline code, math placeholders, bold, italic, strike, links.
  const pattern =
    /(`+)([\s\S]*?)\1|(\u0000MATH(\d+)\u0000)|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)|~~([^~]+)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(protectedText)) !== null) {
    if (m.index > last) {
      parent.appendChild(doc.createTextNode(protectedText.slice(last, m.index)));
    }

    if (m[2] !== undefined && m[1]) {
      // inline code
      const code = doc.createElement("code");
      code.className = "ha-md-inline-code";
      code.textContent = m[2].trim();
      parent.appendChild(code);
    } else if (m[4] !== undefined) {
      // Math. Prefer the real renderer; fall back to showing the source.
      const latex = mathStore[Number(m[4])] ?? "";
      const el = doc.createElement("span");
      el.className = "ha-math-inline";
      if (!renderMath || !renderMath(el, latex, false)) {
        el.textContent = latex;
      }
      parent.appendChild(el);
    } else if (m[5] !== undefined) {
      parent.appendChild(wrapEmphasis(doc, m[5], "strong", "em"));
    } else if (m[6] !== undefined || m[7] !== undefined) {
      parent.appendChild(wrapEmphasis(doc, m[6] ?? m[7]!, "strong"));
    } else if (m[8] !== undefined || m[9] !== undefined) {
      parent.appendChild(wrapEmphasis(doc, m[8] ?? m[9]!, "em"));
    } else if (m[10] !== undefined) {
      parent.appendChild(wrapEmphasis(doc, m[10], "del"));
    } else if (m[11] !== undefined && m[12]) {
      const a = doc.createElement("a");
      a.href = m[12];
      a.textContent = m[11];
      a.target = "_blank";
      a.rel = "noreferrer";
      parent.appendChild(a);
    }

    last = pattern.lastIndex;
  }

  if (last < protectedText.length) {
    parent.appendChild(doc.createTextNode(protectedText.slice(last)));
  }
}

function wrapEmphasis(
  doc: Document,
  text: string,
  ...tags: string[]
): HTMLElement {
  let node: HTMLElement | null = null;
  let outermost: HTMLElement | null = null;
  for (const tag of tags) {
    const el = doc.createElement(tag);
    if (node) {
      node.appendChild(el);
    } else {
      outermost = el;
    }
    node = el;
  }
  node!.textContent = text;
  return outermost!;
}
