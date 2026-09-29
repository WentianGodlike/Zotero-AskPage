// @ts-nocheck
/**
 * Local behaviour checks for the pure logic modules.
 *
 * Run with: npm run test:local
 *
 * These modules only need a DOM, which `linkedom`... is not available, so we
 * exercise the text-level logic and the markdown *tokenizer* behaviour that
 * does not require a real document. Anything that needs `Document` is covered
 * by inspecting the generated DOM via a tiny stub below.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// `parseThinkingParams` logs through Zotero when the JSON is malformed; stub the
// global so the import works outside Zotero.
// The stub also carries what `storage.ts` needs for path resolution: a data
// directory and a readable preference store. Defined before the module imports
// below, which capture `Zotero` when they are first evaluated.
(globalThis as any).__prefs = {};
(globalThis as any).Zotero = {
  debug: () => {},
  DataDirectory: { dir: "/data" },
  Prefs: { get: (key: string) => (globalThis as any).__prefs?.[key] },
};

import {
  normalizeSelection,
  matchActionsToButtons,
} from "../src/modules/readerPopup";
import { buildInitialMessages, buildFollowUpMessages } from "../src/modules/prompts";
import {
  buildEndpoint,
  DeepSeekError,
  parseThinkingParams,
  canAbort,
  makeAbortController,
} from "../src/modules/deepseek";
import {
  renderMarkdown,
  looksLikeFencedMath,
  stripMathDelimiters,
} from "../src/modules/markdown";
import { HIGHLIGHT_ASK_PROVIDERS } from "../src/data/providers.data";
import { validateSettings, getProvider } from "../src/modules/providers";
import { matchesItem } from "../src/modules/sidebar";
import { screenshotDir } from "../src/modules/storage";
import {
  chunkText,
  tokenize,
  rankChunks,
  locatePassage,
  formatRetrieved,
} from "../src/modules/retrieval";
import {
  findAnySelection,
  scaleRectToCanvas,
  expandForFormula,
  clampRect,
  isUsableRect,
  unionRects,
  dataUrlBytes,
  looksLikeFormulaSelection,
  planTiles,
  effectiveTileScale,
  estimateImageTokens,
  TILE_PIXEL_BUDGET,
  MAX_IMAGE_DIMENSION,
} from "../src/modules/screenshot";
import {
  htmlToText,
  formatAnnotations,
  looksLikeSupportingFilename,
  declaresItselfSupportingInfo,
  isSupportingInfo,
  bundleSize,
} from "../src/modules/context";
import {
  decodeEntities,
  parseHtmlToMathNodes,
  keepWoff2FontFaces,
  stripFontFaces,
  latexToNodes,
  buildMathNodes,
  type MathNode,
} from "../src/modules/katex";
import {
  buildSystemPrompt,
  buildUserMessage,
  trimFullText,
  extractNearby,
  DEFAULT_SCENARIO_PROMPT,
  DEFAULT_TRANSLATE_TASK,
  QUICK_ACTIONS,
  resolveTaskPrompt,
} from "../src/modules/prompts";
import {
  appendTurn,
  makeSessionId,
  sessionChars,
  renderSessionHtml,
  pickSessionFiles,
  type Session,
  type SessionTurn,
} from "../src/modules/notes";
import registerPreferencesPaneTests from "./preferencesPane.test";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

/** Register a check. `fn` may return a Promise; the runner awaits it. */
function test(name, fn) {
  const run = () => {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        return result.then(
          () => {
            passed++;
            console.log(`  ✓ ${name}`);
          },
          (e) => {
            failed++;
            console.log(`  ✗ ${name}`);
            console.log(`      ${(e && e.message) || e}`);
          },
        );
      }
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`      ${(e && e.message) || e}`);
    }
    return Promise.resolve();
  };
  pending.push(run());
}

/** Minimal session fixtures for the notes tests. */
function makeSession(itemID: number): Session {
  const now = "2026-01-01T00:00:00.000Z";
  return { id: "s1", itemID, createdAt: now, updatedAt: now, turns: [] };
}

function makeTurn(
  question: string,
  answer: string,
  extra: Partial<SessionTurn> = {},
): SessionTurn {
  return {
    question,
    answer,
    selection: "sel",
    ts: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

// NOTE_HEADING is not exported; keep the literal in sync with notes.ts.
const NOTE_HEADING = "AskPage 会话";
// The previous heading must still be recognised, or every conversation
// archived before the rename becomes unreachable.
const LEGACY_NOTE_HEADING = "Highlight Ask 会话";

/* ---------------------------------------------------------------- */
/* A minimal DOM good enough for renderMarkdown                      */
/* ---------------------------------------------------------------- */

class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attrs = {};
    this._text = "";
    this.className = "";
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length) {
      return this.children.map((c) => c.textContent).join("");
    }
    return this._text;
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const n of nodes) {
      this.children.push(n);
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    for (const n of nodes) {
      this.children.push(n);
    }
  }
  /** Flatten to a comparable string with tag markers. */
  serialize() {
    const kids = this.children.map((c) => c.serialize()).join("");
    const cls = this.className ? `.${this.className}` : "";
    if (this.tagName === "#TEXT") {
      return this._text;
    }
    return `<${this.tagName.toLowerCase()}${cls}>${kids || this._text}</${this.tagName.toLowerCase()}>`;
  }
}

const doc = {
  createElement(tag) {
    return new El(tag, doc);
  },
  createTextNode(text) {
    const t = new El("#text", doc);
    t._text = String(text);
    return t;
  },
};

const render = (md) => renderMarkdown(md, doc).serialize();

/* ---------------------------------------------------------------- */

console.log("\nnormalizeSelection");
test("joins hard-wrapped lines into one paragraph", () => {
  const out = normalizeSelection("the quick brown\nfox jumps over\nthe lazy dog");
  assert.equal(out, "the quick brown fox jumps over the lazy dog");
});

test("keeps blank lines as paragraph separators", () => {
  const out = normalizeSelection("first para\n\nsecond para");
  assert.equal(out, "first para\n\nsecond para");
});

test("rejoins hyphenated line breaks", () => {
  assert.equal(normalizeSelection("hyphen-\nation"), "hyphenation");
});

test("does not join a hyphen before a capital", () => {
  assert.equal(normalizeSelection("well-\nKnown"), "well- Known");
});

test("strips LaTeX latexit base64 blobs (arXiv case)", () => {
  const b64 = "A".repeat(400);
  const raw = `before <latexit sha1_base64="${b64}">abc</latexit> after`;
  const out = normalizeSelection(raw);
  assert.ok(!out.includes("A".repeat(120)), "long base64 run should be gone");
  assert.ok(out.includes("before"), "surrounding text kept");
  assert.ok(out.includes("after"), "surrounding text kept");
});

test("strips invisible zero-width characters", () => {
  const out = normalizeSelection("a\u200Bb\u200Ec\uFEFFd");
  assert.equal(out, "abcd");
});

test("collapses runs of spaces", () => {
  assert.equal(normalizeSelection("a     b"), "a b");
});

test("handles empty input", () => {
  assert.equal(normalizeSelection(""), "");
  assert.equal(normalizeSelection("   \n  \n "), "");
});

console.log("\nprompts");
test("initial messages carry the selection and question", () => {
  const msgs = buildInitialMessages("E = mc^2", "这段什么意思");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.ok(msgs[0].content.includes("LaTeX"));
  assert.ok(msgs[1].content.includes("E = mc^2"));
  assert.ok(msgs[1].content.includes("这段什么意思"));
});

test("follow-up appends to history without mutating it", () => {
  const history = buildInitialMessages("x", "q");
  const next = buildFollowUpMessages(history, "再解释一下");
  assert.equal(history.length, 2, "original history untouched");
  assert.equal(next.length, 3);
  assert.equal(next[2].content, "再解释一下");
});

console.log("\nbuildEndpoint");
test("appends the path to a bare base url", () => {
  assert.equal(
    buildEndpoint("https://api.deepseek.com", "/chat/completions"),
    "https://api.deepseek.com/chat/completions",
  );
});
test("does not double the slash for trailing-slash urls", () => {
  assert.equal(
    buildEndpoint("https://api.deepseek.com/", "/chat/completions"),
    "https://api.deepseek.com/chat/completions",
  );
});
test("keeps a /v1 prefix intact", () => {
  assert.equal(
    buildEndpoint("https://api.deepseek.com/v1", "/chat/completions"),
    "https://api.deepseek.com/v1/chat/completions",
  );
});
test("throws a helpful error when unset", () => {
  assert.throws(() => buildEndpoint("", "/chat/completions"), DeepSeekError);
});

console.log("\nrenderMarkdown");
test("renders a paragraph", () => {
  assert.equal(render("hello world"), "<div.ha-md><p>hello world</p></div>");
});

test("renders bold and italic without leaking markers", () => {
  const out = render("**bold** and *italic*");
  assert.ok(out.includes("<strong>bold</strong>"), out);
  assert.ok(out.includes("<em>italic</em>"), out);
});

test("renders headings shifted down so the panel stays readable", () => {
  assert.ok(render("# Title").includes("<h3>Title</h3>"));
  assert.ok(render("### Deep").includes("<h5>Deep</h5>"));
});

test("renders unordered and ordered lists", () => {
  const ul = render("- one\n- two");
  assert.ok(ul.includes("<ul>") && ul.includes("<li>one</li>"), ul);
  const ol = render("1. first\n2. second");
  assert.ok(ol.includes("<ol>") && ol.includes("<li>first</li>"), ol);
});

test("renders a fenced code block with its language", () => {
  const out = render("```python\nx = 1\n```");
  assert.ok(out.includes("<pre>"), out);
  assert.ok(out.includes("x = 1"), out);
  assert.ok(out.includes("python"), out);
});

test("protects inline math from emphasis rules", () => {
  // The underscores and asterisks inside $...$ must survive untouched.
  const out = render("value $a_i * b_j$ here");
  assert.ok(out.includes("a_i * b_j"), out);
  assert.ok(!out.includes("<em>"), `math was mangled: ${out}`);
});

test("renders display math as its own block", () => {
  const out = render("$$\\frac{a}{b}$$");
  assert.ok(out.includes("\\frac{a}{b}"), out);
});

test("keeps a multi-line display math block together", () => {
  const out = render("$$\nE = mc^2\n$$");
  assert.ok(out.includes("E = mc^2"), out);
});

test("marks inline code distinctly", () => {
  const out = render("use `getPref()` here");
  assert.ok(out.includes("ha-md-inline-code"), out);
  assert.ok(out.includes("getPref()"), out);
});

test("treats model-supplied markup as text, not elements", () => {
  // NOTE: this stub's serializer does not HTML-escape text, so it cannot prove
  // escaping. What it *can* prove is that the renderer never *parses* the
  // model's markup into element nodes. Escaping itself is provided by the real
  // DOM's textContent setter, which is inherently safe.
  const root = renderMarkdown('<script>alert("x")</script>', doc);
  const tags = [];
  const walk = (node) => {
    if (node.tagName !== "#TEXT") {
      tags.push(node.tagName);
    }
    for (const child of node.children || []) {
      walk(child);
    }
  };
  walk(root);
  assert.ok(!tags.includes("SCRIPT"), `script became an element: ${tags.join(",")}`);
  assert.deepEqual(tags, ["DIV", "P"], `unexpected element tree: ${tags.join(",")}`);
});

test("survives an unterminated code fence while streaming", () => {
  const out = render("text\n```js\nlet x = 1");
  assert.ok(out.includes("let x = 1"), out);
});

test("survives a dangling math delimiter while streaming", () => {
  const out = render("the value $x + y");
  assert.ok(out.includes("$x + y") || out.includes("x + y"), out);
});

test("handles empty input", () => {
  assert.equal(render(""), "<div.ha-md></div>");
});

/* ---------------------------------------------------------------- */

console.log("\nparseThinkingParams");
test("parses a plain object", () => {
  assert.deepEqual(parseThinkingParams('{"reasoning_effort":"high"}'), {
    reasoning_effort: "high",
  });
});

