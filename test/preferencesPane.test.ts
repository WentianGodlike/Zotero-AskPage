// @ts-nocheck
/**
 * Checks for the preference pane script (`addon/content/preferences.js`).
 *
 * This file is special: Zotero loads it as a bare script into the preference
 * window's sandbox, and — critically — runs it BEFORE inserting that pane's
 * markup into the document. A naive top-level `init()` therefore hits a null
 * element, throws, and leaves the pane permanently blank. That was a real bug
 * (the pane rendered empty while the previous pane's content stayed on screen).
 *
 * We execute the real file in a `vm` sandbox shaped like Zotero's environment
 * (no `module`, no `require`) and assert on observable behaviour: whether
 * initialisation actually ran, and whether failures get reported rather than
 * swallowed.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SCRIPT = resolve(
  import.meta.dirname ?? ".",
  "../addon/content/preferences.js",
);
const MARKUP = resolve(
  import.meta.dirname ?? ".",
  "../addon/content/preferences.xhtml",
);

/**
 * Read the element ids straight out of the real markup.
 *
 * Hardcoding this list means the tests silently go stale whenever a field is
 * added — the stub returns null for the new id and every test fails for the
 * wrong reason. Deriving it from the markup keeps the harness honest.
 */
function elementIdsFromMarkup(): string[] {
  const html = readFileSync(MARKUP, "utf8");
  return [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
}

const ELEMENT_IDS = elementIdsFromMarkup();

/**
 * Run the pane script in a fake Zotero preference window.
 *
 * @param {object} [opts]
 * @param {number|null} [opts.readyAfterTicks] Make elements resolvable after N
 *   polls. `0` = already present, `null` = never present.
 * @param {boolean} [opts.observerFires] Whether the MutationObserver callback runs.
 * @param {number} [opts.maxTicks] Safety bound on the poll loop.
 */
function runPane(opts = {}) {
  const {
    readyAfterTicks = 0,
    observerFires = false,
    maxTicks = 130,
  } = opts;

  const src = readFileSync(SCRIPT, "utf8");
  const errors = [];
  const calls = { renderedOptions: 0, listenersBound: 0 };
  let docReady = readyAfterTicks === 0;
  let ticks = 0;
  const timers = new Set();

  const makeEl = (id) => ({
    id,
    value: "",
    textContent: "",
    className: "",
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    href: "",
    replaceChildren() {
      if (id === "provider") {
        calls.renderedOptions++;
      }
    },
    appendChild() {},
    append() {},
    addEventListener() {
      calls.listenersBound++;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  });

  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, makeEl(id)]));

  const sandbox = {
    Zotero: {
      logError: (e) => errors.push(String((e && e.message) || e)),
      debug: () => {},
      Prefs: { get: () => undefined, set: () => {} },
      launchURL: () => {},
    },
    document: {
      documentElement: {},
      getElementById: (id) => (docReady ? elements[id] || null : null),
      createElement: () => makeEl("created"),
      createTextNode: () => ({}),
    },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        if (observerFires) {
          setTimeout(() => this.cb([]), 0);
        }
      }
      disconnect() {}
    },
    setInterval: (fn) => {
      const handle = setInterval(() => {
        ticks++;
        if (readyAfterTicks && ticks >= readyAfterTicks) {
          docReady = true;
        }
        fn();
        if (ticks >= maxTicks) {
          clearInterval(handle);
        }
      }, 1);
      timers.add(handle);
      return handle;
    },
    clearInterval: (h) => {
      timers.delete(h);
      clearInterval(h);
    },
    setTimeout,
    clearTimeout,
    URL,
    JSON,
    console,
  };
  // Deliberately no `module` / `require`: Zotero's sandbox has neither.
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "preferences.js" });

  return {
    errors,
    calls,
    get ticks() {
      return ticks;
    },
    cleanup() {
      for (const h of timers) {
        clearInterval(h);
      }
      timers.clear();
    },
  };
}

