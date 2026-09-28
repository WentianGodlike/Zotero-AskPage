/**
 * Math rendering, backed by the real KaTeX.
 *
 * Earlier this file contained a hand-written LaTeX subset renderer. It covered
 * the notation in the first few papers that were tried, then silently dropped
 * `\tilde` and mangled norms — the failure mode of any partial TeX
 * implementation is a *wrong formula*, which is worse than no rendering at all
 * when the reader is trying to follow a derivation. KaTeX is therefore bundled
 * and used directly.
 *
 * Two things make that affordable:
 *
 *  - **No fonts are shipped.** Zotero already bundles KaTeX's fonts for its note
 *    editor (20 woff2 files under `resource://zotero/note-editor/assets/fonts`),
 *    so only the library and stylesheet are added.
 *  - **No `innerHTML`.** KaTeX's `renderToString` returns markup; the small
 *    parser below turns that into a node tree which the caller materialises with
 *    its own `document`. That keeps the project's zero-`innerHTML` rule and
 *    avoids relying on DOM globals that Zotero's plugin sandbox may not expose.
 */

import katex from "katex";

const FONT_STYLE_ID = "ha-katex-fonts";
const LAYOUT_STYLE_ID = "ha-katex-layout";

/* ------------------------------------------------------------------ */
/* Node tree                                                           */
/* ------------------------------------------------------------------ */

/** A declarative description of a rendered element. */
export interface MathNode {
  tag: string;
  attrs: Record<string, string>;
  children: MathNode[];
}

/** Marker tag used for text; the builder turns it into a text node. */
const TEXT_TAG = "#text";

/** Build real elements from a MathNode tree using the host's document. */
export function buildMathNodes(node: MathNode, doc: Document): Node {
  if (node.tag === TEXT_TAG) {
    return doc.createTextNode(node.attrs.value ?? "");
  }
  const el = doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    el.setAttribute(name, value);
  }
  for (const child of node.children) {
    el.appendChild(buildMathNodes(child, doc));
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Minimal HTML → node tree parser                                     */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decode the entities KaTeX emits. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[body] ?? match;
    },
  );
}

interface Token {
  kind: "open" | "close" | "text";
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
}

/** Tokenise the well-formed subset of HTML that KaTeX produces. */
function tokenise(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      tokens.push({ kind: "text", text: html.slice(i) });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: "text", text: html.slice(i, lt) });
    }

    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      // Unterminated tag: keep the remainder as text rather than losing it.
      tokens.push({ kind: "text", text: html.slice(lt) });
      break;
    }

    const inner = html.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith("/")) {
      tokens.push({ kind: "close", tag: inner.slice(1).trim().toLowerCase() });
      continue;
    }
    // Comments, doctypes and processing instructions carry no content here.
    if (inner.startsWith("!") || inner.startsWith("?")) {
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const tag = (space < 0 ? body : body.slice(0, space)).trim().toLowerCase();
    const attrText = space < 0 ? "" : body.slice(space);

    const attrs: Record<string, string> = {};
    const attrRe =
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }

    tokens.push({ kind: "open", tag, attrs });
    if (selfClosing || VOID_TAGS.has(tag)) {
      tokens.push({ kind: "close", tag });
    }
  }
  return tokens;
}

/**
 * Convert simple HTML into a node tree.
 *
 * Intentionally minimal: it exists because KaTeX returns a string and the
 * project does not parse model-influenced HTML into the page. Anything that is
 * not a plain element (comments, doctypes) is dropped, and malformed nesting is
 * repaired by closing the open element rather than throwing.
 */
