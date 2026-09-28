import { sessionsDir, writeTextFile, readTextFile } from "./storage";
import { getPref } from "../utils/prefs";

/**
 * Conversation persistence.
 *
 * Two destinations, on purpose:
 *
 *   note   the human-readable copy, attached to the paper as a child note.
 *          Syncs with the library, is full-text searchable, and can be edited
 *          in place. This is the primary artefact.
 *   json   a structural mirror under the data directory. Machine-readable, so
 *          a future history panel, export, or cost report does not have to
 *          parse HTML out of a note.
 *
 * The note is written first and is allowed to fail independently: losing the
 * JSON mirror is an inconvenience, losing the note is losing the user's work.
 */

export interface SessionTurn {
  question: string;
  answer: string;
  /** Chain-of-thought, when the provider returned one. */
  reasoning?: string;
  ts: string;
  model?: string;
  tokens?: number;
  /** The selection this turn was asked about. */
  selection: string;
}

export interface Session {
  id: string;
  itemID: number;
  title?: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
  /** Zotero note item id, once the note exists. */
  noteItemID?: number;
}

const NOTE_HEADING = "Highlight Ask 会话";

/** Stable-ish, readable, and unique enough for one library. */
export function makeSessionId(itemID: number, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return `item${itemID}-${stamp}`;
}

export function sessionPath(session: Session): string {
  return `${sessionsDir()}/${session.id}.json`;
}

/* ------------------------------------------------------------------ */
/* JSON mirror                                                         */
/* ------------------------------------------------------------------ */

export async function saveSessionJson(session: Session): Promise<boolean> {
  if (!getPref("saveToJson")) {
    return false;
  }
  return writeTextFile(sessionPath(session), JSON.stringify(session, null, 2));
}

export async function loadSessionJson(id: string): Promise<Session | null> {
  const raw = await readTextFile(`${sessionsDir()}/${id}.json`);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as Session;
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] corrupt session ${id}: ${(e as Error)?.message || e}`),
    );
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Note rendering                                                      */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render a session as Zotero note HTML.
 *
 * Answers are stored inside `<pre>` so the LaTeX source survives verbatim: the
 * note editor would otherwise reflow or mangle `$...$` and backslashes. Answers
 * are wrapped in `<div data-ha-turn>` so the note can be re-parsed and appended
 * to later without duplicating content.
 */
export function renderSessionHtml(session: Session): string {
  const parts: string[] = [];
  parts.push(`<h1>${NOTE_HEADING}</h1>`);
  parts.push(
    `<p><em>${escapeHtml(session.title || "")}</em></p>`,
  );

  session.turns.forEach((turn, index) => {
    parts.push(`<h2>${index + 1}. ${escapeHtml(turn.question)}</h2>`);
    if (turn.selection) {
      parts.push("<blockquote>");
      parts.push(escapeHtml(turn.selection));
      parts.push("</blockquote>");
    }
    if (turn.reasoning) {
      parts.push("<details><summary>推理过程</summary>");
      parts.push(`<pre>${escapeHtml(turn.reasoning)}</pre>`);
      parts.push("</details>");
    }
    parts.push(`<pre>${escapeHtml(turn.answer)}</pre>`);
    const meta: string[] = [];
    if (turn.model) {
      meta.push(escapeHtml(turn.model));
    }
    if (turn.tokens) {
      meta.push(`${turn.tokens} tokens`);
    }
    if (turn.ts) {
      meta.push(escapeHtml(turn.ts));
    }
    if (meta.length) {
      parts.push(`<p><small>${meta.join(" · ")}</small></p>`);
    }
  });

  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Note persistence                                                    */
/* ------------------------------------------------------------------ */

/**
 * Find the existing conversation note for a paper, if one is already attached.
 * Returns null when there is none, so the caller can create one.
 */
export async function findSessionNote(
  parentItemID: number,
): Promise<Zotero.Item | null> {
  try {
    const parent = await Zotero.Items.getAsync(parentItemID);
    if (!parent) {
      return null;
    }
    const noteIDs: number[] = parent.getNotes?.() || [];
    for (const id of noteIDs) {
      const note = await Zotero.Items.getAsync(id);
      const html: string = note?.getNote?.() || "";
      if (html.includes(NOTE_HEADING)) {
        return note;
      }
    }
    // Also look one level down: papers often hold a PDF, and notes may hang off
    // the attachment rather than the parent item.
    const attachments: number[] = parent.getAttachments?.() || [];
    for (const attID of attachments) {
      const att = await Zotero.Items.getAsync(attID);
      for (const id of att?.getNotes?.() || []) {
        const note = await Zotero.Items.getAsync(id);
        const html: string = note?.getNote?.() || "";
        if (html.includes(NOTE_HEADING)) {
          return note;
        }
      }
    }
  } catch (e) {
    Zotero.logError(e as Error);
  }
  return null;
}

export interface SaveOutcome {
  note: "written" | "updated" | "skipped" | "failed";
  json: boolean;
  noteItemID?: number;
}

/**
 * Persist a session to the note and the JSON mirror.
 * Never throws: the answer is already on screen, and failing to archive it must
 * not look like the answer itself failed.
 */
export async function persistSession(session: Session): Promise<SaveOutcome> {
  session.updatedAt = new Date().toISOString();
  const outcome: SaveOutcome = { note: "skipped", json: false };

  if (getPref("saveToNote")) {
    try {
      const existing =
        (session.noteItemID
          ? await Zotero.Items.getAsync(session.noteItemID)
          : null) || (await findSessionNote(session.itemID));

      if (existing) {
        existing.setNote(renderSessionHtml(session));
        await existing.saveTx();
        session.noteItemID = existing.id;
        outcome.note = "updated";
        outcome.noteItemID = existing.id;
      } else {
        const note = new Zotero.Item("note");
        const parent = await Zotero.Items.getAsync(session.itemID);
        if (!parent) {
          outcome.note = "failed";
        } else {
          note.libraryID = parent.libraryID;
          note.parentID = parent.id;
          note.setNote(renderSessionHtml(session));
          await note.saveTx();
          session.noteItemID = note.id;
          outcome.note = "written";
          outcome.noteItemID = note.id;
        }
      }
    } catch (e) {
      Zotero.logError(
        new Error(`[Highlight Ask] note save failed: ${(e as Error)?.message || e}`),
      );
      outcome.note = "failed";
    }
  }

  outcome.json = await saveSessionJson(session);
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit tested)                                          */
/* ------------------------------------------------------------------ */

export function appendTurn(session: Session, turn: SessionTurn): Session {
  return {
    ...session,
    turns: [...session.turns, turn],
    updatedAt: turn.ts || new Date().toISOString(),
  };
}

/** Character count actually archived, useful for a "saved" confirmation. */
export function sessionChars(session: Session): number {
  return session.turns.reduce(
    (sum, t) => sum + (t.answer?.length || 0) + (t.question?.length || 0),
    0,
  );
}
