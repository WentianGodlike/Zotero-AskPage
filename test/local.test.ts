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
(globalThis as any).Zotero = { debug: () => {} };

import { normalizeSelection } from "../src/modules/readerPopup";
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
import {
  htmlToText,
  formatAnnotations,
  looksLikeSupportingInfo,
  bundleSize,
} from "../src/modules/context";
import {
  decodeEntities,
  parseHtmlToMathNodes,
  rewriteFontFaces,
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
const NOTE_HEADING = "Highlight Ask 会话";

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
(globalThis as any).Zotero = {
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

console.log("\nlooksLikeSupportingInfo");
// Patterns taken from a real library. Mistaking the article for SI would send
// the wrong document; mistaking SI for the article loses the derivations.
test("recognises the publishers' actual SI filenames", () => {
  for (const name of [
    "ma3c01377_si_001.pdf", // ACS
    "advs10440-sup-0001-suppmat.pdf", // Wiley
    "supporting information.pdf",
    "paper_SI_v2.pdf",
    "SI_1.pdf",
    "paper_ESI.pdf", // RSC
    "1-s2.0-S0009261420308812-mmc1.pdf", // Elsevier supplementary
    "appendix.pdf",
  ]) {
    assert.equal(looksLikeSupportingInfo(name), true, `should be SI: ${name}`);
  }
});

test("does not mistake the article for SI", () => {
  for (const name of [
    "Sun 等 - 2026 - Advanced Multifunctional Vitrimer-Based Composites.pdf",
    "UnderstandingDeepLearning_02_09_26_C.pdf",
    "1-s2.0-S0009261420308812-main.pdf",
    "高等代数 上册 第二版.pdf",
    "paper.pdf",
    // Real false positive from a library: the title ends in a standalone "Si".
    // Matching a bare "si" token sent the article itself as Supporting
    // Information, which is the dangerous direction of error.
    "Shafe 等 - 2024 - Identification and Design of Better Diamine-Hardened Epoxy-Based Thermoset Shape Memory Polymers Si.pdf",
    "Kanduč 等 - 2024 - Molecular dynamics simulations as support for experimental studies.pdf",
  ]) {
    assert.equal(looksLikeSupportingInfo(name), false, `should NOT be SI: ${name}`);
  }
});

test("does not fire on words that merely contain the letters", () => {
  // "situ", "simple", "design" all contain "si" but are not SI.
  for (const name of ["situ_synthesis.pdf", "simple_model.pdf", "design.pdf"]) {
    assert.equal(looksLikeSupportingInfo(name), false, `false positive: ${name}`);
  }
});

test("handles paths, extensions and empty input", () => {
  assert.equal(looksLikeSupportingInfo("storage:abc/paper_si_001.pdf"), true);
  assert.equal(looksLikeSupportingInfo(""), false);
  assert.equal(looksLikeSupportingInfo("   "), false);
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
test("rewrites font URLs to Zotero's copies", () => {
  // The bundled CSS says `fonts/...`; Zotero keeps them under assets/fonts/.
  const css = '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2)}';
  const out = rewriteFontFaces(css);
  assert.ok(
    out.includes("resource://zotero/note-editor/assets/fonts/KaTeX_Main-Regular.woff2"),
    out,
  );
});

test("keeps both woff2 and woff fallbacks", () => {
  const css =
    '@font-face{src:url(fonts/a.woff2) format("woff2"),url(fonts/a.woff) format("woff")}';
  const out = rewriteFontFaces(css);
  assert.ok(out.includes("assets/fonts/a.woff2"));
  assert.ok(out.includes("assets/fonts/a.woff"));
});

test("only font-face blocks are kept by the rewriter", () => {
  const css = '@font-face{src:url(fonts/a.woff2)}.katex{color:red}';
  const out = rewriteFontFaces(css);
  assert.ok(out.includes("@font-face"));
  assert.ok(!out.includes(".katex"), out);
});

test("stripFontFaces leaves the layout rules behind", () => {
  const css = '@font-face{src:url(fonts/a.woff2)}.katex{color:red}.mord{margin:0}';
  const out = stripFontFaces(css);
  assert.ok(!out.includes("@font-face"), out);
  assert.ok(out.includes(".katex"));
  assert.ok(out.includes(".mord"));
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
