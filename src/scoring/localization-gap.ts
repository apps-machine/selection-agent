// Track A localization-gap scorer.
//
// Heuristic v1: detects description language and compares to the expected
// language for the given market. v1 has known false positives on multilingual
// apps that ship an English description by default for every market — the M4
// Claude judges (text + vision) refine this signal.
//
// Output: 0 = description language matches market expectation (well localized)
//         5 = neutral (unknown market or uncertain detection)
//        10 = clear mismatch (e.g., English description in JP market)

export interface LocalizationGapInput {
  description: string;
  market: string;
}

type LangCode = "en" | "fr" | "de" | "es" | "pt" | "it" | "nl" | "pl" | "tr"
  | "ja" | "ko" | "zh" | "ru" | "el" | "ar" | "he";

const MARKET_TO_LANG: Readonly<Record<string, LangCode>> = Object.freeze({
  // English
  us: "en", gb: "en", au: "en", ca: "en", ie: "en", nz: "en", za: "en",
  sg: "en", hk: "en", in: "en", ph: "en",
  // Romance
  fr: "fr", be: "fr", ch: "de", lu: "fr",
  es: "es", mx: "es", ar: "es", cl: "es", co: "es", pe: "es", uy: "es", ve: "es",
  br: "pt", pt: "pt",
  it: "it",
  // Germanic / other Western EU
  de: "de", at: "de",
  nl: "nl",
  // Slavic
  pl: "pl",
  ru: "ru",
  // Asian
  jp: "ja",
  kr: "ko",
  cn: "zh", tw: "zh",
  // Other
  tr: "tr",
  gr: "el",
  sa: "ar", ae: "ar", eg: "ar",
  il: "he",
});

// Stop word sets — chosen to maximize disambiguation across Latin-script langs.
const STOP_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: ["the", "and", "you", "your", "with", "this", "that", "for", "are", "is", "have", "of", "to", "a", "an"],
  fr: ["le", "la", "les", "et", "est", "vous", "pour", "avec", "votre", "des", "une", "dans", "ce", "sont", "ou", "du", "au"],
  de: ["der", "die", "das", "und", "ist", "sie", "für", "mit", "ihre", "ein", "eine", "einem", "einer", "dem", "den", "zum", "zur", "deine", "deinen"],
  es: ["el", "los", "las", "y", "es", "con", "su", "este", "esta", "una", "un", "tus", "sus", "que"],
  pt: ["o", "os", "as", "é", "com", "sua", "seu", "uma", "um", "no", "na", "do", "da", "dos", "das"],
  it: ["il", "lo", "gli", "è", "per", "tuo", "questa", "della", "delle", "degli", "che", "una"],
  nl: ["het", "een", "en", "voor", "met", "uw", "deze", "van", "te", "op", "niet", "naar", "is"],
  pl: ["i", "w", "z", "na", "do", "jest", "się", "od", "po", "dla", "to", "że", "sa", "ale"],
  tr: ["ve", "bir", "bu", "ile", "için", "siz", "sizin", "olan", "daha", "çok", "kadar"],
});

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const HIRAGANA_KATAKANA_RE = /[぀-ゟ゠-ヿ]/;
const HANGUL_RE = /[가-힯]/;
const HAN_RE = /[一-鿿]/;
const GREEK_RE = /[Ͱ-Ͽ]/;
const ARABIC_RE = /[؀-ۿ]/;
const HEBREW_RE = /[֐-׿]/;

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
    .split(/[^a-zà-ÿœæçñ’']+/u)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return null;

  let bestLang: LangCode | null = null;
  let bestCount = 0;
  for (const [lang, words] of Object.entries(STOP_WORDS)) {
    const set = new Set(words);
    let count = 0;
    for (const t of tokens) if (set.has(t)) count++;
    if (count > bestCount) {
      bestCount = count;
      bestLang = lang as LangCode;
    }
  }
  // Require at least 2 stop-word hits to claim confident detection.
  return bestCount >= 2 ? bestLang : null;
}

export function scoreLocalizationGap(input: LocalizationGapInput): number {
  const desc = input.description ?? "";
  if (desc.trim().length === 0) return 5;

  const expected = MARKET_TO_LANG[input.market.toLowerCase()];
  if (!expected) return 5;

  const detected = detectLanguage(desc);
  if (detected === null) return 5;
  if (detected === expected) return 0;
  return 10;
}