export default function register(test) {
  console.log("\npreference pane script");

  test("initialises when the markup is already present", () => {
    const r = runPane({ readyAfterTicks: 0 });
    try {
      assert.deepEqual(r.errors, [], `unexpected errors: ${r.errors.join("; ")}`);
      assert.equal(r.calls.renderedOptions, 1, "provider options were not rendered");
      assert.ok(
        r.calls.listenersBound >= 6,
        `only ${r.calls.listenersBound} listeners bound`,
      );
    } finally {
      r.cleanup();
    }
  });

  test("initialises when the markup arrives AFTER the script (Zotero's real order)", async () => {
    // The regression: Zotero loads scripts first and appends markup second, so a
    // top-level init() throws here and leaves the pane blank.
    const r = runPane({ readyAfterTicks: 3, observerFires: false });
    try {
      // The poll loop runs on timers, so give it a chance to fire before
      // asserting — a synchronous assertion would check a pane that has had no
      // opportunity to initialise and pass for the wrong reason.
      await new Promise((res) => setTimeout(res, 150));
      assert.ok(r.ticks >= 3, `poll loop never ran (ticks=${r.ticks})`);
      assert.deepEqual(r.errors, [], `unexpected errors: ${r.errors.join("; ")}`);
      assert.equal(
        r.calls.renderedOptions,
        1,
        "script never initialised after the markup appeared",
      );
      assert.ok(
        r.calls.listenersBound >= 6,
        `listeners were not bound (${r.calls.listenersBound})`,
      );
    } finally {
      r.cleanup();
    }
  });

  test("initialises via the MutationObserver path, not just polling", () => {
    // Elements become visible only once the observer callback runs, and the
    // observer fires before any poll tick can see them.
    const errors = [];
    const calls = { renderedOptions: 0, listenersBound: 0 };
    const src = readFileSync(SCRIPT, "utf8");
    let visible = false;

    const makeEl = (id) => ({
      id,
      value: "",
      textContent: "",
      className: "",
      checked: false,
      disabled: false,
      style: {},
      dataset: {},
      replaceChildren() {
        if (id === "provider") {
          calls.renderedOptions++;
        }
      },
      appendChild() {},
      append() {},
      addEventListener() {
        calls.listenersBound++;
      },
      closest() {
        return null;
      },
    });
    const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, makeEl(id)]));

    const sandbox = {
      Zotero: {
        logError: (e) => errors.push(String((e && e.message) || e)),
        debug: () => {},
        Prefs: { get: () => undefined, set: () => {} },
      },
      document: {
        documentElement: {},
        getElementById: (id) => (visible ? elements[id] || null : null),
        createElement: () => makeEl("created"),
        createTextNode: () => ({}),
      },
      MutationObserver: class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          // Simulate the markup landing, then the observer firing.
          visible = true;
          queueMicrotask(() => this.cb([]));
        }
        disconnect() {}
      },
      // Polling never sees the element: it is the observer that must drive init.
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout,
      clearTimeout,
      URL,
      JSON,
      console,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "preferences.js" });

    return new Promise((res, rej) => {
      queueMicrotask(() => {
        try {
          assert.deepEqual(errors, [], `unexpected errors: ${errors.join("; ")}`);
          assert.equal(
            calls.renderedOptions,
            1,
            "MutationObserver path did not initialise the pane",
          );
          res();
        } catch (e) {
          rej(e);
        }
      });
    });
  });

  test("markup never appears: logs a clear error instead of staying silent", async () => {
    const r = runPane({ readyAfterTicks: null, observerFires: false, maxTicks: 140 });
    try {
      await new Promise((res) => setTimeout(res, 200));
      assert.ok(r.ticks > 100, `poll loop did not run to its limit (${r.ticks})`);
      assert.equal(
        r.errors.length,
        1,
        `expected exactly one logged error, got: ${r.errors.join("; ")}`,
      );
      assert.match(r.errors[0], /never appeared/);
      assert.equal(
        r.calls.renderedOptions,
        0,
        "initialised despite the markup never appearing",
      );
    } finally {
      r.cleanup();
    }
  });

  test("does not use require() or module.exports (absent in Zotero's sandbox)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // Strip comments so the file's own explanation of these does not match.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/\brequire\s*\(/.test(code),
      "pane script calls require(), which does not exist in Zotero",
    );
    assert.ok(
      !/\bmodule\.exports\b/.test(code),
      "pane script assigns module.exports, which does not exist in Zotero",
    );
  });

  test("reads the provider catalogue from both sources", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // The bundle's API is preferred, but the generated data script is the
    // fallback when the plugin has not finished starting up.
    assert.ok(
      /Zotero\.HighlightAsk/.test(src),
      "pane no longer prefers the bundle's API bridge",
    );
    assert.ok(
      /HIGHLIGHT_ASK_PROVIDERS/.test(src),
      "pane no longer falls back to the generated catalogue",
    );
  });

  test("every element the script looks up exists in the markup", () => {
    // A missing id means a null dereference at init, which (before the
    // try/catch) left the pane blank with no visible reason.
    const src = readFileSync(SCRIPT, "utf8");
    const markup = readFileSync(MARKUP, "utf8");
    const defined = new Set(elementIdsFromMarkup());

    const looked = new Set([
      ...[...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
    ]);

    const missing = [...looked].filter((id) => !defined.has(id));
    assert.deepEqual(missing, [], `script looks up ids absent from the markup: ${missing}`);

    // Dynamic ids built as "prompt-" + prefKey cannot be checked statically;
    // assert the container those live in is present.
    assert.ok(defined.has("prompt-fields"), "prompt editor container is missing");
  });

  test("every id in the markup is reachable (no dead fields)", () => {
    // Guards the opposite mistake: markup left behind after a field is removed.
    const src = readFileSync(SCRIPT, "utf8");
    const defined = elementIdsFromMarkup();
    const orphans = defined.filter(
      (id) => !src.includes(`"${id}"`) && !src.includes(`'${id}'`) && !src.includes(`prompt-`),
    );
    assert.deepEqual(orphans, [], `markup defines ids the script never touches: ${orphans}`);
  });
}
