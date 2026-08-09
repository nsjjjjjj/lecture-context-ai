import { MAX_SPOKEN_ALIASES } from "./spoken-aliases.js";

export const MAX_GLOSSARY_TERMS = 50;

// 한 원본 용어는 정식 표기, 영문 표기, 검증된 한글 발음 별칭을 가질 수 있다.
// 50개 제한은 원본 용어에만 적용하고 파생 표기는 별도 안전 상한으로 관리한다.
export const MAX_PHRASE_SET_FORMS = MAX_GLOSSARY_TERMS * (2 + MAX_SPOKEN_ALIASES);
