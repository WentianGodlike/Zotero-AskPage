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
// Default state of the per-panel "全文" toggle.
pref("sendFullText", false);
// Character budget for the full text when it is attached.
pref("fullTextMaxChars", 120000);

// ---- storage -------------------------------------------------------
// Write conversations into a child note on the paper (syncs with the library).
pref("saveToNote", true);
// Also mirror conversations to JSON under the data directory.
pref("saveToJson", true);
// Append one metadata line per request to logs/requests.jsonl.
pref("logRequests", true);
