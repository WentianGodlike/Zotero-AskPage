import type { ChatMessage, ContentPart } from "./deepseek";
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

/**
 * Default prompt for the 翻译 quick action.
 *
 * Modelled on the widely used translator-plugin prompt: state the role, name
 * the direction, demand fluency and fidelity, and forbid commentary.
 *
 * Two deliberate departures from that reference:
 *
 *  - It does NOT ask to "keep technical terms in English". That instruction
 *    reliably produces bilingual clutter — `离散化 (discretization)` — which
 *    makes a translation harder to read, not easier. Only names, abbreviations
 *    and symbols keep their original form, because those have no settled
 *    translation.
 *  - It keeps the "no speculation" clause. A translator that invents text to
 *    smooth over a mangled PDF fragment is worse than one that stays literal,
 *    since the reader cannot tell the invention from the source.
 */
export const DEFAULT_TRANSLATE_TASK = `请把下面这段学术文本翻译成中文。

要求：
- 准确、通顺，符合中文学术表达习惯，按中文语序组织句子
- 不要中英对照：不要写成「中文（English）」这种括号夹注的形式
- 人名、模型名、缩写、符号保留原样；其余词汇正常译成中文
- 数学公式保持 LaTeX 原样（行内 $...$，独立 $$...$$），不要展开解释，
  也不要用代码块包起来
- 不要逐词硬译，也不要意译到偏离原意

只输出译文本身：不要解释、不要总结、不要补充背景、不要评论、不要加标题。
如果原文因 PDF 抽取而残缺，按最可能的意思翻译，不要凭空补写内容。`;

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
    title: "只翻译选中的内容，不要讲解",
    prefKey: "promptTaskTranslate",
    defaultPrompt: DEFAULT_TRANSLATE_TASK,
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

数学的处理方式（输出格式必须严格遵守）：
- 所有数学一律用 LaTeX，且只用这两种分隔符：
  行内用 $...$，独立成行的公式用 $$...$$
- **不要**把公式放进代码块（三个反引号的围栏）里，无论是 latex、math
  还是不加语言标记
- **不要**用反斜杠加圆括号、或反斜杠加方括号这类分隔符（只认 $ 符号）
- 一个 $$...$$ 内只放一个公式；不要把多个公式塞进同一个 $$ 里
- 逐个解释符号含义；说明每一步推导依据的是什么定义或定理
- 若原式残缺，给出你推测的完整形式，并标出哪部分是你的推测

关于随附的截图：
- 若附带了选区截图，它是为公式准备的：PDF 抽取会把分式压平、上下标错位、
  范数竖线丢失，而截图保留了原始排版
- 以截图为准还原公式，并与文本内容相互印证；两者冲突时以截图为准
- 仍按上面的要求输出 LaTeX，不要描述图片本身

关于 Supporting Information：
- 若提供了 SI，它常含正文放不下的推导、参数表与补充图，优先在其中找依据
- 引用 SI 内容时指明来自 SI，不要把 SI 的内容说成正文的内容

关于「读者的标注与笔记」：
- 它们反映读者已经读到哪、在意什么，用来理解提问的意图，不要逐条复述
- 若读者的批注本身有误解，直接指出，不要顺着错误往下讲

回答要求：
- 用中文回答。术语默认译成中文；只有人名、模型名、缩写和符号保留原样；
  不要写成「中文（English）」这种括号夹注
- 直接回答，不要客套话，不要复述原文
- 信息确实不足时，明确说缺什么，并给出最可能的解释
- 严格按「问题」里提出的要求作答：如果只要求翻译，就只给译文，
  不要额外讲解、总结或补充背景`;

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
  /**
   * The reader's own annotations, already formatted as a list.
   * These carry the reader's judgement about what matters, so they are labelled
   * clearly and placed before the passage for grounding.
   */
  annotations?: string;
  /** The reader's own notes, already converted to plain text. */
  notes?: string[];
  /** Supporting Information documents attached to the same item. */
  supportingInfo?: Array<{ name: string; text: string }>;
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
  if (ctx.annotations && ctx.annotations.trim()) {
    parts.push(
      "读者在本文中做过的标注（高亮与批注，反映读者认为重要的地方）：\n" +
        ctx.annotations,
    );
  }
  if (ctx.notes && ctx.notes.length) {
    parts.push(
      "读者自己写的笔记：\n" +
        ctx.notes.map((n, i) => `【笔记 ${i + 1}】\n${n}`).join("\n\n"),
    );
  }
  if (ctx.supportingInfo && ctx.supportingInfo.length) {
    for (const si of ctx.supportingInfo) {
      parts.push(
        `以下是本文的 Supporting Information（${si.name}，同样来自 PDF 抽取）：\n` +
          '"""\n' +
          si.text +
          '\n"""',
      );
    }
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

export interface ImageAttachment {
  /** Base64 data URL. */
  dataUrl: string;
}

export function buildInitialMessages(
  selection: string,
  question: string,
  extra: {
    nearby?: string;
    fullText?: string;
    title?: string;
    annotations?: string;
    notes?: string[];
    supportingInfo?: Array<{ name: string; text: string }>;
    /** Crop images of the selection, for formulas the text layer mangles. */
    images?: ImageAttachment[];
  } = {},
): ChatMessage[] {
  const text = buildUserMessage({ selection, question, ...extra });

  // Images are only allowed in `user` messages, and a plain string keeps the
  // order cache-friendly when there is nothing to attach.
  const images = extra.images ?? [];
  if (!images.length) {
    return [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: text },
    ];
  }

  const parts: ContentPart[] = [
    { type: "text", text },
    ...images.map(
      (img): ContentPart => ({
        type: "image_url",
        image_url: {
          url: img.dataUrl,
          // `original` keeps the pixels; the default already behaves this way,
          // but stating it protects against a silent quality loss if the
          // provider changes its default. Tiles stay inside the pixel budget
          // so this never costs more than the flat per-image maximum.
          detail: "original",
        },
      }),
    ),
  ];

  return [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: parts },
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
