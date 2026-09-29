// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // The settings pane runs inside Zotero's preferences window, i.e. in a
      // browser environment with the Zotero object injected. Without this the
      // linter reports every `document`, `window` and `Zotero` reference as an
      // undefined global.
      files: ["addon/content/**/*.js"],
      languageOptions: {
        globals: {
          document: "readonly",
          window: "readonly",
          console: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
          URL: "readonly",
          fetch: "readonly",
          MutationObserver: "readonly",
          Zotero: "readonly",
          Services: "readonly",
          HIGHLIGHT_ASK_PROVIDERS: "readonly",
        },
      },
      rules: {
        // Reaching into the plugin's published API is the documented handshake
        // between the pane and the bundle, so `any`-ish access is expected.
        "no-unused-vars": "off",
      },
    },
    {
      // Build and diagnostic scripts: plain Node ESM.
      files: ["scripts/**/*.mjs", "scripts/**/*.js"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
          fetch: "readonly",
          URL: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
        },
      },
      rules: {
        "no-unused-vars": "off",
      },
    },
    {
      // The test entry points opt out of type checking on purpose: they load
      // modules through esbuild and exercise them with deliberately malformed
      // values, which static types would reject.
      files: ["test/**/*.ts"],
      rules: {
        "@typescript-eslint/ban-ts-comment": "off",
      },
    },
  ],
});
