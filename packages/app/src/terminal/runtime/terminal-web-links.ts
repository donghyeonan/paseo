// WebLinksAddon ends an http(s) URL only at whitespace, quotes, or a few ASCII delimiters, so
// prose glued to a URL joins the link: Korean particles (`…/preview.html에서`) and non-ASCII
// punctuation (`…/preview.html”`, `…/preview.html。`). Hangul is valid in IRIs
// (`/wiki/대한민국`), so a Hangul tail is cut only when it starts with a known particle, runs to
// the end of the token, and is glued to an ASCII letter or digit or to a closing quote or
// bracket. `/wiki/서울에서` and `/wiki/한국·일본` stay whole because they can be page titles.
//
// The pattern uses lookaheads only: lookbehind is a syntax error in iOS 15 WebViews, which run
// this runtime.

const KOREAN_PARTICLES = [
  "이",
  "가",
  "을",
  "를",
  "은",
  "는",
  "의",
  "에",
  "께",
  "로",
  "으로",
  "와",
  "과",
  "랑",
  "도",
  "만",
  "나",
  "야",
  "인",
  "일",
  "임",
  "입니",
  "예요",
  "라",
  "한테",
  "하고",
  "까지",
  "부터",
  "처럼",
  "보다",
  "마다",
  "밖에",
  "조차",
  "뿐",
];

// URL characters, URL-final characters, and token terminators, as in WebLinksAddon's default.
const URL_CHARACTER = "[^\\s\"'!*(){}|\\\\^<>`]";
const URL_FINAL_CHARACTER = "[^\\s\"':,.!?{}|\\\\^~\\[\\]`()<>]";
const TOKEN_END = "(?:[\\s\"'!*(){}|\\\\^<>`]|$)";
const NON_ASCII = "(?![\\x00-\\x7F])";
const TRAILING_PUNCTUATION = `(?:[:,.?~\\[\\]]|${NON_ASCII}\\p{P})`;
const CLOSING_PUNCTUATION = `${NON_ASCII}[\\p{Pe}\\p{Pf}]`;
const KOREAN_PROSE_SUFFIX = `(?:${KOREAN_PARTICLES.join("|")})[\\uAC00-\\uD7A3]*`;
const GLUED_PROSE_TAIL = `${KOREAN_PROSE_SUFFIX}${TRAILING_PUNCTUATION}*${TOKEN_END}`;
const PROSE_TAIL = `${TRAILING_PUNCTUATION}*(?:${CLOSING_PUNCTUATION}${KOREAN_PROSE_SUFFIX}${TRAILING_PUNCTUATION}*)?${TOKEN_END}`;

// The lazy body stops at the first character after which only prose remains in the token.
export const TERMINAL_URL_REGEX = new RegExp(
  `(https?|HTTPS?):[/]{2}${URL_CHARACTER}*?(?:[A-Za-z0-9](?=${GLUED_PROSE_TAIL})|${URL_FINAL_CHARACTER}(?=${PROSE_TAIL}))`,
  "u",
);