test("returns no extras for empty or whitespace input", () => {
  assert.deepEqual(parseThinkingParams(""), {});
  assert.deepEqual(parseThinkingParams("   \n "), {});
});

test("degrades to no extras on malformed JSON", () => {
  // A typo in the settings pane must never break asking a question.
  assert.deepEqual(parseThinkingParams("{oops"), {});
  assert.deepEqual(parseThinkingParams('{"a":}'), {});
});

test("rejects JSON that is not an object", () => {
  assert.deepEqual(parseThinkingParams("[1,2,3]"), {});
  assert.deepEqual(parseThinkingParams('"just a string"'), {});
  assert.deepEqual(parseThinkingParams("42"), {});
});

test("keeps nested values intact", () => {
  const out = parseThinkingParams('{"thinking":{"type":"enabled"},"top_p":0.95}');
  assert.deepEqual(out, { thinking: { type: "enabled" }, top_p: 0.95 });
});

/* ---------------------------------------------------------------- */

console.log("\nprovider catalogue");
test("every provider has the required shape", () => {
  assert.ok(HIGHLIGHT_ASK_PROVIDERS.length > 0);
  for (const p of HIGHLIGHT_ASK_PROVIDERS) {
    assert.ok(p.key, `provider missing key: ${JSON.stringify(p)}`);
    assert.ok(p.label, `provider ${p.key} missing label`);
    assert.equal(typeof p.requiresKey, "boolean", `${p.key} requiresKey`);
    assert.ok(Array.isArray(p.models), `${p.key} models must be an array`);
  }
});

test("provider keys are unique", () => {
  const keys = HIGHLIGHT_ASK_PROVIDERS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(",")}`);
});

test("the default pref provider exists in the catalogue", () => {
  // The shipped default in addon/prefs.js must resolve, otherwise the plugin
  // silently falls back to the first entry.
  assert.ok(HIGHLIGHT_ASK_PROVIDERS.some((p) => p.key === "deepseek"));
});

test("a 'custom' escape hatch exists", () => {
  assert.ok(HIGHLIGHT_ASK_PROVIDERS.some((p) => p.key === "custom"));
});

test("every non-custom provider has an absolute http(s) base URL", () => {
  for (const p of HIGHLIGHT_ASK_PROVIDERS) {
    if (p.key === "custom") continue;
    assert.match(
      p.baseUrl,
      /^https?:\/\//,
      `${p.key} baseUrl must be absolute: ${p.baseUrl}`,
    );
  }
});

test("model ids are unique within each provider", () => {
  for (const p of HIGHLIGHT_ASK_PROVIDERS) {
    const ids = p.models.map((m) => m.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${p.key} has duplicate model ids: ${ids.join(",")}`,
    );
  }
});

test("base URLs never carry a chat/completions suffix", () => {
  // buildEndpoint appends the path; a stored suffix would double it up.
  for (const p of HIGHLIGHT_ASK_PROVIDERS) {
    assert.ok(
      !/\/chat\/completions/.test(p.baseUrl),
      `${p.key} baseUrl should not include /chat/completions`,
    );
  }
});

test("Ollama is marked as needing no key and as local", () => {
  const ollama = HIGHLIGHT_ASK_PROVIDERS.find((p) => p.key === "ollama");
  assert.ok(ollama, "ollama preset missing");
  assert.equal(ollama.requiresKey, false);
  assert.equal(ollama.local, true);
});

/*
 * The settings pane loads the *generated* providers.data.js and reads the
 * HIGHLIGHT_ASK_PROVIDERS global from it. If the generator ever stops emitting
 * that global, the pane silently falls back to a stub catalogue — so assert on
 * the real build artefact, not just the TypeScript source.
 */
console.log("\ngenerated providers.data.js");
const dataPath = resolve(
  import.meta.dirname ?? ".",
  "../.scaffold/build/addon/content/providers.data.js",
);

test("the built asset exists", () => {
  const src = readFileSync(dataPath, "utf8");
  assert.ok(src.length > 0);
});

test("loading it defines a usable global catalogue", () => {
  const src = readFileSync(dataPath, "utf8");
  const sandbox: any = {};
  // Execute exactly as the settings pane would: a bare script whose `globalThis`
  // is the pane scope.
  new Function("globalThis", src)(sandbox);
  const list = sandbox.HIGHLIGHT_ASK_PROVIDERS;
  assert.ok(Array.isArray(list), "HIGHLIGHT_ASK_PROVIDERS global was not defined");
  assert.equal(
    list.length,
    HIGHLIGHT_ASK_PROVIDERS.length,
    "generated catalogue differs in length from the source",
  );
  assert.deepEqual(
    list.map((p: any) => p.key),
    HIGHLIGHT_ASK_PROVIDERS.map((p) => p.key),
    "generated catalogue keys differ from the source",
  );
});

test("the generated catalogue preserves model ids and vision flags", () => {
  const src = readFileSync(dataPath, "utf8");
  const sandbox: any = {};
  new Function("globalThis", src)(sandbox);
  const list = sandbox.HIGHLIGHT_ASK_PROVIDERS;
  for (const srcProvider of HIGHLIGHT_ASK_PROVIDERS) {
    const built = list.find((p: any) => p.key === srcProvider.key);
    assert.deepEqual(
      built.models.map((m: any) => m.id),
      srcProvider.models.map((m) => m.id),
      `${srcProvider.key}: model ids drifted`,
    );
    assert.deepEqual(
      built.models.map((m: any) => Boolean(m.vision)),
      srcProvider.models.map((m) => Boolean(m.vision)),
      `${srcProvider.key}: vision flags drifted`,
    );
  }
});

/* ---------------------------------------------------------------- */

console.log("\nlooksLikeFencedMath");
// Models routinely wrap formulas in a code fence instead of using $...$.
// A false positive turns genuine code into garbled maths, so the heuristic
// must be conservative.
test("a latex-tagged fence is maths", () => {
  assert.equal(looksLikeFencedMath("latex", "E = mc^2"), true);
  assert.equal(looksLikeFencedMath("tex", "x"), true);
  assert.equal(looksLikeFencedMath("math", "x"), true);
  assert.equal(looksLikeFencedMath("katex", "x"), true);
});

test("a fence containing already-delimited maths is maths", () => {
  assert.equal(looksLikeFencedMath("", "$$E = mc^2$$"), true);
  assert.equal(looksLikeFencedMath("", "\\[x\\]"), true);
});

test("an untagged fence with obvious LaTeX and no code is maths", () => {
  assert.equal(
    looksLikeFencedMath("", "\\tilde L = L + \\frac{\\alpha}{4}"),
    true,
  );
});

test("a real language tag is never treated as maths", () => {
  // The decisive guard: `python` fence stays code even if it mentions \frac.
  assert.equal(looksLikeFencedMath("python", "x = \\frac{1}{2}"), false);
  assert.equal(looksLikeFencedMath("javascript", "const a = 1"), false);
  assert.equal(looksLikeFencedMath("json", '{"a": 1}'), false);
});

test("code-shaped content is not maths even without a tag", () => {
  assert.equal(looksLikeFencedMath("", "function f() { return 1; }"), false);
  assert.equal(looksLikeFencedMath("", "const x = 1;"), false);
  assert.equal(looksLikeFencedMath("", "def f():\n    return 1"), false);
});

test("plain prose in a fence is not maths", () => {
  assert.equal(looksLikeFencedMath("", "hello world"), false);
  assert.equal(looksLikeFencedMath("", "步骤一：准备数据"), false);
});

test("empty content is not maths", () => {
  assert.equal(looksLikeFencedMath("", ""), false);
  assert.equal(looksLikeFencedMath("latex", ""), false);
});

console.log("\nstripMathDelimiters");
test("strips $$ and $ wrappers", () => {
  assert.equal(stripMathDelimiters("$$x$$"), "x");
  assert.equal(stripMathDelimiters("$x$"), "x");
});

test("strips backslash-bracket wrappers", () => {
  assert.equal(stripMathDelimiters("\\[x\\]"), "x");
  assert.equal(stripMathDelimiters("\\(x\\)"), "x");
});

test("leaves undelimited content alone", () => {
  assert.equal(stripMathDelimiters("x + y"), "x + y");
});

test("does not eat a lone dollar in text", () => {
  assert.equal(stripMathDelimiters("price is $5"), "price is $5");
});

console.log("\nfenced maths in renderMarkdown");
test("a latex fence renders as maths, not as a code block", () => {
  const root = renderMarkdown("```latex\nE = mc^2\n```", doc, {
    renderMath: (el: any, latex: string) => {
      el.textContent = `MATH(${latex})`;
      return true;
    },
  });
  const flat = root.serialize();
  assert.ok(flat.includes("MATH(E = mc^2)"), flat);
  assert.ok(!flat.includes("<pre>"), `should not be a code block: ${flat}`);
});

test("a python fence still renders as a code block", () => {
  const root = renderMarkdown("```python\nx = 1\n```", doc, {
    renderMath: (el: any) => {
      el.textContent = "MATH";
      return true;
    },
  });
  const flat = root.serialize();
  assert.ok(flat.includes("<pre>"), flat);
  assert.ok(!flat.includes("MATH"), flat);
});

test("$$-delimited maths still renders as maths", () => {
  const root = renderMarkdown("$$a^2$$", doc, {
    renderMath: (el: any, latex: string) => {
      el.textContent = `MATH(${latex})`;
      return true;
    },
  });
  assert.ok(root.serialize().includes("MATH(a^2)"), root.serialize());
});

test("falls back to the source when no renderer is supplied", () => {
  const root = renderMarkdown("$$a^2$$", doc);
  assert.ok(root.serialize().includes("a^2"), root.serialize());
});

console.log("\nvalidateSettings");
const baseDraft = () => ({
  providerKey: "deepseek",
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  thinkingParamsText: '{"reasoning_effort":"high"}',
  temperatureText: "",
});

test("accepts a good draft and normalises the base URL", () => {
  const d = baseDraft();
  d.baseUrl = "https://api.deepseek.com///";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.baseUrl, "https://api.deepseek.com");
});

test("trims surrounding whitespace on every field", () => {
  const d = baseDraft();
  d.apiKey = "  sk-test  ";
  d.model = "  deepseek-flash  ";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.apiKey, "sk-test");
  assert.equal(r.value.model, "deepseek-flash");
});

test("rejects an empty base URL", () => {
  const d = baseDraft();
  d.baseUrl = "   ";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /地址/);
});

test("rejects a base URL without a scheme", () => {
  const d = baseDraft();
  d.baseUrl = "api.deepseek.com";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /http/);
});

test("rejects a base URL that already ends in /chat/completions", () => {
  // This is a very common mistake and would produce a doubled path.
  const d = baseDraft();
  d.baseUrl = "https://api.deepseek.com/chat/completions";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /chat\/completions/);
});

test("rejects an empty model", () => {
  const d = baseDraft();
  d.model = "";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /模型/);
});

test("rejects malformed thinking params", () => {
  const d = baseDraft();
  d.thinkingParamsText = "{oops";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
});

test("rejects thinking params that are not an object", () => {
  const d = baseDraft();
  d.thinkingParamsText = "[1,2]";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON 对象/);
});

test("allows empty thinking params", () => {
  const d = baseDraft();
  d.thinkingParamsText = "";
  assert.equal(validateSettings(d).ok, true);
});

test("rejects an out-of-range temperature", () => {
  for (const bad of ["-1", "2.5", "abc"]) {
    const d = baseDraft();
    d.temperatureText = bad;
    assert.equal(validateSettings(d).ok, false, `should reject ${bad}`);
  }
});

test("allows an empty temperature (means: do not send it)", () => {
  const d = baseDraft();
  d.temperatureText = "";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.temperatureText, "");
});

test("requires a key for providers that need one", () => {
  const d = baseDraft();
  d.apiKey = "";
  const r = validateSettings(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /API Key/);
});

