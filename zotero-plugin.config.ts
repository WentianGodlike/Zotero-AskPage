import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // Gecko rejects an XPI whose manifest carries a malformed `update_url`, and
  // Zotero only reports that as "may not be compatible with this version".
  // The value must therefore always be a well-formed absolute URL. It is also
  // what Zotero polls for updates: releases publish update.json to the
  // `release` tag (a prerelease kept separate from the versioned `v*` tags),
  // and deleting that prerelease would leave every installed copy unable to
  // see new versions.
  // `{{owner}}`/`{{repo}}` come from package.json's repository field.
  updateURL:
    "https://github.com/{{owner}}/{{repo}}/releases/download/release/{{updateJson}}",
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        // The provider catalogue is also needed by the settings pane, which
        // runs outside this bundle. Emit it as a plain script that defines a
        // single global, so both consumers read the same preset table instead
        // of keeping two copies in sync by hand.
        entryPoints: ["src/data/providers.data.ts"],
        bundle: true,
        format: "iife",
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/providers.data.js",
      },
      {
        // KaTeX's stylesheet, emitted as a file rather than imported so the
        // runtime can trim its @font-face rules to the woff2 fonts we ship.
        // The fonts live in addon/assets/fonts and are copied to
        // content/fonts below, so the relative `fonts/...` URLs resolve.
        entryPoints: ["node_modules/katex/dist/katex.min.css"],
        loader: { ".css": "copy" },
        bundle: false,
        outfile: ".scaffold/build/addon/content/katex.css",
        // The stylesheet sits at content/katex.css while the shipped fonts are
        // at assets/fonts, so the relative URLs need one level up. Doing it here
        // keeps the runtime free of path rewriting.
        plugins: [
          {
            name: "repoint-katex-fonts",
            setup(build: any) {
              build.onEnd(async () => {
                const fs = await import("node:fs");
                const file = ".scaffold/build/addon/content/katex.css";
                if (!fs.existsSync(file)) {
                  return;
                }
                const css = fs.readFileSync(file, "utf8");
                fs.writeFileSync(
                  file,
                  css.replace(/url\(fonts\//g, "url(../assets/fonts/"),
                );
              });
            },
          },
        ],
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
