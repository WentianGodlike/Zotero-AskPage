/**
 * KaTeX integration.
 *
 * Zotero ships KaTeX (plus its fonts) for the note editor, but does not expose
 * a global `katex` object, so the renderer itself has to come from somewhere
 * else. We reuse Zotero's own CSS and fonts — that guarantees the glyphs match
 * the rest of the app, adds nothing to the bundle, and avoids shipping a second
 * copy of ~1 MB of fonts.
 *
 * Two pieces:
 *
 *  1. A tiny LaTeX→HTML renderer covering the notation that actually shows up
 *     in papers (fractions, sub/superscripts, roots, Greek, operators, sums and
 *     integrals). Not a TeX engine — it degrades to showing the LaTeX source
 *     rather than showing something wrong.
 *
 *  2. `extractKatexCss()`, which pulls just the KaTeX rules out of Zotero's
 *     `editor.css` and rewrites the relative font URLs to absolute ones. That
 *     file also contains ProseMirror and note-editor styling, which must NOT
 *     leak into the reader panel.
 */

const NOTE_EDITOR_BASE = "resource://zotero/note-editor/";

/* ------------------------------------------------------------------ */
/* CSS extraction (pure; unit tested)                                  */
/* ------------------------------------------------------------------ */

/**
 * Keep only the rules that belong to KaTeX, and make font URLs absolute.
 *
 * Zotero's editor.css declares fonts as `url(assets/fonts/KaTeX_*.woff2)`,
 * relative to the stylesheet. Once injected into a reader document those paths
 * resolve against the document instead, so they are rewritten here.
 */
export function extractKatexCss(css: string, fontBase = NOTE_EDITOR_BASE): string {
  const out: string[] = [];

  // Walk top-level rules. A naive split on "}" is fine for this stylesheet:
  // it contains no nested at-rules other than @font-face, and no "}" inside
  // strings.
  const blocks = css.split("}");

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) {
      continue;
    }

    const isFontFace = /^@font-face\b/i.test(block);
    const mentionsKatex = /katex/i.test(block);

    if (isFontFace) {
      // Fonts are only useful for KaTeX glyphs. The stylesheet names them all
      // "KaTeX_*", so filter on the URL too in case the family name differs.
      if (!mentionsKatex && !/KaTeX_/.test(block)) {
        continue;
      }
      out.push(
        block.replace(
          /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
          (_m, _q, url: string) =>
            `url(${/^(data:|https?:|resource:|chrome:|jar:)/i.test(url)
              ? url
              : fontBase + url.replace(/^\.?\//, "")})`,
        ) + "}",
      );
      continue;
    }

    // Everything the renderer needs is namespaced under .katex.
    if (mentionsKatex) {
      out.push(`${block}}`);
    }
  }

  return out.join("\n");
}