test("does not require a key for Ollama", () => {
  const d = baseDraft();
  d.providerKey = "ollama";
  d.apiKey = "";
  d.baseUrl = "http://localhost:11434/v1";
  d.model = "qwen3:8b";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
});

test("warns when the provider and the address disagree", () => {
  const d = baseDraft();
  d.providerKey = "deepseek";
  d.baseUrl = "https://my-proxy.example.com/v1";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /my-proxy\.example\.com/);
});

test("does not warn for the custom provider (proxies are the point)", () => {
  const d = baseDraft();
  d.providerKey = "custom";
  d.baseUrl = "https://my-proxy.example.com/v1";
  const r = validateSettings(d);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
});

test("an unknown provider key falls back instead of crashing", () => {
  const d = baseDraft();
  d.providerKey = "does-not-exist";
  const r = validateSettings(d);
  // Falls back to the first catalogue entry (deepseek), which needs a key.
  assert.equal(getProvider("does-not-exist").key, HIGHLIGHT_ASK_PROVIDERS[0].key);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.providerKey, HIGHLIGHT_ASK_PROVIDERS[0].key);
});

test("never throws, whatever it is handed", () => {
  const nasty = [
    {},
    { baseUrl: null, model: null, apiKey: null, thinkingParamsText: null, temperatureText: null },
    { baseUrl: "http://x", model: "m", thinkingParamsText: "null", temperatureText: "0" },
  ];
  for (const d of nasty) {
    validateSettings(d as any);
  }
});

/* ---------------------------------------------------------------- */

console.log("\nprompt layering");
test("the system prompt stacks role then scenario", () => {
  const system = buildSystemPrompt({
    role: "ROLE_MARKER",
    scenario: "SCENARIO_MARKER",
  });
  assert.ok(system.indexOf("ROLE_MARKER") < system.indexOf("SCENARIO_MARKER"));
});

test("the system prompt is identical for different questions (cache friendly)", () => {
  // Stable prefix matters: providers cache on it, and it must not vary with the
  // selection or the question.
  const a = buildSystemPrompt();
  const b = buildSystemPrompt();
  assert.equal(a, b);
  assert.ok(!a.includes("请解释这段内容"));
});

test("volatile content goes in the user message, not the system message", () => {
  const system = buildSystemPrompt();
  const user = buildUserMessage({
    selection: "SELECTION_MARKER",
    question: "QUESTION_MARKER",
    nearby: "NEARBY_MARKER",
    fullText: "FULLTEXT_MARKER",
    title: "TITLE_MARKER",
  });
  for (const marker of [
    "SELECTION_MARKER",
    "QUESTION_MARKER",
    "NEARBY_MARKER",
    "FULLTEXT_MARKER",
    "TITLE_MARKER",
  ]) {
    assert.ok(!system.includes(marker), `${marker} leaked into the system prompt`);
    assert.ok(user.includes(marker), `${marker} missing from the user message`);
  }
});

test("the default scenario prompt warns about PDF extraction damage", () => {
  // This is the plugin's core value proposition; losing it silently would make
  // formula answers much worse.
  const scenario = DEFAULT_SCENARIO_PROMPT;
  assert.match(scenario, /PDF/);
  assert.match(scenario, /LaTeX|\$\.\.\.\$/);
  assert.match(scenario, /抽取|提取/);
});

test("the user message omits absent optional sections", () => {
  const user = buildUserMessage({ selection: "x", question: "y" });
  assert.ok(!user.includes("全文"));
  assert.ok(!user.includes("附近的原文"));
  assert.ok(user.includes("选中"));
});

test("nearby text identical to the selection is not repeated", () => {
  const user = buildUserMessage({
    selection: "same",
    question: "q",
    nearby: "same",
  });
  assert.ok(!user.includes("附近的原文"));
});

console.log("\ntranslate prompt");
// The translation prompt is the one users hit most often and the one that has
// regressed twice, so its contract is pinned down here.
const translateAction = QUICK_ACTIONS.find((a) => a.id === "translate")!;

test("the translate action exists and uses the default prompt", () => {
  assert.ok(translateAction, "translate quick action is missing");
  assert.equal(translateAction.defaultPrompt, DEFAULT_TRANSLATE_TASK);
});

test("forbids bilingual parenthetical glosses", () => {
  // "keep technical terms in English" produced `离散化 (discretization)`,
  // which makes a translation markedly harder to read.
  assert.match(DEFAULT_TRANSLATE_TASK, /不要中英对照/);
  assert.match(DEFAULT_TRANSLATE_TASK, /括号夹注/);
  assert.ok(
    !/专业术语保留英文原词/.test(DEFAULT_TRANSLATE_TASK),
    "the instruction that caused the glossing is back",
  );
});

test("says only names, abbreviations and symbols keep their original form", () => {
  assert.match(DEFAULT_TRANSLATE_TASK, /人名、模型名、缩写、符号保留原样/);
});

test("demands a clean result with no added commentary", () => {
  assert.match(DEFAULT_TRANSLATE_TASK, /只输出译文本身/);
  for (const forbidden of ["不要解释", "不要总结", "不要补充背景", "不要评论"]) {
    assert.ok(
      DEFAULT_TRANSLATE_TASK.includes(forbidden),
      `missing constraint: ${forbidden}`,
    );
  }
});

test("protects LaTeX from being explained away", () => {
  assert.match(DEFAULT_TRANSLATE_TASK, /LaTeX 原样/);
});

test("forbids inventing content for damaged PDF text", () => {
  // A translator that fills gaps is worse than a literal one: the reader
  // cannot tell invented text from the source.
  assert.match(DEFAULT_TRANSLATE_TASK, /不要凭空补写/);
});

test("the scenario layer also forbids glossing and enforces the task", () => {
  assert.match(DEFAULT_SCENARIO_PROMPT, /括号夹注/);
  assert.match(DEFAULT_SCENARIO_PROMPT, /严格按「问题」里提出的要求作答/);
});

test("the scenario layer pins down the maths delimiters", () => {
  // Models otherwise drift to code fences or \( \) forms, which then do not
  // render. The renderer tolerates fences, but the prompt should not rely on it.
  assert.match(DEFAULT_SCENARIO_PROMPT, /行内用 \$\.\.\.\$/, "inline rule missing");
  assert.match(DEFAULT_SCENARIO_PROMPT, /\$\$\.\.\.\$\$/, "display rule missing");
  assert.match(DEFAULT_SCENARIO_PROMPT, /不要.*放进代码块/, "fence ban missing");
  assert.match(DEFAULT_SCENARIO_PROMPT, /只认 \$ 符号/, "single-delimiter rule missing");
});

test("the translate task also forbids code fences around maths", () => {
  assert.match(DEFAULT_TRANSLATE_TASK, /不要用代码块包起来/);
});

console.log("\ntrimFullText");
test("short text is passed through untouched", () => {
  const r = trimFullText("hello", 100);
  assert.equal(r.text, "hello");
  assert.equal(r.truncated, false);
});

test("long text keeps the head and the tail, cutting the middle", () => {
  const text = "A".repeat(400) + "MIDDLE" + "B".repeat(400);
  const r = trimFullText(text, 100);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("A"), "head kept");
  assert.ok(r.text.endsWith("B"), "tail kept");
  assert.ok(!r.text.includes("MIDDLE"), "middle dropped");
  assert.ok(r.text.includes("省略"), "tells the reader something was cut");
});

test("result never exceeds the budget by much", () => {
  const r = trimFullText("x".repeat(10000), 500);
  const notice = r.text.length - 500;
  assert.ok(notice < 200, `trim overflowed by ${notice} chars`);
});

test("handles empty and whitespace input", () => {
  assert.deepEqual(trimFullText("", 100), { text: "", truncated: false });
  assert.deepEqual(trimFullText("   ", 100), { text: "", truncated: false });
});

console.log("\nextractNearby");
test("returns a window around the selection", () => {
  const text = "BEFORE ".repeat(50) + "THE_SELECTION" + " AFTER".repeat(50);
  const out = extractNearby(text, "THE_SELECTION", 200);
  assert.ok(out.includes("THE_SELECTION"));
  assert.ok(out.length <= 200 + "THE_SELECTION".length + 4);
});

test("falls back to a looser probe when the selection was normalised", () => {
  // The panel joins hard-wrapped lines, so the stored text may not match exactly.
  const text = "alpha beta gamma THE SELECTION IS HERE delta epsilon";
  const out = extractNearby(text, "THE SELECTION IS HERE", 100);
  assert.ok(out.includes("THE SELECTION IS HERE"), out);
});

test("returns empty when the selection is not in the text", () => {
  assert.equal(extractNearby("some text", "NOT_PRESENT_ANYWHERE_XYZ"), "");
});

test("returns empty when either input is empty", () => {
  assert.equal(extractNearby("", "x"), "");
  assert.equal(extractNearby("text", ""), "");
  assert.equal(extractNearby("text", "   "), "");
});

test("marks clipped ends", () => {
  const text = "x".repeat(500) + "NEEDLE" + "y".repeat(500);
  const out = extractNearby(text, "NEEDLE", 100);
  assert.ok(out.startsWith("…"), "leading clip is marked");
  assert.ok(out.endsWith("…"), "trailing clip is marked");
});

console.log("\nsession model");
test("appendTurn does not mutate the original session", () => {
  const s = makeSession(1);
  const next = appendTurn(s, makeTurn("q1", "a1"));
  assert.equal(s.turns.length, 0, "original untouched");
  assert.equal(next.turns.length, 1);
});

test("appendTurn records the update time", () => {
  const s = makeSession(1);
  const next = appendTurn(s, makeTurn("q", "a", { ts: "2026-01-02T03:04:05.000Z" }));
  assert.equal(next.updatedAt, "2026-01-02T03:04:05.000Z");
});

test("session ids are filesystem safe and unique per call", () => {
  const a = makeSessionId(42, new Date("2026-01-02T03:04:05.678Z"));
  const b = makeSessionId(42, new Date("2026-01-02T03:04:06.678Z"));
  assert.notEqual(a, b);
  assert.ok(!/[:.]/.test(a), `unsafe characters in ${a}`);
  assert.ok(a.includes("42"));
});

test("sessionChars counts question and answer text", () => {
  const s = makeSession(1);
  s.turns.push(makeTurn("12345", "1234567890"));
  assert.equal(sessionChars(s), 15);
});

test("renderSessionHtml escapes HTML from the paper and the model", () => {
  const s = makeSession(1);
  s.turns.push(makeTurn("<img src=x onerror=alert(1)>", "<script>bad()</script>"));
  const html = renderSessionHtml(s);
  assert.ok(!html.includes("<script>"), "model output was not escaped");
  assert.ok(!html.includes("<img"), "selection was not escaped");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderSessionHtml keeps answers verbatim inside pre", () => {
  // LaTeX must survive; the note editor would otherwise reflow $...$ and \.
  const answer = "$$\\frac{a}{b}$$ and `code`";
  const s = makeSession(1);
  s.turns.push(makeTurn("q", answer));
  const html = renderSessionHtml(s);
  assert.ok(html.includes("\\frac{a}{b}"));
  assert.ok(/<pre>[\s\S]*\\frac\{a\}\{b\}[\s\S]*<\/pre>/.test(html));
});

test("renderSessionHtml numbers turns in order", () => {
  const s = makeSession(1);
  s.turns.push(makeTurn("first", "a"));
  s.turns.push(makeTurn("second", "b"));
  const html = renderSessionHtml(s);
  assert.ok(html.indexOf("1. first") < html.indexOf("2. second"));
  assert.ok(html.includes(NOTE_HEADING));
  // A note written before the rename is still the reader's conversation.
  assert.ok(
    renderSessionHtml({
      id: "s",
      itemID: 1,
      title: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      turns: [{ question: "q", answer: "a", ts: "2026-01-01T00:00:00.000Z" }],
    } as any).includes(NOTE_HEADING),
    "new sessions use the current heading",
  );
});

/* ---------------------------------------------------------------- */

