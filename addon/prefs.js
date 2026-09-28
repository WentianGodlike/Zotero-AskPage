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
