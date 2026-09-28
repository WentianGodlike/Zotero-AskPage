import type { ChatMessage } from "./deepseek";

/** Built-in quick actions shown in the reader selection popup. */
export interface QuickAction {
  id: string;
  label: string;
  title: string;
  question: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "explain",
    label: "解释这段",
    title: "让 AI 讲解选中的内容（公式会给出推导与符号说明）",
    question: "请解释这段内容。",
  },
  {
    id: "translate",
    label: "翻译",
    title: "翻译选中的内容",
    question: "请把这段翻译成中文，专业术语保留英文原词。",
  },
  {
    id: "role",
    label: "有何作用",
    title: "说明这段在论文中的作用",
    question: "这段在论文中起什么作用？和论文的主要结论有什么关系？",
  },
];

const SYSTEM_PROMPT = `你是一位学术论文精读助手，帮助读者理解他们正在阅读的论文片段。

规则：
1. 读者可能只选中了公式、半句话或不完整的片段，文字层还可能有识别错误（PDF 抽取的公式尤其容易乱）。请结合学术常识推断读者真正想问什么，必要时明确指出"这段文字可能是抽取错误"。
2. 涉及数学时：
   - 用 LaTeX 写公式，行内用 $...$，独立公式用 $$...$$。
   - 逐个解释符号含义，说明每一步推导的依据。
   - 如果选中的文字公式残缺，请推测原式并说明推测依据。
3. 用中文回答，专业术语保留英文原词。
4. 简洁、直给，不要客套话，不要重复读者已经给出的原文。
5. 如果片段信息不足以回答，直接说明缺少什么，并给出最可能的解释。`;

/**
 * Build the message list for the first question about a selection.
 */
export function buildInitialMessages(
  selection: string,
  question: string,
): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `论文片段：\n"""\n${selection}\n"""\n\n问题：${question}`,
    },
  ];
}

/** Append a follow-up turn to an existing conversation. */
export function buildFollowUpMessages(
  history: ChatMessage[],
  question: string,
): ChatMessage[] {
  return [...history, { role: "user", content: question }];
}
