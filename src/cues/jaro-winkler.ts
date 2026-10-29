/**
 * Jaro-Winkler similarity metric.
 * Returns a score between 0.0 (no similarity) and 1.0 (exact match).
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const a = s1.toLowerCase();
  const b = s2.toLowerCase();

  const len1 = a.length;
  const len2 = b.length;

  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const matches1 = new Array<boolean>(len1).fill(false);
  const matches2 = new Array<boolean>(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (!matches2[j] && a[i] === b[j]) {
        matches1[i] = true;
        matches2[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (matches1[i]) {
      while (!matches2[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
  }

  const jaro =
    (matches / len1 +
      matches / len2 +
      (matches - transpositions / 2) / matches) /
    3;

  // Winkler prefix adjustment (up to 4 matching initial chars, scaling factor p = 0.1)
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(len1, len2));
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) {
      prefix++;
    } else {
      break;
    }
  }

  const p = 0.1;
  return jaro + prefix * p * (1 - jaro);
}

/**
 * Checks if query phrase fuzzy-matches any sliding window or substring of fullText.
 * E.g., if fullText is "Ja niin me sanomme Isän ja Pojan ja Pyhän Hengen nimeen aamen"
 * and phrase is "Isän ja Pojan ja Pyhän Hengen nimeen", this checks the best matching window.
 */
export function fuzzySubstringMatch(
  phrase: string,
  fullText: string,
  threshold = 0.8
): { matched: boolean; score: number } {
  const normPhrase = phrase.toLowerCase().trim();
  const normText = fullText.toLowerCase().trim();

  // 1. Direct substring match is an immediate 1.0
  if (normText.includes(normPhrase)) {
    return { matched: true, score: 1.0 };
  }

  // 2. Direct full comparison
  const directScore = jaroWinkler(normPhrase, normText);
  if (directScore >= threshold) {
    return { matched: true, score: directScore };
  }

  // 3. Sliding window over words
  const textWords = normText.split(/\s+/);
  const phraseWords = normPhrase.split(/\s+/);
  const phraseWordCount = phraseWords.length;

  if (textWords.length < phraseWordCount) {
    return { matched: directScore >= threshold, score: directScore };
  }

  let bestScore = directScore;

  // Window sizes from phraseWordCount - 1 to phraseWordCount + 2
  const minW = Math.max(1, phraseWordCount - 1);
  const maxW = Math.min(textWords.length, phraseWordCount + 2);

  for (let w = minW; w <= maxW; w++) {
    for (let i = 0; i <= textWords.length - w; i++) {
      const windowStr = textWords.slice(i, i + w).join(" ");
      const score = jaroWinkler(normPhrase, windowStr);
      if (score > bestScore) {
        bestScore = score;
      }
      if (bestScore >= threshold) {
        return { matched: true, score: bestScore };
      }
    }
  }

  return { matched: bestScore >= threshold, score: bestScore };
}