console.log("\nmatchesItem (reader item vs pane item)");
// A reader's itemID is the PDF attachment; the item pane usually shows the
// parent item. Comparing ids naively made the sidebar claim it was "not ready"
// even while it was on screen.
const fakeItems: Record<number, any> = {
  100: { id: 100, parentItemID: false, getAttachments: () => [101, 102] }, // the paper
  101: { id: 101, parentItemID: 100, getAttachments: () => [] }, // a PDF of it
  102: { id: 102, parentItemID: 100, getAttachments: () => [] }, // another PDF
  200: { id: 200, parentItemID: false, getAttachments: () => [201] }, // unrelated
  201: { id: 201, parentItemID: 200, getAttachments: () => [] },
};
// Merge rather than replace: an earlier stub already provides the data
// directory and preference store that other modules read.
(globalThis as any).Zotero = {
  ...(globalThis as any).Zotero,
  debug: () => {},
  Items: { get: (id: number) => fakeItems[id] },
};

test("identical ids match", () => {
  assert.equal(matchesItem(100, 100), true);
});

test("a PDF attachment matches its parent paper", () => {
  // The exact case that broke: reader says 101, the pane shows 100.
  assert.equal(matchesItem(101, 100), true);
});

test("a parent paper matches one of its attachments", () => {
  assert.equal(matchesItem(100, 101), true);
  assert.equal(matchesItem(100, 102), true);
});

test("two attachments of the same paper are not the same item", () => {
  // They are siblings, not the same document; treating them as equal would let
  // one PDF's conversation serve another's question.
  assert.equal(matchesItem(101, 102), false);
});

test("unrelated items do not match", () => {
  assert.equal(matchesItem(100, 200), false);
  assert.equal(matchesItem(101, 201), false);
});

test("an unknown id does not match and does not throw", () => {
  assert.equal(matchesItem(999, 100), false);
  assert.equal(matchesItem(100, 999), false);
});

test("a throwing Zotero.Items.get degrades to no match", () => {
  const original = (globalThis as any).Zotero.Items.get;
  (globalThis as any).Zotero.Items.get = () => {
    throw new Error("boom");
  };
  try {
    assert.equal(matchesItem(1, 2), false);
  } finally {
    (globalThis as any).Zotero.Items.get = original;
  }
});

console.log("\nKaTeX SVG delimiters need the SVG namespace");
// Tall delimiters — norms, big brackets — are inline SVG paths, not font
// glyphs. Building them with createElement puts them in the HTML namespace,
// where the browser renders nothing: the norm bars vanish while the rest of the
// formula looks correct.
function buildWithRecorder(latex: string, display = false) {
  const made: Array<{ tag: string; ns: string; attrs: Record<string, string> }> = [];
  const make = (tag: string, ns: string) => ({
    tag,
    ns,
    attrs: {} as Record<string, string>,
    kids: [] as any[],
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    appendChild(n: any) {
      this.kids.push(n);
    },
  });
  const doc = {
    createElement(tag: string) {
      const el = make(tag, "html");
      made.push(el);
      return el;
    },
    createElementNS(ns: string, tag: string) {
      const el = make(tag, ns);
      made.push(el);
      return el;
    },
    createTextNode(t: string) {
      return { text: t };
    },
  } as unknown as Document;
  buildMathNodes(latexToNodes(latex, display), doc);
  return made;
}

const SVG_NS = "http://www.w3.org/2000/svg";

test("a norm delimiter is built as SVG in the SVG namespace", () => {
  const made = buildWithRecorder(
    "\\left\\| \\frac{\\partial L}{\\partial \\phi} \\right\\|^2",
  );
  const svgs = made.filter((e) => e.tag === "svg");
  assert.equal(svgs.length, 2, `expected two bars, got ${svgs.length}`);
  for (const svg of svgs) {
    assert.equal(svg.ns, SVG_NS, "svg must be in the SVG namespace");
  }
  const paths = made.filter((e) => e.tag === "path");
  assert.ok(paths.length > 0, "the bars are drawn as paths");
  for (const path of paths) {
    assert.equal(path.ns, SVG_NS, "path must be in the SVG namespace");
    assert.ok(path.attrs.d, "a path without its d attribute draws nothing");
  }
});

test("only the norm bars use SVG; other delimiters use font glyphs", () => {
  // Verified against KaTeX 0.18: \left( \right), \left\{ \right\} and
  // \left[ \right] all render from the Size fonts, while \| needs paths.
  // Recording the real behaviour keeps the namespace rule pinned without
  // asserting something KaTeX never does.
  for (const tex of [
    "\\left( \\frac{a}{b} \\right)",
    "\\left\\{ \\frac{a}{b} \\right\\}",
    "\\left[ \\begin{matrix} a & b \\\\ c & d \\end{matrix} \\right]",
  ]) {
    const made = buildWithRecorder(tex);
    assert.equal(
      made.filter((e) => e.tag === "svg").length,
      0,
      `${tex} unexpectedly produced SVG`,
    );
    assert.ok(
      made.some((e) => (e.attrs.class ?? "").includes("delimsizing")),
      `${tex} should still produce sized delimiters`,
    );
  }
});

test("SVG attribute names keep their case", () => {
  // `viewBox` lower-cased to `viewbox` is an unknown attribute, so the SVG
  // loses its coordinate system and draws nothing — the norm bars vanished
  // while the rest of the formula rendered perfectly. HTML ignores attribute
  // case; SVG does not.
  const made = buildWithRecorder(
    "\\left\\| \\frac{\\partial L}{\\partial \\phi} \\right\\|^2",
  );
  const svgs = made.filter((e) => e.tag === "svg");
  assert.ok(svgs.length > 0, "expected SVG delimiters");
  for (const svg of svgs) {
    assert.ok(
      "viewBox" in svg.attrs,
      `viewBox missing (got ${Object.keys(svg.attrs).join(",")})`,
    );
    assert.ok(!("viewbox" in svg.attrs), "viewBox must not be lower-cased");
  }
});

test("ordinary HTML attributes are unaffected by case handling", () => {
  const made = buildWithRecorder("\\frac{a}{b}");
  const withClass = made.filter((e) => e.attrs.class !== undefined);
  assert.ok(withClass.length > 0, "class attributes should survive");
});

test("plain formulas create no SVG at all", () => {
  const made = buildWithRecorder("x^2 + y_i");
  assert.equal(made.filter((e) => e.tag === "svg").length, 0);
});

test("non-SVG elements stay in the HTML namespace", () => {
  const made = buildWithRecorder("\\frac{a}{b}");
  for (const el of made) {
    assert.equal(el.ns, "html", `${el.tag} should be HTML`);
  }
});

console.log("\nscreenshot directory resolution");
// The capture-preview path is configurable. A mis-resolved path writes files
// somewhere the reader cannot find, which reads as "the button did nothing".
const SCREENSHOT_PREF = "extensions.zotero.highlightask.screenshotDir";
function withPref(value: string): string {
  (globalThis as any).__prefs = { [SCREENSHOT_PREF]: value };
  return screenshotDir();
}

test("an empty preference keeps the default location", () => {
  assert.equal(withPref(""), "/data/highlight-ask/debug");
});

test("a relative value becomes a subdirectory of the plugin folder", () => {
  assert.equal(withPref("captures"), "/data/highlight-ask/captures");
  assert.equal(withPref("a/b"), "/data/highlight-ask/a/b");
});

test("a trailing separator is tolerated", () => {
  assert.equal(withPref("captures/"), "/data/highlight-ask/captures");
  assert.equal(withPref("captures//"), "/data/highlight-ask/captures");
});

test("an absolute path is used as given", () => {
  assert.equal(withPref("/tmp/ha"), "/tmp/ha");
  assert.equal(withPref("/tmp/ha/"), "/tmp/ha");
});

test("whitespace is trimmed rather than becoming a directory name", () => {
  assert.equal(withPref("   "), "/data/highlight-ask/debug");
  assert.equal(withPref("  captures  "), "/data/highlight-ask/captures");
});

console.log("\nselection popup: layout constraints");
// The reader caps this popup at 198px (`.selection-popup` in reader.css). A
// `min-width` larger than that does not widen the popup — it pushes the send
// button outside it, which is exactly what happened. These assertions pin the
// constraint so the tempting fix (make it wider) cannot come back.
function popupCss(): string {
  const src = readFileSync(
    new URL("../src/modules/readerPopup.ts", import.meta.url),
    "utf8",
  );
  const match = src.match(/const BTN_CSS = `([\s\S]*?)`;/);
  assert.ok(match, "BTN_CSS not found");
  return match[1].replace(/\$\{BTN_ROW_CLASS\}/g, "ha-selection-actions");
}

test("the popup stylesheet sets no min-width beyond the reader's cap", () => {
  const css = popupCss();
  for (const match of css.matchAll(/min-width:\s*(\d+)px/g)) {
    assert.ok(
      Number(match[1]) <= 198,
      `min-width ${match[1]}px exceeds the reader's 198px cap and will overflow`,
    );
  }
});

test("the question field is an input element, not a textarea", () => {
  // The reader deletes the selected annotation on Backspace and exempts only
  // `input`:
  //   if (event.target.closest('input, .label-popup') || ...) return;
  // A textarea is missing from that list, so Backspace was treated as "delete
  // the annotation" and dismissed the popup while typing. The element type is
  // therefore load-bearing, not cosmetic.
  const src = readFileSync(
    new URL("../src/modules/readerPopup.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /createElement\("input"\)/.test(src),
    "the question field must be an input element",
  );
  assert.ok(
    !/createElement\("textarea"\)/.test(src),
    "a textarea would be dismissed by the reader's Backspace handling",
  );
});

test("the popup lays out inside the reader's 198px cap", () => {
  // Raising the cap on .selection-popup looked like the fix and is not: the
  // reader sizes the popup from its content, so a larger cap changed nothing
  // observable. The width setting and its plumbing were removed rather than
  // left in place doing nothing.
  const css = popupCss();
  assert.ok(
    !/\.selection-popup\s*\{/.test(css),
    "the popup element must not be restyled; the cap cannot be raised usefully",
  );
  assert.ok(
    !/popupWidth|--ha-popup-width|__HA_POPUP_WIDTH__/.test(css),
    "no leftover width plumbing",
  );
});

test("the question field reserves three lines", () => {
  const css = popupCss();
  assert.ok(
    /height:\s*3\.9em/.test(css),
    "expected roughly three lines of height",
  );
});

test("the question row wraps instead of overflowing", () => {
  const css = popupCss();
  const form = css.slice(css.indexOf(".ha-ask-form"));
  assert.ok(
    /flex-wrap:\s*wrap/.test(form.slice(0, 400)),
    "the form must wrap; without it the button is pushed out",
  );
});

test("the input is box-sized so padding cannot overflow the popup", () => {
  const css = popupCss();
  const input = css.slice(css.indexOf(".ha-ask-input"));
  assert.ok(
    /box-sizing:\s*border-box/.test(input.slice(0, 600)),
    "expected border-box sizing",
  );
});

console.log("\nselection popup: action-to-button matching");
// The row now also holds a free-form input and its send button, so matching by
// index would silently bind each preset to the wrong action — the button would
// still work, just do something else than its label says.
test("pairs actions with buttons by id, not by position", () => {
  const actions = [
    { id: "explain", label: "解释这段" },
    { id: "translate", label: "翻译" },
    { id: "role", label: "有何作用" },
  ];
  const buttons = [
    { dataset: { haAction: "role" } },
    { dataset: { haAction: "explain" } },
    { dataset: { haAction: "translate" } },
  ];
  const pairs = matchActionsToButtons(actions, buttons);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].action.label, "有何作用");
  assert.equal(pairs[1].action.label, "解释这段");
  assert.equal(pairs[2].action.label, "翻译");
});

test("ignores buttons that carry no action id", () => {
  // The send button for the free-form field has no action id.
  const pairs = matchActionsToButtons(
    [{ id: "explain" }],
    [{ dataset: { haAction: "explain" } }, { dataset: {} }],
  );
  assert.equal(pairs.length, 1);
});

