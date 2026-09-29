pref("provider", "deepseek");
pref("apiKey", "");
pref("baseUrl", "https://api.deepseek.com");
pref("model", "deepseek-flash");
// Provider-specific request body fields, merged verbatim into the request.
// Kept as JSON so switching providers never needs a code change. DeepSeek
// ignores unknown fields, so a stale value here is harmless.
pref("thinkingParams", '{"reasoning_effort":"high"}');
// Stored as a string: a float pref is >4 bytes and is unreliable on some platforms.
pref("temperature", "0.3");
pref("showReasoning", true);

// ---- prompts -------------------------------------------------------
// Empty string means "use the built-in default", so clearing the box in
// settings restores sane behaviour rather than sending a prompt-less request.
pref("promptRole", "");
pref("promptScenario", "");
pref("promptTaskExplain", "");
pref("promptTaskTranslate", "");
pref("promptTaskRole", "");

// ---- context -------------------------------------------------------
// Attach the surrounding paragraphs of the paper to each question. Cheap and
// often decisive, because a formula's definitions usually sit nearby.
pref("sendNearby", true);
// Attach the reader's own highlights and notes. Free (already in the library)
// and unusually informative: they record what the reader judged important.
pref("sendAnnotations", true);
// Attach Supporting Information (the separate SI PDF publishers ship alongside
// the article). Extended derivations and full parameter tables usually live
// there, which is where questions about a paper's maths tend to land.
pref("sendSI", true);
// Show a "截图预览" button in the panel: crops the current selection out of the
// PDF canvas and saves it to the configurable screenshot directory so it can
// be inspected. On by default — the capture preview is also how a reader
// verifies what is actually being sent, not only a development aid.
pref("debugScreenshot", true);
// Where "截图预览" writes captured PNGs.
//
// Empty means the default: <data dir>/highlight-ask/debug. A relative value is
// taken as a subdirectory of the plugin folder; an absolute path is used as is.
pref("screenshotDir", "");
// Attach a cropped screenshot of the selection. PDF text extraction flattens
// fractions and drops norm bars, so a screenshot is the only reliable source
// for formulas. Large selections are tiled so nothing is resampled.
pref("sendScreenshot", true);
// Character budget per SI document.
pref("siMaxChars", 200000);
// Default state of the per-panel "全文" toggle.
pref("sendFullText", false);
// Character budget for the full text when it is attached.
pref("fullTextMaxChars", 120000);
// For documents too long to send whole, search them and send the passages most
// similar to the selection. The query is the selection, not the question:
// questions are usually Chinese while the documents are English.
pref("retrievePassages", true);
// How many passages to retrieve.
pref("retrieveTopK", 5);
// Send retrieved passages even when the document would fit whole.
//
// A 120K-character budget is ~34K tokens per question; five retrieved passages
// are ~2K. The whole document is only worth that when the question is genuinely
// about the document as a whole.
pref("alwaysRetrieve", true);

// ---- storage -------------------------------------------------------
// Write conversations into a child note on the paper (syncs with the library).
pref("saveToNote", true);
// Also mirror conversations to JSON under the data directory.
pref("saveToJson", true);
// Append one metadata line per request to logs/requests.jsonl.
pref("logRequests", true);
