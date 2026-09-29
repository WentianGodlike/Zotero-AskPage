#!/usr/bin/env node
/**
 * Diagnostic: run the ACTUALLY INSTALLED preference pane script end to end.
 *
 * Reproduces Zotero's real behaviour:
 *   1. only the pane's scripts exist (no markup yet)
 *   2. the script runs via loadSubScript semantics (bare script, sandbox global)
 *   3. afterwards the pane's XHTML is inserted
 *   4. Zotero then mutates the DOM (this is what a MutationObserver sees)
 *
 * Logs every step so a failure points at a specific line rather than "blank".
 *
 * Usage: node scripts/diagnose-pane.mjs [path-to-xpi]
 */
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const XPI =
  process.argv[2] ||
  // Default to the build output rather than a machine-specific install path:
  // a hardcoded /home/... path escaped the cross-platform check (which scans
  // Python only) and broke for anyone else on the first run.
  (() => {
    const dir = new URL("../.scaffold/build/", import.meta.url);
    try {
      const xpis = readdirSync(dir)
        .filter((n) => n.endsWith(".xpi"))
        .sort();
      if (xpis.length) {
        return new URL(xpis[xpis.length - 1], dir).pathname;
      }
    } catch {
      /* fall through to the message below */
    }
    console.error(
      "No .xpi under .scaffold/build — run `npm run build` first, or pass one:\n" +
        "  npm run diagnose -- /path/to/plugin.xpi",
    );
    process.exit(2);
  })();

/** Pull a file out of the XPI without a zip library. */
function readFromXpi(path, entry) {
  return execFileSync("python3", [
    "-c",
    `import zipfile,sys; sys.stdout.write(zipfile.ZipFile(${JSON.stringify(path)}).read(${JSON.stringify(entry)}).decode('utf-8'))`,
  ]).toString();
}

const log = (...a) => console.log("  ", ...a);

console.log(`\nXPI: ${XPI}\n`);

const xhtml = readFromXpi(XPI, "content/preferences.xhtml");
const paneScript = readFromXpi(XPI, "content/preferences.js");
const dataScript = readFromXpi(XPI, "content/providers.data.js");

/* ---- collect the ids the markup defines ---------------------------- */
const ids = [...xhtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
console.log(`markup defines ${ids.length} ids`);

/* ---- fake DOM ------------------------------------------------------ */
const events = [];
const errors = [];
const logs = [];
let markupInserted = false;

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
    events.push(`replaceChildren(${id})`);
  },
  appendChild() {
    events.push(`appendChild(${id})`);
  },
  append() {},
  addEventListener() {
    events.push(`on(${id})`);
  },
  closest() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
});

const elements = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));

/* ---- sandbox shaped like Zotero's pane scope ----------------------- */
const sandbox = {
  Zotero: {
    logError: (e) => {
      errors.push(String((e && e.message) || e));
      log("Zotero.logError:", (e && e.message) || e);
    },
    debug: (m) => logs.push(String(m)),
    Prefs: { get: () => undefined, set: () => {} },
    launchURL: () => {},
    HighlightAsk: { api: undefined }, // plugin bundle may not be ready
  },
  document: {
    documentElement: {},
    getElementById: (id) => (markupInserted ? elements[id] || null : null),
    createElement: () => makeEl("created"),
    createTextNode: () => ({}),
  },
  MutationObserver: class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  },
  setInterval: (fn) => {
    const h = setInterval(fn, 1);
    timers.add(h);
    return h;
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
const observers = [];
const timers = new Set();
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

/* ---- 1. run the pane's scripts, BEFORE any markup exists ----------- */
console.log("\nstep 1: run pane scripts (no markup in the DOM yet)");
vm.createContext(sandbox);
try {
  vm.runInContext(dataScript, sandbox, { filename: "providers.data.js" });
  log(
    "providers.data.js ran; HIGHLIGHT_ASK_PROVIDERS =",
    Array.isArray(sandbox.HIGHLIGHT_ASK_PROVIDERS)
      ? `${sandbox.HIGHLIGHT_ASK_PROVIDERS.length} providers`
      : "NOT DEFINED",
  );
} catch (e) {
  log("providers.data.js THREW:", e.message);
}

try {
  vm.runInContext(paneScript, sandbox, { filename: "preferences.js" });
  log("preferences.js ran without throwing");
} catch (e) {
  log("preferences.js THREW:", e.message);
  log(e.stack);
}

/* ---- 2. insert markup, then let observers/polling run -------------- */
console.log("\nstep 2: insert markup into the DOM");
markupInserted = true;
for (const o of observers) {
  try {
    o.cb([]);
  } catch (e) {
    log("observer callback threw:", e.message);
  }
}

await new Promise((r) => setTimeout(r, 300));
for (const h of timers) {
  clearInterval(h);
}

/* ---- report -------------------------------------------------------- */
console.log("\nevents observed:");
for (const e of events) {
  console.log("   -", e);
}

console.log("\nZotero.debug messages:");
for (const m of logs) {
  console.log("   -", m);
}

console.log("\nerrors:");
if (!errors.length) {
  console.log("   (none)");
} else {
  for (const e of errors) {
    console.log("   ✗", e);
  }
}

const initialised = events.some((e) =>
  e.startsWith("replaceChildren(provider)"),
);
console.log(
  `\nRESULT: pane ${initialised ? "INITIALISED ✓" : "DID NOT INITIALISE ✗"}\n`,
);
process.exit(initialised && !errors.length ? 0 : 1);