test("ignores unknown ids instead of throwing", () => {
  const pairs = matchActionsToButtons(
    [{ id: "explain" }],
    [{ dataset: { haAction: "nope" } }],
  );
  assert.deepEqual(pairs, []);
});

test("every preset action has a unique id", () => {
  // Ids are the binding key now, so a duplicate would make one preset
  // unreachable while another ran twice.
  const ids = QUICK_ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
});

console.log("\nrobustness: settings validation");
// `validateSettings` promises never to throw, and it reads preferences that a
// user can hand-edit to any type. A numeric baseUrl used to crash on `.trim()`
// instead of being reported as invalid.
const DRAFT = {
  providerKey: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: "sk-x",
  temperatureText: "",
  thinkingParamsText: "",
};

test("a valid draft passes", () => {
  assert.equal(validateSettings(DRAFT).ok, true);
});

test("non-string fields never throw", () => {
  const weird: Array<Record<string, unknown>> = [
    { baseUrl: 42 },
    { baseUrl: {} },
    { baseUrl: null },
    { model: [] },
    { apiKey: true },
    { temperatureText: {} },
    { thinkingParamsText: 5 },
    { providerKey: null },
    { baseUrl: undefined, model: undefined, apiKey: undefined },
  ];
  for (const over of weird) {
    assert.doesNotThrow(
      () => validateSettings({ ...DRAFT, ...over } as any),
      `threw for ${JSON.stringify(over)}`,
    );
  }
});

test("a non-string field is treated as missing and rejected", () => {
  const result = validateSettings({ ...DRAFT, baseUrl: 42 } as any);
  assert.equal(result.ok, false);
  assert.ok(result.error, "should explain what is wrong");
});

test("dangerous URL schemes are refused", () => {
  for (const baseUrl of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "not a url",
  ]) {
    const result = validateSettings({ ...DRAFT, providerKey: "custom", baseUrl } as any);
    assert.equal(result.ok, false, `${baseUrl} should be refused`);
  }
});

test("a baseUrl ending in /chat/completions is refused with a hint", () => {
  const result = validateSettings({
    ...DRAFT,
    baseUrl: "https://api.deepseek.com/chat/completions",
  } as any);
  assert.equal(result.ok, false);
  assert.ok(/chat\/completions/.test(result.error || ""), result.error);
});

test("malformed thinking params are refused", () => {
  assert.equal(
    validateSettings({ ...DRAFT, thinkingParamsText: "{oops" } as any).ok,
    false,
  );
  assert.equal(
    validateSettings({ ...DRAFT, thinkingParamsText: "[1,2]" } as any).ok,
    false,
  );
});

test("an out-of-range temperature is refused", () => {
  for (const temperatureText of ["hot", "999", "-3"]) {
    assert.equal(
      validateSettings({ ...DRAFT, temperatureText } as any).ok,
      false,
      `${temperatureText} should be refused`,
    );
  }
});

test("an empty draft is refused rather than crashing", () => {
  assert.doesNotThrow(() => validateSettings({} as any));
  assert.equal(validateSettings({} as any).ok, false);
});

console.log("\nrobustness: malformed context and budgets");
// Prompt assembly receives values that cross several boundaries (Zotero, the
// reader, user preferences). A malformed one must not throw, and must never
// reach the model as the literal string "undefined".
test("a non-string annotations value does not throw", () => {
  assert.doesNotThrow(() =>
    buildUserMessage({ selection: "x", question: "q", annotations: 999 as any }),
  );
});

test("malformed notes entries are dropped, not stringified", () => {
  const out = buildUserMessage({
    selection: "x",
    question: "q",
    notes: [1, null, {}, "real note"] as any,
  });
  assert.ok(out.includes("real note"), out);
  assert.ok(!out.includes("undefined"), out);
  assert.ok(!out.includes("null"), out);
});

test("supporting info entries without text are skipped", () => {
  const out = buildUserMessage({
    selection: "x",
    question: "q",
    supportingInfo: [{}, { name: null, text: null }, { name: "SI.pdf", text: "body" }] as any,
  });
  assert.ok(out.includes("SI.pdf"), out);
  assert.ok(out.includes("body"), out);
});

test("non-string retrieved and fullText are ignored", () => {
  assert.doesNotThrow(() =>
    buildUserMessage({
      selection: "x",
      question: "q",
      retrieved: 5 as any,
      fullText: [] as any,
    }),
  );
});

test("a null selection and question do not throw", () => {
  assert.doesNotThrow(() =>
    buildUserMessage({ selection: null as any, question: null as any }),
  );
});

test("a zero or negative budget yields nothing rather than a fragment", () => {
  // A negative budget used to return just the head slice — silently wrong
  // content, which is worse than an empty result.
  for (const budget of [0, -5, NaN]) {
    const out = trimFullText("abcdef", budget);
    assert.equal(out.text, "", `budget ${budget} should yield nothing`);
    assert.equal(out.truncated, true);
  }
});

test("an infinite budget means no limit", () => {
  const out = trimFullText("abcdef", Infinity);
  assert.equal(out.text, "abcdef");
  assert.equal(out.truncated, false);
});

test("a tiny budget never emits a NaN in the omission marker", () => {
  for (const budget of [1, 10, 30, 63]) {
    const out = trimFullText("x".repeat(500), budget);
    assert.ok(!/NaN|undefined/.test(out.text), `budget ${budget}: ${out.text}`);
  }
});

test("non-string text is treated as empty", () => {
  assert.equal(trimFullText(null as any, 100).text, "");
  assert.equal(trimFullText(undefined as any, 100).text, "");
});

console.log("\nretrieval: chunking");
test("short text stays one chunk", () => {
  const chunks = chunkText("hello world");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "hello world");
});

test("long text is split into overlapping chunks", () => {
  const text = "Paragraph one.\n\n".repeat(200);
  const chunks = chunkText(text, 400, 80);
  assert.ok(chunks.length > 1, `expected splitting, got ${chunks.length}`);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(
      chunks[i].start < chunks[i - 1].end,
      `chunk ${i} does not overlap the previous one`,
    );
  }
});

test("chunks cover the text without gaps", () => {
  const text = "abcdefghij".repeat(300);
  const chunks = chunkText(text, 500, 50);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, text.length);
});

test("empty text yields no chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
});

console.log("\nretrieval: tokenization");
test("drops stopwords that carry no signal", () => {
  const tokens = tokenize("the model and the data");
  assert.ok(!tokens.includes("the"));
  assert.ok(tokens.includes("model"));
  assert.ok(tokens.includes("data"));
});

test("stems plurals and common suffixes", () => {
  // The query passage and the matching passage need not inflect alike.
  assert.equal(tokenize("regularizations")[0], tokenize("regularization")[0]);
  assert.equal(tokenize("models")[0], tokenize("model")[0]);
});

test("splits CJK into bigrams", () => {
  // No segmenter available, and this also lets a Chinese question match
  // Chinese notes the reader wrote.
  const tokens = tokenize("监督学习");
  assert.ok(tokens.includes("监督"), tokens.join("|"));
  assert.ok(tokens.includes("督学"), tokens.join("|"));
});

console.log("\nretrieval: ranking");
const BOOK = [
  "Chapter 1. Supervised learning maps inputs to outputs using labelled training data.",
  "Chapter 2. Shallow networks compose linear transformations with nonlinearities.",
  "Chapter 3. Deep networks stack many layers and train by backpropagation.",
  "Chapter 4. Regularization penalises complexity to reduce the generalization gap.",
].join("\n\n");

test("finds the chunk about the query topic", () => {
  const hits = rankChunks(BOOK, "supervised learning labelled training data");
  assert.ok(hits.length > 0);
  assert.ok(hits[0].text.includes("Chapter 1"), hits[0].text);
});

test("ranks different topics to different places", () => {
  const a = rankChunks(BOOK, "backpropagation layers")[0];
  const b = rankChunks(BOOK, "regularization generalization gap")[0];
  assert.ok(a.text.includes("Chapter 3"), a.text);
  assert.ok(b.text.includes("Chapter 4"), b.text);
});

test("returns nothing for a query with no matching terms", () => {
  assert.deepEqual(rankChunks(BOOK, "photosynthesis chlorophyll"), []);
});

test("honours topK", () => {
  const hits = rankChunks(BOOK, "learning networks data", { topK: 2 });
  assert.ok(hits.length <= 2);
});

test("can exclude the passage already being sent", () => {
  const target = "Chapter 1. Supervised learning maps inputs to outputs using labelled training data.";
  const range = locatePassage(BOOK, target)!;
  const hits = rankChunks(BOOK, target, { excludeRange: range });
  for (const hit of hits) {
    assert.ok(
      !hit.text.includes("Chapter 1"),
      "the passage being sent should not be returned again",
    );
  }
});

console.log("\nretrieval: locating and formatting");
test("locates an exact passage", () => {
  const target = "Shallow networks compose";
  const found = locatePassage(BOOK, target);
  assert.ok(found, "passage should be found");
  assert.equal(BOOK.slice(found!.start, found!.start + target.length), target);
});

test("locates a passage across line breaks", () => {
  // The text layer inserts breaks, so the selection rarely matches verbatim.
  const found = locatePassage(BOOK, "Chapter 3.  Deep networks stack");
  assert.ok(found, "should match with whitespace differences");
});

test("refuses to locate a passage too short to be meaningful", () => {
  assert.equal(locatePassage(BOOK, "the"), null);
});

test("formatting reports each passage's position in the document", () => {
  const hits = rankChunks(BOOK, "regularization penalises complexity");
  const out = formatRetrieved(hits, BOOK.length);
  assert.ok(out.includes("% 处"), out);
  assert.ok(out.includes("Chapter 4"), out);
});

test("formatting returns passages in document order, not relevance order", () => {
  // Reading a derivation in the order the author wrote it is easier.
  const hits = rankChunks(BOOK, "learning networks data regularization", {
    topK: 4,
  });
  const out = formatRetrieved(hits, BOOK.length);
  const positions = [...out.matchAll(/全文约 (\d+)% 处/g)].map((m) => Number(m[1]));
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, positions.join(","));
});


// A screenshot used to work only for the first question of a session: the first
// path attached it, and the follow-up path — which never called the assembler —
// silently dropped it for every later formula.
test("a follow-up without images stays a plain string", () => {
  const history = [{ role: "user" as const, content: "first" }];
  const out = buildFollowUpMessages(history, "second");
  assert.equal(out.length, 2);
  assert.equal(out[1].content, "second");
});

test("a follow-up with an image becomes content parts", () => {
  const history = [{ role: "user" as const, content: "first" }];
  const out = buildFollowUpMessages(history, "second", [
    { dataUrl: "data:image/png;base64,AAAA" },
  ]);
  const last = out[out.length - 1];
  assert.ok(Array.isArray(last.content), "expected content parts");
  const parts = last.content as any[];
  assert.equal(parts[0].type, "text");
  assert.equal(parts[0].text, "second");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
});

test("several tiles become several image parts", () => {
  const out = buildFollowUpMessages([], "q", [
    { dataUrl: "data:image/png;base64,AA" },
    { dataUrl: "data:image/png;base64,BB" },
    { dataUrl: "data:image/png;base64,CC" },
  ]);
  const parts = out[out.length - 1].content as any[];
  assert.equal(parts.filter((p) => p.type === "image_url").length, 3);
});

test("images are declared as original so nothing is resampled", () => {
  const out = buildFollowUpMessages([], "q", [
    { dataUrl: "data:image/png;base64,AA" },
  ]);
  const parts = out[out.length - 1].content as any[];
  assert.equal(parts[1].image_url.detail, "original");
});

test("the previous history is preserved", () => {
  const history = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "first" },
  ];
  const out = buildFollowUpMessages(history, "second", [
    { dataUrl: "data:image/png;base64,AA" },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, "sys");
  assert.equal(out[1].content, "first");
});

