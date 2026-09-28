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
import { buildEndpoint, DeepSeekError, parseThinkingParams } from "../src/modules/deepseek";
import { renderMarkdown } from "../src/modules/markdown";
import { HIGHLIGHT_ASK_PROVIDERS } from "../src/data/providers.data";
import { validateSettings, getProvider } from "../src/modules/providers";
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

// The preference pane script needs its own sandboxed runner.
registerPreferencesPaneTests(test);

await Promise.all(pending);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
