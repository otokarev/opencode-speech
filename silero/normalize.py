"""Make text speakable for Silero v4_ru, which drops digits and Latin letters.

Numbers become Russian words (num2words), known Latin words come from WORDS, short all-caps
words are spelled letter by letter, everything else Latin is transliterated by rough English rules.
"""
import re

from num2words import num2words

# Lowercase key -> how it is said. Extend freely.
WORDS = {
    "pr": "пиар",
    "prs": "пиары",
    "stage": "стейдж",
    "master": "мастер",
    "prod": "прод",
    "merge": "мёрж",
    "commit": "коммит",
    "push": "пуш",
    "branch": "бранч",
    "worktree": "вёрктри",
    "jira": "джира",
    "ticket": "тикет",
    "testing": "тестинг",
    "qa": "кью эй",
    "api": "эй пи ай",
    "bo": "бэк офис",
    "php": "пэ хэ пэ",
    "symfony": "симфони",
    "redis": "редис",
    "docker": "докер",
    "yaml": "ямл",
    "json": "джейсон",
    "env": "энв",
    "dev": "дев",
    "test": "тест",
    "piper": "пайпер",
    "silero": "силеро",
    "rhvoice": "эр эйч войс",
    "claude": "клод",
    "olesya": "олеся",
    "ok": "окей",
    "phpstan": "пэ хэ пэ стан",
    "phpunit": "пэ хэ пэ юнит",
    "github": "гитхаб",
    "git": "гит",
    "entr": "энтр",
    "mfa": "эм эф эй",
    "jwt": "джей дабл ю ти",
    "url": "ю ар эл",
    "id": "ай ди",
    "uuid": "ю ю ай ди",
}

LETTERS = {
    "a": "эй", "b": "би", "c": "си", "d": "ди", "e": "и", "f": "эф", "g": "джи", "h": "эйч",
    "i": "ай", "j": "джей", "k": "кей", "l": "эл", "m": "эм", "n": "эн", "o": "оу", "p": "пи",
    "q": "кью", "r": "ар", "s": "эс", "t": "ти", "u": "ю", "v": "ви", "w": "дабл ю", "x": "экс",
    "y": "уай", "z": "зед",
}

DIGRAPHS = [
    ("sch", "ш"), ("tch", "ч"), ("sh", "ш"), ("ch", "ч"), ("th", "т"), ("ph", "ф"), ("ck", "к"),
    ("qu", "кв"), ("ee", "и"), ("oo", "у"), ("ea", "и"), ("ou", "ау"), ("oa", "оу"), ("ai", "эй"),
    ("ay", "эй"), ("ey", "ей"), ("oy", "ой"), ("kh", "х"), ("zh", "ж"), ("ts", "ц"), ("ya", "я"),
    ("yu", "ю"), ("yo", "ё"),
]
SINGLE = {
    "a": "а", "b": "б", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и", "j": "дж",
    "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р", "s": "с",
    "t": "т", "u": "у", "v": "в", "w": "в", "x": "кс", "z": "з",
}


def transliterate(word: str) -> str:
    w = word.lower()
    out = []
    i = 0
    while i < len(w):
        for latin, cyr in DIGRAPHS:
            if w.startswith(latin, i):
                out.append(cyr)
                i += len(latin)
                break
        else:
            ch = w[i]
            nxt = w[i + 1] if i + 1 < len(w) else ""
            if ch == "c":
                out.append("с" if nxt in ("e", "i", "y") else "к")
            elif ch == "y":
                out.append("и" if i > 0 and nxt not in "aeiou" else "й")
            elif ch == "e" and i == len(w) - 1 and len(w) > 3:
                pass  # silent final e: "make", "stage"
            else:
                out.append(SINGLE.get(ch, ch))
            i += 1
    return "".join(out)


def say_latin(match: re.Match) -> str:
    word = match.group(0)
    known = WORDS.get(word.lower())
    if known:
        return known
    if word.isupper() and len(word) <= 5:
        return " ".join(LETTERS[c] for c in word.lower())
    return transliterate(word)


def say_number(match: re.Match) -> str:
    text = match.group(0).replace(",", ".")
    try:
        value = float(text) if "." in text else int(text)
        return num2words(value, lang="ru")
    except (ValueError, OverflowError, NotImplementedError):
        return " ".join(num2words(int(d), lang="ru") for d in text if d.isdigit())


def normalize(text: str) -> str:
    text = text.replace("%", " процентов").replace("×", " на ")
    text = re.sub(r"\d+(?:[.,]\d+)?", say_number, text)
    text = re.sub(r"[A-Za-z]+", say_latin, text)
    return re.sub(r"\s+", " ", text).strip()