console.log("\nmarkdown: display maths keeps its display flag");
// A `$$...$$` sitting inside a paragraph used to be reconstructed with
// display:false, which renders sums and fractions at inline size — the "flat
// formula" a reader notices immediately.
function renderCalls(markdown: string) {
  const calls: Array<{ latex: string; display: boolean }> = [];
  const fakeDoc = {
    createElement(tag: string) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        classList: { add() {}, contains: () => false, toggle() {} },
        style: {},
        dataset: {},
        children: [] as any[],
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        appendChild(c: any) {
          this.children.push(c);
          return c;
        },
        replaceChildren() {},
        set textContent(v: string) {
          this._text = v;
        },
        get textContent() {
          return this._text ?? "";
        },
      };
    },
    createTextNode(t: string) {
      return { nodeValue: t, textContent: t };
    },
  } as unknown as Document;

  renderMarkdown(markdown, fakeDoc, {
    renderMath: (_el, latex, display) => {
      calls.push({ latex, display });
      return true;
    },
  });
  return calls;
}

test("a display formula on its own line renders as display", () => {
  const calls = renderCalls("$$x = y$$");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].display, true);
  assert.equal(calls[0].latex, "x = y");
});

test("a display formula inside a paragraph still renders as display", () => {
  // This is the case that was broken: the paragraph path always passed false.
  const calls = renderCalls("where the result is $$\\prod_{i=1}^{I} x_i$$ as shown.");
  const display = calls.filter((c) => c.display);
  assert.equal(
    display.length,
    1,
    `expected one display call, got ${JSON.stringify(calls)}`,
  );
  assert.ok(display[0].latex.includes("prod"), display[0].latex);
});

test("inline maths stays inline", () => {
  const calls = renderCalls("We write $x_i$ for the input.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].display, false);
  assert.equal(calls[0].latex, "x_i");
});

test("inline and display maths in one line are distinguished", () => {
  const calls = renderCalls("Let $\\phi$ be the parameter: $$p(\\phi) = \\frac{a}{b}$$ done.");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].display, false);
  assert.equal(calls[1].display, true);
});

test("bracket delimiters count as display", () => {
  const calls = renderCalls("\\[x = y\\]");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].display, true);
});

console.log("\nplanTiles");
// The provider resamples every image to roughly 1300x1300 pixels and bills a
// flat maximum per image, so a tile must stay inside that budget or the maths
// inside it stops being legible.
test("a single formula stays one tile at full scale", () => {
  const rect = { left: 626, top: 1609, width: 496, height: 173 };
  assert.equal(planTiles(rect, 2).length, 1);
  assert.equal(effectiveTileScale(rect, 2), 2);
});

test("a full page is split until every tile fits the budget", () => {
  const rect = { left: 0, top: 0, width: 1700, height: 2200 };
  const tiles = planTiles(rect, 2);
  assert.ok(tiles.length > 1, `expected splitting, got ${tiles.length}`);
  const scale = effectiveTileScale(rect, 2);
  for (const t of tiles) {
    assert.ok(
      t.width * t.height * scale * scale <= TILE_PIXEL_BUDGET + 1,
      `tile ${t.width}x${t.height} exceeds the budget`,
    );
  }
});

test("tiles cover the whole rectangle", () => {
  const rect = { left: 10, top: 20, width: 800, height: 1000 };
  const tiles = planTiles(rect, 2);
  assert.equal(tiles[0].top, rect.top, "first tile must start at the top");
  const last = tiles[tiles.length - 1];
  assert.equal(last.top + last.height, rect.top + rect.height, "must reach the bottom");
});

test("consecutive tiles overlap so a formula on a boundary stays whole", () => {
  const rect = { left: 0, top: 0, width: 400, height: 2000 };
  const tiles = planTiles(rect, 2);
  assert.ok(tiles.length > 1);
  for (let i = 1; i < tiles.length; i++) {
    const prevEnd = tiles[i - 1].top + tiles[i - 1].height;
    assert.ok(tiles[i].top < prevEnd, `tile ${i} does not overlap the previous one`);
  }
});

test("width is never split", () => {
  // Cutting a formula vertically would separate the two sides of an equation.
  const rect = { left: 0, top: 0, width: 3000, height: 400 };
  for (const t of planTiles(rect, 2)) {
    assert.equal(t.left, rect.left);
    assert.equal(t.width, rect.width);
  }
});

test("degenerate rectangles produce no tiles", () => {
  assert.deepEqual(planTiles({ left: 0, top: 0, width: 0, height: 100 }), []);
  assert.deepEqual(planTiles({ left: 0, top: 0, width: 100, height: 0 }), []);
});

test("scale never drops below the floor, so something always renders", () => {
  const huge = { left: 0, top: 0, width: 20000, height: 20000 };
  assert.ok(effectiveTileScale(huge, 2) >= 0.05);
});

test("scale never exceeds the requested scale", () => {
  // A tiny crop must not be blown up past the requested factor.
  const tiny = { left: 0, top: 0, width: 20, height: 10 };
  assert.ok(effectiveTileScale(tiny, 2) <= 2);
});

test("a wide selection is scaled by the side limit, then split", () => {
  // 6000x200 is only 1.2 Mpx, well under the 1.69 Mpx budget, so the *budget*
  // asks for no downscaling. The per-side limit still does: 6000 at 2x would be
  // 12000 px, and exceeding 8192 px fails the request rather than just looking
  // worse. So the scale lands on 8192/6000 and the height is divided.
  const rect = { left: 0, top: 0, width: 6000, height: 200 };
  const scale = effectiveTileScale(rect, 2);
  assert.ok(Math.abs(scale - MAX_IMAGE_DIMENSION / 6000) < 1e-9, `got ${scale}`);
  assert.ok(planTiles(rect, 2).length > 1);
});

test("the per-side limit is enforced even under the pixel budget", () => {
  // 6000 px wide at 2x would be 12000 px, over the 8192 px hard limit, which is
  // a request error rather than a quality loss.
  const rect = { left: 0, top: 0, width: 6000, height: 200 };
  const scale = effectiveTileScale(rect, 2);
  assert.ok(
    rect.width * scale <= MAX_IMAGE_DIMENSION,
    `scaled width ${rect.width * scale} exceeds the limit`,
  );
});

test("no tile ever exceeds the per-side limit", () => {
  for (const rect of [
    { left: 0, top: 0, width: 6000, height: 200 },
    { left: 0, top: 0, width: 20000, height: 20000 },
    { left: 0, top: 0, width: 1700, height: 2200 },
    { left: 0, top: 0, width: 100, height: 9000 },
  ]) {
    const scale = effectiveTileScale(rect, 2);
    for (const t of planTiles(rect, 2)) {
      assert.ok(
        t.width * scale <= MAX_IMAGE_DIMENSION + 1 &&
          t.height * scale <= MAX_IMAGE_DIMENSION + 1,
        `${t.width}x${t.height} @${scale} exceeds the limit`,
      );
    }
  }
});

test("image tokens follow the provider's flat per-image maximum", () => {
  // 2000x2000 and 5000x5000 cost the same after resampling.
  assert.equal(estimateImageTokens(1), 1024);
  assert.equal(estimateImageTokens(5), 5120);
  assert.equal(estimateImageTokens(0), 0);
});

console.log("\nlooksLikeFormulaSelection");
// Cases below are the real strings from a saved session, not invented ones.
test("accepts a single extracted formula", () => {
  // Verbatim from the text layer of Understanding Deep Learning, eq. 9.11.
  const text = "P r(φ|{xi, yi}) = ∏I i=1 P r(yi|xi, φ)P r(φ) ∫ ∏I i=1 P r(yi|xi, φ)P r(φ)dφ ,";
  assert.equal(
    looksLikeFormulaSelection(text, { width: 992, height: 120 }),
    true,
  );
});

test("accepts a short equation with a norm", () => {
  const text = "L̃GD [ϕ] = L[ϕ] + α ∂L 4 ∂ϕ 2 .";
  assert.equal(looksLikeFormulaSelection(text, { width: 700, height: 110 }), true);
});

test("rejects the long prose selection that contained formulas", () => {
  // Also verbatim: the 1127-character selection from the same session, which
  // is exactly the case a screenshot would ruin — downscaled until the
  // embedded formulas are unreadable.
  const text =
    "The maximum likelihood approach is generally overconfident; it selects the most likely " +
    "parameters during training and uses these to make predictions. However, many parameter " +
    "values may be broadly compatible with the data and only slightly less likely. The Bayesian " +
    "approach treats the parameters as unknown variables, and computes a distribution over these " +
    "parameters conditioned on the training data using Bayes rule:";
  assert.equal(
    looksLikeFormulaSelection(text, { width: 1782, height: 348 }),
    false,
  );
});

test("rejects plain prose", () => {
  assert.equal(
    looksLikeFormulaSelection(
      "This is effectively an infinite weighted ensemble, where the weight depends on the prior.",
      { width: 900, height: 60 },
    ),
    false,
  );
});

test("rejects a symbol-dense but multi-line block", () => {
  // Symbol ratio is high, but it spans many lines: not a single formula.
  const text = "a = b + c\nd = e - f\ng = h * i\nj = k / l";
  assert.equal(looksLikeFormulaSelection(text, { width: 300, height: 400 }), false);
});

test("rejects empty text", () => {
  assert.equal(looksLikeFormulaSelection("", { width: 100, height: 20 }), false);
  assert.equal(looksLikeFormulaSelection("   ", { width: 100, height: 20 }), false);
});

test("handles a zero-width rect without dividing by zero", () => {
  assert.doesNotThrow(() =>
    looksLikeFormulaSelection("x = y", { width: 0, height: 10 }),
  );
});

console.log("\nfindAnySelection");
// The panel lives in the reader window while the PDF is in a nested frame, so
// the outermost getSelection() is always empty.
function fakeWindow(opts: {
  text?: string;
  children?: any[];
  throwsOnDocument?: boolean;
}) {
  const win: any = {
    frames: [],
    getSelection: () => ({
      rangeCount: opts.text ? 1 : 0,
      toString: () => opts.text ?? "",
    }),
  };
  if (opts.throwsOnDocument) {
    Object.defineProperty(win, "document", {
      get() {
        throw new Error("cross-origin");
      },
    });
  } else {
    win.document = {};
  }
  win.frames = opts.children ?? [];
  return win;
}

test("finds a selection in a child frame", () => {
  const inner = fakeWindow({ text: "E = mc^2" });
  const outer = fakeWindow({ text: "", children: [inner] });
  assert.ok(findAnySelection(outer));
});

test("returns the outermost non-empty selection when there is one", () => {
  const child = fakeWindow({ text: "child" });
  const outer = fakeWindow({ text: "outer", children: [child] });
  const found = findAnySelection(outer)!;
  assert.equal(String(found.toString()), "outer");
});

test("skips a frame whose document throws", () => {
  const bad = fakeWindow({ text: "hidden", throwsOnDocument: true });
  const good = fakeWindow({ text: "visible" });
  const outer = fakeWindow({ text: "", children: [bad, good] });
  assert.ok(findAnySelection(outer));
});

test("returns null when nothing is selected", () => {
  assert.equal(findAnySelection(fakeWindow({ text: "" })), null);
  assert.equal(findAnySelection(null), null);
});

test("does not recurse forever", () => {
  // A self-referencing frame list must terminate.
  const outer = fakeWindow({ text: "" });
  outer.frames = [outer];
  assert.doesNotThrow(() => findAnySelection(outer, 0));
});

console.log("\nscreenshot geometry");
// This maths is where a screenshot silently captures the wrong region, which
// then looks like a model failure rather than a bug.
test("scales a text-layer rect into canvas pixels", () => {
  // Page laid out at 600x800 CSS px, drawn into a canvas at 1200x1600 (2x DPR).
  const out = scaleRectToCanvas(
    { left: 110, top: 210, width: 100, height: 20 },
    { left: 100, top: 200, width: 600, height: 800 },
    1200,
    1600,
  );
  assert.deepEqual(out, { left: 20, top: 20, width: 200, height: 40 });
});