/** Inject the KaTeX stylesheet into a document, once. */
export function ensureKatexStyles(doc: Document, css: string): void {
  const id = "ha-katex-styles";
  if (doc.getElementById(id)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = css;
  (doc.head || doc.documentElement)?.appendChild(style);
}

/**
 * Fetch and install Zotero's KaTeX CSS.
 * Returns false when the stylesheet could not be loaded, in which case math
 * falls back to showing its LaTeX source.
 */
export async function installKatexStyles(doc: Document): Promise<boolean> {
  try {
    if (doc.getElementById("ha-katex-styles")) {
      return true;
    }
    const res = await fetch(`${NOTE_EDITOR_BASE}editor.css`);
    if (!res.ok) {
      Zotero.debug(`[Highlight Ask] editor.css fetch failed: HTTP ${res.status}`);
      return false;
    }
    const css = extractKatexCss(await res.text());
    if (!css.trim()) {
      Zotero.debug("[Highlight Ask] no KaTeX rules found in editor.css");
      return false;
    }
    ensureKatexStyles(doc, css);
    return true;
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] KaTeX styles unavailable: ${(e as Error)?.message || e}`,
    );
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* LaTeX vocabulary                                                    */
/* ------------------------------------------------------------------ */

const GREEK: Record<string, string> = {
  alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4",
  epsilon: "\u03b5", varepsilon: "\u03b5", zeta: "\u03b6", eta: "\u03b7",
  theta: "\u03b8", vartheta: "\u03d1", iota: "\u03b9", kappa: "\u03ba",
  lambda: "\u03bb", mu: "\u03bc", nu: "\u03bd", xi: "\u03be",
  pi: "\u03c0", rho: "\u03c1", sigma: "\u03c3", tau: "\u03c4",
  upsilon: "\u03c5", phi: "\u03c6", varphi: "\u03c6", chi: "\u03c7",
  psi: "\u03c8", omega: "\u03c9", Gamma: "\u0393", Delta: "\u0394",
  Theta: "\u0398", Lambda: "\u039b", Xi: "\u039e", Pi: "\u03a0",
  Sigma: "\u03a3", Upsilon: "\u03a5", Phi: "\u03a6", Psi: "\u03a8",
  Omega: "\u03a9",
};

const OPERATORS: Record<string, string> = {
  times: "\u00d7", div: "\u00f7", pm: "\u00b1", mp: "\u2213",
  cdot: "\u00b7", ast: "\u2217", leq: "\u2264", le: "\u2264",
  geq: "\u2265", ge: "\u2265", neq: "\u2260", ne: "\u2260",
  approx: "\u2248", equiv: "\u2261", propto: "\u221d", in: "\u2208",
  notin: "\u2209", subset: "\u2282", subseteq: "\u2286",
  supset: "\u2283", supseteq: "\u2287", cup: "\u222a", cap: "\u2229",
  emptyset: "\u2205", infty: "\u221e", partial: "\u2202",
  nabla: "\u2207", forall: "\u2200", exists: "\u2203",
  rightarrow: "\u2192", to: "\u2192", leftarrow: "\u2190",
  leftrightarrow: "\u2194", Rightarrow: "\u21d2", Leftarrow: "\u21d0",
  Leftrightarrow: "\u21d4", mapsto: "\u21a6", ldots: "\u2026",
  cdots: "\u22ef", dots: "\u2026", angle: "\u2220", perp: "\u22a5",
  parallel: "\u2225", sim: "\u223c", simeq: "\u2243", ll: "\u226a",
  gg: "\u226b", prime: "\u2032", circ: "\u2218",
  // Norm and delimiter characters. `\|` and `\Vert` are how a norm or a
  // double bar is written; without these the backslash swallowed the bar and
  // `\|\nabla L\|` came out looking like a letter.
  "|": "\u2016", Vert: "\u2016", vert: "|", lVert: "\u2016",
  rVert: "\u2016", lvert: "|", rvert: "|",
  langle: "\u27e8", rangle: "\u27e9", lceil: "\u2308", rceil: "\u2309",
  lfloor: "\u230a", rfloor: "\u230b", backslash: "\\",
};

/**
 * Accents.
 *
 * `char` is a combining mark placed after the base character; `body` is used
 * with KaTeX's own `.accent` / `.accent-body` classes, which is how KaTeX
 * positions marks over wide bases. Both are emitted: the class-based version
 * handles alignment, and the combining mark keeps the text copyable and
 * readable if a font lacks the positioning rule.
 */
const ACCENTS: Record<string, { char: string; wide?: boolean }> = {
  tilde: { char: "\u0303", wide: true },
  widetilde: { char: "\u0303", wide: true },
  hat: { char: "\u0302" },
  widehat: { char: "\u0302", wide: true },
  bar: { char: "\u0304" },
  vec: { char: "\u20d7" },
  dot: { char: "\u0307" },
  ddot: { char: "\u0308" },
  acute: { char: "\u0301" },
  grave: { char: "\u0300" },
  check: { char: "\u030c" },
  breve: { char: "\u0306" },
};

/**
 * Mathematical alphanumeric alphabets.
 *
 * The Unicode "Mathematical Alphanumeric Symbols" block is NOT a contiguous
 * range per alphabet: blackboard bold letters such as ℂ, ℍ, ℕ, ℙ, ℚ, ℝ, ℤ live
 * in the Letterlike Symbols block, and the script/fraktur uppercase sets have
 * holes. Computing an offset from a base therefore produces wrong glyphs —
 * `\mathbb{R}` came out as 𝕉. Alphabets with holes are listed explicitly.
 */
const BB_UPPER = "𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ";
const CAL_UPPER = "𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵";
const FRAK_UPPER = "𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨ";

/** Command names handled by `toAlphabet`. */
const ALPHABET_COMMANDS = new Set([
  "mathbb", "mathcal", "mathfrak", "mathbf", "mathit", "mathsf", "mathtt",
]);

/**
 * Split into code points up front.
 *
 * Blackboard-bold and script letters live above U+FFFF, so a string index
 * returns half a surrogate pair — `upperMap[17]` yielded "\ud835" rather than
 * a character. `Array.from` iterates by code point instead.
 */
const BB_UPPER_CP = Array.from(BB_UPPER);
const CAL_UPPER_CP = Array.from(CAL_UPPER);
const FRAK_UPPER_CP = Array.from(FRAK_UPPER);

function mapAscii(text: string, upperTable: string[], lowerBase: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      const idx = code - 65;
      // Prefer the explicit table; fall back to a computed code point.
      out += upperTable.length
        ? upperTable[idx]
        : String.fromCodePoint(lowerBase - 32 + idx);
    } else if (code >= 97 && code <= 122) {
      out += String.fromCodePoint(lowerBase + (code - 97));
    } else {
      out += ch;
    }
  }
  return out;
}

function toAlphabet(text: string, kind: string): string {
  switch (kind) {
    case "mathbb":
      return mapAscii(text, BB_UPPER_CP, 0x1d552);
    case "mathcal":
      return mapAscii(text, CAL_UPPER_CP, 0x1d4b6);
    case "mathfrak":
      return mapAscii(text, FRAK_UPPER_CP, 0x1d51e);
    case "mathbf":
      return mapAscii(text, [], 0x1d41a);
    case "mathit":
      return mapAscii(text, [], 0x1d44e);
    case "mathsf":
      return mapAscii(text, [], 0x1d5ba);
    case "mathtt":
      return mapAscii(text, [], 0x1d68a);
    default:
      return text;
  }
}

const BIG_OPERATORS = new Set([
  "sum", "prod", "int", "iint", "oint", "bigcup", "bigcap", "lim", "max", "min",
]);

const FUNCTIONS = new Set([
  "sin", "cos", "tan", "log", "ln", "exp", "arg", "det", "dim", "ker", "deg",
  "gcd", "hom", "sup", "inf", "lim", "max", "min", "Pr", "tr", "diag",
]);

const SUP: Record<string, string> = {
  "0": "\u2070", "1": "\u00b9", "2": "\u00b2", "3": "\u00b3", "4": "\u2074",
  "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079",
  "+": "\u207a", "-": "\u207b", "=": "\u207c", "(": "\u207d", ")": "\u207e",
  n: "\u207f", i: "\u2071",
};

const SUB: Record<string, string> = {
  "0": "\u2080", "1": "\u2081", "2": "\u2082", "3": "\u2083", "4": "\u2084",
  "5": "\u2085", "6": "\u2086", "7": "\u2087", "8": "\u2088", "9": "\u2089",
  "+": "\u208a", "-": "\u208b", "=": "\u208c", "(": "\u208d", ")": "\u208e",
  a: "\u2090", e: "\u2091", i: "\u1d62", j: "\u2c7c", k: "\u2096",
  n: "\u2099", o: "\u2092", p: "\u209a", r: "\u1d63", s: "\u209b",
  t: "\u209c", u: "\u1d64", v: "\u1d65", x: "\u2093",
};

/** Consume a `{...}` group, honouring nesting. */
function takeGroup(src: string, start: number): { text: string; next: number } {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { text: src.slice(start + 1, i), next: i + 1 };
      }
    }
  }
  return { text: src.slice(start + 1), next: src.length };
}

/** Consume a single argument: a braced group, a command, or one character. */
function takeArg(src: string, start: number): { text: string; next: number } {
  let i = start;
  while (i < src.length && src[i] === " ") {
    i++;
  }
  if (src[i] === "{") {
    return takeGroup(src, i);
  }
  if (src[i] === "\\") {
    const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
    return { text: m ? m[0] : src[i], next: i + (m ? m[0].length : 1) };
  }
  return { text: src[i] ?? "", next: i + 1 };
}

/* ------------------------------------------------------------------ */
/* Rendering to a node tree                                            */
/* ------------------------------------------------------------------ */

/**
 * A declarative description of rendered math.
 *
 * Returning data rather than an HTML string keeps the zero-`innerHTML` rule
 * intact and means the renderer needs no DOM globals (Zotero's plugin sandbox
 * does not guarantee `Element`, so `instanceof` checks would be unsafe).
 */
export type MathNode =
  | string
  | {
      tag: string;
      className?: string;
      style?: string;
      children?: MathNode[];
    };

/** Build real elements from a MathNode tree using the host's document. */
export function buildMathNodes(
  node: MathNode,
  doc: Document,
): Node {
  if (typeof node === "string") {
    return doc.createTextNode(node);
  }
  const el = doc.createElement(node.tag);
  if (node.className) {
    el.className = node.className;
  }
  if (node.style) {
    el.setAttribute("style", node.style);
  }
  for (const child of node.children ?? []) {
    el.appendChild(buildMathNodes(child, doc));
  }
  return el;
}

/** Wrap rendered math the way KaTeX's stylesheet expects. */
export function mathTree(latex: string, displayMode = false): MathNode {
  const body = parseLatex(String(latex ?? ""));
  return displayMode
    ? {
        tag: "span",
        className: "katex-display",
        children: [{ tag: "span", className: "katex", children: [body] }],
      }
    : { tag: "span", className: "katex", children: [body] };
}

/**
 * Render math into a container. Returns false when there was nothing to render,
 * so the caller can fall back to showing the LaTeX source.
 *
 * `data-latex` is set so the original source stays copyable.
 */
export function renderMathInto(
  doc: Document,
  container: HTMLElement,
  latex: string,
  displayMode: boolean,
): boolean {
  const source = String(latex ?? "").trim();
  if (!source) {
    return false;
  }
  try {
    container.setAttribute("data-latex", source);
    container.appendChild(buildMathNodes(mathTree(source, displayMode), doc));
    // Marks the success path so the stylesheet can drop the monospace chip
    // styling without relying on :has(), which older Gecko does not support.
    container.classList.add("ha-math-rendered");
    return true;
  } catch (e) {
    Zotero.debug(`[Highlight Ask] math render failed: ${(e as Error)?.message || e}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* LaTeX subset parser                                                 */
/* ------------------------------------------------------------------ */

function text(value: string): MathNode {
  return value;
}

function span(className: string, children: MathNode[]): MathNode {
  return { tag: "span", className, children };
}

function styled(style: string, children: MathNode[]): MathNode {
  return { tag: "span", style, children };
}

/** Parse a LaTeX fragment into a node tree. */
function parseLatex(src: string): MathNode {
  const nodes: MathNode[] = [];
  let plain = "";

  const flush = () => {
    if (plain) {
      nodes.push(text(plain));
      plain = "";
    }
  };

  for (let i = 0; i < src.length; ) {
    const ch = src[i];

    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (!m) {
        plain += ch;
        i++;
        continue;
      }
      const name = m[1];
      i += m[0].length;

      if (GREEK[name]) {
        flush();
        nodes.push(text(GREEK[name]));
        continue;
      }
      if (OPERATORS[name]) {
        flush();
        nodes.push(text(OPERATORS[name]));
        continue;
      }
      if (BIG_OPERATORS.has(name)) {
        flush();
        const sym =
          name === "sum" ? "\u2211" : name === "prod" ? "\u220f" :
          name === "int" ? "\u222b" : name === "iint" ? "\u222c" :
          name === "oint" ? "\u222e" : name === "bigcup" ? "\u22c3" :
          name === "bigcap" ? "\u22c2" : name;
        const children: MathNode[] = [text(sym)];
        // Optional limits, e.g. \sum_{i=1}^{n}
        for (let k = 0; k < 2; k++) {
          const rest = src.slice(i).replace(/^\s+/, "");
          const marker = rest[0];
          if (marker !== "_" && marker !== "^") {
            break;
          }
          const offset = i + (src.slice(i).length - rest.length);
          const arg = takeArg(src, offset + 1);
          children.push(
            scriptNode(marker === "^" ? "sup" : "sub", arg.text),
          );
          i = arg.next;
        }
        nodes.push(span("mop", children));
        continue;
      }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        flush();
        const num = takeArg(src, i);
        const den = takeArg(src, num.next);
        i = den.next;
        nodes.push(
          span("mfrac", [
            span("mfrac-num", [parseLatex(num.text)]),
            span("mfrac-den", [parseLatex(den.text)]),
          ]),
        );
        continue;
      }
      if (name === "sqrt") {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(span("msqrt", [text("\u221a"), span("msqrt-inner", [parseLatex(arg.text)])]));
        continue;
      }
      if (ACCENTS[name]) {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(accentNode(name, arg.text));
        continue;
      }
      if (ALPHABET_COMMANDS.has(name)) {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(text(toAlphabet(arg.text, name)));
        continue;
      }
      if (name === "overline" || name === "underline") {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(
          styled(
            name === "overline"
              ? "border-top:1px solid currentColor;padding-top:.08em"
              : "border-bottom:1px solid currentColor;padding-bottom:.08em",
            [parseLatex(arg.text)],
          ),
        );
        continue;
      }
      if (name === "text" || name === "mathrm" || name === "operatorname") {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(span("mtext", [text(arg.text)]));
        continue;
      }
      if (name === "mathbf" || name === "boldsymbol" || name === "bm") {
        flush();
        const arg = takeArg(src, i);
        i = arg.next;
        nodes.push(styled("font-weight:700", [parseLatex(arg.text)]));
        continue;
      }
      if (name === "left" || name === "right") {
        // Size modifiers are irrelevant here; emit the delimiter itself.
        flush();
        const delim = src[i];
        if (delim) {
          i++;
          if (delim !== ".") {
            nodes.push(text(delim));
          }
        }
        continue;
      }
      if (FUNCTIONS.has(name)) {
        flush();
        nodes.push(span("mop", [text(name)]));
        continue;
      }
      if ([" ", ",", ";", "quad", "qquad"].includes(name)) {
        flush();
        nodes.push(text(" "));
        continue;
      }
      // Unknown command: keep it visible instead of silently dropping it.
      flush();
      nodes.push(text(m[0]));
      continue;
    }

    if (ch === "{") {
      const group = takeGroup(src, i);
      flush();
      nodes.push(parseLatex(group.text));
      i = group.next;
      continue;
    }

    if (ch === "^" || ch === "_") {
      flush();
      const arg = takeArg(src, i + 1);
      nodes.push(scriptNode(ch === "^" ? "sup" : "sub", arg.text));
      i = arg.next;
      continue;
    }

    if (ch === "}" || ch === "$") {
      // Stray delimiters: the caller already stripped the matching pairs.
      i++;
      continue;
    }

    plain += ch;
    i++;
  }

  flush();
  return nodes.length === 1 ? nodes[0] : { tag: "span", children: nodes };
}

/**
 * Build an accented expression.
 *
 * Emits KaTeX's `.accent` / `.accent-body` structure so the mark is positioned
 * by the stylesheet, and includes the combining character so the text stays
 * copyable and degrades sensibly.
 */
function accentNode(name: string, arg: string): MathNode {
  const spec = ACCENTS[name];
  const base = parseLatex(arg);
  const mark = spec.char;
  return span("accent", [
    span("accent-body", [base, text(mark)]),
  ]);
}

/** A sub/superscript: Unicode when every character has a form, else CSS. */
function scriptNode(kind: "sup" | "sub", arg: string): MathNode {
  const table = kind === "sup" ? SUP : SUB;
  const plainArg = arg.replace(/\s/g, "");
  if (plainArg && [...plainArg].every((c) => table[c])) {
    return text([...plainArg].map((c) => table[c]).join(""));
  }
  return styled(
    `font-size:.72em;${kind === "sup" ? "vertical-align:super" : "vertical-align:sub"}`,
    [parseLatex(arg)],
  );
}