export function parseHtmlToMathNodes(html: string): MathNode {
  const root: MathNode = { tag: "span", attrs: {}, children: [] };
  const stack: MathNode[] = [root];

  for (const token of tokenise(html)) {
    const top = stack[stack.length - 1];
    if (token.kind === "text") {
      const value = decodeEntities(token.text ?? "");
      if (value) {
        top.children.push({
          tag: TEXT_TAG,
          attrs: { value },
          children: [],
        });
      }
      continue;
    }
    if (token.kind === "open") {
      const node: MathNode = {
        tag: token.tag ?? "span",
        attrs: token.attrs ?? {},
        children: [],
      };
      top.children.push(node);
      stack.push(node);
      continue;
    }
    if (stack.length > 1) {
      stack.pop();
    }
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Reduce the stylesheet's `@font-face` rules to woff2 only.
 *
 * The fonts are shipped in the addon, so the relative `fonts/...` URLs resolve
 * against `katex.css` and need no rewriting. The woff and ttf fallbacks are
 * dropped because only woff2 is bundled — leaving them would produce 404s on
 * every formula.
 */
export function keepWoff2FontFaces(css: string, fontBase?: string): string {
  const out: string[] = [];
  for (const raw of css.split("}")) {
    const block = raw.trim();
    if (!block || !/^@font-face\b/i.test(block)) {
      continue;
    }

    // Drop the woff and ttf sources rather than keeping "the first entry":
    // publishers order the `src` list differently, and only woff2 is shipped,
    // so any other format is a guaranteed 404.
    let rule = block.replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)(\s*format\(\s*['"]?(?:woff|truetype)['"]?\s*\))?/gi,
      (match, _q, url: string, format?: string) => {
        const isWoff2 = /woff2/i.test(url) || /woff2/i.test(format ?? "");
        return isWoff2 ? match : "";
      },
    );

    if (fontBase) {
      // A relative URL inside an injected <style> resolves against the
      // *document* URL, not the stylesheet's location, so `../assets/fonts/x`
      // looked for the font beside the reader page and never found it. Missing
      // fonts are what make super/subscripts render cramped.
      rule = rule.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (_m, _q, url: string) =>
          `url(${
            /^(data:|https?:|resource:|chrome:|jar:)/i.test(url)
              ? url
              : fontBase + url.replace(/^(\.\.\/)*(assets\/)?(fonts\/)?/, "")
          })`,
      );
    }

    // Tidy the separators left behind by removed entries: a dangling comma is
    // harmless in CSS but made the generated rules look malformed in review.
    rule = rule
      .replace(/,\s*,/g, ",")
      .replace(/(src:\s*),/i, "$1")
      .replace(/,\s*$/, "")
      .replace(/\{\s*,/g, "{");

    out.push(rule + "}");
  }
  return out.join("\n");
}

/** Remove `@font-face` blocks, leaving the layout rules. */
export function stripFontFaces(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, "");
}

function hasStyle(doc: Document, id: string): boolean {
  try {
    return Boolean(doc.getElementById(id));
  } catch {
    return false;
  }
}

function addStyle(doc: Document, id: string, css: string): void {
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = css;
  (doc.head || doc.documentElement)?.appendChild(style);
}

let bundledCss: string | null = null;

/**
 * Read the stylesheet that was built into the addon.
 *
 * Emitted as a sibling file rather than embedded in the bundle so the font-face
 * rewriting can operate on plain text.
 */
async function loadBundledCss(rootURI: string): Promise<string> {
  if (bundledCss !== null) {
    return bundledCss;
  }
  try {
    const res = await fetch(`${rootURI}content/katex.css`);
    bundledCss = res.ok ? await res.text() : "";
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] KaTeX CSS unavailable: ${(e as Error)?.message || e}`,
    );
    bundledCss = "";
  }
  return bundledCss;
}

/**
 * Install KaTeX's stylesheet with fonts pointed at Zotero's copies.
 *
 * Returns false when the stylesheet could not be loaded; math still renders,
 * just without the fine positioning.
 */
export async function installKatexStyles(
  doc: Document,
  rootURI: string,
): Promise<boolean> {
  try {
    if (hasStyle(doc, LAYOUT_STYLE_ID)) {
      return true;
    }
    const css = await loadBundledCss(rootURI);
    if (!css.trim()) {
      return false;
    }
    // Fonts first, then layout. Both are needed: without the font faces KaTeX
    // falls back to a system serif and the maths glyphs render flat, which
    // looks like a broken formula rather than a missing font.
    // `rootURI` ends with a slash, so this yields
    // resource://<addon>/assets/fonts/KaTeX_Main-Regular.woff2
    const fontBase = `${rootURI.replace(/\/?$/, "/")}assets/fonts/`;
    addStyle(doc, FONT_STYLE_ID, keepWoff2FontFaces(css, fontBase));
    addStyle(doc, LAYOUT_STYLE_ID, stripFontFaces(css));
    return true;
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] KaTeX styles failed: ${(e as Error)?.message || e}`,
    );
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Options handed to KaTeX. Kept in one place so tests can assert them. */
export const KATEX_OPTIONS = {
  // Render the offending source in red instead of throwing: one malformed
  // fragment in a streamed answer must not blank the whole reply.
  throwOnError: false,
  errorColor: "#b45309",
  // The default, stated explicitly: blocks \htmlClass, \href and friends, which
  // is what makes it safe to accept model-generated input.
  trust: false,
  strict: false,
  output: "html",
} as const;

/** Render LaTeX to a node tree. Exported for tests. */
export function latexToNodes(latex: string, displayMode: boolean): MathNode {
  const html = katex.renderToString(String(latex ?? "").trim(), {
    ...KATEX_OPTIONS,
    displayMode,
  });
  return parseHtmlToMathNodes(html);
}

/** Render LaTeX into a container. Returns false when there was nothing to render. */
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
  container.setAttribute("data-latex", source);
  try {
    container.appendChild(buildMathNodes(latexToNodes(source, displayMode), doc));
    container.classList.add("ha-math-rendered");
    return true;
  } catch (e) {
    // Never lose a formula: fall back to the source text.
    Zotero.debug(`[Highlight Ask] KaTeX failed: ${(e as Error)?.message || e}`);
    container.textContent = source;
    container.classList.add("ha-math-rendered", "ha-math-failed");
    return true;
  }
}