test("handles zoom as well as device pixel ratio", () => {
  // Same page at 1.5x zoom: the layer box grows, so the scale shrinks.
  const out = scaleRectToCanvas(
    { left: 150, top: 300, width: 150, height: 30 },
    { left: 0, top: 0, width: 900, height: 1200 },
    1200,
    1600,
  );
  assert.deepEqual(out, { left: 200, top: 400, width: 200, height: 40 });
});

test("degenerate layer box yields an empty rect instead of Infinity", () => {
  const out = scaleRectToCanvas(
    { left: 1, top: 1, width: 1, height: 1 },
    { left: 0, top: 0, width: 0, height: 0 },
    100,
    100,
  );
  assert.deepEqual(out, { left: 0, top: 0, width: 0, height: 0 });
});

test("grows a tight selection to the full line height", () => {
  // A selection 6px tall in a 20px line box should gain 7px on each side.
  const out = expandForFormula({ left: 10, top: 10, width: 50, height: 6 }, 20, 1, 2);
  assert.equal(out.top, 10 - 7 - 2);
  assert.equal(out.height, 6 + 14 + 4);
});

test("never shrinks a selection taller than its line height", () => {
  const out = expandForFormula({ left: 0, top: 0, width: 10, height: 40 }, 20, 1, 0);
  assert.equal(out.height, 40);
  assert.equal(out.top, 0);
});

test("clamps to the canvas and rounds to whole pixels", () => {
  const out = clampRect(
    { left: -5.4, top: -2.2, width: 30.8, height: 12.6 },
    100,
    100,
  );
  assert.equal(out.left, 0);
  assert.equal(out.top, 0);
  assert.ok(Number.isInteger(out.width) && Number.isInteger(out.height));
  assert.ok(out.left + out.width <= 100);
  assert.ok(out.top + out.height <= 100);
});

test("clamping an off-canvas rect produces nothing usable", () => {
  const out = clampRect({ left: 500, top: 500, width: 50, height: 50 }, 100, 100);
  assert.equal(isUsableRect(out), false);
});

test("rejects rects too small to be worth sending", () => {
  assert.equal(isUsableRect({ left: 0, top: 0, width: 3, height: 30 }), false);
  assert.equal(isUsableRect({ left: 0, top: 0, width: 30, height: 30 }), true);
});

test("unions the lines of a wrapped formula", () => {
  const out = unionRects([
    { left: 10, top: 10, width: 100, height: 20 },
    { left: 20, top: 40, width: 60, height: 20 },
  ])!;
  assert.equal(out.left, 10);
  assert.equal(out.top, 10);
  assert.equal(out.width, 100);
  assert.equal(out.height, 50);
});

test("union of nothing is null", () => {
  assert.equal(unionRects([]), null);
});

test("estimates decoded PNG size from a data URL", () => {
  // 8 base64 chars = 6 bytes.
  assert.equal(dataUrlBytes("data:image/png;base64,AAAAAAAA"), 6);
  assert.equal(dataUrlBytes("not-a-data-url"), 0);
});

console.log("\nSI detection");
// The authoritative signal is the document's own front matter — that is what
// publishers print on the first page of supporting material, and unlike a
// filename rule it works for Word files and HTML too.
test("recognises real first pages from a library", () => {
  // Verbatim openings of the two SI PDFs found in a real library.
  const acs = "Supporting Information for:\nModeling exchange reactions in covalent adaptable networks\nYaguang Sun1, Kaiwei Wan1,2";
  const wiley = "Supporting Information\nfor Adv. Sci., DOI 10.1002/advs.202411385\nAI-Guided Inverse Design";
  assert.equal(isSupportingInfo({ name: "ma3c01377_si_001.pdf", frontMatter: acs }).why, "declared");
  assert.equal(isSupportingInfo({ name: "advs10440-sup-0001-suppmat.pdf", frontMatter: wiley }).why, "declared");
});

test("recognises a bare heading, with or without the (SI) brackets", () => {
  for (const front of [
    "Supporting Information",
    "Supplementary Material",
    "Electronic Supplementary Material",
    "SI\nFigure S1. NMR spectra",
    "(SI)",
  ]) {
    assert.equal(
      isSupportingInfo({ name: "x.pdf", frontMatter: front }).yes,
      true,
      `should declare itself: ${JSON.stringify(front)}`,
    );
  }
});

test("does not fire on an article that merely mentions SI", () => {
  // This was a real false positive: a loose /supporting information/i matched
  // an abstract sentence and sent the article itself as SI.
  const mention = "A Study of Something\nAbstract: Details are given in the Supporting Information.\nIntroduction";
  assert.equal(isSupportingInfo({ name: "paper.pdf", frontMatter: mention }).yes, false);
  const citation = "Results\nSee Supplementary Material for details.";
  assert.equal(isSupportingInfo({ name: "paper.pdf", frontMatter: citation }).yes, false);
});

test("does not fire on a journal front page", () => {
  const front = "Chemical Physics Letters 760 (2020) 137966\nContents lists available at ScienceDirect\nResearch paper";
  assert.equal(isSupportingInfo({ name: "1-s2.0-...-main.pdf", frontMatter: front }).yes, false);
});

test("filename is only a fallback, and only when siblings exist", () => {
  // An unindexed scan has no text to read; the obvious publisher suffixes still
  // help. A wrong filename alone must not be enough.
  const v = isSupportingInfo({ name: "ma3c01377_si_001.pdf" });
  assert.equal(v.why, "filename");
});

test("the old false positive stays fixed", () => {
  // Title ends in a standalone "Si"; no content declaration is present.
  const name = "Shafe 等 - 2024 - Identification and Design of Better Diamine-Hardened Epoxy-Based Thermoset Shape Memory Polymers Si.pdf";
  assert.equal(looksLikeSupportingFilename(name), false);
  assert.equal(isSupportingInfo({ name }).yes, false);
});

test("filename rules stay narrow", () => {
  for (const name of [
    "ma3c01377_si_001.pdf",
    "advs10440-sup-0001-suppmat.pdf",
    "1-s2.0-S0009261420308812-mmc1.pdf",
    "paper_ESI.pdf",
  ]) {
    assert.equal(looksLikeSupportingFilename(name), true, `should match: ${name}`);
  }
  for (const name of [
    "1-s2.0-S0009261420308812-main.pdf",
    "UnderstandingDeepLearning_02_09_26_C.pdf",
    "高等代数 上册 第二版.pdf",
    "situ_synthesis.pdf",
    "simple_model.pdf",
  ]) {
    assert.equal(looksLikeSupportingFilename(name), false, `should not match: ${name}`);
  }
});

test("empty front matter never declares itself", () => {
  assert.equal(declaresItselfSupportingInfo(""), false);
  assert.equal(declaresItselfSupportingInfo("   \n  "), false);
  assert.equal(isSupportingInfo({ name: "x.pdf", frontMatter: "" }).yes, false);
});

console.log("\nbundleSize");
test("estimates tokens from character counts", () => {
  const bundle = {
    selection: "x",
    annotations: [],
    notes: [],
    fullTextTruncated: false,
    supportingInfo: [],
    summary: [],
    sizes: [{ label: "选中片段", chars: 300 }],
  };
  assert.equal(bundleSize(bundle as any).tokens, 100);
});

test("sums the parts and keeps the breakdown", () => {
  const bundle = {
    selection: "x",
    annotations: [],
    notes: [],
    fullTextTruncated: false,
    supportingInfo: [],
    summary: [],
    sizes: [
      { label: "选中片段", chars: 300 },
      { label: "全文", chars: 3000 },
    ],
  };
  const r = bundleSize(bundle as any);
  assert.equal(r.tokens, 1100);
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts[1].label, "全文");
});

console.log("\nhtmlToText (notes)");
test("strips markup and keeps the words", () => {
  assert.equal(htmlToText("<p>hello <b>world</b></p>"), "hello world");
});

test("turns block boundaries into line breaks", () => {
  const out = htmlToText("<p>one</p><p>two</p>");
  assert.equal(out, "one\ntwo");
});

test("renders list items as bullets", () => {
  const out = htmlToText("<ul><li>a</li><li>b</li></ul>");
  assert.ok(out.includes("- a"), out);
  assert.ok(out.includes("- b"), out);
});

test("drops script and style bodies entirely", () => {
  // A note can contain pasted HTML; its scripts must not reach the prompt.
  const out = htmlToText("<style>p{color:red}</style><p>x</p><script>evil()</script>");
  assert.ok(!out.includes("color:red"), out);
  assert.ok(!out.includes("evil"), out);
  assert.ok(out.includes("x"));
});

test("decodes the entities Zotero notes contain", () => {
  assert.equal(htmlToText("<p>a &amp; b &lt;c&gt; &nbsp;d</p>"), "a & b <c>  d");
});

test("collapses excessive blank lines", () => {
  const out = htmlToText("<p>a</p><p></p><p></p><p>b</p>");
  assert.ok(!/\n{3,}/.test(out), JSON.stringify(out));
});

test("handles </br> and empty input", () => {
  assert.doesNotThrow(() => htmlToText("<br>"));
  assert.equal(htmlToText(""), "");
});

console.log("\nformatAnnotations");
test("lists highlights and comments with page labels", () => {
  const out = formatAnnotations([
    { text: "important result", comment: "why?", page: "42" },
  ]);
  assert.ok(out.includes("第 42 页"), out);
  assert.ok(out.includes("高亮：important result"), out);
  assert.ok(out.includes("批注：why?"), out);
});

test("returns empty for no annotations", () => {
  assert.equal(formatAnnotations([]), "");
});

test("caps the number of entries and says how many were dropped", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    text: `h${i}`,
    comment: "",
  }));
  const out = formatAnnotations(many, 3);
  assert.ok(out.includes("h0") && out.includes("h2"), out);
  assert.ok(!out.includes("h5"), "should have stopped at the cap");
  assert.ok(out.includes("另有 7 条"), out);
});

test("caps total length so annotations cannot crowd out the passage", () => {
  const out = formatAnnotations(
    [
      { text: "x".repeat(500), comment: "" },
      { text: "y".repeat(500), comment: "" },
    ],
    40,
    600,
  );
  assert.ok(out.length < 800, `too long: ${out.length}`);
});

test("keeps a comment-only annotation", () => {
  // A reader may comment without highlighting anything.
  const out = formatAnnotations([{ text: "", comment: "note to self" }]);
  assert.ok(out.includes("note to self"), out);
});

console.log("\ndecodeEntities");
test("decodes numeric entities in both bases", () => {
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
});

test("decodes the named entities KaTeX emits", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;"), "&<>\"");
});

test("leaves unknown entities alone rather than mangling them", () => {
  assert.equal(decodeEntities("&notreal;"), "&notreal;");
});

console.log("\nparseHtmlToMathNodes");
function collect(node: MathNode, out: { tags: string[]; classes: string[]; text: string }) {
  if (node.tag === "#text") {
    out.text += node.attrs.value ?? "";
    return out;
  }
  out.tags.push(node.tag);
  if (node.attrs.class) {
    out.classes.push(node.attrs.class);
  }
  for (const c of node.children) collect(c, out);
  return out;
}
/**
 * Inspect parsed markup, skipping the synthetic wrapper.
 *
 * `parseHtmlToMathNodes` returns a root `<span>` that holds the top-level
 * nodes, so the wrapper is not part of what the caller sees.
 */
function inspect(html: string) {
  const out = { tags: [] as string[], classes: [] as string[], text: "" };
  for (const child of parseHtmlToMathNodes(html).children) {
    collect(child, out);
  }
  return out;
}

test("parses nested elements and preserves text", () => {
  const r = inspect(
    '<span class="katex"><span class="mord">x</span></span>',
  );
  assert.deepEqual(r.tags, ["span", "span"]); // tags, not class names
  assert.ok(r.classes.includes("katex"));
  assert.equal(r.text, "x");
});

