export type CommandCategory = 'action' | 'navigation' | 'asset';

export interface CommandItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly category: CommandCategory;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly execute: () => void | Promise<void>;
}

const CATEGORY_PRIORITY: Record<CommandCategory, number> = {
  action: 3,
  navigation: 2,
  asset: 1,
};

function scoreTokenInField(token: string, field: string): number {
  if (!field || !token) return -1;

  if (field.startsWith(token)) {
    return 180 + Math.min(20, token.length * 2);
  }

  const wordPrefixIdx = field.search(
    new RegExp(`(^|[\\s\\-_/:.])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  if (wordPrefixIdx >= 0) {
    return 145 - Math.min(30, wordPrefixIdx);
  }

  const subIdx = field.indexOf(token);
  if (subIdx >= 0) {
    return 100 - Math.min(30, subIdx);
  }

  // Tight ordered character subsequence match (e.g. "trc" -> "trace")
  let tIdx = 0;
  let firstMatch = -1;
  let prevMatch = -1;
  let gapPenalty = 0;

  for (let i = 0; i < field.length && tIdx < token.length; i++) {
    if (field[i] === token[tIdx]) {
      if (firstMatch === -1) firstMatch = i;
      if (prevMatch !== -1) {
        gapPenalty += Math.max(0, i - prevMatch - 1);
      }
      prevMatch = i;
      tIdx += 1;
    }
  }

  if (tIdx === token.length) {
    return Math.max(10, 75 - gapPenalty * 3 - Math.min(20, firstMatch));
  }

  return -1;
}

/**
 * Scores a command item against a whitespace-tokenized fuzzy query.
 * Returns `-1` when any query token fails to match title, keywords, or subtitle.
 */
export function scoreCommandMatch(
  query: string,
  item: Pick<CommandItem, 'title' | 'subtitle' | 'keywords'>,
): number {
  const cleaned = query.trim().toLowerCase();
  if (!cleaned) return 1;

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  const title = item.title.toLowerCase();
  const subtitle = (item.subtitle ?? '').toLowerCase();
  const keywords = (item.keywords ?? []).map((k) => k.toLowerCase());

  let totalScore = 0;
  for (const token of tokens) {
    let bestTokenScore = scoreTokenInField(token, title);

    for (const kw of keywords) {
      const kwScore = scoreTokenInField(token, kw);
      if (kwScore > 0) {
        bestTokenScore = Math.max(bestTokenScore, kwScore * 0.78);
      }
    }

    if (subtitle) {
      const subScore = scoreTokenInField(token, subtitle);
      if (subScore > 0) {
        bestTokenScore = Math.max(bestTokenScore, subScore * 0.45);
      }
    }

    if (bestTokenScore < 0) {
      return -1;
    }
    totalScore += bestTokenScore;
  }

  // Bonus if query starts matching at the start of the title or all tokens hit the title directly
  if (tokens.every((t) => scoreTokenInField(t, title) >= 0)) {
    totalScore += 35;
  }

  return totalScore;
}

/**
 * Ranks commands matching `query` descending by relevance score and category priority.
 */
export function rankCommands(query: string, items: readonly CommandItem[]): CommandItem[] {
  const cleaned = query.trim();
  if (!cleaned) {
    return [...items];
  }

  const scored: { item: CommandItem; score: number; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const score = scoreCommandMatch(cleaned, item);
    if (score >= 0) {
      scored.push({ item, score, index: i });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const catDiff = CATEGORY_PRIORITY[b.item.category] - CATEGORY_PRIORITY[a.item.category];
    if (catDiff !== 0) return catDiff;
    return a.index - b.index;
  });

  return scored.map((entry) => entry.item);
}
