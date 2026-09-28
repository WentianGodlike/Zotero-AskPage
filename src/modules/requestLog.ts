import { appendLine, readTextFile, requestLogPath } from "./storage";
import { getPref } from "../utils/prefs";

/**
 * Request logging.
 *
 * Scope is deliberately metadata-only: timing, model, token counts, outcome.
 * The paper text and the model's answers are never written here, so the log can
 * be shared when debugging without leaking what the user is reading.
 *
 * Format is JSON Lines — one object per line, append-only, trivial to grep,
 * `jq`, or load into a spreadsheet.
 */

export interface RequestLogEntry {
  /** ISO timestamp of when the request finished. */
  ts: string;
  /** Correlates entries belonging to one conversation thread. */
  sessionId?: string;
  itemID?: number;
  provider: string;
  model: string;
  /** Milliseconds from request start to first streamed token. */
  firstTokenMs?: number;
  /** Milliseconds for the whole request. */
  totalMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Length of the selection in characters (size, not content). */
  selectionChars?: number;
  questionChars?: number;
  fullTextChars?: number;
  hasReasoning?: boolean;
  /** Absent on success. */
  error?: string;
  errorKind?: string;
}

function enabled(): boolean {
  try {
    return Boolean(getPref("logRequests"));
  } catch {
    return false;
  }
}

/** Record one request. Never throws, never blocks the caller meaningfully. */
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  if (!enabled()) {
    return;
  }
  try {
    await appendLine(requestLogPath(), JSON.stringify(entry));
  } catch (e) {
    Zotero.debug(`[Highlight Ask] request log failed: ${(e as Error)?.message || e}`);
  }
}

export interface LogSummary {
  requests: number;
  errors: number;
  totalTokens: number;
  byModel: Record<string, { requests: number; tokens: number }>;
  /** Mean total latency in ms. */
  avgTotalMs: number;
  /** Mean time to first token in ms, over requests that reported one. */
  avgFirstTokenMs: number | null;
  firstTs?: string;
  lastTs?: string;
}

/** Read and aggregate the log. Used by the settings pane. */
export async function summarizeLog(): Promise<LogSummary> {
  const raw = (await readTextFile(requestLogPath())) || "";

  const summary: LogSummary = {
    requests: 0,
    errors: 0,
    totalTokens: 0,
    byModel: {},
    avgTotalMs: 0,
    avgFirstTokenMs: null,
  };

  let totalMs = 0;
  let firstTokenSum = 0;
  let firstTokenCount = 0;

  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    let row: RequestLogEntry;
    try {
      row = JSON.parse(text);
    } catch {
      continue; // a torn final line, or a hand-edited file
    }

    summary.requests++;
    if (row.error) {
      summary.errors++;
    }
    const tokens = Number(row.totalTokens) || 0;
    summary.totalTokens += tokens;
    totalMs += Number(row.totalMs) || 0;

    const key = `${row.provider || "?"}/${row.model || "?"}`;
    const bucket = (summary.byModel[key] ||= { requests: 0, tokens: 0 });
    bucket.requests++;
    bucket.tokens += tokens;

    if (typeof row.firstTokenMs === "number") {
      firstTokenSum += row.firstTokenMs;
      firstTokenCount++;
    }
    if (row.ts) {
      summary.firstTs ||= row.ts;
      summary.lastTs = row.ts;
    }
  }

  if (summary.requests) {
    summary.avgTotalMs = Math.round(totalMs / summary.requests);
  }
  if (firstTokenCount) {
    summary.avgFirstTokenMs = Math.round(firstTokenSum / firstTokenCount);
  }
  return summary;
}