test("handles self-closing and void tags", () => {
  const r = inspect("<span>a<br/>b</span>");
  assert.equal(r.text, "ab");
  assert.ok(r.tags.includes("br"));
});

test("preserves inline styles as attributes", () => {
  const node = parseHtmlToMathNodes('<span style="height:0.8em">x</span>');
  const span = node.children.find((c) => c.tag === "span")!;
  assert.equal(span.attrs.style, "height:0.8em");
});

test("drops comments and doctypes", () => {
  const r = inspect("<!-- c --><span>x</span>");
  assert.deepEqual(r.tags, ["span"]);
  assert.equal(r.text, "x");
});

test("repairs malformed nesting instead of throwing", () => {
  assert.doesNotThrow(() => inspect("<span><span>x</span>"));
  assert.doesNotThrow(() => inspect("<span>x</span></span>"));
  assert.doesNotThrow(() => inspect("<span"));
  assert.doesNotThrow(() => inspect(""));
});

test("escaped markup in the source stays text", () => {
  // A formula containing "<b>" must not become an element.
  const node = parseHtmlToMathNodes("<span>&lt;b&gt;</span>");
  const r = { tags: [] as string[], classes: [] as string[], text: "" };
  for (const child of node.children) collect(child, r);
  assert.equal(r.text, "<b>");
  assert.deepEqual(r.tags, ["span"]);
});

console.log("\nKaTeX integration");
/** Concatenate all visible text in a tree. */
const FLAT = (n: MathNode): string =>
  n.tag === "#text" ? (n.attrs.value ?? "") : n.children.map(FLAT).join("");

test("renders the accented symbols the hand-written renderer dropped", () => {
  // KaTeX stacks the accent over the base with two positioned spans rather than
  // using a combining character, so the text is "L" + "~" and the positioning
  // comes from its stylesheet (which we inject).
  const node = latexToNodes("\\tilde{L}", false);
  const r = collect(node, { tags: [], classes: [], text: "" });
  assert.ok(r.classes.some((c) => c.includes("accent")), r.classes.join("|"));
  assert.ok(r.text.includes("L"), `base letter missing: ${r.text}`);
  assert.ok(r.text.includes("~"), `accent mark missing: ${r.text}`);
});

test("blackboard bold and script letters carry KaTeX's font classes", () => {
  // The glyph comes from KaTeX's font via a class such as `mathbb`; the text
  // layer stays the plain letter, which is correct (and copy-pastes as "R").
  for (const [tex, letter] of [
    ["\\mathbb{R}", "R"],
    ["\\mathcal{L}", "L"],
    ["\\mathfrak{g}", "g"],
  ] as Array<[string, string]>) {
    const r = collect(latexToNodes(tex, false), {
      tags: [],
      classes: [],
      text: "",
    });
    assert.equal(r.text, letter, `${tex} text layer`);
    assert.ok(
      r.classes.some((c) => /mathbb|mathcal|mathfrak|mathnormal|mord/.test(c)),
      `${tex} lost its font class: ${r.classes.join("|")}`,
    );
  }
});

test("renders nabla and norm bars", () => {
  const out = FLAT(latexToNodes("\\|\\nabla L\\|", false));
  assert.ok(out.includes("\u2207"), `nabla missing: ${out}`);
  // KaTeX uses U+2225 PARALLEL TO for \| rather than U+2016 DOUBLE VERTICAL LINE.
  assert.ok(out.includes("\u2225"), `norm bars missing: ${out}`);
});

test("covers notation the hand-written renderer never supported", () => {
  // If these ever fail, the bundled KaTeX has been replaced by something else.
  for (const tex of [
    "\\overset{a}{b}",
    "\\binom{n}{k}",
    "\\begin{cases} a & x > 0 \\\\ b & x \\le 0 \\end{cases}",
    "\\underbrace{x}_{y}",
    "\\xrightarrow{f}",
    "\\substack{a \\\\ b}",
  ]) {
    const out = FLAT(latexToNodes(tex, true));
    assert.ok(out.length > 0, `${tex} produced nothing`);
    assert.ok(!out.includes("\\"), `${tex} leaked a backslash: ${out}`);
  }
});

test("keeps KaTeX's own class names so its stylesheet applies", () => {
  const r = collect(latexToNodes("x", false), { tags: [], classes: [], text: "" });
  assert.ok(r.classes.some((c) => c.includes("katex")), r.classes.join("|"));
});

test("display mode produces a display wrapper", () => {
  const r = collect(latexToNodes("x", true), { tags: [], classes: [], text: "" });
  assert.ok(
    r.classes.some((c) => c.includes("katex-display")),
    r.classes.join("|"),
  );
});

test("a malformed formula does not throw", () => {
  // throwOnError:false renders it in red instead.
  assert.doesNotThrow(() => FLAT(latexToNodes("\\frac{a}{", false)));
  assert.doesNotThrow(() => FLAT(latexToNodes("\\notacommand{x}", false)));
  assert.doesNotThrow(() => FLAT(latexToNodes("{{{", false)));
});

test("the colour is marked on errors so the UI can flag them", () => {
  const node = latexToNodes("\\frac{a}{", false);
  const json = JSON.stringify(node);
  assert.ok(json.includes("b45309") || json.includes("katex-error"), json.slice(0, 200));
});

test("buildMathNodes needs only a document, no DOM globals", () => {
  // The sandbox does not guarantee Element/Node constructors.
  const created: string[] = [];
  const fakeDoc = {
    createElement(tag: string) {
      created.push(tag);
      return {
        setAttribute() {},
        appendChild() {},
      };
    },
    createTextNode(text: string) {
      created.push("#text");
      return { text };
    },
  } as unknown as Document;
  const tree = latexToNodes("x^2", false);
  assert.doesNotThrow(() => buildMathNodes(tree, fakeDoc));
  assert.ok(created.length > 0);
});

console.log("\nKaTeX stylesheet");
// The fonts ship with the addon. An earlier version pointed the font URLs at
// Zotero's own copies, whose filenames carry a build-time hash; every request
// 404'd and formulas fell back to a system serif, which reads as a broken
// formula rather than a missing font.
test("trims font sources to woff2, the only format shipped", () => {
  const css =
    '@font-face{font-family:KaTeX_Main;src:url(fonts/a.woff2) format("woff2"),' +
    'url(fonts/a.woff) format("woff"),url(fonts/a.ttf) format("truetype")}';
  const out = keepWoff2FontFaces(css);
  assert.ok(out.includes("a.woff2"), out);
  assert.ok(!out.includes('a.woff)'), out);
  assert.ok(!out.includes("a.ttf"), out);
});

test("keeps every font face, not just the first", () => {
  const css =
    "@font-face{font-family:A;src:url(fonts/a.woff2)}" +
    "@font-face{font-family:B;src:url(fonts/b.woff2)}";
  const out = keepWoff2FontFaces(css);
  assert.equal((out.match(/@font-face/g) || []).length, 2, out);
});

test("the font-face pass drops layout rules", () => {
  const css = "@font-face{src:url(fonts/a.woff2)}.katex{color:red}";
  const out = keepWoff2FontFaces(css);
  assert.ok(!out.includes(".katex"), out);
});

test("stripFontFaces leaves the layout rules behind", () => {
  const css = "@font-face{src:url(fonts/a.woff2)}.katex{color:red}.mord{margin:0}";
  const out = stripFontFaces(css);
  assert.ok(!out.includes("@font-face"), out);
  assert.ok(out.includes(".katex"));
  assert.ok(out.includes(".mord"));
});

test("font URLs are made absolute against the addon", () => {
  // A relative URL inside an injected <style> resolves against the document
  // URL, not the stylesheet's location, so `../assets/fonts/x.woff2` looked for
  // the font beside the reader page and never found it. Missing fonts are what
  // make super/subscripts look cramped.
  const base = "resource://highlight-ask/assets/fonts/";
  const css = '@font-face{src:url(../assets/fonts/a.woff2) format("woff2")}';
  const out = keepWoff2FontFaces(css, base);
  assert.ok(out.includes(`${base}a.woff2`), out);
});

test("every relative spelling normalises to the same absolute URL", () => {
  const base = "resource://highlight-ask/assets/fonts/";
  const want = `${base}a.woff2`;
  for (const url of [
    "../assets/fonts/a.woff2",
    "fonts/a.woff2",
    "assets/fonts/a.woff2",
    "a.woff2",
  ]) {
    const out = keepWoff2FontFaces(
      `@font-face{src:url(${url}) format("woff2")}`,
      base,
    );
    assert.ok(out.includes(want), `${url} -> ${out}`);
    assert.ok(!out.includes("/assets/fonts/assets"), `doubled path: ${out}`);
  }
});

test("absolute and data URLs are left alone", () => {
  const base = "resource://highlight-ask/assets/fonts/";
  for (const url of [
    "https://cdn.example/a.woff2",
    "data:font/woff2;base64,AAAA",
    "resource://other/a.woff2",
  ]) {
    const out = keepWoff2FontFaces(
      `@font-face{src:url(${url}) format("woff2")}`,
      base,
    );
    assert.ok(out.includes(url), `${url} was rewritten: ${out}`);
  }
});

test("the woff fallback is dropped even when it comes first", () => {
  const css =
    '@font-face{src:url(fonts/a.woff) format("woff"),url(fonts/a.woff2) format("woff2")}';
  const out = keepWoff2FontFaces(css, "resource://x/assets/fonts/");
  assert.ok(out.includes("a.woff2"), out);
  assert.ok(!out.includes("a.woff)"), out);
});

console.log("\nabort capability");
test("canAbort() reflects whether AbortController exists", () => {
  // Node has it; Zotero's plugin sandbox does not.
  assert.equal(canAbort(), typeof AbortController !== "undefined");
});

test("makeAbortController returns a usable pair when available", () => {
  const handle = makeAbortController();
  if (typeof AbortController === "undefined") {
    assert.equal(handle, null);
    return;
  }
  assert.ok(handle, "expected a controller in an environment that has one");
  assert.equal(handle.signal.aborted, false);
  handle.controller.abort();
  assert.equal(handle.signal.aborted, true);
});

test("makeAbortController degrades instead of throwing when absent", () => {
  // This is the Zotero case that broke the request outright: referencing the
  // undefined global threw ReferenceError and no request was ever sent.
  const original = (globalThis as any).AbortController;
  delete (globalThis as any).AbortController;
  try {
    assert.equal(canAbort(), false);
    assert.equal(makeAbortController(), null);
  } finally {
    (globalThis as any).AbortController = original;
  }
  assert.equal(canAbort(), true);
});

console.log("\npickSessionFiles");
test("does not confuse item 1 with item 10", () => {
  // A plain startsWith("item1-") would also match item10-, showing one paper
  // another paper's conversation.
  const names = [
    "item10-2026-01-01T00-00-00-000.json",
    "item1-2026-01-02T00-00-00-000.json",
  ];
  assert.deepEqual(pickSessionFiles(names, 1), ["item1-2026-01-02T00-00-00-000.json"]);
  assert.deepEqual(pickSessionFiles(names, 10), ["item10-2026-01-01T00-00-00-000.json"]);
});

test("ignores files that are not sessions", () => {
  const names = ["item5-a.json", "item5-a.json.tmp", "notes.txt", "itemx-a.json"];
  assert.deepEqual(pickSessionFiles(names, 5), ["item5-a.json"]);
});

test("returns oldest first so the newest can be taken last", () => {
  const names = [
    "item3-b.json",
    "item3-a.json",
    "item3-c.json",
  ];
  assert.deepEqual(pickSessionFiles(names, 3), [
    "item3-a.json",
    "item3-b.json",
    "item3-c.json",
  ]);
});

test("returns an empty list when the item has no sessions", () => {
  assert.deepEqual(pickSessionFiles(["item9-a.json"], 4), []);
  assert.deepEqual(pickSessionFiles([], 4), []);
});

// The preference pane script needs its own sandboxed runner.
registerPreferencesPaneTests(test);

await Promise.all(pending);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
