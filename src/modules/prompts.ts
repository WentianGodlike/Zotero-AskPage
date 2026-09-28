import type { ChatMessage } from "./deepseek";
import { getPref } from "../utils/prefs";

/**
 * Prompt construction.
 *
 * The prompt is deliberately layered so each concern can be edited
 * independently and reused:
 *
 *   role        who the model is            (stable, rarely changes)
 *   scenario    what reading situation       (paper-reading specifics)
 *   task        what this particular ask is  (per quick action)
 *
 * `role` and `scenario` are kept as separate preferences rather than one blob
 * because they age differently: the role is generic, the scenario encodes
 * hard-won knowledge about PDF text extraction and mangled formulas.
 *
 * Ordering inside the message list matters for prompt caching: the system
 * message (role + scenario) is identical across questions about the same paper,
 * so providers that cache prefixes (DeepSeek's context caching, Anthropic's
 * prompt caching) get a hit. Keep volatile content — the selection, the
 * question, the full text — in the user message, after the stable part.
 */

/** Built-in quick actions shown in the reader selection popup. */
export interface QuickAction {
  id: string;
  label: string;
  title: string;
  /** Preference key holding the editable task prompt. */
  prefKey: string;
  /** Default task prompt, also used by "restore defaults". */
  defaultPrompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "explain",
    label: "解释这段",
    title: "让 AI 讲解选中的内容（公式会给出推导与符号说明）",
    prefKey: "promptTaskExplain",
    defaultPrompt: "请解释这段内容。",
  },
  {
    id: "translate",
    label: "翻译",
    title: "翻译选中的内容",
    prefKey: "promptTaskTranslate",
    defaultPrompt: "请把这段翻译成中文，专业术语保留英文原词。",
  },
  {
    id: "role",
    label: "有何作用",
    title: "说明这段在论文中的作用",
    prefKey: "promptTaskRole",
    defaultPrompt: "这段在论文中起什么作用？和论文的主要结论有什么关系？",
  },
];

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_ROLE_PROMPT = `你是一位学术论文精读助手，帮助读者理解他们正在阅读的论文片段。
你的回答面向正在读原文的研究者，他们卡住了，需要有人把这一段讲通。`;

export const DEFAULT_SCENARIO_PROMPT = `关于你收到的文本，必须知道这些前提：

1. 文本来自 PDF 的自动抽取，不是人工誊抄。常见问题：
   - 公式被压平成线性文本，分式、上下标、积分上下限的结构丢失
   - 数学字体的私有编码导致符号缺失或变成乱码（希腊字母尤其常见）
   - 断词、硬换行、页眉页脚混入正文
2. 读者可能只选中了半句话、一个公式编号或一小段，本身信息不完整。
3. 遇到疑似抽取错误时，先推断原文最可能是什么，并说明推断依据，再作答。
   不要因为文本残缺就拒绝回答。

数学的处理方式：
- 用 LaTeX：行内 $...$，独立公式 $$...$$
- 逐个解释符号含义；说明每一步推导依据的是什么定义或定理
- 若原式残缺，给出你推测的完整形式，并标出哪部分是你的推测

回答要求：
- 用中文，专业术语保留英文原词
- 直接回答，不要客套话，不要复述原文
- 信息确实不足时，明确说缺什么，并给出最可能的解释`;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface ResolvedPrompts {
  role: string;
  scenario: string;
}

function readPrompt(prefKey: string, fallback: string): string {
  try {
    const value = getPref(prefKey as any);
    const text = typeof value === "string" ? value.trim() : "";
    // An empty pref means "use the default", so clearing the box in settings
    // restores sane behaviour instead of sending a prompt-less request.
    return text || fallback;
  } catch {
    return fallback;
  }
}

export function resolvePrompts(): ResolvedPrompts {
  return {
    role: readPrompt("promptRole", DEFAULT_ROLE_PROMPT),
    scenario: readPrompt("promptScenario", DEFAULT_SCENARIO_PROMPT),
  };
}

export function resolveTaskPrompt(action: QuickAction): string {
  return readPrompt(action.prefKey, action.defaultPrompt);
}

/**
 * Every editable prompt with its built-in default.
 *
 * Exposed to the settings pane (via `Zotero.<AddonInstance>.api`) so the
 * "restore defaults" button and the editor labels cannot drift from the code —
 * there is exactly one definition of what the defaults are.
 */
export interface PromptField {
  prefKey: string;
  label: string;
  help: string;
  default: string;
  /** Suggested textarea height in rows. */
  rows: number;
}

