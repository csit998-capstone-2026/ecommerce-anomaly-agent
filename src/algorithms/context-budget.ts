/**
 * Heuristics for deciding which verified business evidence enters an Agent prompt.
 * These are estimates, not counts from a model tokenizer. Reserve system and
 * conversation tokens before passing a budget to selectContext.
 */

export type ContextCategory =
  | 'sales_change'
  | 'stockout'
  | 'traffic_change'
  | 'price_change'
  | 'promotion_change'
  | 'counter_evidence'
  | 'other';

export interface ContextChunk {
  id: string;
  category: ContextCategory;
  /** Full result, including the source, time window, and freshness metadata. */
  fullText: string;
  /** A short, verified summary supplied by the business adapter. */
  summaryText: string;
  /** Business relevance from 0 to 1; defaults to 0.5. */
  importance?: number;
}

export interface SelectedContextChunk {
  id: string;
  category: ContextCategory;
  mode: 'full' | 'summary';
  text: string;
  estimatedTokens: number;
}

export interface ContextSelection {
  items: SelectedContextChunk[];
  omittedIds: string[];
  /** Sum of selected text estimates; prompt framing must be budgeted separately. */
  estimatedTokens: number;
}

const CATEGORY_WEIGHT: Record<ContextCategory, number> = {
  sales_change: 7,
  stockout: 7,
  counter_evidence: 6,
  traffic_change: 5,
  price_change: 4,
  promotion_change: 4,
  other: 1,
};

const BASE64_MIN_LENGTH = 20_000;
const BASE64_RUN_MIN = 60;
const BASE64_DENSITY_THRESHOLD = 0.7;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Allocate at most 10% of the model window to evidence, capped at 12k and
 * floored at 2k before accounting for tokens already reserved by the caller.
 */
export function budgetFromContextWindow(contextWindow: number, reservedTokens: number): number {
  if (!Number.isInteger(contextWindow) || contextWindow < 1) {
    throw new Error('contextWindow must be a positive integer');
  }
  if (!Number.isInteger(reservedTokens) || reservedTokens < 0) {
    throw new Error('reservedTokens must be a nonnegative integer');
  }
  const perResultLimit = Math.max(2_000, Math.min(12_000, Math.floor(contextWindow * 0.1)));
  return Math.max(0, Math.min(perResultLimit, contextWindow - reservedTokens));
}

/** A conservative text-density heuristic; it cannot enforce a real model limit. */
export function estimateTokensHeuristic(text: string): number {
  if (text.length === 0) return 0;
  if (text.length >= BASE64_MIN_LENGTH) {
    const runs = text.match(new RegExp(`[A-Za-z0-9+/=]{${BASE64_RUN_MIN},}`, 'g')) ?? [];
    const denseChars = runs.reduce((sum, run) => sum + run.length, 0);
    if (denseChars / text.length >= BASE64_DENSITY_THRESHOLD) {
      return Math.ceil(text.length / 1.5);
    }
  }
  const cjkChars = [...text.matchAll(CJK_PATTERN)].length;
  return Math.ceil((text.length - cjkChars) / 4 + cjkChars / 1.5);
}

function score(chunk: ContextChunk): number {
  return CATEGORY_WEIGHT[chunk.category] * (0.5 + (chunk.importance ?? 0.5) / 2);
}

function validate(chunks: readonly ContextChunk[], budgetTokens: number): void {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 0) throw new Error('budgetTokens must be a nonnegative integer');
  const ids = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk.id?.trim()) throw new Error('Context chunk id must not be empty');
    if (ids.has(chunk.id)) throw new Error(`Duplicate context chunk id: ${chunk.id}`);
    ids.add(chunk.id);
    if (!Object.hasOwn(CATEGORY_WEIGHT, chunk.category)) throw new Error(`Unknown context category: ${chunk.category}`);
    if (!chunk.fullText?.trim() || !chunk.summaryText?.trim()) {
      throw new Error(`Full text and verified summary are required for ${chunk.id}`);
    }
    if (chunk.importance !== undefined &&
        (!Number.isFinite(chunk.importance) || chunk.importance < 0 || chunk.importance > 1)) {
      throw new Error(`Invalid importance for ${chunk.id}`);
    }
  }
}

/**
 * First reserve short summaries of the most relevant evidence. Then use spare
 * budget to upgrade selected items to full text by benefit per extra token.
 * This prevents a large low-value tool result from displacing stockout/sales
 * evidence. The adapter must provide fact-preserving summaries; this function
 * never invents or rewrites a measurement.
 */
export function selectContext(chunks: readonly ContextChunk[], budgetTokens: number): ContextSelection {
  validate(chunks, budgetTokens);
  const ranked = [...chunks].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const selected = new Map<string, SelectedContextChunk>();
  let remaining = budgetTokens;

  for (const chunk of ranked) {
    const fullTokens = estimateTokensHeuristic(chunk.fullText);
    const summaryTokens = estimateTokensHeuristic(chunk.summaryText);
    const mode = fullTokens <= summaryTokens ? 'full' : 'summary';
    const tokens = mode === 'full' ? fullTokens : summaryTokens;
    if (tokens > remaining) continue;
    selected.set(chunk.id, {
      id: chunk.id,
      category: chunk.category,
      mode,
      text: mode === 'full' ? chunk.fullText : chunk.summaryText,
      estimatedTokens: tokens,
    });
    remaining -= tokens;
  }

  const upgrades = ranked
    .filter((chunk) => selected.get(chunk.id)?.mode === 'summary')
    .map((chunk) => ({
      chunk,
      extraTokens: estimateTokensHeuristic(chunk.fullText) - estimateTokensHeuristic(chunk.summaryText),
    }))
    .filter(({ extraTokens }) => extraTokens > 0)
    .sort((a, b) =>
      score(b.chunk) / b.extraTokens - score(a.chunk) / a.extraTokens ||
      score(b.chunk) - score(a.chunk) ||
      a.chunk.id.localeCompare(b.chunk.id),
    );

  for (const { chunk, extraTokens } of upgrades) {
    if (extraTokens > remaining) continue;
    const current = selected.get(chunk.id)!;
    selected.set(chunk.id, {
      ...current,
      mode: 'full',
      text: chunk.fullText,
      estimatedTokens: current.estimatedTokens + extraTokens,
    });
    remaining -= extraTokens;
  }

  return {
    items: ranked.flatMap((chunk) => selected.has(chunk.id) ? [selected.get(chunk.id)!] : []),
    omittedIds: ranked.filter((chunk) => !selected.has(chunk.id)).map((chunk) => chunk.id),
    estimatedTokens: budgetTokens - remaining,
  };
}
