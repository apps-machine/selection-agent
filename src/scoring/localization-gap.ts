// Track A localization-gap scorer.
//
// Heuristic v1: detects description language and compares to the expected
// language for the given market. v1 has known false positives on multilingual
// apps that ship an English description by default for every market — the M4
// Claude judges (text + vision) refine this signal.
//
// Output: 0 = description language matches market expectation (well localized)
//         5 = neutral (unknown market, multi-language market, or uncertain detection)
//        10 = clear mismatch (e.g., English description in JP market)

export interface LocalizationGapInput {
  description: string;
  market: string;
}

type LangCode =
  | "en"
  | "fr"
  | "de"
  | "es"
  | "pt"
  | "it"
  | "nl"
  | "pl"
  | "tr"
  | "ja"
  | "ko"
  | "zh"
  | "ru"
  | "el"
  | "ar"
  | "he";

// Markets with a clear single dominant language for app store listings.
// Multi-language markets (ch, be, lu, in, sg, hk) are intentionally omitted —
// the scorer falls back to neutral (5) rather than risk false-positive gap
// signals.
const MARKET_TO_LANG: Readonly<Record<string, LangCode>> = Object.freeze({
  // English
  us: "en",
  gb: "en",
  au: "en",
  ca: "en",
  ie: "en",
  nz: "en",
  za: "en",
  // Romance
  fr: "fr",
  es: "es",
  mx: "es",
  ar: "es",
  cl: "es",
  co: "es",
  pe: "es",
  uy: "es",
  ve: "es",
  br: "pt",
  pt: "pt",
  it: "it",
  // Germanic / other Western EU
  de: "de",
  at: "de",
  nl: "nl",
  // Slavic
  pl: "pl",
  ru: "ru",
  // Asian (script-detectable)
  jp: "ja",
  kr: "ko",
  cn: "zh",
  tw: "zh",
  // Other
  tr: "tr",
  gr: "el",
  sa: "ar",
  ae: "ar",
  eg: "ar",
  il: "he",
});

// Stop word sets — chosen to maximize disambiguation across Latin-script langs.
const STOP_WORDS_RAW: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: [
    "the",
    "and",
    "you",
    "your",
    "with",
    "this",
    "that",
    "for",
    "are",
    "is",
    "have",
    "of",
    "to",
    "a",
    "an",
    "or",
    "if",
    "can",
    "be",
    "by",
    "in",
    "on",
    "at",
    "we",
  ],
  fr: [
    "le",
    "la",
    "les",
    "et",
    "est",
    "vous",
    "pour",
    "avec",
    "votre",
    "des",
    "une",
    "dans",
    "ce",
    "sont",
    "ou",
    "du",
    "au",
  ],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "sie",
    "für",
    "mit",
    "ihre",
    "ein",
    "eine",
    "einem",
    "einer",
    "dem",
    "den",
    "zum",
    "zur",
    "deine",
    "deinen",
  ],
  es: [
    "el",
    "los",
    "las",
    "y",
    "es",
    "con",
    "su",
    "este",
    "esta",
    "una",
    "un",
    "tus",
    "sus",
    "que",
  ],
  pt: [
    "o",
    "os",
    "as",
    "é",
    "com",
    "sua",
    "seu",
    "uma",
    "um",
    "no",
    "na",
    "do",
    "da",
    "dos",
    "das",
  ],
  it: ["il", "lo", "gli", "è", "per", "tuo", "questa", "della", "delle", "degli", "che", "una"],
  nl: ["het", "een", "en", "voor", "met", "uw", "deze", "van", "te", "op", "niet", "naar", "is"],
  pl: ["i", "w", "z", "na", "do", "jest", "się", "od", "po", "dla", "to", "że", "są", "ale"],
  tr: ["ve", "bir", "bu", "ile", "için", "siz", "sizin", "olan", "daha", "çok", "kadar"],
});

// Precomputed Sets — avoid recreating per-call.
const STOP_WORD_SETS: Array<{ lang: LangCode; set: ReadonlySet<string> }> = Object.entries(
  STOP_WORDS_RAW,
).map(([lang, words]) => ({
  lang: lang as LangCode,
  set: new Set(words),
}));

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const HIRAGANA_KATAKANA_RE = /[぀-ゟ゠-ヿ]/;
const HANGUL_RE = /[가-힯]/;
const HAN_RE = /[一-鿿]/;
const GREEK_RE = /[Ͱ-Ͽ]/;
const ARABIC_RE = /[؀-ۿ]/;
const HEBREW_RE = /[֐-׿]/;

// Tokenize Latin-script text using full Unicode letter property — covers
// Polish (ł, ś, ż), Czech (č, ř), Romanian (ș, ț), Hungarian (ő, ű), Turkish
// (ı, İ, ş), and any other Latin-extended diacritics. \p{L} matches any letter,
// \p{M} matches combining marks (e.g., NFD-decomposed accents).
const TOKEN_SPLIT_RE = /[^\p{L}\p{M}'’]+/gu;

function detectLanguage(description: string): LangCode | null {
  // Script-based detection (high confidence, non-Latin scripts).
  if (HIRAGANA_KATAKANA_RE.test(description)) return "ja"; // kana => Japanese
  if (HANGUL_RE.test(description)) return "ko";
  if (CYRILLIC_RE.test(description)) return "ru";
  if (GREEK_RE.test(description)) return "el";
  if (ARABIC_RE.test(description)) return "ar";
  if (HEBREW_RE.test(description)) return "he";
  if (HAN_RE.test(description)) return "zh"; // Han without kana/hangul => Chinese

  // Latin script: stop-word counting.
  const tokens = description
    .toLowerCase()
    .normalize("NFC")
    .split(TOKEN_SPLIT_RE)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return null;

  let bestLang: LangCode | null = null;
  let bestCount = 0;
  let secondBest = 0;
  for (const { lang, set } of STOP_WORD_SETS) {
    let count = 0;
    for (const t of tokens) if (set.has(t)) count++;
    if (count > bestCount) {
      secondBest = bestCount;
      bestCount = count;
      bestLang = lang;
    } else if (count > secondBest) {
      secondBest = count;
    }
  }
  // Confident detection requires (a) at least 2 stop-word hits and
  // (b) a clear winner over the runner-up — ties would otherwise be resolved
  // by Object.entries enumeration order, producing biased detections.
  if (bestCount < 2) return null;
  if (bestCount === secondBest) return null;
  return bestLang;
}

export function scoreLocalizationGap(input: LocalizationGapInput): number {
  const desc = input.description ?? "";
  if (desc.trim().length === 0) return 5;

  const expected = MARKET_TO_LANG[(input.market ?? "").toLowerCase()];
  if (!expected) return 5;

  const detected = detectLanguage(desc);
  if (detected === null) return 5;
  if (detected === expected) return 0;
  return 10;
}