export function promptFields(): PromptField[] {
  return [
    {
      prefKey: "promptRole",
      label: "角色",
      help: "模型是谁。写得越具体，语气和深度越稳定。留空则用默认。",
      default: DEFAULT_ROLE_PROMPT,
      rows: 3,
    },
    {
      prefKey: "promptScenario",
      label: "阅读场景",
      help:
        "这份插件最关键的提示词：告诉模型 PDF 抽取的文本会有什么毛病、" +
        "公式该怎么处理。改这里比改角色更能影响回答质量。",
      default: DEFAULT_SCENARIO_PROMPT,
      rows: 16,
    },
    ...QUICK_ACTIONS.map((a) => ({
      prefKey: a.prefKey,
      label: `任务：${a.label}`,
      help: `点击「${a.label}」时实际发送的问题。`,
      default: a.defaultPrompt,
      rows: 2,
    })),
  ];
}

/** The stable system message: identical for every question about a paper. */
export function buildSystemPrompt(prompts = resolvePrompts()): string {
  return `${prompts.role}\n\n${prompts.scenario}`;
}

/* ------------------------------------------------------------------ */
/* Message construction                                                */
/* ------------------------------------------------------------------ */

export interface BuildContext {
  /** The text the user selected in the PDF. */
  selection: string;
  /** The question to ask. */
  question: string;
  /** Optional surrounding paragraphs, taken from the PDF text layer. */
  nearby?: string;
  /** Optional full text of the paper, when the user enables it. */
  fullText?: string;
  /** Human-readable source title, for grounding. */
  title?: string;
}

/**
 * Assemble the user message.
 *
 * Volatile content lives here (after the stable system message) so prefix
 * caching can do its job.
 */
export function buildUserMessage(ctx: BuildContext): string {
  const parts: string[] = [];

  if (ctx.title) {
    parts.push(`论文标题：${ctx.title}`);
  }
  if (ctx.fullText) {
    parts.push(
      "以下是论文全文（同样来自 PDF 抽取，公式可能有损）：\n" +
        '"""\n' +
        ctx.fullText +
        '\n"""',
    );
  }
  if (ctx.nearby && ctx.nearby.trim() && ctx.nearby.trim() !== ctx.selection.trim()) {
    parts.push(
      "选中片段附近的原文（用于理解上下文）：\n" + '"""\n' + ctx.nearby + '\n"""',
    );
  }
  parts.push("读者选中的片段：\n" + '"""\n' + ctx.selection + '\n"""');
  parts.push(`问题：${ctx.question}`);

  return parts.join("\n\n");
}

export function buildInitialMessages(
  selection: string,
  question: string,
  extra: { nearby?: string; fullText?: string; title?: string } = {},
): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserMessage({ selection, question, ...extra }) },
  ];
}

/** Append a follow-up turn to an existing conversation. */
export function buildFollowUpMessages(
  history: ChatMessage[],
  question: string,
): ChatMessage[] {
  return [...history, { role: "user", content: question }];
}

/* ------------------------------------------------------------------ */
/* Context window management                                           */
/* ------------------------------------------------------------------ */

/**
 * Trim the full text so a question cannot blow past the context window.
 *
 * When the paper is too long we keep the beginning and the end and cut the
 * middle, because for a paper those hold the abstract/introduction and the
 * conclusion, which is what a question about "this formula" most often needs.
 */
export function trimFullText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const clean = (text || "").trim();
  if (!clean) {
    return { text: "", truncated: false };
  }
  if (clean.length <= maxChars) {
    return { text: clean, truncated: false };
  }

  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return {
    text:
      clean.slice(0, head) +
      `\n\n…（此处省略约 ${clean.length - maxChars} 个字符）…\n\n` +
      clean.slice(clean.length - tail),
    truncated: true,
  };
}

/**
 * Pick a window of the paper's text around the selection.
 * Returns the surrounding paragraphs, which usually contain the definitions a
 * formula depends on.
 */
export function extractNearby(
  fullText: string,
  selection: string,
  windowChars = 1200,
): string {
  const text = fullText || "";
  const needle = (selection || "").trim();
  if (!text || !needle) {
    return "";
  }

  // The selection may have been normalised (line joins, whitespace collapsed),
  // so an exact match is not guaranteed. Try progressively looser probes.
  const probes = [
    needle,
    needle.slice(0, 80),
    needle.slice(0, 40),
    needle.split(/\s+/).slice(0, 6).join(" "),
  ].filter((p) => p.length >= 4);

  let at = -1;
  for (const probe of probes) {
    at = text.indexOf(probe);
    if (at >= 0) {
      break;
    }
  }
  if (at < 0) {
    return "";
  }

  const half = Math.floor(windowChars / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, at + needle.length + half);
  const slice = text.slice(start, end).trim();
  return (start > 0 ? "…" : "") + slice + (end < text.length ? "…" : "");
}
