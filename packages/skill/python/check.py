#!/usr/bin/env python3
"""check.py: run the Logisticshub rules on an extraction and write reports.

Python port of check.mjs for hosts without Node.js (claude.ai, the Claude API).
Standard library only, Python 3.9+. Every text and shared constant (messages,
vocabularies, lexicons, rule titles, report CSS...) is read from
check-data.json next to this file, built from the TypeScript sources. The
Incoterms names, legal-form phrases and packing kinds are kept here; the
parity test compares them with the TypeScript tables (--dump-tables).

  python3 check.py extraction.json [--lang en|ka|ru|tr] [--out dir] [--format md,json,html]
  python3 check.py --schema        # print the extraction JSON Schema

Exit codes:
  0  checked, with or without findings;
  1  the extraction is not usable (wrong shape, another schema version):
     the reports are written and list what to fix;
  2  nothing was checked: a bad option, a file that cannot be read or is not
     JSON, or reports that cannot be written. One line on stderr says which.

The PDFs are not read (no PDF library in the stdlib): no marked copies, and
quotes are not looked up on their pages.
"""
import argparse
import codecs
import errno
from functools import lru_cache
import gzip
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "check-data.json"), encoding="utf-8") as _f:
    DATA = json.load(_f)

VERSION = DATA["version"]
SCHEMA_VERSION = DATA["schemaVersion"]
REPORT_VERSION = DATA["reportVersion"]
REGISTRY_FIELDS = DATA["registryFields"]
REGISTRY_LABELS = DATA["registryLabels"]
REGISTRY_SOURCE = DATA["registrySource"]
REGISTRY_VERSION = DATA["registryVersion"]
REPORT_LANGUAGES = DATA["languages"]
RULE_IDS = DATA["ruleIds"]
RULE_TITLES = DATA["ruleTitles"]
RULE_CHECKS = DATA["ruleChecks"]
KEY_CHECKS = DATA["keyChecks"]
FIELD_LABELS = DATA["fieldLabels"]
MESSAGES = DATA["messages"]
DATE_PARAMS = DATA["dateParams"]
NUMBER_PARAMS = DATA["numberParams"]
CMR_PARTS = DATA["cmrParts"]
VOCAB = DATA["vocab"]
UI = DATA["ui"]
LEXICONS = DATA["lexicons"]
LEGAL_FORMS = set(DATA["legalForms"])
INCOTERMS_2020 = set(DATA["incoterms2020"])
SEA_ONLY = set(DATA["seaOnly"])
SELLER_INSURES = set(DATA["sellerInsures"])
REQUIRED_DOCUMENTS = DATA["requiredDocuments"]
UNIT_ALIASES = DATA["unitAliases"]
MONTH_WORDS = DATA["monthWords"]
CURRENCY_CODES = set(DATA["currencyCodes"])
CURRENCY_SIGNS = DATA["currencySigns"]
CMR_SEVERITY = DATA["cmrSeverity"]
REPORT_CSS = DATA["reportCss"]

sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))

# --------------------------------------------------------------------------
# JavaScript semantics
# --------------------------------------------------------------------------

# JS \s and String.prototype.trim(): WhiteSpace + LineTerminator.
JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
JS_WS_CLASS = "".join("\\u%04x" % ord(c) for c in JS_WS)


def js_trim(s):
    return s.strip(JS_WS)


def js_trim_end(s):
    return s.rstrip(JS_WS)


def cat(ch):
    return unicodedata.category(ch)


def is_letter(ch):
    return cat(ch)[0] == "L"


def is_letter_or_number(ch):
    return cat(ch)[0] in "LN"


def nfc(s):
    return unicodedata.normalize("NFC", s)


def nfkc(s):
    return unicodedata.normalize("NFKC", s)


def locale_lower(s, locale):
    """String.prototype.toLocaleLowerCase(locale)."""
    if locale in ("tr", "az"):
        s = s.replace("I\u0307", "i").replace("\u0130", "i").replace("I", "\u0131")
    return s.lower()


def locale_upper(s, locale):
    """String.prototype.toLocaleUpperCase(locale)."""
    if locale in ("tr", "az"):
        s = s.replace("i", "\u0130")
    return s.upper()


def scf(ch):
    """Simple case folding of one character (JS regex /iu canonicalization)."""
    folded = ch.casefold()
    if len(folded) == 1:
        return folded
    lower = ch.lower()
    if len(lower) == 1:
        return lower
    return ch


def fold(s):
    return "".join(scf(c) for c in s)


def utf16_len(s):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def _lone_surrogates_fffd(error):
    return ("\ufffd" * (error.end - error.start), error.end)


codecs.register_error("lh_fffd", _lone_surrogates_fffd)


def to_bytes(text):
    """UTF-8 like Node's Buffer.from(text): lone surrogates become U+FFFD."""
    return text.encode("utf-8", "lh_fffd")


_SURROGATE = re.compile("[\ud800-\udfff]")


def js_string(s):
    out = json.dumps(s, ensure_ascii=False)
    return _SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group(0)), out)


def js_number(f):
    if isinstance(f, bool):
        return "true" if f else "false"
    if isinstance(f, int):
        return str(f)
    if f != f or f in (float("inf"), float("-inf")):
        return "null"
    if f == 0:
        return "0"
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    import decimal

    sign = "-" if f < 0 else ""
    d = decimal.Decimal(repr(abs(f))).normalize()
    t = d.as_tuple()
    digits = "".join(str(x) for x in t.digits)
    k = len(digits)
    n = t.exponent + k
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        body = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + es
    return sign + body


UNDEFINED = object()


def js_stringify(value, indent=2):
    """JSON.stringify(value, null, indent); indent=None is compact."""

    def ser(v, level):
        if v is None:
            return "null"
        if v is True:
            return "true"
        if v is False:
            return "false"
        if isinstance(v, (int, float)):
            return js_number(v)
        if isinstance(v, str):
            return js_string(v)
        if isinstance(v, (list, tuple)):
            items = ["null" if x is UNDEFINED else ser(x, level + 1) for x in v]
            return wrap("[", items, "]", level)
        if isinstance(v, dict):
            items = [js_string(str(k)) + (": " if indent else ":") + ser(x, level + 1) for k, x in v.items() if x is not UNDEFINED]
            return wrap("{", items, "}", level)
        raise TypeError("cannot serialize %r" % (v,))

    def wrap(open_, items, close, level):
        if not items:
            return open_ + close
        if not indent:
            return open_ + ",".join(items) + close
        pad = " " * (indent * (level + 1))
        return open_ + "\n" + ",\n".join(pad + x for x in items) + "\n" + " " * (indent * level) + close

    return ser(value, 0)


def _reject_constant(name):
    raise ValueError("Unexpected token %s in JSON" % name)


def _parse_float(text):
    value = float(text)
    if value.is_integer() and abs(value) < 2 ** 63:
        return int(value)
    return value


def js_json_parse(text):
    """JSON.parse: integral numbers become int (as JS prints them)."""
    return json.loads(text, parse_float=_parse_float, parse_constant=_reject_constant)


# --------------------------------------------------------------------------
# Reading the extraction file (input.ts)
# --------------------------------------------------------------------------


def decode_text(data):
    """The text of a file: UTF-8 unless a byte order mark says UTF-16. The mark itself is dropped."""
    if data[:2] == b"\xff\xfe":
        return data[2:].decode("utf-16-le", "replace")
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", "replace")
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    return data.decode("utf-8", "replace")


_JSON_HEX = set("0123456789abcdefABCDEF")
_JSON_DIGITS = set("0123456789")
_JSON_WS = set(" \t\n\r")
_JSON_ESCAPES = set('"\\/bfnrt')


def json_error_offset(text):
    """Index of the first character that breaks the JSON grammar, -1 if none, len(text) if the text ends too early."""
    n = len(text)
    i = 0

    def at(k):
        return text[k] if k < n else None

    def string():
        nonlocal i
        i += 1
        while i < n:
            ch = text[i]
            if ch == '"':
                i += 1
                return True
            if ch < " ":
                return False
            if ch == "\\":
                nxt = at(i + 1)
                if nxt is None:
                    i = n
                    return False
                if nxt == "u":
                    for k in range(2, 6):
                        if at(i + k) not in _JSON_HEX:
                            i = min(i + k, n)
                            return False
                    i += 6
                    continue
                if nxt not in _JSON_ESCAPES:
                    i += 1
                    return False
                i += 2
                continue
            i += 1
        return False

    def digits():
        nonlocal i
        if at(i) not in _JSON_DIGITS:
            return False
        while at(i) in _JSON_DIGITS:
            i += 1
        return True

    def number():
        nonlocal i
        if at(i) == "-":
            i += 1
        if at(i) == "0":
            i += 1
        elif not digits():
            return False
        if at(i) == ".":
            i += 1
            if not digits():
                return False
        if at(i) in ("e", "E"):
            i += 1
            if at(i) in ("+", "-"):
                i += 1
            if not digits():
                return False
        return True

    def word(literal):
        nonlocal i
        for ch in literal:
            if at(i) != ch:
                return False
            i += 1
        return True

    opened = []
    expect = "value"
    while True:
        while i < n and text[i] in _JSON_WS:
            i += 1
        if expect == "nothing":
            return i if i < n else -1
        if i >= n:
            return n
        ch = text[i]
        top = opened[-1] if opened else None
        if expect in ("value", "value-or-end"):
            if expect == "value-or-end" and ch == "]":
                i += 1
                opened.pop()
                expect = "comma-or-end" if opened else "nothing"
            elif ch == "{":
                i += 1
                opened.append("{")
                expect = "key-or-end"
            elif ch == "[":
                i += 1
                opened.append("[")
                expect = "value-or-end"
            else:
                if ch == '"':
                    ok = string()
                elif ch == "-" or ch in _JSON_DIGITS:
                    ok = number()
                elif ch == "t":
                    ok = word("true")
                elif ch == "f":
                    ok = word("false")
                elif ch == "n":
                    ok = word("null")
                else:
                    ok = False
                if not ok:
                    return i
                expect = "comma-or-end" if opened else "nothing"
        elif expect in ("key", "key-or-end"):
            if expect == "key-or-end" and ch == "}":
                i += 1
                opened.pop()
                expect = "comma-or-end" if opened else "nothing"
            else:
                if ch != '"' or not string():
                    return i
                expect = "colon"
        elif expect == "colon":
            if ch != ":":
                return i
            i += 1
            expect = "value"
        elif ch == ",":
            i += 1
            expect = "value" if top == "[" else "key"
        elif (top == "[" and ch == "]") or (top == "{" and ch == "}"):
            i += 1
            opened.pop()
            expect = "comma-or-end" if opened else "nothing"
        else:
            return i


def parse_json(text):
    """(True, value), or (False, where the text stops being JSON), worded like input.ts."""
    try:
        return True, js_json_parse(text)
    except (ValueError, RecursionError):
        if js_trim(text) == "":
            return False, "the file is empty"
        offset = json_error_offset(text)
        if offset < 0:
            return False, "not valid JSON"
        line_start = text.rfind("\n", 0, offset) + 1
        where = "line %d, column %d" % (text.count("\n", 0, line_start) + 1, offset - line_start + 1)
        if offset >= len(text):
            return False, "not valid JSON: it ends too early at %s" % where
        return False, "not valid JSON at %s (unexpected %s)" % (where, js_string(text[offset]))


IO_REASONS = {
    "ENOENT": "no such file or folder",
    "EISDIR": "it is a folder, not a file",
    "ENOTDIR": "a file stands where a folder is needed",
    "EEXIST": "a file with that name is in the way",
    "EACCES": "permission denied",
    "EPERM": "permission denied",
    "EROFS": "the file system is read-only",
    "ENOSPC": "no space left on the device",
}


def io_problem(error):
    """Why a file could not be read or written: "no such file or folder (ENOENT)"."""
    code = errno.errorcode.get(error.errno) if isinstance(error, OSError) and error.errno is not None else None
    if code is not None:
        return "%s (%s)" % (IO_REASONS[code], code) if code in IO_REASONS else code
    return str(error).split("\n")[0]


# --------------------------------------------------------------------------
# Decimal (exact; value = units / 10^scale)
# --------------------------------------------------------------------------

_CANONICAL = re.compile(r"-?[0-9]+(\.[0-9]+)?")


def is_canonical_decimal(text):
    return _CANONICAL.fullmatch(text) is not None


def parse_decimal(text):
    if not is_canonical_decimal(text):
        return None
    negative = text.startswith("-")
    body = text[1:] if negative else text
    parts = body.split(".")
    whole = parts[0]
    fraction = parts[1] if len(parts) > 1 else ""
    units = int(whole + fraction)
    return (-units if negative else units, len(fraction))


def dec(text):
    value = parse_decimal(text)
    if value is None:
        raise ValueError("Not a canonical decimal: %s" % js_string(text))
    return value


ZERO = (0, 0)


def _rescale(value, scale):
    return value[0] * 10 ** (scale - value[1])


def _align(a, b):
    scale = max(a[1], b[1])
    return _rescale(a, scale), _rescale(b, scale), scale


def d_add(a, b):
    x, y, scale = _align(a, b)
    return (x + y, scale)


def d_sub(a, b):
    x, y, scale = _align(a, b)
    return (x - y, scale)


def d_mul(a, b):
    return (a[0] * b[0], a[1] + b[1])


def d_sum(values):
    total = ZERO
    for v in values:
        total = d_add(total, v)
    return total


def d_compare(a, b):
    x, y, _ = _align(a, b)
    return -1 if x < y else 1 if x > y else 0


def d_equals(a, b):
    return d_compare(a, b) == 0


def d_abs(value):
    return (-value[0], value[1]) if value[0] < 0 else value


def d_within(a, b, tolerance):
    return d_compare(d_abs(d_sub(a, b)), tolerance) <= 0


def _trunc_div(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def to_fixed(value, fraction_digits):
    units, scale = value
    diff = scale - fraction_digits
    if diff > 0:
        factor = 10 ** diff
        half = factor // 2
        units = _trunc_div(units + (-half if units < 0 else half), factor)
    elif diff < 0:
        units = units * 10 ** (-diff)
    negative = units < 0
    digits = str(-units if negative else units)
    if fraction_digits > 0:
        digits = digits.rjust(fraction_digits + 1, "0")
        digits = digits[:-fraction_digits] + "." + digits[-fraction_digits:]
    return "-" + digits if negative else digits


def to_canonical(value):
    units, scale = value
    if units == 0:
        return "0"
    negative = units < 0
    digits = str(-units if negative else units)
    while scale > 0 and digits.endswith("0") and len(digits) > 1:
        digits = digits[:-1]
        scale -= 1
    if scale > 0:
        digits = digits.rjust(scale + 1, "0")
        digits = digits[:-scale] + "." + digits[-scale:]
    return "-" + digits if negative and digits != "0" else digits


# --------------------------------------------------------------------------
# Extraction schema (structure only) and validation
# --------------------------------------------------------------------------

LANGUAGES = ["en", "ru", "tr", "ka", "other"]
STR = ("str",)
NSTR = ("nullable", STR)


def _cited(kind):
    return ("cited", kind)


TEXT, DECIMAL, DATE, CURRENCY, WORDS = (_cited(k) for k in ("text", "decimal", "date", "currency", "words"))
PARTY = ("obj", [("name", TEXT), ("address", TEXT), ("country", TEXT), ("taxId", TEXT)])
REFERENCE = ("obj", [("number", TEXT), ("date", DATE)])
INCOTERM = ("obj", [("code", TEXT), ("place", TEXT), ("version", TEXT)])


def _document(type_, fields):
    base = [
        ("type", ("literal", type_)),
        ("id", STR),
        ("sourceFile", NSTR),
        ("language", ("nullable", ("enum", LANGUAGES))),
        ("number", TEXT),
        ("date", DATE),
    ]
    return ("obj", base + fields)


INVOICE_LINE = ("obj", [
    ("description", TEXT), ("model", TEXT), ("hsCode", TEXT), ("quantity", DECIMAL),
    ("unit", TEXT), ("unitPrice", DECIMAL), ("lineTotal", DECIMAL),
])
PACKING_LIST_LINE = ("obj", [
    ("description", TEXT), ("model", TEXT), ("quantity", DECIMAL), ("unit", TEXT),
    ("packages", DECIMAL), ("packingMethod", TEXT), ("netWeightKg", DECIMAL), ("grossWeightKg", DECIMAL), ("volumeM3", DECIMAL),
])
CMR_GOODS_LINE = ("obj", [
    ("marksAndNumbers", TEXT), ("packages", DECIMAL), ("packingMethod", TEXT),
    ("description", TEXT), ("grossWeightKg", DECIMAL), ("volumeM3", DECIMAL),
])
DECLARATION_ITEM = ("obj", [
    ("itemNumber", TEXT), ("description", TEXT), ("packages", DECIMAL), ("packingMethod", TEXT),
    ("hsCode", TEXT), ("countryOfOrigin", TEXT), ("grossWeightKg", DECIMAL), ("procedure", TEXT),
    ("netWeightKg", DECIMAL), ("supplementaryQuantity", DECIMAL), ("supplementaryUnit", TEXT),
    ("invoiceValue", DECIMAL), ("customsValueGel", DECIMAL), ("rsValueInGel", DECIMAL),
])
DOCUMENT_SCHEMAS = {
    "commercial_invoice": _document("commercial_invoice", [
        ("seller", PARTY), ("buyer", PARTY), ("consignee", PARTY), ("contractRef", REFERENCE),
        ("incoterm", INCOTERM), ("currency", CURRENCY), ("lines", ("arr", INVOICE_LINE)),
        ("subtotal", DECIMAL), ("discount", DECIMAL), ("discountPercent", DECIMAL), ("freight", DECIMAL), ("insurance", DECIMAL),
        ("otherCharges", ("arr", DECIMAL)), ("tax", DECIMAL), ("total", DECIMAL), ("totalInWords", WORDS), ("packages", DECIMAL), ("netWeightKg", DECIMAL),
        ("grossWeightKg", DECIMAL), ("countryOfOrigin", TEXT),
    ]),
    "packing_list": _document("packing_list", [
        ("shipper", PARTY), ("consignee", PARTY), ("invoiceRef", REFERENCE), ("packingMethod", TEXT),
        ("lines", ("arr", PACKING_LIST_LINE)), ("totalQuantity", DECIMAL), ("totalPackages", DECIMAL),
        ("totalNetWeightKg", DECIMAL), ("totalGrossWeightKg", DECIMAL), ("totalVolumeM3", DECIMAL),
    ]),
    "cmr": _document("cmr", [
        ("placeOfIssue", TEXT), ("sender", PARTY), ("carrier", PARTY), ("placeOfTakingOver", TEXT),
        ("dateOfTakingOver", DATE), ("placeOfDelivery", TEXT), ("consignee", PARTY),
        ("goods", ("arr", CMR_GOODS_LINE)), ("dangerousGoods", TEXT), ("totalPackages", DECIMAL),
        ("totalGrossWeightKg", DECIMAL), ("carriageCharges", TEXT), ("customsInstructions", TEXT),
        ("convention", TEXT), ("attachedDocuments", ("arr", TEXT)),
    ]),
    "contract": _document("contract", [
        ("seller", PARTY), ("buyer", PARTY), ("incoterm", INCOTERM), ("currency", CURRENCY),
        ("totalAmount", DECIMAL), ("totalInWords", WORDS), ("goodsDescription", TEXT),
    ]),
    "customs_declaration": _document("customs_declaration", [
        ("sourceKind", ("nullable", ("enum", ("rs_json",)))),
        ("customsOfficeCode", TEXT), ("customsOfficeName", TEXT), ("regime", TEXT),
        ("assessmentNumber", TEXT), ("assessmentDate", DATE), ("exporter", PARTY), ("importer", PARTY),
        ("countryOfDispatch", TEXT), ("countryOfDestination", TEXT), ("currency", CURRENCY),
        ("totalInvoiceAmount", DECIMAL), ("exchangeRate", DECIMAL), ("totalPackages", DECIMAL),
        ("attachedDocuments", ("arr", TEXT)), ("items", ("arr", DECLARATION_ITEM)),
    ]),
    "other": _document("other", [("title", TEXT)]),
}
DOCUMENT = ("union", "type", DOCUMENT_SCHEMAS)
EXTRACTION = ("obj", [("schemaVersion", ("literal", SCHEMA_VERSION)), ("documents", ("arr", DOCUMENT))])
CITED_FIELDS = [("value", NSTR), ("quote", NSTR), ("page", ("nullable", ("int",)))]
MAX_SAFE_INTEGER = 2 ** 53 - 1


TOP_LEVEL = "(top level)"
_CITED = '{ "value": …, "quote": …, "page": … }'
_BLANK = '{ "value": null, "quote": null, "page": null }'


def _got(data):
    """ "a string", "an array", "null": what was found where something else belongs."""
    if data is UNDEFINED:
        return "nothing"
    if data is None:
        return "null"
    if isinstance(data, bool):
        return "a boolean"
    if isinstance(data, (int, float)):
        return "a number"
    if isinstance(data, str):
        return "a string"
    if isinstance(data, list):
        return "an array"
    return "an object"


def _or_list(values):
    return "".join(values) if len(values) < 2 else "%s or %s" % (", ".join(values[:-1]), values[-1])


def _shape(schema, data, path, issues, nullable=False):
    """Structural check, worded like shape.ts: one line per problem that says what to write."""
    kind = schema[0]
    or_null = " or null" if nullable else ""

    def add(message, at=None):
        issues.append((path if at is None else at, message))

    if kind == "nullable":
        if data is UNDEFINED:
            add("Missing. Write null when there is none.")
        elif data is not None:
            _shape(schema[1], data, path, issues, True)
    elif kind == "cited":
        if data is UNDEFINED:
            add("Missing. Write %s when the document does not print it." % _BLANK)
        elif not isinstance(data, dict):
            add("Must be %s, got %s." % (_CITED, _got(data)))
        else:
            for key, child in CITED_FIELDS:
                _shape(child, data.get(key, UNDEFINED), "%s.%s" % (path, key), issues)
    elif kind == "str":
        if data is UNDEFINED:
            add("Missing. A string is required.")
        elif not isinstance(data, str):
            number = isinstance(data, (int, float)) and not isinstance(data, bool)
            add("Must be a string%s, got %s%s." % (or_null, _got(data), ": write it in quotes" if number else ""))
    elif kind == "int":
        expected = "Must be a whole number (1 for the first page)%s" % or_null
        if isinstance(data, bool) or not isinstance(data, (int, float)):
            add("%s, got %s." % (expected, _got(data)))
        elif data != data or data in (float("inf"), float("-inf")) or abs(data) > MAX_SAFE_INTEGER:
            add("%s, got a number too large to be a page." % expected)
        elif not (isinstance(data, int) or data.is_integer()):
            add("%s, got %s." % (expected, js_number(data)))
    elif kind == "enum":
        choice = _or_list(schema[1]) + (", or null" if nullable else "")
        if not isinstance(data, str):
            add("Must be one of %s, got %s." % (choice, _got(data)))
        elif data not in schema[1]:
            add("Unknown %s %s. Use %s." % (path[path.rfind(".") + 1:], js_string(data), choice))
    elif kind == "literal":
        if not isinstance(data, str) or data != schema[1]:
            add("Must be %s." % js_string(schema[1]))
    elif kind == "arr":
        if data is UNDEFINED:
            add("Missing. Write an empty array when there are none.")
        elif not isinstance(data, list):
            add("Must be an array, got %s." % _got(data))
        else:
            for i, item in enumerate(data):
                _shape(schema[1], item, "%s[%d]" % (path, i), issues)
    elif kind == "union":
        if not isinstance(data, dict):
            add("Must be an object, got %s." % _got(data))
            return
        types = _or_list(list(schema[2]))
        type_ = data.get(schema[1], UNDEFINED)
        option = schema[2].get(type_) if isinstance(type_, str) else None
        type_path = "%s.%s" % (path, schema[1])
        if option is not None:
            for key, child in option[1]:
                if key != schema[1]:
                    _shape(child, data.get(key, UNDEFINED), "%s.%s" % (path, key), issues)
        elif type_ is UNDEFINED:
            add("Missing. Use %s." % types, type_path)
        elif isinstance(type_, str):
            add("Unknown type %s. Use %s." % (js_string(type_), types), type_path)
        else:
            add("Must be one of %s, got %s." % (types, _got(type_)), type_path)
    elif kind == "obj":
        keys = ", ".join(key for key, _ in schema[1])
        if data is UNDEFINED:
            add("Missing. Write an object with the keys %s." % keys)
        elif not isinstance(data, dict):
            add("Must be an object with the keys %s, got %s." % (keys, _got(data)))
        else:
            for key, child in schema[1]:
                _shape(child, data.get(key, UNDEFINED), "%s.%s" % (path, key), issues)


def shape_issues(data):
    """Every shape problem as (path, message), in schema order; another schema version is one line and nothing else."""
    current = js_string(SCHEMA_VERSION)
    if not isinstance(data, dict):
        return [(TOP_LEVEL, "Must be one JSON object with the keys schemaVersion and documents, got %s." % _got(data))]
    issues = []
    version = data.get("schemaVersion", UNDEFINED)
    documents = data.get("documents", UNDEFINED)
    if version is UNDEFINED:
        issues.append(("schemaVersion", 'Missing. Write "schemaVersion": %s when the extraction follows the guide that comes with this checker.' % current))
    elif not isinstance(version, str):
        issues.append(("schemaVersion", "Must be the string %s, got %s." % (current, _got(version))))
    elif version != SCHEMA_VERSION:
        return [("schemaVersion", "This extraction is written for schema version %s; this checker reads version %s. "
                 "Extract the documents again with the guide that comes with this checker." % (js_string(version), current))]
    if documents is UNDEFINED:
        issues.append(("documents", "Missing. Write an array with one object per document."))
    elif not isinstance(documents, list):
        issues.append(("documents", "Must be an array with one object per document, got %s." % _got(documents)))
    else:
        _shape(("arr", DOCUMENT), documents, "documents", issues)
    return issues


def _strip(schema, data):
    """Parsed copy: unknown keys dropped, integral numbers as int."""
    kind = schema[0]
    if data is None:
        return None
    if kind == "nullable":
        return _strip(schema[1], data)
    if kind == "int":
        return int(data)
    if kind == "arr":
        return [_strip(schema[1], item) for item in data]
    if kind == "cited":
        return _strip(("obj", CITED_FIELDS), data)
    if kind == "obj":
        return {key: _strip(child, data[key]) for key, child in schema[1]}
    if kind == "union":
        return _strip(schema[2][data[schema[1]]], data)
    return data


def walk_cited(schema, data, visit, path=""):
    kind = schema[0]
    if kind == "cited":
        visit(schema[1], path, data)
    elif kind == "nullable":
        if data is not None:
            walk_cited(schema[1], data, visit, path)
    elif kind == "union":
        walk_cited(schema[2][data[schema[1]]], data, visit, path)
    elif kind == "arr":
        for index, item in enumerate(data):
            walk_cited(schema[1], item, visit, "%s[%d]" % (path, index))
    elif kind == "obj":
        for key, child in schema[1]:
            walk_cited(child, data[key], visit, "%s.%s" % (path, key) if path else key)


_ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_ISO_CURRENCY = re.compile(r"[A-Z]{3}")
_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def is_iso_date(text):
    match = _ISO_DATE.fullmatch(text)
    if not match:
        return False
    year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    if month < 1 or month > 12 or day < 1:
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = 29 if month == 2 and leap else _DAYS[month - 1]
    return day <= days


def is_iso_currency(text):
    return _ISO_CURRENCY.fullmatch(text) is not None


# --------------------------------------------------------------------------
# Readings of the numbers and dates printed in a quote (quote.ts)
# --------------------------------------------------------------------------

_CHUNK = re.compile("[0-9]+(?:[.,'    ’][0-9]+)*")
_DIGIT_GROUP = re.compile("[0-9]+")
GROUPING = "    '’"
BLANK = " \t   "


def _other_sign(sign):
    return "," if sign == "." else "."


def _threes(groups):
    return all(len(group) == 3 for group in groups)


def _read_segment(segment):
    """Readings [(canonical value, decimal sign or None)] of one number, or None for an unknown pattern."""
    parts, seps, grouped = segment["parts"], segment["seps"], segment["grouped"]
    if not seps:
        return [(parts[0], None)]
    last = seps[-1]
    other = _other_sign(last)
    if other in seps:
        if last in seps[:-1] or not _threes(parts[1:-1]):
            return None
        return [("".join(parts[:-1]) + "." + parts[-1], last)]
    if len(seps) > 1:
        return [("".join(parts), other)] if _threes(parts[1:]) else None
    whole, fraction = parts[0], parts[1]
    readings = []
    if not grouped and len(fraction) == 3 and len(whole) <= 3 and not whole.startswith("0"):
        readings.append((whole + fraction, other))
    readings.append((whole + "." + fraction, last))
    return readings


def _segments(chunk, offset, join):
    out = []
    current = None
    first_group = 0
    previous_end = 0
    for match in _DIGIT_GROUP.finditer(chunk):
        group = match.group(0)
        sep = chunk[previous_end:match.start()] if match.start() > 0 else ""
        previous_end = match.end()
        end = offset + previous_end
        if current is not None and sep in (".", ","):
            current["parts"].append(group)
            current["seps"].append(sep)
            current["end"] = end
        elif (current is not None and join and not current["seps"] and len(group) == 3 and first_group <= 3
              and sep != "" and sep in GROUPING):
            current["parts"][0] += group
            current["grouped"] = True
            current["end"] = end
        else:
            current = {"parts": [group], "seps": [], "grouped": False, "start": offset + match.start(), "end": end}
            first_group = len(group)
            out.append(current)
    return out


def _is_digit_char(quote, index):
    return 0 <= index < len(quote) and "0" <= quote[index] <= "9"


def _percent_around(quote, start, end):
    """Does a percent sign belong to the number at [start, end)? It belongs to the number it touches
    ("20%", "%18"), never across a space to the next number; a sign that stands free belongs to the one
    number beside it, and to neither when a number stands on each side."""
    n = len(quote)
    if end < n and quote[end] == "%":
        return True
    if start >= 1 and quote[start - 1] == "%":
        return not _is_digit_char(quote, start - 2)
    after = end
    while after < n and quote[after] in BLANK:
        after += 1
    if after < n and quote[after] == "%":
        beyond = after + 1
        while beyond < n and quote[beyond] in BLANK:
            beyond += 1
        if not _is_digit_char(quote, beyond):
            return True
    before = start - 1
    while before >= 0 and quote[before] in BLANK:
        before -= 1
    if before >= 0 and quote[before] == "%":
        beyond = before - 1
        while beyond >= 0 and quote[beyond] in BLANK:
            beyond -= 1
        if beyond < 0 or not _is_digit_char(quote, beyond):
            return True
    return False


def printed_numbers(quote):
    """Every number printed in a quote with the ways it can be read."""
    result = {"numbers": [], "fragments": [], "unsure": False}

    def add(target, segment):
        readings = _read_segment(segment)
        if readings is None:
            result["unsure"] = True
            return
        target.append({"text": quote[segment["start"]:segment["end"]], "readings": readings,
                       "percent": _percent_around(quote, segment["start"], segment["end"]),
                       "start": segment["start"], "end": segment["end"]})

    for match in _CHUNK.finditer(quote):
        joined = _segments(match.group(0), match.start(), True)
        split = _segments(match.group(0), match.start(), False)
        for segment in joined:
            add(result["numbers"], segment)
        if len(split) != len(joined):
            for segment in split:
                add(result["fragments"], segment)
    return result


_BRACKET_OPEN = re.compile("\\((?:[ \t\u00a0\u202f]*(?:[A-Z]{3}|[$€£₾₺₽]))?[ \t\u00a0\u202f]*\\Z")
_BRACKET_CLOSE = re.compile("[ \t\u00a0\u202f]*(?:(?:[A-Z]{3}|[$€£₾₺₽])[ \t\u00a0\u202f]*)?\\)")
MINUS = "-\u2212"


def printed_negative(quote, start, end):
    """Is the number at [start, end) printed as a negative amount: in brackets, or with a minus attached?"""
    if _BRACKET_OPEN.search(quote[:start]) and _BRACKET_CLOSE.match(quote[end:]):
        return True

    def opens_field(index):
        return index < 0 or quote[index] in BLANK or quote[index] == "("

    if start >= 1 and quote[start - 1] in MINUS:
        return opens_field(start - 2)
    before = start - 1
    while before >= 0 and quote[before] in BLANK:
        before -= 1
    return 0 <= before < start - 1 and quote[before] == "\u2212" and opens_field(before - 1)


def shown_decimal_sign(number):
    return number["readings"][0][1] if len(number["readings"]) == 1 else None


def readings_with(number, sign):
    fitting = [r for r in number["readings"] if r[1] is None or r[1] == sign]
    return fitting if fitting else number["readings"]


_NUMERIC_DATE = re.compile("(?<![0-9])([0-9]{1,4})[  ]*([./-])[  ]*([0-9]{1,2})[  ]*\\2[  ]*([0-9]{1,4})(?![0-9])")


def _date_readings(a, b, c):
    """Readings [(iso, order)] of three numbers printed as a date."""
    A, B, C = int(a), int(b), int(c)
    out = []

    def push(year, month, day, order):
        iso = "%04d-%02d-%02d" % (year, month, day)
        if is_iso_date(iso) and not any(reading[0] == iso for reading in out):
            out.append((iso, order))

    if len(a) == 4:
        if len(c) <= 2:
            push(A, B, C, "ymd")
    elif len(c) == 4:
        if len(a) <= 2:
            push(C, B, A, "dmy")
            push(C, A, B, "mdy")
    elif len(a) <= 2 and len(c) <= 2:
        for century in (2000, 1900):
            push(century + C, B, A, "dmy")
            push(century + C, A, B, "mdy")
            push(century + A, B, C, "ymd")
    return out


def printed_dates(quote):
    """Every all-numeric date printed in a quote with the ways it can be read."""
    dates = []
    for match in _NUMERIC_DATE.finditer(quote):
        a, b, c = match.group(1), match.group(3), match.group(4)
        readings = _date_readings(a, b, c)
        if not readings:
            continue
        full_year_last = len(c) == 4 and len(a) <= 2
        day_first = full_year_last and int(b) <= 12
        month_first = full_year_last and int(a) <= 12
        shows = None if len(readings) != 1 or day_first == month_first else "dmy" if day_first else "mdy"
        dates.append({"text": match.group(0), "readings": readings, "fullYearLast": full_year_last, "shows": shows})
    return dates


def date_readings_with(date, order):
    if not date["fullYearLast"]:
        return date["readings"]
    fitting = [r for r in date["readings"] if r[1] == order]
    return fitting if fitting else date["readings"]


_CLOCK_TIME = re.compile("[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?")


def month_name_date(quote, language):
    """The date a quote prints with a month name, as YYYY-MM-DD, or None when it is not one beyond doubt.
    A month is read in the document's own language or in English, and in no other."""
    if language is None or language not in MONTH_WORDS:
        return None
    own, english = MONTH_WORDS[language], MONTH_WORDS["en"]
    months = [own.get(word, english.get(word)) for word in _letter_runs(fold_name(quote))]
    months = [month for month in months if month is not None]
    if len(months) != 1:
        return None
    day = None
    year = None
    for digits in _DIGIT_GROUP.findall(_CLOCK_TIME.sub(" ", quote)):
        number = int(digits)
        if len(digits) == 4 and 1900 <= number <= 2100 and year is None:
            year = digits
        elif len(digits) <= 2 and 1 <= number <= 31 and day is None:
            day = digits
        else:
            return None
    if day is None or year is None:
        return None
    iso = "%s-%02d-%s" % (year, months[0], day.rjust(2, "0"))
    return iso if is_iso_date(iso) else None


_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def other_currency(value, quote):
    """The one currency a quote names by code or sign when the value is not it, or None."""
    codes = []
    n = len(quote)
    i = 0
    while i < n:
        if quote[i] in _UPPER:
            j = i
            while j < n and quote[j] in _UPPER:
                j += 1
            run = quote[i:j]
            if (j - i == 3 and not (i > 0 and is_letter_or_number(quote[i - 1])) and not (j < n and is_letter_or_number(quote[j]))
                    and run in CURRENCY_CODES):
                if run not in codes:
                    codes.append(run)
            else:
                # Any other word: the quote is more than a currency with its amount, so nothing is read from it.
                return None
            i = j
        elif is_letter(quote[i]):
            return None
        else:
            i += 1
    signs = []
    for ch in quote:
        if ch in CURRENCY_SIGNS and ch not in signs:
            signs.append(ch)
    if value in codes or any(value in CURRENCY_SIGNS[sign] for sign in signs):
        return None
    named = []
    for code in codes + [CURRENCY_SIGNS[sign][0] for sign in signs]:
        if code not in named:
            named.append(code)
    return named[0] if len(named) == 1 else None


def _agreed(shown):
    """The one value all (value, example) entries agree on, as the first entry; None when none or they disagree."""
    if not shown:
        return None
    first = shown[0]
    return first if all(entry[0] == first[0] for entry in shown) else None


def _convention_of(doc):
    """How one document prints its numbers and dates, where its own quotes show it beyond doubt."""
    signs = []
    orders = []

    def visit(kind, path, field):
        if field["value"] is None or field["quote"] is None:
            return
        if kind == "decimal":
            for number in printed_numbers(field["quote"])["numbers"]:
                sign = shown_decimal_sign(number)
                if sign:
                    signs.append((sign, number["text"]))
        elif kind == "date":
            for date in printed_dates(field["quote"]):
                if date["shows"]:
                    orders.append((date["shows"], date["text"]))

    walk_cited(DOCUMENT, doc, visit)
    return {"decimal": _agreed(signs), "date": _agreed(orders), "language": doc["language"]}


def _listed(values):
    unique = []
    for value in values:
        if value not in unique:
            unique.append(value)
    return " or ".join(unique[:4])


def _decimal_issue(value, quote, path, convention):
    target = d_abs(parse_decimal(value))
    printed = printed_numbers(quote)
    numbers = printed["numbers"]

    def reads(number, sign=None):
        readings = readings_with(number, sign) if sign else number["readings"]
        return any(d_equals(parse_decimal(reading[0]), target) for reading in readings)

    matching = [number for number in numbers + printed["fragments"] if reads(number)]
    if not matching:
        if not numbers or printed["unsure"]:
            return None
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s", which reads %s.'
                % (value, quote, _listed([r[0] for n in numbers for r in n["readings"]])))
    decimal = convention["decimal"]
    if decimal and not any(reads(number, decimal[0]) for number in matching):
        expected = _listed([r[0] for n in matching for r in readings_with(n, decimal[0])])
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s": this document writes decimals with "%s" (as in "%s"), so the quote reads %s.'
                % (value, quote, decimal[0], decimal[1], expected))
    if all(number["percent"] for number in matching) and not path.endswith(".discountPercent"):
        return ("EXT_PERCENTAGE", '"%s" is a percentage in the quote "%s", and this field takes an amount. Give the printed amount, or null when only a rate is printed.'
                % (value, quote))
    # The sign of a charge the total adds: "(500.00)" or "-500.00" given as 500.00 would be added where it is taken off.
    if (_SIGNED_FIELD.search(path) and len(numbers) == 1 and not printed["fragments"] and not printed["unsure"]
            and d_compare(parse_decimal(value), ZERO) > 0 and printed_negative(quote, numbers[0]["start"], numbers[0]["end"])):
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s": an amount printed in brackets or with a minus is negative, so the quote reads -%s.'
                % (value, quote, value))
    return None


_SIGNED_FIELD = re.compile(r"\.(?:freight|insurance|tax|otherCharges\[[0-9]+\])\Z")


def _currency_issue(value, quote):
    named = other_currency(value, quote)
    if named is None:
        return None
    return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s", which names %s.' % (value, quote, named))


def _date_issue(value, quote, convention):
    dates = printed_dates(quote)
    if not dates:
        # No all-numeric date: a date with a month name, when the quote is one beyond doubt, or nothing to compare with.
        named = month_name_date(quote, convention["language"])
        if named is None or named == value:
            return None
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s", which reads %s.' % (value, quote, named))
    matching = [date for date in dates if any(reading[0] == value for reading in date["readings"])]
    if not matching:
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s", which reads %s.'
                % (value, quote, _listed([r[0] for d in dates for r in d["readings"]])))
    date = convention["date"]
    if date and not any(any(reading[0] == value for reading in date_readings_with(printed, date[0])) for printed in matching):
        expected = _listed([r[0] for printed in matching for r in date_readings_with(printed, date[0])])
        order = "the day before the month" if date[0] == "dmy" else "the month before the day"
        return ("EXT_QUOTE_MISMATCH", '"%s" does not match the quote "%s": this document writes %s (as in "%s"), so the quote reads %s.'
                % (value, quote, order, date[1], expected))
    return None


def rs_date(quote):
    m = re.fullmatch(r"([0-9]{2})\.([0-9]{2})\.([0-9]{4})", quote)
    if not m:
        return None
    value = "%s-%s-%s" % (m[3], m[2], m[1])
    return value if is_iso_date(value) else None


def json_decimal(quote):
    m = re.fullmatch(r"(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?", quote)
    if not m:
        return None
    sign, whole, fraction, exponent = m.groups()
    if exponent is None:
        return quote
    # shortcut: cap exponent expansion to bound allocation; raise for a documented larger range.
    digits = exponent.lstrip("+-").lstrip("0")
    if len(digits) > 4:
        return None
    shift = int(digits or "0") * (-1 if exponent.startswith("-") else 1)
    if abs(shift) > 1000:
        return None
    digits = whole + (fraction or "")
    point = len(whole) + shift
    if point <= 0:
        return sign + "0." + "0" * -point + digits
    left = digits[:point].ljust(point, "0").lstrip("0") or "0"
    return sign + left + ("." + digits[point:] if point < len(digits) else "")


def inspect_extraction(extraction):
    """Checks every cited field: (issues, ids of the fields no rule may use)."""
    issues = []
    unusable = set()
    seen = set()
    for index, doc in enumerate(extraction["documents"]):
        if doc["id"] in seen:
            issues.append({"code": "EXT_DUPLICATE_ID", "path": "documents[%d].id" % index, "message": 'Duplicate document id "%s".' % doc["id"]})
        seen.add(doc["id"])

    for index, doc in enumerate(extraction["documents"]):
        declaration = doc["type"] == "customs_declaration"
        rs = declaration and doc["sourceKind"] == "rs_json"
        convention = _convention_of(doc)

        def visit(kind, path, field):
            value, quote, page = field["value"], field["quote"], field["page"]
            if value is None:
                return
            cited = quote if quote is not None and js_trim(quote) != "" else None
            if cited is None:
                issues.append({"code": "EXT_UNCITED", "path": path, "message": "Value has no supporting quote."})
            if page is not None and page < 1:
                issues.append({"code": "EXT_PAGE", "path": path, "message": "Page must be 1 or more, got %s." % js_number(page)})
            problem = None
            if kind == "decimal":
                if not is_canonical_decimal(value):
                    problem = ("EXT_DECIMAL_FORMAT", '"%s" is not a canonical decimal like 13300.00.' % value)
                elif cited is not None and not rs:
                    problem = _decimal_issue(value, cited, path, convention)
            elif kind == "date":
                if not is_iso_date(value):
                    problem = ("EXT_DATE_FORMAT", '"%s" is not a valid YYYY-MM-DD date.' % value)
                elif cited is not None and not rs:
                    problem = _date_issue(value, cited, convention)
            elif kind == "currency":
                if not is_iso_currency(value):
                    problem = ("EXT_CURRENCY_FORMAT", '"%s" is not an ISO 4217 code like EUR.' % value)
                elif cited is not None and not rs:
                    problem = _currency_issue(value, cited)
            if rs and problem is None and cited is not None:
                reading = json_decimal(cited) if kind == "decimal" or path.endswith(".itemNumber") else rs_date(cited) if kind == "date" else cited
                if value != reading:
                    problem = ("EXT_QUOTE_MISMATCH", '"%s" does not match the Revenue Service JSON value "%s".' % (value, cited))
            if rs and page is not None:
                issues.append({"code": "EXT_PAGE", "path": path, "message": "A Revenue Service JSON citation has no page. Write null."})
            elif declaration and not rs and page is None:
                issues.append({"code": "EXT_PAGE", "path": path, "message": "Give the page of the customs declaration where the quote is printed."})
            wrong_page = page is not None if rs else page is None or page < 1
            if declaration and (cited is None or wrong_page):
                unusable.add(id(field))
            if problem is not None:
                issues.append({"code": problem[0], "path": path, "message": problem[1]})
                unusable.add(id(field))

        walk_cited(DOCUMENT, doc, visit, "documents[%d]" % index)
    return issues, unusable


def parse_extraction(data):
    issues = shape_issues(data)
    if issues:
        return {
            "ok": False,
            "extraction": None,
            "issues": [{"code": "EXT_SHAPE", "path": path, "message": message} for path, message in issues],
        }
    extraction = _strip(EXTRACTION, data)
    issues, unusable = inspect_extraction(extraction)
    return {"ok": True, "extraction": extraction, "issues": issues, "unusable": unusable}


# ==== words ====
# --------------------------------------------------------------------------
# Amounts in words
# --------------------------------------------------------------------------


class WordsParseError(Exception):
    def __init__(self, code, message, word=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.word = word


_DIGITS = re.compile(r"[0-9]+")
_FRACTION = re.compile(r"([0-9]{1,2})/100")
_ZERO_FRACTION = re.compile(r"(?:no|xx|zero)/100")


def _words(text, lexicon):
    text = locale_lower(nfc(text), lexicon["locale"]).replace("ё", "е")
    out = []
    for ch in text:
        out.append(ch if ch in "/&" or cat(ch)[0] in "LMN" else " ")
    return "".join(out).split(" ")


def words_of(text, lexicon):
    return [w for w in _words(text, lexicon) if w]


def _starts_with_stem(word, stems):
    best = None
    for stem, value in stems.items():
        if word.startswith(stem) and (best is None or utf16_len(stem) > utf16_len(best[0])):
            best = (stem, value)
    return best


# Items: ("number", value, role, text) | ("digits", value, text) | ("fraction", value, text)
#        ("major", code, text, stem) | ("minor", code, text) | ("qualifier", codes)
#        ("connector", standalone) | ("ignore",)


def _classify_exact(word, lexicon):
    if _DIGITS.fullmatch(word):
        return ("digits", int(word), word)
    fraction = _FRACTION.fullmatch(word)
    if fraction:
        return ("fraction", int(fraction.group(1)), word)
    if _ZERO_FRACTION.fullmatch(word):
        return ("fraction", 0, word)
    number = lexicon["numbers"].get(word)
    if number:
        return ("number", number["value"], number["role"], word)
    if word in lexicon["connectors"]:
        return ("connector", True)
    if word in lexicon["ignorable"]:
        return ("ignore",)
    return None


def _classify_currency(word, lexicon):
    """Longest stem wins, so "евроцентов" is cents, not euro."""
    major = _starts_with_stem(word, lexicon["major"])
    minor = _starts_with_stem(word, lexicon["minor"])
    if minor and (not major or utf16_len(minor[0]) > utf16_len(major[0])):
        return ("minor", minor[1], word)
    if major:
        return ("major", major[1], word, major[0])
    qualifier = _starts_with_stem(word, lexicon["qualifiers"])
    return ("qualifier", qualifier[1]) if qualifier else None


SUFFIX = "suffix"
_MORPHEME_CACHE = {}


def _morphemes(lexicon):
    cached = _MORPHEME_CACHE.get(lexicon["language"])
    if cached is not None:
        return cached
    items = []
    for text, word in lexicon["numbers"].items():
        items.append((text, ("number", word["value"], word["role"], text)))
    for text in lexicon["connectors"]:
        items.append((text, ("connector", False)))
    for text in lexicon["ignorable"]:
        items.append((text, ("ignore",)))
    for text, code in lexicon["major"].items():
        items.append((text, ("major", code, text, text)))
    for text, codes in lexicon["qualifiers"].items():
        items.append((text, ("qualifier", codes)))
    for text, code in lexicon["minor"].items():
        items.append((text, ("minor", code, text)))
    for text in lexicon["suffixes"]:
        items.append((text, SUFFIX))
    items.sort(key=lambda m: -utf16_len(m[0]))  # stable, longest first
    _MORPHEME_CACHE[lexicon["language"]] = items
    return items


AFTER_START, AFTER_PART, AFTER_CURRENCY, AFTER_SUFFIX = 0, 1, 2, 3


def _segment(word, lexicon):
    """Glued word -> morphemes, longest match first, backtracking. A suffix
    follows a word part at the end, or a currency part inside the word."""
    morphemes = _morphemes(lexicon)
    length = len(word)
    memo = {}

    def walk(position, after):
        if position == length:
            return []
        key = (position, after)
        if key in memo:
            return memo[key]
        result = None
        for text, item in morphemes:
            if not word.startswith(text, position):
                continue
            end = position + len(text)
            if item is SUFFIX:
                if after in (AFTER_START, AFTER_SUFFIX):
                    continue
                if end == length:
                    result = []
                    break
                if after != AFTER_CURRENCY:
                    continue
                rest = walk(end, AFTER_SUFFIX)
                if rest is not None:
                    result = rest
                    break
                continue
            rest = walk(end, AFTER_CURRENCY if item[0] in ("major", "minor") else AFTER_PART)
            if rest is not None:
                result = [item] + rest
                break
        memo[key] = result
        return result

    return walk(0, AFTER_START)


def _read_word(word, lexicon):
    exact = _classify_exact(word, lexicon)
    if exact:
        return [exact]
    parts = _segment(word, lexicon) if lexicon["glued"] else None
    if parts:
        return parts
    currency = _classify_currency(word, lexicon)
    return [currency] if currency else None


def _tokenize(text, lexicon):
    items = []
    words = words_of(text, lexicon)
    for index, word in enumerate(words):
        if word in lexicon["articles"]:
            # "a hundred", "a thousand": one. Anywhere else an article carries no amount.
            number = lexicon["numbers"].get(words[index + 1]) if index + 1 < len(words) else None
            items.append(("number", 1, "unit", word) if number and number["role"] != "unit" else ("ignore",))
            continue
        read = _read_word(word, lexicon)
        if not read and lexicon["language"] == "tr" and "ı" in word:
            read = _read_word(word.replace("ı", "i"), lexicon)
        if not read:
            raise WordsParseError("UNKNOWN_WORD", 'Unknown word "%s".' % word, word)
        items.extend(read)
    return items


def _room_after(value, lexicon):
    """What a unit word leaves room for in its group of three digits."""
    if value >= 100:
        return 100
    if value >= 20 and value % 10 == 0:
        return 20 if lexicon["vigesimal"] and value % 20 == 0 else 10
    if value == 10:
        return 10 if lexicon["compoundTeens"] else 1
    return 1


def _evaluate(run, lexicon):
    total = 0
    group = 0
    room = None  # what the group can still take; None before its first word
    last_scale = None
    saw_hundred = False
    phrase = " ".join(text for _, _, text in run)

    def invalid():
        return WordsParseError("INVALID_SEQUENCE", 'Not a valid number: "%s".' % phrase, phrase)

    for value, role, _ in run:
        if role == "unit":
            if room is not None and value >= room:
                raise invalid()
            if value == 0 and (group != 0 or total != 0 or len(run) > 1):
                raise invalid()
            group += value
            room = _room_after(value, lexicon)
        elif role == "hundred":
            if saw_hundred or group >= 100:
                raise invalid()
            group = (1 if group == 0 else group) * 100
            saw_hundred = True
            room = 100
        else:
            if last_scale is not None and value >= last_scale:
                raise invalid()
            total += (1 if group == 0 else group) * value
            group = 0
            room = None
            last_scale = value
            saw_hundred = False
    return total + group


def _apply_qualifiers(items):
    """"Swiss francs": a qualifier next to a currency word it knows settles the currency."""
    out = list(items)
    for index, item in enumerate(items):
        if item[0] != "qualifier":
            continue
        for at in (index + 1, index - 1):
            near = out[at] if 0 <= at < len(out) else None
            code = item[1].get(near[3]) if near is not None and near[0] == "major" else None
            if code:
                out[at] = ("major", code, near[2], near[3])
                break
    return [("ignore",) if item[0] == "qualifier" else item for item in out]


def _merge_cent_compounds(items):
    """"euro cents", "евро центов": "euro" right before a cent word names the minor unit."""
    out = []
    for item in items:
        previous = out[-1] if out else None
        if (item[0] == "minor" and previous is not None and previous[0] == "major" and previous[1] == "EUR"
                and (item[1] is None or item[1] == "EUR")):
            out[-1] = ("minor", "EUR", previous[2] + " " + item[2])
        else:
            out.append(item)
    return out


def _meaningful(item):
    return item[0] not in ("connector", "ignore")


# Elements: ("amount", value, is_fraction) | ("major", code) | ("minor", code)


def _elements(items, lexicon):
    out = []
    index = 0
    while index < len(items):
        item = items[index]
        kind = item[0]
        if kind == "number":
            run = []
            splits = []
            connector = False
            end = index
            while end < len(items):
                nxt = items[end]
                if nxt[0] == "number":
                    if connector:
                        splits.append(len(run))
                    connector = False
                    run.append((nxt[1], nxt[2], nxt[3]))
                elif nxt[0] == "connector":
                    if nxt[1]:
                        connector = True
                elif nxt[0] != "ignore":
                    break
                end += 1
            after = next((i for i in items[end:] if _meaningful(i)), None)
            split = splits[-1] if splits and out and out[-1][0] == "major" and after is not None and after[0] == "minor" else 0
            for part in ([run[:split], run[split:]] if split > 0 else [run]):
                out.append(("amount", _evaluate(part, lexicon), False))
            index = end
            continue
        if kind in ("digits", "fraction"):
            out.append(("amount", item[1], kind == "fraction"))
        elif kind in ("major", "minor"):
            previous = out[-1] if out else None
            if not (previous is not None and previous[0] == kind and previous[1] == item[1]):
                out.append((kind, item[1]))
        index += 1
    return out


def _interpret(items, lexicon):
    els = _elements(_merge_cent_compounds(_apply_qualifiers(items)), lexicon)
    if not any(e[0] == "amount" for e in els):
        raise WordsParseError("EMPTY", "No amount found.")
    prefix_style = els[0][0] != "amount"
    owner = {}
    currency_of = {}

    def element(at):
        return els[at] if 0 <= at < len(els) else None

    def neighbour(start, step, skip_fractions):
        at = start + step
        while skip_fractions:
            el = element(at)
            if el is None or el[0] != "amount" or not el[2]:
                break
            at += step
        return at

    for index, el in enumerate(els):
        if el[0] != "amount":
            continue
        for step in ((-1, 1) if prefix_style else (1, -1)):
            at = neighbour(index, step, not el[2])
            word = element(at)
            if word is None or word[0] == "amount" or at in owner:
                continue
            if el[2] and word[0] != "minor":
                continue
            owner[at] = index
            currency_of[index] = at
            across = neighbour(index, -step, True)
            twin = element(across)
            if word[0] == "major" and twin is not None and twin[0] == "major" and twin[1] == word[1] and across not in owner:
                owner[across] = index
            break
    if any(el[0] != "amount" and index not in owner for index, el in enumerate(els)):
        raise WordsParseError("AMBIGUOUS", "A currency word is not attached to any number.")

    has_major_word = any(e[0] == "major" for e in els)
    major = None
    minor = None
    currency = None
    for index, el in enumerate(els):
        if el[0] != "amount":
            continue
        at = currency_of.get(index)
        word = els[at] if at is not None else None
        word_kind = word[0] if word is not None else None
        if el[2] or word_kind == "minor":
            role = "minor"
        elif word_kind == "major" or major is None:
            role = "major"
        else:
            role = "minor"
        if role == "major":
            if major is not None:
                raise WordsParseError("AMBIGUOUS", "More than one main amount.")
            major = el[1]
            if word_kind == "major":
                currency = word[1]
        else:
            if minor is not None:
                raise WordsParseError("AMBIGUOUS", "More than one minor-unit amount.")
            minor = el[1]
            if word_kind == "minor" and word[1] is not None and currency is None and not has_major_word:
                currency = word[1]
    if major is None:
        major = 0
    if minor is not None and minor >= 100:
        raise WordsParseError("MINOR_OUT_OF_RANGE", "Minor units must be below 100, got %d." % minor)
    amount = (major, 0) if minor is None else (major * 100 + minor, 2)
    return {"language": lexicon["language"], "currency": currency, "major": major, "minor": minor, "amount": amount}


_TR_LETTERS = set(fold("çğıöşüİ"))
_TR_WORDS = [fold(w) for w in ("yalniz", "bin", "yuz", "kurus", "lira", "avro", "milyon")]


def _in_ranges(text, ranges):
    return any(lo <= ord(ch) <= hi for ch in text for lo, hi in ranges)


GEORGIAN = [(0x10A0, 0x10FF), (0x1C90, 0x1CBF)]
CYRILLIC = [(0x0400, 0x04FF)]


def detect_words_language(text):
    if _in_ranges(text, GEORGIAN):
        return "ka"
    if _in_ranges(text, CYRILLIC):
        return "ru"
    folded = fold(text)
    if any(ch in _TR_LETTERS for ch in folded):
        return "tr"
    for i in range(len(text)):
        if i > 0 and is_letter_or_number(text[i - 1]):
            continue  # (?<![\p{L}\p{N}])
        if any(folded.startswith(w, i) for w in _TR_WORDS):
            return "tr"
    return "en"


def parse_amount_in_words_as(text, language):
    lexicon = LEXICONS[language]
    try:
        return {"ok": True, "value": _interpret(_tokenize(text, lexicon), lexicon)}
    except WordsParseError as error:
        result = {"code": error.code, "message": error.message}
        if error.word:
            result["word"] = error.word
        return {"ok": False, "error": result}


def parse_amount_in_words(text, language=None):
    if language and language != "other":
        stated = parse_amount_in_words_as(text, language)
        detected = detect_words_language(text)
        if stated["ok"] or detected == language:
            return stated
        fallback = parse_amount_in_words_as(text, detected)
        if fallback["ok"]:
            return fallback
        # Both failed: the detected language's error names a word of the phrase's own language. English is only
        # the default for unmarked Latin text and does not overrule a document stated to be Turkish.
        return stated if language == "tr" and detected == "en" else fallback
    first = detect_words_language(text)
    first_result = parse_amount_in_words_as(text, first)
    if first_result["ok"]:
        return first_result
    for other in LEXICONS:
        if other == first:
            continue
        result = parse_amount_in_words_as(text, other)
        if result["ok"]:
            return result
    return first_result


# ==== checks ====
# --------------------------------------------------------------------------
# Check helpers
# --------------------------------------------------------------------------


# What the rules know about the extraction they run on: the fields the
# extraction check found unusable and each document's position (ids may
# repeat, positions cannot). Set by check_extraction for the length of a run.
_RUN = {"unusable": frozenset(), "indexes": {}}


def evidence(doc, path, field, computed=False):
    result = {
        "documentId": doc["id"],
        "documentIndex": _RUN["indexes"].get(id(doc), -1),
        "documentType": doc["type"],
        "path": path,
        "value": field["value"],
        "quote": field["quote"],
        "page": field["page"],
    }
    if computed:
        result["computed"] = True
    return result


def num(field):
    """Decimal value of a cited field, or None if absent, malformed or unusable."""
    return None if field["value"] is None or id(field) in _RUN["unusable"] else parse_decimal(field["value"])


def text_of(field):
    value = field["value"]
    value = js_trim(value) if value is not None else None
    return value if value else None


def quoted(field):
    return (id(field) not in _RUN["unusable"] and (field["page"] is None or field["page"] >= 1)
            and field["quote"] is not None and bool(js_trim(field["quote"])))


def cited_written_text(field):
    value = text_of(field)
    return value if quoted(field) and value == js_trim(field["quote"]) else None


def iso_date(field):
    value = field["value"]
    return value if value is not None and id(field) not in _RUN["unusable"] and is_iso_date(value) else None


def currency_code(field):
    """ISO 4217 code of a currency field, or None if absent, not a code or unusable."""
    value = field["value"]
    return value if value is not None and id(field) not in _RUN["unusable"] and is_iso_currency(value) else None


def sum_all(items, pick):
    if not items:
        return None
    values = [num(pick(item)) for item in items]
    return None if any(v is None for v in values) else d_sum(values)


def rounding_tolerance(printed):
    return (5, printed[1] + 1)


def same_within(a, b, tolerance):
    return d_within(a, b, dec(tolerance) if isinstance(tolerance, str) else tolerance)


def show(value, like=None):
    return to_fixed(value, like[1] if like is not None else value[1])


_REF_PREFIX = re.compile("^(?:(?:NO|NR)(?:[.:#]|(?=[%s0-9]))|№|#|N°)[%s]*" % (JS_WS_CLASS, JS_WS_CLASS))
_REF_SEPARATORS = re.compile("[%s\\-_./\\\\:]+" % JS_WS_CLASS)
SEPARATOR_CHARS = set(JS_WS) | set("-_./\\:")
EDGE_SEPARATORS = set("-_./\\:")


def normalize_ref(value):
    value = nfkc(value).upper()
    value = _REF_PREFIX.sub("", value, count=1)
    return _REF_SEPARATORS.sub("", value)


def contains_ref(text, ref):
    """Whole-number match of `ref` in `text`, separators may differ."""
    chars = normalize_ref(ref)
    if not chars:
        return False
    t = nfkc(text).upper()
    n = len(t)
    for start in range(n):
        if t[start] != chars[0]:
            continue
        if start >= 1 and is_letter_or_number(t[start - 1]):
            continue
        if start >= 2 and t[start - 1] in EDGE_SEPARATORS and is_letter_or_number(t[start - 2]):
            continue
        j = start + 1
        ok = True
        for ch in chars[1:]:
            while j < n and t[j] in SEPARATOR_CHARS:
                j += 1
            if j < n and t[j] == ch:
                j += 1
            else:
                ok = False
                break
        if not ok:
            continue
        if j < n and is_letter_or_number(t[j]):
            continue
        if j + 1 < n and t[j] in EDGE_SEPARATORS and is_letter_or_number(t[j + 1]):
            continue
        return True
    return False


_LATIN = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\u017f\u212a")  # /[a-z]/iu also matches long s and Kelvin sign


def script_of(value):
    if _in_ranges(value, GEORGIAN):
        return "georgian"
    if _in_ranges(value, CYRILLIC):
        return "cyrillic"
    if any(ch in _LATIN for ch in value):
        return "latin"
    return "other"


_NAME_QUOTES = set("\"'«»„“”()")

# Keep in sync with LEGAL_FORM_PHRASES in packages/core/src/check/helpers.ts
# (python.test.ts compares them through --dump-tables).
LEGAL_FORM_PHRASES = [
    ["limited liability company", "llc"],
    ["limited liability partnership", "llp"],
    ["public limited company", "plc"],
    ["open joint stock company", "ojsc"],
    ["closed joint stock company", "cjsc"],
    ["joint stock company", "jsc"],
    ["incorporated", "inc"],
    ["gesellschaft mit beschränkter haftung", "gmbh"],
    ["aktiengesellschaft", "ag"],
    ["osaühing", "oü"],
    ["anonim şirketi", "aş"],
    ["limited şirketi", "ltd şti"],
    ["sanayi ve ticaret", "san ve tic"],
    ["ticaret ve sanayi", "tic ve san"],
    ["общество с ограниченной ответственностью", "ооо"],
    ["открытое акционерное общество", "оао"],
    ["закрытое акционерное общество", "зао"],
    ["публичное акционерное общество", "пао"],
    ["акционерное общество", "ао"],
    ["индивидуальный предприниматель", "ип"],
    ["товарищество с ограниченной ответственностью", "тоо"],
    ["შეზღუდული პასუხისმგებლობის საზოგადოება", "შპს"],
    ["სააქციო საზოგადოება", "სს"],
    ["ინდივიდუალური მეწარმე", "იმ"],
]


def fold_name(value):
    """Turkish İ/I/ı/i -> i, lower case, NFKD without combining marks."""
    value = value.replace("İ", "i").replace("I", "i").replace("ı", "i").lower()
    return "".join(ch for ch in unicodedata.normalize("NFKD", value) if cat(ch)[0] != "M")


def _name_words(value):
    out = []
    for ch in fold_name(value):
        out.append(" " if ch in _NAME_QUOTES or not (ch == "/" or is_letter_or_number(ch)) else ch)
    tokens = [t for t in "".join(out).split(" ") if t]
    words = []
    letters = []

    def flush():
        if len(letters) > 1:
            words.append("".join(letters))
        else:
            words.extend(letters)
        del letters[:]

    for token in tokens:
        if len(token) == 1 and is_letter(token):
            letters.append(token)
            continue
        flush()
        words.append(token)
    flush()
    return words


LEGAL_FORM_WORDS = set(w for form in LEGAL_FORMS for w in _name_words(form))
LEGAL_PHRASE_WORDS = [(_name_words(long_), _name_words(short)) for long_, short in LEGAL_FORM_PHRASES]


def name_tokens(value):
    tokens = _name_words(value)
    out = []
    i = 0
    while i < len(tokens):
        phrase = next((p for p in LEGAL_PHRASE_WORDS if tokens[i:i + len(p[0])] == p[0]), None)
        if phrase is not None:
            out.extend(phrase[1])
            i += len(phrase[0])
        else:
            out.append(tokens[i])
            i += 1
    return [t for t in out if t not in LEGAL_FORM_WORDS]


def same_party(a, b):
    if script_of(a) != script_of(b):
        return None
    x = name_tokens(a)
    y = name_tokens(b)
    if not x or not y:
        return None
    joined_x = " %s " % " ".join(x)
    joined_y = " %s " % " ".join(y)
    if joined_y in joined_x or joined_x in joined_y:
        return True
    set_y = set(y)
    shared = len([t for t in x if t in set_y])
    return shared / len(set(x) | set_y) >= 0.6


def finding(rule, severity, key, params, ev, units=None):
    result = {"rule": rule, "severity": severity, "key": key, "params": params}
    if units:
        result["units"] = units
    result["evidence"] = ev
    return result


def money_units(currencies):
    """Finding units for the money params whose currency is known: [(param, code or None)] -> dict or None."""
    known = {name: code for name, code in currencies if code is not None}
    return known or None


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------


def rule_amount_in_words(ctx):
    findings = []
    docs = [(d, "total") for d in ctx["invoices"]] + [(d, "totalAmount") for d in ctx["contracts"]]
    for doc, amount_field in docs:
        words = doc["totalInWords"]
        if words["value"] is None:
            continue
        words_evidence = evidence(doc, "totalInWords", words)
        parsed = parse_amount_in_words(words["value"], doc["language"])
        if not parsed["ok"]:
            params = {"reason": parsed["error"]["code"]}
            if "word" in parsed["error"]:
                params["word"] = parsed["error"]["word"]
            findings.append(finding("AMT-01", "warning", "AMT-01.unreadable", params, [words_evidence]))
            continue
        value = parsed["value"]
        amount_cited = doc["total"] if doc["type"] == "commercial_invoice" else doc["totalAmount"]
        amount = num(amount_cited)
        currency = currency_code(doc["currency"])
        if amount is not None and not d_equals(value["amount"], amount):
            # Each amount with its own currency: the one the words name (when they name exactly one) and the document's.
            named = value["currency"]
            findings.append(finding("AMT-01", "error", "AMT-01.mismatch", {
                "words": words["value"],
                "wordsAmount": to_fixed(value["amount"], max(value["amount"][1], amount[1])),
                "amount": amount_cited["value"] if amount_cited["value"] is not None else "",
            }, [words_evidence, evidence(doc, amount_field, amount_cited)],
                money_units([("wordsAmount", named if named and is_iso_currency(named) else None), ("amount", currency)])))
        # A word that names several currencies ("manat": AZN/TMT) agrees with any of them.
        if value["currency"] and currency and currency not in value["currency"].split("/"):
            findings.append(finding("AMT-01", "error", "AMT-01.currency", {"wordsCurrency": value["currency"], "currency": currency},
                                    [words_evidence, evidence(doc, "currency", doc["currency"])]))
    return findings


def _or_empty(value):
    return value if value is not None else ""


def rule_line_arithmetic(ctx):
    findings = []
    for invoice in ctx["invoices"]:
        currency = currency_code(invoice["currency"])
        for index, line in enumerate(invoice["lines"]):
            quantity = num(line["quantity"])
            unit_price = num(line["unitPrice"])
            line_total = num(line["lineTotal"])
            if quantity is None or unit_price is None or line_total is None:
                continue
            expected = d_mul(quantity, unit_price)
            if same_within(expected, line_total, rounding_tolerance(line_total)):
                continue
            path = "lines[%d]" % index
            findings.append(finding("SUM-01", "error", "SUM-01.line", {
                "line": str(index + 1),
                "quantity": _or_empty(line["quantity"]["value"]),
                "unitPrice": _or_empty(line["unitPrice"]["value"]),
                "expected": show(expected, line_total),
                "found": _or_empty(line["lineTotal"]["value"]),
            }, [
                evidence(invoice, path + ".quantity", line["quantity"]),
                evidence(invoice, path + ".unitPrice", line["unitPrice"]),
                evidence(invoice, path + ".lineTotal", line["lineTotal"]),
            ], money_units([("expected", currency), ("found", currency)])))
    return findings


def _gives_discount(rate):
    """A printed discount rate that takes something off: any rate but a readable 0."""
    if rate["value"] is None:
        return False
    percent = num(rate)
    return percent is None or not d_equals(percent, ZERO)


def rule_invoice_totals(ctx):
    findings = []
    for invoice in ctx["invoices"]:
        currency = currency_code(invoice["currency"])
        money = money_units([("expected", currency), ("found", currency)])
        lines_sum = sum_all(invoice["lines"], lambda line: line["lineTotal"])
        subtotal = num(invoice["subtotal"])
        if lines_sum is not None and subtotal is not None and not same_within(lines_sum, subtotal, rounding_tolerance(subtotal)):
            findings.append(finding("SUM-02", "error", "SUM-02.subtotal",
                                    {"expected": show(lines_sum, subtotal), "found": _or_empty(invoice["subtotal"]["value"])},
                                    [evidence(invoice, "subtotal", invoice["subtotal"])], money))
        total = num(invoice["total"])
        base = subtotal if subtotal is not None else lines_sum
        if total is None or base is None:
            continue
        expected = base
        parts = [show(base, total)]
        used = []
        if subtotal is not None:
            used.append(evidence(invoice, "subtotal", invoice["subtotal"]))
        discount = num(invoice["discount"])
        if discount is not None:
            reduction = d_sub(ZERO, discount) if d_compare(discount, ZERO) < 0 else discount
            expected = d_sub(expected, reduction)
            parts.append("− " + show(reduction, total))
            used.append(evidence(invoice, "discount", invoice["discount"]))
        elif invoice["discount"]["value"] is not None or _gives_discount(invoice["discountPercent"]):
            # A discount is printed, but not as an amount the checker can use.
            continue
        charges = [("freight", invoice["freight"]), ("insurance", invoice["insurance"])]
        charges += [("otherCharges[%d]" % index, charge) for index, charge in enumerate(invoice["otherCharges"])]
        charges.append(("tax", invoice["tax"]))
        printed = [(path, field) for path, field in charges if field["value"] is not None]
        if any(num(field) is None for _, field in printed):
            continue
        for path, field in printed:
            charge = num(field)
            expected = d_add(expected, charge)
            # An amount taken off (an advance already paid) is negative.
            parts.append("− " + show(d_sub(ZERO, charge), total) if d_compare(charge, ZERO) < 0 else "+ " + show(charge, total))
            used.append(evidence(invoice, path, field))
        if same_within(expected, total, rounding_tolerance(total)):
            continue
        findings.append(finding("SUM-02", "error", "SUM-02.total",
                                {"expected": show(expected, total), "formula": " ".join(parts), "found": _or_empty(invoice["total"]["value"])},
                                [evidence(invoice, "total", invoice["total"])] + used, money))
    return findings


def rule_document_totals(ctx):
    findings = []
    options = ctx["options"]
    exact = rounding_tolerance

    def weight(_):
        return options["weightToleranceKg"]

    def volume(_):
        return options["volumeToleranceM3"]

    def compare_total(doc, lines_total, total_path, total, metric, tolerance):
        stated = num(total)
        if lines_total is None or stated is None:
            return
        if same_within(lines_total, stated, tolerance(stated)):
            return
        findings.append(finding("SUM-03", "error", "SUM-03.total", {
            "document": doc["type"],
            "metric": metric,
            "expected": show(lines_total, stated),
            "found": _or_empty(total["value"]),
        }, [evidence(doc, total_path, total)]))

    for pl in ctx["packingLists"]:
        lines = pl["lines"]
        compare_total(pl, sum_all(lines, lambda l: l["quantity"]), "totalQuantity", pl["totalQuantity"], "quantity", exact)
        compare_total(pl, sum_all(lines, lambda l: l["packages"]), "totalPackages", pl["totalPackages"], "packages", exact)
        compare_total(pl, sum_all(lines, lambda l: l["netWeightKg"]), "totalNetWeightKg", pl["totalNetWeightKg"], "netWeightKg", weight)
        compare_total(pl, sum_all(lines, lambda l: l["grossWeightKg"]), "totalGrossWeightKg", pl["totalGrossWeightKg"], "grossWeightKg", weight)
        compare_total(pl, sum_all(lines, lambda l: l["volumeM3"]), "totalVolumeM3", pl["totalVolumeM3"], "volumeM3", volume)
    for cmr in ctx["cmrs"]:
        goods = cmr["goods"]
        compare_total(cmr, sum_all(goods, lambda g: g["packages"]), "totalPackages", cmr["totalPackages"], "packages", exact)
        compare_total(cmr, sum_all(goods, lambda g: g["grossWeightKg"]), "totalGrossWeightKg", cmr["totalGrossWeightKg"], "grossWeightKg", weight)
    return findings


def _encode(entries):
    """JSON [[type, value], ...], localized by format_message."""
    return js_stringify([[type_, _or_empty(value)] for type_, value in entries], None)


def _observe(doc, path, field):
    if doc is None or field is None:
        return None
    value = num(field)
    return {"doc": doc, "path": path, "field": field, "value": value, "computed": False} if value is not None else None


def _cite(o):
    return evidence(o["doc"], o["path"], o["field"], o["computed"])


def _stated_or_sum(doc, total_path, total, lines, lines_path, pick):
    stated = _observe(doc, total_path, total)
    if stated is not None or doc is None or lines is None:
        return stated
    summed = sum_all(lines, pick)
    if summed is None:
        return None
    page = pick(lines[0])["page"] if lines else None
    return {"doc": doc, "path": lines_path + "[*]", "field": {"value": show(summed), "quote": None, "page": page}, "value": summed,
            "computed": True}


def _agree(observed, tolerance, make):
    present = [o for o in observed if o is not None]
    if len(present) < 2:
        return []
    first = present[0]
    if all(same_within(o["value"], first["value"], tolerance(o)) for o in present[1:]):
        return []
    values = _encode([(o["doc"]["type"], o["field"]["value"]) for o in present])
    return [make(values, [_cite(o) for o in present])]


# Keep in sync with PACKING_KINDS in packages/core/src/check/rules/cross.ts.
PACKING_KINDS = {
    "carton": ["carton", "ctn", "box", "karton", "kutu", "koli", "короб", "ящик", "ყუთ", "კოლოფ"],
    "pallet": ["pallet", "palet", "plt", "паллет", "палет", "поддон", "პალეტ"],
    "crate": ["crate", "sandik", "обрешет"],
    "bag": ["bag", "sack", "мешок", "мешк", "cuval", "torba", "ტომარ"],
    "roll": ["roll", "рулон", "rulo", "რულონ"],
    "bale": ["bale", "кип", "balya"],
    "drum": ["drum", "barrel", "бочк", "varil", "კასრ"],
    "bundle": ["bundle", "пачк", "связк", "demet", "შეკვრ"],
    "case": ["case"],
}
PACKING_STEMS = sorted(((fold_name(stem), kind) for kind, stems in PACKING_KINDS.items() for stem in stems),
                       key=lambda s: -utf16_len(s[0]))


def _letter_runs(text):
    runs = []
    current = []
    for ch in text:
        if is_letter(ch):
            current.append(ch)
        elif current:
            runs.append("".join(current))
            current = []
    if current:
        runs.append("".join(current))
    return runs


def packing_kind(texts):
    kinds = set()
    for value in texts:
        for word in _letter_runs(fold_name(value or "")):
            match = next((s for s in PACKING_STEMS if word.startswith(s[0])), None)
            if match is not None:
                kinds.add(match[1])
    return "+".join(sorted(kinds)) if kinds else None


def _fold_unit(value):
    """Folded unit without dots and spaces: "PCS." -> "pcs", "m²" -> "m2"."""
    return "".join(ch for ch in fold_name(value) if is_letter_or_number(ch))


UNIT_KEYS = {}
for _unit, _spellings in UNIT_ALIASES.items():
    for _spelling in _spellings:
        UNIT_KEYS[_fold_unit(_spelling)] = _unit


_PLURAL = re.compile("[a-z]{3,}s")
_PLURAL_ES = re.compile("(?:x|z|ch|sh|ss)es\\Z")


def _singular(unit):
    """The singular of a plain English plural: "rolls" -> "roll", "boxes" -> "box"."""
    if not _PLURAL.fullmatch(unit) or unit.endswith("ss"):
        return unit
    return unit[:-2] if _PLURAL_ES.search(unit) else unit[:-1]


def unit_key(value):
    """One key per unit of measure, or None when no unit is written."""
    folded = _fold_unit(value or "")
    if not folded:
        return None
    one = _singular(folded)
    return UNIT_KEYS.get(folded, UNIT_KEYS.get(one, one))


def _units_of(lines):
    """The distinct units of the lines that state a quantity, sorted."""
    units = set()
    for line in lines:
        unit = None if line["quantity"]["value"] is None else unit_key(line["unit"]["value"])
        if unit:
            units.add(unit)
    return sorted(units)


def _same_units(a, b):
    """Comparable quantities: equal units, or one side names none."""
    return not a or not b or a == b


def _first(items):
    return items[0] if items else None


def _get(doc, key):
    return doc[key] if doc is not None else None


def rule_currencies(ctx):
    docs = [d for d in ctx["invoices"] + ctx["contracts"] if currency_code(d["currency"])]
    distinct = set(d["currency"]["value"] for d in docs)
    if len(distinct) < 2:
        return []
    return [finding("CUR-01", "error", "CUR-01.mismatch",
                    {"currencies": _encode([(d["type"], d["currency"]["value"]) for d in docs])},
                    [evidence(d, "currency", d["currency"]) for d in docs])]


def _package_counts(invoice, pl, cmr):
    return [
        (_observe(invoice, "packages", _get(invoice, "packages")),
         packing_kind([invoice["packages"]["quote"] if invoice is not None else None])),
        (_stated_or_sum(pl, "totalPackages", _get(pl, "totalPackages"), _get(pl, "lines"), "lines", lambda l: l["packages"]),
         packing_kind([pl["packingMethod"]["value"] if pl is not None else None, pl["totalPackages"]["quote"] if pl is not None else None]
                      + [t for l in (pl["lines"] if pl is not None else []) for t in (l["packingMethod"]["value"], l["packages"]["quote"])])),
        (_stated_or_sum(cmr, "totalPackages", _get(cmr, "totalPackages"), _get(cmr, "goods"), "goods", lambda g: g["packages"]),
         packing_kind([cmr["totalPackages"]["quote"] if cmr is not None else None]
                      + [t for g in (cmr["goods"] if cmr is not None else []) for t in (g["packingMethod"]["value"], g["packages"]["quote"])])),
    ]


def rule_quantities(ctx):
    findings = []
    invoice = _first(ctx["invoices"])
    pl = _first(ctx["packingLists"])
    cmr = _first(ctx["cmrs"])

    if invoice is not None and pl is not None:
        def by_model(lines):
            return lines if lines and all(l["model"]["value"] for l in lines) else None

        inv_lines = by_model(invoice["lines"])
        pl_lines = by_model(pl["lines"])
        if inv_lines is not None and pl_lines is not None and all(l["quantity"]["value"] for l in pl["lines"]):
            pl_index = _group_by_model(pl["lines"])
            inv_index = _group_by_model(invoice["lines"])

            def missing(doc, group, present, absent):
                return finding("QTY-01", "error", "QTY-01.missing-line", {"model": group["model"], "present": present, "missing": absent},
                               [evidence(doc, "lines[%d].model" % i, line["model"]) for line, i in group["lines"]])

            for model, group in inv_index.items():
                match = pl_index.get(model)
                if match is None:
                    findings.append(missing(invoice, group, "commercial_invoice", "packing_list"))
                    continue
                # One model in two units on one document (pieces and sets) has no single quantity.
                comparable = len(group["units"]) <= 1 and len(match["units"]) <= 1 and _same_units(group["units"], match["units"])
                if comparable and group["quantity"] is not None and match["quantity"] is not None and not d_equals(group["quantity"], match["quantity"]):
                    findings.append(finding("QTY-01", "error", "QTY-01.line", {
                        "model": group["model"],
                        "invoice": group["shown"],
                        "packingList": match["shown"],
                    }, [evidence(invoice, "lines[%d].quantity" % i, line["quantity"]) for line, i in group["lines"]]
                       + [evidence(pl, "lines[%d].quantity" % i, line["quantity"]) for line, i in match["lines"]]))
            for model, group in pl_index.items():
                if model not in inv_index:
                    findings.append(missing(pl, group, "packing_list", "commercial_invoice"))
        else:
            inv_qty = _stated_or_sum(invoice, "lines", None, invoice["lines"], "lines", lambda l: l["quantity"])
            pl_qty = _stated_or_sum(pl, "totalQuantity", pl["totalQuantity"], pl["lines"], "lines", lambda l: l["quantity"])
            if (inv_qty is not None and pl_qty is not None and _same_units(_units_of(invoice["lines"]), _units_of(pl["lines"]))
                    and not d_equals(inv_qty["value"], pl_qty["value"])):
                findings.append(finding("QTY-01", "error", "QTY-01.quantity",
                                        {"invoice": inv_qty["field"]["value"], "packingList": pl_qty["field"]["value"]},
                                        [_cite(inv_qty), _cite(pl_qty)]))

    counts = _package_counts(invoice, pl, cmr)
    present = [c for c in counts if c[0] is not None]
    kinds = []
    for _, kind in present:
        if kind and kind not in kinds:
            kinds.append(kind)
    groups = [[c for c in present if c[1] == kind] for kind in kinds] if len(kinds) > 1 else [present]
    for group in groups:
        findings.extend(_agree(
            [o for o, _ in group],
            lambda o: rounding_tolerance(o["value"]),
            lambda values, ev: finding("QTY-01", "error", "QTY-01.packages", {"values": values}, ev),
        ))
    return findings


def _group_by_model(lines):
    groups = {}
    for i, line in enumerate(lines):
        key = normalize_ref(line["model"]["value"])
        group = groups.get(key)
        if group is None:
            group = {"model": line["model"]["value"], "lines": [], "quantity": None, "shown": "", "units": []}
            groups[key] = group
        group["lines"].append((line, i))
    for group in groups.values():
        group["units"] = _units_of([line for line, _ in group["lines"]])
        quantities = [num(line["quantity"]) for line, _ in group["lines"]]
        if any(q is None for q in quantities):
            continue
        group["quantity"] = d_sum(quantities)
        group["shown"] = group["lines"][0][0]["quantity"]["value"] if len(group["lines"]) == 1 else show(group["quantity"])
    return groups


def rule_gross_vs_net(ctx):
    findings = []

    def check(doc, where, net_path, net, gross_path, gross):
        n = num(net)
        g = num(gross)
        if n is None or g is None or d_compare(g, n) >= 0:
            return
        findings.append(finding("WGT-01", "error", "WGT-01.gross-below-net", {"where": where, "net": net["value"], "gross": gross["value"]},
                                [evidence(doc, gross_path, gross), evidence(doc, net_path, net)]))

    for invoice in ctx["invoices"]:
        check(invoice, "commercial_invoice", "netWeightKg", invoice["netWeightKg"], "grossWeightKg", invoice["grossWeightKg"])
    for pl in ctx["packingLists"]:
        for i, line in enumerate(pl["lines"]):
            check(pl, "packing_list:line:%d" % (i + 1), "lines[%d].netWeightKg" % i, line["netWeightKg"],
                  "lines[%d].grossWeightKg" % i, line["grossWeightKg"])
        check(pl, "packing_list:total", "totalNetWeightKg", pl["totalNetWeightKg"], "totalGrossWeightKg", pl["totalGrossWeightKg"])
    return findings


def rule_weights_agree(ctx):
    invoice = _first(ctx["invoices"])
    pl = _first(ctx["packingLists"])
    cmr = _first(ctx["cmrs"])

    def tolerance(_):
        return ctx["options"]["weightToleranceKg"]

    return _agree(
        [
            _stated_or_sum(pl, "totalGrossWeightKg", _get(pl, "totalGrossWeightKg"), _get(pl, "lines"), "lines", lambda l: l["grossWeightKg"]),
            _stated_or_sum(cmr, "totalGrossWeightKg", _get(cmr, "totalGrossWeightKg"), _get(cmr, "goods"), "goods", lambda g: g["grossWeightKg"]),
            _observe(invoice, "grossWeightKg", _get(invoice, "grossWeightKg")),
        ],
        tolerance,
        lambda values, ev: finding("WGT-02", "error", "WGT-02.gross", {"values": values}, ev),
    ) + _agree(
        [
            _stated_or_sum(pl, "totalNetWeightKg", _get(pl, "totalNetWeightKg"), _get(pl, "lines"), "lines", lambda l: l["netWeightKg"]),
            _observe(invoice, "netWeightKg", _get(invoice, "netWeightKg")),
        ],
        tolerance,
        lambda values, ev: finding("WGT-02", "error", "WGT-02.net", {"values": values}, ev),
    )


def rule_references(ctx):
    findings = []
    invoice = _first(ctx["invoices"])
    pl = _first(ctx["packingLists"])
    cmr = _first(ctx["cmrs"])
    contract = _first(ctx["contracts"])

    def same_ref(a, b):
        return normalize_ref(a) == normalize_ref(b)

    if invoice is not None and pl is not None:
        expected = text_of(invoice["number"])
        found = text_of(pl["invoiceRef"]["number"])
        if expected and found and not same_ref(expected, found):
            findings.append(finding("REF-01", "error", "REF-01.invoice-number", {"expected": expected, "found": found},
                                    [evidence(pl, "invoiceRef.number", pl["invoiceRef"]["number"]), evidence(invoice, "number", invoice["number"])]))
        expected_date = iso_date(invoice["date"])
        found_date = iso_date(pl["invoiceRef"]["date"])
        if expected_date and found_date and expected_date != found_date:
            findings.append(finding("REF-01", "error", "REF-01.invoice-date", {"expected": expected_date, "found": found_date},
                                    [evidence(pl, "invoiceRef.date", pl["invoiceRef"]["date"]), evidence(invoice, "date", invoice["date"])]))

    if invoice is not None and contract is not None:
        expected = text_of(contract["number"])
        found = text_of(invoice["contractRef"]["number"])
        if expected and found and not same_ref(expected, found):
            findings.append(finding("REF-01", "error", "REF-01.contract-number", {"expected": expected, "found": found},
                                    [evidence(invoice, "contractRef.number", invoice["contractRef"]["number"]), evidence(contract, "number", contract["number"])]))
        expected_date = iso_date(contract["date"])
        found_date = iso_date(invoice["contractRef"]["date"])
        if expected_date and found_date and expected_date != found_date:
            findings.append(finding("REF-01", "error", "REF-01.contract-date", {"expected": expected_date, "found": found_date},
                                    [evidence(invoice, "contractRef.date", invoice["contractRef"]["date"]), evidence(contract, "date", contract["date"])]))

    if cmr is not None and cmr["attachedDocuments"]:
        listed = [_or_empty(d["value"]) for d in cmr["attachedDocuments"]]
        for doc in (invoice, pl):
            number = text_of(doc["number"]) if doc is not None else None
            if doc is None or not number:
                continue
            if any(contains_ref(entry, number) for entry in listed):
                continue
            findings.append(finding("REF-01", "warning", "REF-01.cmr-missing-document", {"document": doc["type"], "number": number},
                                    [evidence(cmr, "attachedDocuments[%d]" % i, d) for i, d in enumerate(cmr["attachedDocuments"])]))
    declaration = _first(ctx["declarations"])
    number = cited_written_text(invoice["number"]) if invoice else None
    entries = declaration["attachedDocuments"] if declaration else []
    if number and entries and all(cited_written_text(entry) for entry in entries) and not any(contains_ref(entry["value"], number) for entry in entries):
        findings.append(finding("REF-01", "warning", "REF-01.declaration-missing-invoice", {"number": number},
                                [evidence(declaration, "attachedDocuments[%d]" % i, entry) for i, entry in enumerate(entries)]
                                + [evidence(invoice, "number", invoice["number"])]))
    return findings


def rule_date_order(ctx):
    findings = []
    invoice = _first(ctx["invoices"])
    cmr = _first(ctx["cmrs"])
    contract = _first(ctx["contracts"])
    invoice_date = iso_date(invoice["date"]) if invoice is not None else None
    if invoice is None or not invoice_date:
        return findings
    contract_date = iso_date(contract["date"]) if contract is not None else None
    if contract is not None and contract_date and contract_date > invoice_date:
        findings.append(finding("DATE-01", "error", "DATE-01.contract-after-invoice", {"contract": contract_date, "invoice": invoice_date},
                                [evidence(contract, "date", contract["date"]), evidence(invoice, "date", invoice["date"])]))
    if cmr is not None:
        if cmr["dateOfTakingOver"]["value"]:
            path, field = "dateOfTakingOver", cmr["dateOfTakingOver"]
        else:
            path, field = "date", cmr["date"]
        shipment = iso_date(field)
        if shipment and invoice_date > shipment:
            findings.append(finding("DATE-01", "warning", "DATE-01.invoice-after-shipment", {"invoice": invoice_date, "shipment": shipment},
                                    [evidence(invoice, "date", invoice["date"]), evidence(cmr, path, field)]))
    declaration = _first(ctx["declarations"])
    registration = iso_date(declaration["date"]) if declaration and quoted(declaration["date"]) else None
    if registration and quoted(invoice["date"]) and invoice_date > registration:
        findings.append(finding("DATE-01", "error", "DATE-01.invoice-after-declaration",
                                {"invoice": invoice_date, "registration": registration},
                                [evidence(invoice, "date", invoice["date"]), evidence(declaration, "date", declaration["date"])]))
    return findings


def rule_parties(ctx):
    findings = []
    invoice = _first(ctx["invoices"])
    pl = _first(ctx["packingLists"])
    cmr = _first(ctx["cmrs"])
    contract = _first(ctx["contracts"])
    if invoice is None:
        return findings

    def side(doc, path, party):
        return {"doc": doc, "path": path, "party": party} if doc is not None and party is not None and text_of(party["name"]) else None

    consignee = side(invoice, "consignee", invoice["consignee"]) if text_of(invoice["consignee"]["name"]) else side(invoice, "buyer", invoice["buyer"])
    pairs = [
        ("seller", side(invoice, "seller", invoice["seller"]), side(contract, "seller", _get(contract, "seller"))),
        ("seller", side(invoice, "seller", invoice["seller"]), side(pl, "shipper", _get(pl, "shipper"))),
        ("seller", side(invoice, "seller", invoice["seller"]), side(cmr, "sender", _get(cmr, "sender"))),
        ("buyer", side(invoice, "buyer", invoice["buyer"]), side(contract, "buyer", _get(contract, "buyer"))),
        ("consignee", consignee, side(pl, "consignee", _get(pl, "consignee"))),
        ("consignee", consignee, side(cmr, "consignee", _get(cmr, "consignee"))),
    ]
    for role, a, b in pairs:
        if a is None or b is None:
            continue
        name_a = text_of(a["party"]["name"])
        name_b = text_of(b["party"]["name"])
        if same_party(name_a, name_b) is not False:
            continue
        findings.append(finding("PTY-01", "warning", "PTY-01.name",
                                {"role": role, "a": name_a, "aDocument": a["doc"]["type"], "b": name_b, "bDocument": b["doc"]["type"]},
                                [evidence(a["doc"], a["path"] + ".name", a["party"]["name"]),
                                 evidence(b["doc"], b["path"] + ".name", b["party"]["name"])]))
    return findings


# Keep in sync with INCOTERM_NAMES in packages/core/src/check/rules/cross.ts.
INCOTERM_NAMES = {
    "Ex Works": "EXW",
    "Free Carrier": "FCA",
    "Carriage Paid To": "CPT",
    "Carriage and Insurance Paid To": "CIP",
    "Delivered at Place": "DAP",
    "Delivered at Place Unloaded": "DPU",
    "Delivered Duty Paid": "DDP",
    "Free Alongside Ship": "FAS",
    "Free on Board": "FOB",
    "Cost and Freight": "CFR",
    "Cost Insurance and Freight": "CIF",
    "Франко завод": "EXW",
    "Франко перевозчик": "FCA",
    "Перевозка оплачена до": "CPT",
    "Перевозка и страхование оплачены до": "CIP",
    "Поставка в месте назначения": "DAP",
    "Поставка в месте назначения с разгрузкой": "DPU",
    "Поставка с оплатой пошлин": "DDP",
    "Поставка с оплатой пошлины": "DDP",
    "Франко вдоль борта судна": "FAS",
    "Франко борт": "FOB",
    "Стоимость и фрахт": "CFR",
    "Стоимость страхование и фрахт": "CIF",
    "İşyerinde Teslim": "EXW",
    "Taşıyıcıya Teslim": "FCA",
    "Taşıma Ödenmiş Olarak Teslim": "CPT",
    "Taşıma ve Sigorta Ödenmiş Olarak Teslim": "CIP",
    "Belirlenen Yerde Teslim": "DAP",
    "Belirlenen Yerde Boşaltılmış Olarak Teslim": "DPU",
    "Gümrük Vergisi Ödenmiş Olarak Teslim": "DDP",
    "Gümrük Vergileri Ödenmiş Olarak Teslim": "DDP",
    "Gemi Doğrultusunda Teslim": "FAS",
    "Gemi Yanında Teslim": "FAS",
    "Gemide Teslim": "FOB",
    "Masraflar ve Navlun Ödenmiş Olarak Teslim": "CFR",
    "Masraflar Sigorta ve Navlun Ödenmiş Olarak Teslim": "CIF",
}


def _letters_only(value):
    return "".join(ch for ch in fold_name(value) if is_letter(ch))


INCOTERM_NAME_KEYS = sorted(((_letters_only(name), code) for name, code in INCOTERM_NAMES.items()), key=lambda e: -utf16_len(e[0]))
_INCOTERM_CODE = re.compile("([a-z])[.%s-]*([a-z])[.%s-]*([a-z])" % (JS_WS_CLASS, JS_WS_CLASS))


def incoterm_code(value):
    """Incoterms 2020 code of a written rule ("C.I.F.", "Ex Works", "Франко завод"), or None."""
    folded = js_trim(fold_name(value or ""))
    if not folded:
        return None
    match = _INCOTERM_CODE.match(folded)
    if match and not (match.end() < len(folded) and is_letter(folded[match.end()])):
        code = (match.group(1) + match.group(2) + match.group(3)).upper()
        if code in INCOTERMS_2020:
            return code
    letters = _letters_only(folded)
    return next((code for name, code in INCOTERM_NAME_KEYS if letters.startswith(name)), None)


def rule_incoterms(ctx):
    findings = []
    docs = [d for d in ctx["invoices"] + ctx["contracts"] if text_of(d["incoterm"]["code"])]
    for doc in docs:
        if incoterm_code(doc["incoterm"]["code"]["value"]):
            continue
        findings.append(finding("INC-01", "warning", "INC-01.unknown", {"code": doc["incoterm"]["code"]["value"]},
                                [evidence(doc, "incoterm.code", doc["incoterm"]["code"])]))
    known = [d for d in docs if incoterm_code(d["incoterm"]["code"]["value"])]
    if len(set(incoterm_code(d["incoterm"]["code"]["value"]) for d in known)) > 1:
        findings.append(finding("INC-01", "error", "INC-01.mismatch",
                                {"codes": _encode([(d["type"], d["incoterm"]["code"]["value"]) for d in known])},
                                [evidence(d, "incoterm.code", d["incoterm"]["code"]) for d in known]))
    return findings


def _agreed_incoterm(ctx):
    for doc in ctx["invoices"] + ctx["contracts"]:
        code = incoterm_code(doc["incoterm"]["code"]["value"])
        if code:
            return doc, code
    return None


def rule_sea_term_on_road(ctx):
    agreed = _agreed_incoterm(ctx)
    if agreed is None or agreed[1] not in SEA_ONLY or not ctx["cmrs"]:
        return []
    doc, code = agreed
    return [finding("INC-02", "warning", "INC-02.sea-term-road", {"code": code}, [evidence(doc, "incoterm.code", doc["incoterm"]["code"])])]


def _insurance_title_test():
    source = DATA["insuranceTitle"]["source"]
    flags = DATA["insuranceTitle"]["flags"]
    alternatives = source.split("|")
    if "i" in flags and not any(re.escape(a) != a for a in alternatives):
        folded = [fold(a) for a in alternatives]
        return lambda s: any(a in fold(s) for a in folded)
    pattern = re.compile(source, re.IGNORECASE if "i" in flags else 0)
    return lambda s: pattern.search(s) is not None


INSURANCE_TITLE = _insurance_title_test()


def rule_insurance(ctx):
    agreed = _agreed_incoterm(ctx)
    if agreed is None or agreed[1] not in SELLER_INSURES:
        return []

    def is_insurance(title):
        # "SİGORTA": JS case folding misses the dotted capital, so TS also tests a Turkish-lowercased copy.
        return INSURANCE_TITLE(title) or INSURANCE_TITLE(locale_lower(title, "tr"))

    has_document = any(is_insurance(_or_empty(d["title"]["value"])) for d in ctx["others"])
    has_charge = any(i["insurance"]["value"] is not None for i in ctx["invoices"])
    if has_document or has_charge:
        return []
    doc, code = agreed
    return [finding("INC-03", "warning", "INC-03.no-insurance", {"code": code}, [evidence(doc, "incoterm.code", doc["incoterm"]["code"])])]


def _filled(value):
    return bool(value and js_trim(value))


def _missing_fields(checks):
    return [path for path, value in checks if not _filled(value)]


def _missing_g(c):
    goods = c["goods"]
    packages = _filled(c["totalPackages"]["value"]) or (len(goods) > 0 and all(_filled(g["packages"]["value"]) for g in goods))
    marks = any(_filled(g["marksAndNumbers"]["value"]) for g in goods)
    return ([] if packages else ["totalPackages"]) + ([] if marks else ["goods[*].marksAndNumbers"])


def _missing_f(c):
    if not c["goods"]:
        return ["goods"]
    out = []
    for i, g in enumerate(c["goods"]):
        out += _missing_fields([("goods[%d].description" % i, g["description"]["value"]), ("goods[%d].packingMethod" % i, g["packingMethod"]["value"])])
    return out


def _missing_h(c):
    goods = c["goods"]
    ok = _filled(c["totalGrossWeightKg"]["value"]) or (len(goods) > 0 and all(_filled(g["grossWeightKg"]["value"]) for g in goods))
    return [] if ok else ["totalGrossWeightKg"]


CMR_PARTICULARS = [
    ("a", lambda c: _missing_fields([("date", c["date"]["value"]), ("placeOfIssue", c["placeOfIssue"]["value"])])),
    ("b", lambda c: _missing_fields([("sender.name", c["sender"]["name"]["value"]), ("sender.address", c["sender"]["address"]["value"])])),
    ("c", lambda c: _missing_fields([("carrier.name", c["carrier"]["name"]["value"]), ("carrier.address", c["carrier"]["address"]["value"])])),
    ("d", lambda c: _missing_fields([
        ("placeOfTakingOver", c["placeOfTakingOver"]["value"]),
        ("dateOfTakingOver", c["dateOfTakingOver"]["value"]),
        ("placeOfDelivery", c["placeOfDelivery"]["value"]),
    ])),
    ("e", lambda c: _missing_fields([("consignee.name", c["consignee"]["name"]["value"]), ("consignee.address", c["consignee"]["address"]["value"])])),
    ("f", _missing_f),
    ("g", _missing_g),
    ("h", _missing_h),
    ("i", lambda c: _missing_fields([("carriageCharges", c["carriageCharges"]["value"])])),
    ("j", lambda c: _missing_fields([("customsInstructions", c["customsInstructions"]["value"])])),
    ("k", lambda c: _missing_fields([("convention", c["convention"]["value"])])),
]


def rule_cmr_particulars(ctx):
    findings = []
    for cmr in ctx["cmrs"]:
        for item, missing_of in CMR_PARTICULARS:
            missing = missing_of(cmr)
            if not missing:
                continue
            findings.append(finding("CMR-01", CMR_SEVERITY[item], "CMR-01.missing", {"item": item, "fields": ", ".join(missing)},
                                    [evidence(cmr, "number", cmr["number"])]))
    return findings


GEORGIA_COUNTRIES = set(DATA["georgiaCountries"])
HS_CODE_SEPARATORS = str.maketrans("", "", JS_WS + ".")
HS_DESCRIPTION_SEPARATORS = str.maketrans("", "", JS_WS)


@lru_cache(maxsize=1)
def hs_nomenclature():
    with gzip.open(os.path.join(HERE, "hs-nomenclature.json.gz"), "rt", encoding="utf-8") as source:
        data = json.load(source)
    by_code = {row[0]: row for row in data["entries"]}
    by_subheading = {}
    for row in data["entries"]:
        if len(row[0]) >= 6:
            by_subheading.setdefault(row[0][:6], []).append(row)
    return data, by_code, by_subheading


def is_georgia(value):
    return js_trim(value or "").replace("İ", "i").lower() in GEORGIA_COUNTRIES


def georgian_party(party):
    return all(is_georgia(party["country"][key]) for key in ("value", "quote"))


def document_parties(doc):
    roles = {
        "commercial_invoice": ("seller", "buyer", "consignee"),
        "packing_list": ("shipper", "consignee"),
        "cmr": ("sender", "carrier", "consignee"),
        "contract": ("seller", "buyer"),
    }
    return ((role, doc[role]) for role in roles.get(doc["type"], ()))


def tax_digits(field, pageless=False):
    value, quote, page = (field[key] for key in ("value", "quote", "page"))
    if value is None or quote is None or (page is not None if pageless else page is None or page < 1):
        return None

    def digits(printed):
        printed = js_trim(printed)
        if re.match(r"[A-Za-z]{2}", printed) and len(printed) > 2:
            next_char = printed[2]
            if next_char in JS_WS or cat(next_char) == "Pd" or next_char in "0123456789":
                printed = printed[2:]
        return "".join(ch for ch in printed if ch not in JS_WS and cat(ch) != "Pd")

    code = digits(value)
    return code if re.fullmatch(r"[0-9]+", code) and code == digits(quote) else None


def company_parties(documents):
    for doc in documents:
        for role, party in document_parties(doc):
            if georgian_party(party):
                code = tax_digits(party["taxId"])
                if code and len(code) == 9:
                    yield doc, role, party, code


def rule_party_tax_ids(ctx):
    findings, seen, reported = [], [], {}
    for doc in ctx["extraction"]["documents"]:
        for role, party in document_parties(doc):
            if party["taxId"]["value"] is None:
                continue
            citation = evidence(doc, role + ".taxId", party["taxId"])
            code = tax_digits(party["taxId"])
            name = text_of(party["name"])
            if not code or (georgian_party(party) and len(code) not in (9, 11)):
                findings.append(finding("PTY-02", "warning", "PTY-02.unreadable", {"name": name or ""}, [citation]))
                continue
            if not name:
                continue
            for earlier_name, earlier_code, first in seen:
                if earlier_code == code or first["documentIndex"] == citation["documentIndex"] or same_party(earlier_name, name) is not True:
                    continue
                pair = tuple(sorted((earlier_code, code)))
                names = reported.setdefault(pair, [])
                if any(same_party(reported_name, name) is True for reported_name in names):
                    continue
                names.append(name)
                findings.append(finding("PTY-02", "error", "PTY-02.number",
                                        {"name": name, "a": first["quote"], "b": citation["quote"]}, [first, citation]))
            seen.append((name, code, citation))
    return findings


def registry_parties(ctx):
    snapshot = ctx["options"].get("registry")
    if snapshot is None:
        return
    entries = {entry["code"]: entry for entry in snapshot["entries"]}
    for doc, role, party, code in company_parties(ctx["extraction"]["documents"]):
        if code in entries:
            yield doc, role, party, code, entries[code]


def rule_taxpayer_name(ctx):
    findings, seen = [], set()
    for doc, role, party, code, entry in registry_parties(ctx):
        answer = entry.get("answer", [])
        registered = answer[0]["FullName"] if len(answer) == 1 else None
        printed = text_of(party["name"])
        if not registered or not printed:
            continue
        a, b = " ".join(name_tokens(printed)), " ".join(name_tokens(registered))
        if script_of(a) == "other" or script_of(a) != script_of(b):
            continue
        key = (code, a)
        if not a or not b or a == b or key in seen:
            continue
        seen.add(key)
        findings.append(finding("TAX-01", "warning", "TAX-01.name",
                                {"printed": printed, "registered": registered, "snapshotDate": entry["checkedAt"][:10]},
                                [evidence(doc, role + ".name", party["name"]), evidence(doc, role + ".taxId", party["taxId"])]))
    return findings


def rule_taxpayer_vat(ctx):
    findings = []
    for doc, role, party, code, entry in registry_parties(ctx):
        answer = entry.get("answer", [])
        if doc["type"] != "commercial_invoice" or role != "seller" or num(doc["tax"]) is None or not answer or not all(row["VatPayer"] == "არა" for row in answer):
            continue
        findings.append(finding("TAX-02", "warning", "TAX-02.vat", {"code": code, "checkedAt": entry["checkedAt"]},
                                [evidence(doc, "seller.taxId", party["taxId"]), evidence(doc, "tax", doc["tax"])]))
    return findings


def rule_taxpayer_reply(ctx):
    findings, seen = [], set()
    for doc, role, party, code, entry in registry_parties(ctx):
        error = entry.get("error", {})
        if error.get("Status") != -1 or code in seen:
            continue
        seen.add(code)
        findings.append(finding("TAX-03", "warning", "TAX-03.reply", {"code": code, "reply": error["Message"]},
                                [evidence(doc, role + ".taxId", party["taxId"])]))
    return findings


def rule_hs_codes(ctx):
    findings = []
    for invoice in ctx["invoices"]:
        date = iso_date(invoice["date"])
        if not date or not any(item["hsCode"]["value"] is not None for item in invoice["lines"]):
            continue
        if not any(georgian_party(party) for _, party in document_parties(invoice)):
            continue
        data, by_code, by_subheading = hs_nomenclature()
        if date < data["edition"]["inForceFrom"]:
            continue
        for index, item in enumerate(invoice["lines"]):
            field = item["hsCode"]
            if field["value"] is None:
                continue
            code = field["value"].translate(HS_CODE_SEPARATORS)
            params = {"line": str(index + 1)}
            cited = [evidence(invoice, "lines[%d].hsCode" % index, field)]
            subheading = code[:6]
            if not re.fullmatch(r"[0-9]{6,12}", code) or code != (field["quote"] or "").translate(HS_CODE_SEPARATORS):
                findings.append(finding("HS-01", "warning", "HS-01.unreadable", params, cited))
            elif subheading not in by_subheading:
                heading = by_code.get(code[:4])
                params["subheading"] = subheading
                if heading:
                    params.update(heading=heading[0], description=heading[1])
                key = "HS-01.unknown-subheading-heading" if heading else "HS-01.unknown-subheading"
                findings.append(finding("HS-01", "warning", key, params, cited))
            elif len(code) == 11 and code not in by_code:
                alternatives = [row for row in by_subheading[subheading] if len(row[0]) == 11][:5]
                neighbours = "; ".join("%s · %s" % tuple(row[:2]) for row in alternatives)
                params.update(code=code, subheading=subheading, neighbours=neighbours)
                findings.append(finding("HS-01", "error", "HS-01.unknown-national", params, cited))
    return findings


def rule_dec_parties(ctx):
    invoice, declaration = _first(ctx["invoices"]), _first(ctx["declarations"])
    if not invoice or not declaration:
        return []
    findings = []
    for a_role, b_role in (("seller", "exporter"), ("buyer", "importer")):
        a, b = invoice[a_role], declaration[b_role]
        key = "taxId" if a["taxId"]["value"] is not None and b["taxId"]["value"] is not None else "name"
        if key == "taxId":
            av = tax_digits(a[key])
            bv = tax_digits(b[key], declaration["sourceKind"] == "rs_json")
        else:
            av, bv = cited_written_text(a[key]), cited_written_text(b[key])
        if not av or not bv or not quoted(a[key]) or not quoted(b[key]):
            continue
        agrees = av == bv if key == "taxId" else script_of(av) == "other" or same_party(av, bv) is not False
        if agrees:
            continue
        message = "DEC-01.tax-id" if key == "taxId" else "DEC-01.name"
        findings.append(finding("DEC-01", "error", message, {"role": a_role, "invoice": av, "declaration": bv},
                                [evidence(invoice, a_role + "." + key, a[key]), evidence(declaration, b_role + "." + key, b[key])]))
    return findings


def _usable_code(field, pattern):
    if not quoted(field) or field["value"] is None:
        return None
    code = field["value"].translate(HS_CODE_SEPARATORS)
    return code if re.fullmatch(pattern, code) and code == field["quote"].translate(HS_CODE_SEPARATORS) else None


def _item_number(item, index):
    return (item["itemNumber"]["value"] or str(index + 1)) if quoted(item["itemNumber"]) else str(index + 1)


def rule_dec_codes(ctx):
    findings = []
    invoices, declarations = ctx["invoices"], ctx["declarations"]
    for declaration in declarations:
        date = iso_date(declaration["date"]) if quoted(declaration["date"]) else None
        if not date or not any(item["hsCode"]["value"] is not None for item in declaration["items"]):
            continue
        data, by_code, by_subheading = hs_nomenclature()
        if date < data["edition"]["inForceFrom"]:
            continue
        for i, item in enumerate(declaration["items"]):
            field = item["hsCode"]
            if field["value"] is None:
                continue
            line = _item_number(item, i)
            cited = [evidence(declaration, "items[%d].hsCode" % i, field)]
            code = _usable_code(field, r"[0-9]{11}")
            if code is None:
                findings.append(finding("DEC-02", "warning", "DEC-02.unreadable", {"line": line}, cited))
            elif code not in by_code:
                subheading = code[:6]
                rows = [row for row in by_subheading.get(subheading, []) if len(row[0]) == 11][:5]
                neighbours = "; ".join("%s · %s" % tuple(row[:2]) for row in rows)
                heading = by_code.get(code[:4])
                key = "DEC-02.unknown-national" if neighbours else "DEC-02.unknown-national-heading" if heading else "DEC-02.unknown-national-alone"
                params = {"line": line, "code": code, "subheading": subheading, "neighbours": neighbours,
                          "heading": heading[0] if heading else "", "description": heading[1] if heading else ""}
                findings.append(finding("DEC-02", "error", key, params, cited))

    declaration = _first(declarations)
    if not declaration or not invoices or any(not invoice["lines"] for invoice in invoices) or not declaration["items"]:
        return findings
    lines = [(_usable_code(line["hsCode"], r"[0-9]{6,12}"), str(i + 1), evidence(invoice, "lines[%d].hsCode" % i, line["hsCode"]))
             for invoice in invoices for i, line in enumerate(invoice["lines"])]
    items = [(_usable_code(item["hsCode"], r"[0-9]{6,12}"), _item_number(item, i), evidence(declaration, "items[%d].hsCode" % i, item["hsCode"]))
             for i, item in enumerate(declaration["items"])]
    if any(code is None for code, _, _ in lines + items):
        return findings
    for side, other, key in ((lines, items, "DEC-02.invoice-prefix"), (items, lines, "DEC-02.declaration-prefix")):
        prefixes = {code[:6] for code, _, _ in other}
        for code, line, cited in side:
            if code[:6] not in prefixes:
                findings.append(finding("DEC-02", "warning", key, {"code": code, "line": line}, [cited]))
    return findings


def _quoted_sum(declaration, key):
    items = declaration["items"]
    if not all(quoted(item[key]) for item in items):
        return None
    return _stated_or_sum(declaration, "", None, items, "items", lambda item: item[key])


def _item_evidence(declaration, key):
    return [evidence(declaration, "items[%d].%s" % (i, key), item[key]) for i, item in enumerate(declaration["items"])]


def rule_dec_weights(ctx):
    declaration = _first(ctx["declarations"])
    if not declaration:
        return []
    invoice, pl, cmr = _first(ctx["invoices"]), _first(ctx["packingLists"]), _first(ctx["cmrs"])
    findings = []
    for key, total, documents in (
        ("DEC-03.gross", "grossWeightKg", [(pl, "totalGrossWeightKg"), (cmr, "totalGrossWeightKg"), (invoice, "grossWeightKg")]),
        ("DEC-03.net", "netWeightKg", [(pl, "totalNetWeightKg"), (invoice, "netWeightKg")]),
    ):
        sources = [_observe(doc, path, _get(doc, path)) for doc, path in documents]
        expected = next((source for source in sources if source and quoted(source["field"])), None)
        actual = _quoted_sum(declaration, total)
        if not expected or not actual or same_within(expected["value"], actual["value"], ctx["options"]["weightToleranceKg"]):
            continue
        params = {"expected": expected["field"]["value"], "found": actual["field"]["value"], "document": expected["doc"]["type"]}
        findings.append(finding("DEC-03", "error", key, params, [_cite(actual)] + _item_evidence(declaration, total) + [_cite(expected)]))
    return findings


def rule_dec_packages(ctx):
    declaration = _first(ctx["declarations"])
    if not declaration or not quoted(declaration["totalPackages"]):
        return []
    actual = _observe(declaration, "totalPackages", declaration["totalPackages"])
    if not actual:
        return []
    inv, packing, road = _package_counts(_first(ctx["invoices"]), _first(ctx["packingLists"]), _first(ctx["cmrs"]))
    counts = []
    for observed, kind in (packing, road, inv):
        if not observed:
            continue
        if observed["computed"]:
            doc = observed["doc"]
            lines = doc["lines"] if doc["type"] == "packing_list" else doc["goods"]
            supported = all(quoted(line["packages"]) for line in lines)
        else:
            supported = quoted(observed["field"])
        if supported:
            counts.append((observed, kind))
    if not counts:
        return []
    expected, kind = counts[0]
    actual_kind = packing_kind([declaration["totalPackages"]["quote"]]) or packing_kind(
        [value for item in declaration["items"] for value in (cited_written_text(item["packingMethod"]), item["packages"]["quote"])])
    kinds = {k for k in [actual_kind] + [method for _, method in counts] if k}
    if (len(kinds) > 1 and (not actual_kind or not kind or actual_kind != kind)) or d_equals(actual["value"], expected["value"]):
        return []
    params = {"expected": expected["field"]["value"], "found": actual["field"]["value"], "document": expected["doc"]["type"]}
    return [finding("DEC-04", "error", "DEC-04.packages", params, [_cite(actual), _cite(expected)])]


def _usable_amount(field):
    return num(field) if quoted(field) else None


def _usable_currency(field):
    return currency_code(field) if quoted(field) else None


def rule_dec_values(ctx):
    invoices, declarations = ctx["invoices"], ctx["declarations"]
    first = _first(declarations)
    if not first:
        return []
    findings = []
    found = _usable_currency(first["currency"])
    expected = _usable_currency(invoices[0]["currency"]) if invoices else None
    if found and expected and all(_usable_currency(invoice["currency"]) == expected for invoice in invoices):
        if found != expected:
            findings.append(finding("DEC-05", "error", "DEC-05.currency", {"expected": expected, "found": found},
                                    [evidence(first, "currency", first["currency"])] + [evidence(doc, "currency", doc["currency"]) for doc in invoices]))
        else:
            actual = _usable_amount(first["totalInvoiceAmount"])
            total = sum_all(invoices, lambda invoice: invoice["total"]) if all(quoted(inv["total"]) for inv in invoices) else None
            if actual is not None and total is not None and not d_equals(total, actual):
                findings.append(finding("DEC-05", "error", "DEC-05.invoice-total",
                                        {"expected": show(total), "found": first["totalInvoiceAmount"]["value"]},
                                        [evidence(first, "totalInvoiceAmount", first["totalInvoiceAmount"])]
                                        + [evidence(doc, "total", doc["total"]) for doc in invoices], {"expected": expected, "found": found}))
    for declaration in declarations:
        total = _usable_amount(declaration["totalInvoiceAmount"])
        actual = _quoted_sum(declaration, "invoiceValue")
        if total is None or not actual or d_equals(actual["value"], total):
            continue
        currency = _usable_currency(declaration["currency"])
        findings.append(finding("DEC-05", "error", "DEC-05.item-total",
                                {"expected": declaration["totalInvoiceAmount"]["value"], "found": actual["field"]["value"]},
                                [_cite(actual)] + _item_evidence(declaration, "invoiceValue")
                                + [evidence(declaration, "totalInvoiceAmount", declaration["totalInvoiceAmount"])],
                                {"expected": currency, "found": currency} if currency else None))
    return findings


_COUNTRY_CODES = {js_trim(fold_name(name)): code for code, names in DATA["countries"].items() for name in [code] + names}


def _origin(field):
    value = cited_written_text(field)
    return _COUNTRY_CODES.get(js_trim(fold_name(value))) if value else None


def rule_dec_origin(ctx):
    invoice = _first(ctx["invoices"])
    expected = _origin(invoice["countryOfOrigin"]) if invoice else None
    findings = []
    for index, declaration in enumerate(ctx["declarations"]):
        for i, item in enumerate(declaration["items"]):
            field = item["countryOfOrigin"]
            line = _item_number(item, i)
            cited = evidence(declaration, "items[%d].countryOfOrigin" % i, field)
            if cited_written_text(field) == "999":
                findings.append(finding("DEC-06", "warning", "DEC-06.unestablished", {"line": line}, [cited]))
            elif index == 0 and expected:
                country = _origin(field)
                if country and country != expected:
                    findings.append(finding("DEC-06", "warning", "DEC-06.origin",
                                            {"line": line, "invoice": invoice["countryOfOrigin"]["value"], "declaration": field["value"]},
                                            [cited, evidence(invoice, "countryOfOrigin", invoice["countryOfOrigin"])]))
    return findings


def rule_checklist(ctx):
    findings = []
    documents = ctx["extraction"]["documents"]
    for type_ in REQUIRED_DOCUMENTS:
        if not [d for d in documents if d["type"] == type_]:
            findings.append(finding("DOC-01", "warning", "DOC-01.missing", {"document": type_}, []))
    for type_ in ("commercial_invoice", "packing_list", "cmr", "contract", "customs_declaration"):
        docs = [d for d in documents if d["type"] == type_]
        if len(docs) > 1:
            key = "DOC-01.multiple-invoices-declaration" if type_ == "commercial_invoice" and ctx["declarations"] else "DOC-01.multiple"
            findings.append(finding("DOC-01", "warning", key, {"document": type_, "count": str(len(docs))},
                                    [evidence(d, "number", d["number"]) for d in docs]))
    return findings


RULES = [
    rule_amount_in_words,
    rule_line_arithmetic,
    rule_invoice_totals,
    rule_document_totals,
    rule_currencies,
    rule_quantities,
    rule_gross_vs_net,
    rule_weights_agree,
    rule_references,
    rule_date_order,
    rule_parties,
    rule_incoterms,
    rule_sea_term_on_road,
    rule_insurance,
    rule_cmr_particulars,
    rule_checklist,
    rule_hs_codes,
    rule_party_tax_ids,
    rule_taxpayer_name,
    rule_taxpayer_vat,
    rule_taxpayer_reply,
    rule_dec_parties,
    rule_dec_codes,
    rule_dec_weights,
    rule_dec_packages,
    rule_dec_values,
    rule_dec_origin,
]
DEFAULT_OPTIONS = {"weightToleranceKg": "0.5", "volumeToleranceM3": "0.01"}


def check_extraction(extraction, options=None, unusable=None):
    docs = extraction["documents"]
    if unusable is None:
        unusable = inspect_extraction(extraction)[1]
    ctx = {
        "extraction": extraction,
        "invoices": [d for d in docs if d["type"] == "commercial_invoice"],
        "packingLists": [d for d in docs if d["type"] == "packing_list"],
        "cmrs": [d for d in docs if d["type"] == "cmr"],
        "contracts": [d for d in docs if d["type"] == "contract"],
        "declarations": [d for d in docs if d["type"] == "customs_declaration"],
        "others": [d for d in docs if d["type"] == "other"],
        "options": dict(DEFAULT_OPTIONS, **(options or {})),
    }
    findings = []
    _RUN["unusable"] = unusable
    _RUN["indexes"] = dict((id(doc), index) for index, doc in enumerate(docs))
    try:
        for rule in RULES:
            findings.extend(rule(ctx))
    finally:
        _RUN["unusable"] = frozenset()
        _RUN["indexes"] = {}

    def order(f):
        return (0 if f["severity"] == "error" else 1) * 100 + RULE_IDS.index(f["rule"])

    return sorted(findings, key=order)  # stable


def check_documents(data, options=None):
    parsed = parse_extraction(data)
    snapshot = (options or {}).get("registry")
    if not parsed["ok"]:
        return {"ok": False, "extraction": None, "extractionIssues": parsed["issues"], "findings": [],
                **({"registry": {"snapshot": snapshot, "parties": []}} if snapshot is not None else {}),
                "summary": {"documents": 0, "errors": 0, "warnings": 0}}
    findings = check_extraction(parsed["extraction"], options, parsed["unusable"])
    result = {
        "ok": True,
        "extraction": parsed["extraction"],
        "extractionIssues": parsed["issues"],
        "findings": findings,
        "summary": {
            "documents": len(parsed["extraction"]["documents"]),
            "errors": len([f for f in findings if f["severity"] == "error"]),
            "warnings": len([f for f in findings if f["severity"] == "warning"]),
        },
    }
    if snapshot is not None:
        result["registry"] = {
            "snapshot": snapshot,
            "parties": [{"code": code, "name": party["name"]["value"]}
                        for _, _, party, code in company_parties(parsed["extraction"]["documents"])],
        }
    return result


# ==== report ====
# --------------------------------------------------------------------------
# Messages
# --------------------------------------------------------------------------

DOC_PARAMS = {"document", "present", "missing", "aDocument", "bDocument"}
_PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_]+)\}")


def _js_str(value):
    """String(value ?? "") for a decoded JSON value."""
    if value is None or value is UNDEFINED:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, list):
        return ",".join(_js_str(x) for x in value)
    if isinstance(value, dict):
        return "[object Object]"
    return value


def _at(p, i):
    """p?.[i] on a decoded JSON value."""
    if isinstance(p, (list, str)):
        return p[i] if i < len(p) else UNDEFINED
    if isinstance(p, dict):
        return p.get(str(i), UNDEFINED)
    return UNDEFINED


def _pairs(encoded):
    """Decodes a list param: JSON [[documentType, value], ...]; invalid -> []."""
    try:
        parsed = js_json_parse(encoded)
    except ValueError:
        return []
    if not isinstance(parsed, list):
        return []
    return [(_js_str(_at(p, 0)), _js_str(_at(p, 1))) for p in parsed]


def capitalize(text, language):
    """Sentence case; Georgian is left as is (no case in running text)."""
    if language == "ka" or len(text) == 0:
        return text
    if ord(text[0]) > 0xFFFF:  # charAt(0) is half a surrogate pair: unchanged
        return text
    return locale_upper(text[0], language) + text[1:]


def _localize(name, value, vocab, language):
    def doc_label(code):
        return vocab["doc"].get(code, code)

    if name in DOC_PARAMS:
        return doc_label(value)
    if name == "metric":
        return vocab["metric"].get(value, value)
    if name == "role":
        return vocab["role"].get(value, value)
    if name == "values":
        def listed(doc):
            return vocab["docIn"].get(doc, doc) if vocab["listIn"] else doc_label(doc)

        return ", ".join("%s %s" % (listed(doc), v) for doc, v in _pairs(value))
    if name in ("currencies", "codes"):
        return ", ".join("%s (%s)" % (v, doc_label(doc)) for doc, v in _pairs(value))
    if name == "where":
        parts = value.split(":")
        doc = parts[0]
        part = parts[1] if len(parts) > 1 else None
        n = parts[2] if len(parts) > 2 else "undefined"
        capital = capitalize(doc_label(doc), language)
        if part == "total":
            return "%s, %s" % (capital, vocab["total"])
        if part == "line":
            return "%s, %s %s" % (capital, vocab["line"], n)
        return capital
    return value


def format_date(iso, language):
    """A date the way the language writes it: "5 October 2026" in English, 05.10.2026 elsewhere."""
    match = _ISO_DATE.fullmatch(iso)
    if not match or not is_iso_date(iso):
        return iso
    year, month, day = match.group(1), match.group(2), match.group(3)
    months = VOCAB[language]["months"]
    if months:
        return "%d %s %s" % (int(day), months[int(month) - 1], year)
    return "%s.%s.%s" % (day, month, year)


_FIELD_INDEX = re.compile(r"\[[^\]]*\]")


def _particular_text(item, fields, vocab):
    """What a CMR-01 finding says is missing: the missing parts of the particular, or all of it."""
    whole = vocab["particular"].get(item, item)
    parts = CMR_PARTS.get(item)
    if not parts or fields is None:
        return whole
    missing = list(dict.fromkeys(_FIELD_INDEX.sub("", field) for field in fields.split(", ")))
    if any(field not in parts for field in missing) or all(part in missing for part in parts):
        return whole
    return ", ".join(vocab["cmrField"][field] for field in missing)


def plural_category(count, language):
    if language == "ru":
        tens = count % 100
        ones = count % 10
        if ones == 1 and tens != 11:
            return "one"
        if 2 <= ones <= 4 and (tens < 12 or tens > 14):
            return "few"
        return "many"
    return "one" if count == 1 else "many"


def count_documents(count, language):
    return "%d %s" % (count, VOCAB[language]["documentCount"][plural_category(count, language)])


_COUNT = re.compile("[0-9]+")


_CANONICAL_NUMBER = re.compile(r"(-?)([0-9]+)(?:\.([0-9]+))?")
_FORMULA_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?")


def format_number(value, language):
    """A canonical decimal the way the language writes a number; other text comes back unchanged."""
    match = _CANONICAL_NUMBER.fullmatch(value)
    if not match:
        return value
    fmt = VOCAB[language]["number"]
    sign, whole, fraction = match.group(1), match.group(2), match.group(3)
    head = len(whole) % 3
    groups = ([whole[:head]] if head else []) + [whole[i:i + 3] for i in range(head, len(whole), 3)]
    return sign + fmt["group"].join(groups) + ("" if fraction is None else fmt["decimal"] + fraction)


def _number_text(kind, value, unit, vocab, language, escape):
    """A number param as it is shown, with its unit; text that is not a number is escaped like any document text."""
    if kind == "formula":
        return _FORMULA_NUMBER.sub(lambda m: format_number(m.group(0), language), escape(value))
    if not _CANONICAL_NUMBER.fullmatch(value):
        return escape(value)
    shown = format_number(value, language)
    if kind == "kg":
        return "%s %s" % (shown, vocab["kg"])
    return "%s %s" % (shown, escape(unit)) if kind == "money" and unit else shown


def format_message(key, params, language="en", escape=None, units=None):
    vocab = VOCAB[language]
    if escape is None:
        escape = _as_is
    units = units or {}
    values = {}
    dates = DATE_PARAMS.get(key, [])
    numbers = NUMBER_PARAMS.get(key, {})
    for name, value in params.items():
        kind = numbers.get(name)
        if name in dates:
            values[name] = escape(format_date(value, language))
        elif kind and name != "values":
            values[name] = _number_text(kind, value, units.get(name), vocab, language, escape)
        elif kind:
            def listed(doc):
                return vocab["docIn"].get(doc, doc) if vocab["listIn"] else vocab["doc"].get(doc, doc)

            values[name] = ", ".join("%s %s" % (escape(listed(doc)), _number_text(kind, v, None, vocab, language, escape)) for doc, v in _pairs(value))
        else:
            values[name] = escape(_localize(name, value, vocab, language))
        if name in DOC_PARAMS:
            values[name + "In"] = escape(vocab["docIn"].get(value, value))
    if params.get("item"):
        values["particular"] = _particular_text(params["item"], params.get("fields"), vocab)
    if "reason" in params:
        reason = vocab["reason"].get(params["reason"], values["reason"])
        values["reason"] = reason.replace("{word}", values.get("word", ""))
    if "count" in params and _COUNT.fullmatch(params["count"]):
        values["docs"] = vocab["documentCount"][plural_category(int(params["count"]), language)]
    text = _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), MESSAGES[language][key])
    return capitalize(text, language)


def _as_is(text):
    return text


# --------------------------------------------------------------------------
# Report view and renderers
# --------------------------------------------------------------------------


def pick_language(extraction):
    counts = {}
    for doc in (extraction or {}).get("documents", []):
        lang = doc["language"]
        if lang and lang in REPORT_LANGUAGES:
            counts[lang] = counts.get(lang, 0) + 1
    ranked = sorted(counts.items(), key=lambda entry: -entry[1])
    return ranked[0][0] if ranked else "en"


_PATH_INDEX = re.compile(r"\[[^\]]*\]")
_LINE_FIELD = re.compile(r"(lines|items)\[([0-9]+)\]\.")


def field_label(type_, path, language):
    """The name of an evidence field in the report's language, or None when the path has none."""
    labels = FIELD_LABELS[language]
    key = _PATH_INDEX.sub("", path)
    label = labels.get("%s:%s" % (type_, key), labels.get(key))
    if label is None:
        return None
    line = _LINE_FIELD.match(path)
    return "%s %d, %s" % (VOCAB[language]["item" if line[1] == "items" else "line"], int(line[2]) + 1, label) if line else label


def registry_view(registry, language):
    title, source, party, time, unavailable, status, message, *field_labels = REGISTRY_LABELS[language]
    snapshot = registry["snapshot"]
    parties = {}
    for item in registry["parties"]:
        names = parties.setdefault(item["code"], {})
        if item["name"]:
            names[item["name"]] = None
    replies = {entry["code"]: entry for entry in snapshot["entries"]}
    entries = []
    for code in dict.fromkeys([*parties, *replies]):
        reply = replies.get(code, {})
        entry = {"code": code, "parties": list(parties.get(code, {})), "checkedAt": reply.get("checkedAt")}
        if "answer" in reply:
            entry["answer"] = reply["answer"]
        elif "error" in reply:
            entry["error"] = reply["error"]
        entry["checked"] = bool(reply.get("answer")) or reply.get("error", {}).get("Status") == -1
        entries.append(entry)
    labels = {"party": party, "time": time, "unavailable": unavailable, "replyStatus": status, "replyMessage": message}
    labels.update(zip(REGISTRY_FIELDS, field_labels))
    return {"title": title, "source": {"label": source, "value": snapshot["sourceUrl"]}, "labels": labels, "entries": entries}


def registry_rows(registry, entry):
    labels = registry["labels"]
    rows = [(labels["party"], " · ".join(entry["parties"]) or "—"), (labels["time"], entry["checkedAt"] or "—")]
    if not entry["checked"]:
        rows.append((labels["unavailable"], ""))
    if "error" in entry:
        error = entry["error"]
        if "Status" in error:
            rows += [(labels["replyStatus"], js_number(error["Status"])), (labels["replyMessage"], error["Message"])]
        else:
            rows.append((labels["replyMessage"], error["transport"]))
    for answer in entry.get("answer", []):
        rows.extend((labels[field], answer[field]) for field in REGISTRY_FIELDS)
    return rows


def build_report(result, language=None):
    if language is None:
        language = pick_language(result["extraction"])
    vocab = VOCAB[language]
    docs = result["extraction"]["documents"] if result["extraction"] else []
    findings = []
    for index, f in enumerate(result["findings"]):
        ev = []
        for e in f["evidence"]:
            # By position: two documents may carry the same id (an extraction issue), never the same position.
            doc = docs[e["documentIndex"]] if 0 <= e["documentIndex"] < len(docs) else None
            ev.append({
                "document": vocab["doc"][e["documentType"]],
                "documentId": e["documentId"],
                "documentType": e["documentType"],
                "number": doc["number"]["value"] if doc is not None else None,
                "sourceFile": doc["sourceFile"] if doc is not None else None,
                "page": e["page"],
                "path": e["path"],
                "label": None if e.get("computed") is True else field_label(e["documentType"], e["path"], language),
                "quote": e["quote"],
                "value": e["value"],
                "computed": e.get("computed") is True,
            })
        findings.append({
            "index": index + 1,
            "rule": f["rule"],
            "ruleTitle": RULE_TITLES[language][f["rule"]],
            "severity": f["severity"],
            "message": format_message(f["key"], f["params"], language, None, f.get("units")),
            "check": KEY_CHECKS[language].get(f["key"], RULE_CHECKS[language][f["rule"]]),
            "key": f["key"],
            "params": f["params"],
            "units": f.get("units") or {},
            "evidence": ev,
        })
    return {
        "language": language,
        "ui": UI[language],
        "readable": result["ok"],
        "documents": [{"id": d["id"], "type": d["type"], "label": vocab["doc"][d["type"]], "number": d["number"]["value"], "sourceFile": d["sourceFile"]} for d in docs],
        "rulesRun": len(RULES) - (0 if "registry" in result else 3) - (0 if any(d["type"] == "customs_declaration" for d in docs) else 6) if result["ok"] else 0,
        "errors": [f for f in findings if f["severity"] == "error"],
        "warnings": [f for f in findings if f["severity"] == "warning"],
        "extractionIssues": result["extractionIssues"],
        "sourceNotes": list(dict.fromkeys((d["sourceFile"] + ": " if d["sourceFile"] else "") + UI[language]["declarationSource"]
                                          for d in docs if d["type"] == "customs_declaration" and d["sourceKind"] == "rs_json")),
        **({"registry": registry_view(result["registry"], language)} if "registry" in result else {}),
    }


def evidence_source(e, ui):
    name = " ".join(x for x in (e["document"], e["number"]) if x)
    source = " (%s)" % e["sourceFile"] if e["sourceFile"] else ""
    page = ", %s %s" % (ui["page"], js_number(e["page"])) if e["page"] is not None else ""
    return name + source + page


def evidence_heading(e, ui):
    """Where a piece of evidence is and which field it is."""
    source = evidence_source(e, ui)
    return source if e["label"] is None else "%s · %s" % (source, e["label"])


_MD_WHITESPACE = re.compile("[%s]+" % JS_WS_CLASS)
_MD_CONTROL = re.compile(r"([\\`*_\[\]<>|~])")


def markdown_text(text):
    """Document text in report.md: one line, Markdown control characters escaped."""
    return _MD_CONTROL.sub(r"\\\1", _MD_WHITESPACE.sub(" ", text))


def plain_text(text):
    """Document text in the report printed to a terminal: one line, no Markdown escapes."""
    return _MD_WHITESPACE.sub(" ", text)


def _finding_block(f, view, escape):
    ui = view["ui"]
    open_, close = ui["quote"]
    message = format_message(f["key"], f["params"], view["language"], escape, f["units"])
    lines = ["### %d. %s · %s" % (f["index"], f["rule"], f["ruleTitle"]), "", message, ""]
    for e in f["evidence"]:
        if e["quote"] is not None:
            shown = open_ + escape(e["quote"]) + close
        elif e["value"] is None:
            shown = "—"
        elif e["computed"]:
            shown = "%s (%s)" % (format_number(escape(e["value"]), view["language"]), ui["computed"])
        else:
            shown = escape(e["value"])
        lines.append("- %s: %s" % (escape(evidence_heading(e, ui)), shown))
    if f["evidence"]:
        lines.append("")
    lines.append("→ " + f["check"])
    return js_trim_end("\n".join(lines))


def _issues_hint(view):
    ui = view["ui"]
    return "%s %s" % (ui["extractionIssuesHint"], ui["extractionIssuesEffect"]) if view["readable"] else ui["extractionIssuesHint"]


def render_markdown(view, escape=markdown_text):
    ui = view["ui"]
    out = ["# " + ui["title"], ""]
    errors, warnings = view["errors"], view["warnings"]
    if not view["readable"]:
        out += [ui["unreadable"], ""]
    else:
        out += [
            "**%s: %d · %s: %d** · %s: %s, %d %s" % (ui["errors"], len(errors), ui["warnings"], len(warnings), ui["checked"],
                                                  count_documents(len(view["documents"]), view["language"]), view["rulesRun"], ui["rules"]),
            "",
        ]
    # Before the findings: a value with an issue is left out of the rules, so what follows depends on them.
    if view["extractionIssues"]:
        out += ["## " + ui["extractionIssues"], "", _issues_hint(view), ""]
        for issue in view["extractionIssues"]:
            out.append("- `%s` (%s): %s" % (issue["path"], issue["code"], escape(issue["message"])))
        out.append("")
    elif view["readable"]:
        out += [ui["extractionOk"], ""]
    if view["readable"]:
        if not errors and not warnings and not view["extractionIssues"]:
            out += ["✓ " + ui["noProblems"], ""]
        if errors:
            out += ["## " + ui["errorsHeading"], ""] + [_finding_block(f, view, escape) + "\n" for f in errors]
        if warnings:
            out += ["## " + ui["warningsHeading"], ""] + [_finding_block(f, view, escape) + "\n" for f in warnings]
    registry = view.get("registry")
    if registry is not None:
        out += ["## " + registry["title"], "", "%s: %s" % (registry["source"]["label"], escape(registry["source"]["value"])), ""]
        for entry in registry["entries"]:
            out += ["### " + entry["code"], ""]
            out += ["- %s: %s" % (label, escape(value)) if value else "- " + label for label, value in registry_rows(registry, entry)]
            out.append("")
    if view["sourceNotes"]:
        out += ["## " + ui["notes"], ""] + ["- " + escape(note) for note in view["sourceNotes"]] + [""]
    out += ["---", ui["generatedBy"]]
    return js_trim("\n".join(out)) + "\n"


def render_text(view):
    """The report as it is printed to a terminal: the layout of report.md, document text without Markdown escapes."""
    return render_markdown(view, plain_text)


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _html_finding(f, view):
    ui = view["ui"]
    items = []
    for e in f["evidence"]:
        if e["quote"] is not None:
            shown = "<q>%s</q>" % esc(e["quote"])
        elif e["value"] is None:
            shown = "—"
        elif e["computed"]:
            shown = '%s <span class="src">%s</span>' % (esc(format_number(e["value"], view["language"])), esc(ui["computed"]))
        else:
            shown = esc(e["value"])
        field = "" if e["label"] is None else '<span class="field">%s:</span> ' % esc(e["label"])
        items.append('<li><span class="src">%s</span>%s%s</li>' % (esc(evidence_source(e, ui)), field, shown))
    items = "".join(items)
    label = ui["error"] if f["severity"] == "error" else ui["warning"]
    return (
        '<article class="finding %s">\n'
        '  <div class="rule">%s · <b>%s</b> · %s</div>\n'
        '  <div class="message">%s</div>\n'
        "  %s\n"
        '  <p class="check">→ %s</p>\n'
        "</article>"
    ) % (f["severity"], esc(label), esc(f["rule"]), esc(f["ruleTitle"]), esc(f["message"]), "<ul>%s</ul>" % items if items else "", esc(f["check"]))


def render_html(view):
    ui = view["ui"]
    errors, warnings = view["errors"], view["warnings"]
    body = []
    if not view["readable"]:
        body.append('<p class="ok">%s</p>' % esc(ui["unreadable"]))
    else:
        body.append(
            '<div class="summary">\n'
            '  <div class="stat err"><strong>%d</strong><span>%s</span></div>\n'
            '  <div class="stat warn"><strong>%d</strong><span>%s</span></div>\n'
            '  <div class="stat"><strong>%d</strong><span>%s</span></div>\n'
            '  <div class="stat"><strong>%d</strong><span>%s</span></div>\n'
            "</div>" % (len(errors), esc(ui["errors"]), len(warnings), esc(ui["warnings"]),
                        len(view["documents"]), esc(ui["documents"]), view["rulesRun"], esc(ui["rules"]))
        )
    if view["extractionIssues"]:
        issues = "".join("<li>%s · %s · %s</li>" % (esc(i["path"]), esc(i["code"]), esc(i["message"])) for i in view["extractionIssues"])
        body.append('<h2>%s</h2><p class="issues-hint">%s</p><ul class="issues">%s</ul>' % (esc(ui["extractionIssues"]), esc(_issues_hint(view)), issues))
    elif view["readable"]:
        body.append('<p class="note">%s</p>' % esc(ui["extractionOk"]))
    if view["readable"]:
        if not errors and not warnings and not view["extractionIssues"]:
            body.append('<p class="ok">✓ %s</p>' % esc(ui["noProblems"]))
        if errors:
            body += ["<h2>%s</h2>" % esc(ui["errorsHeading"])] + [_html_finding(f, view) for f in errors]
        if warnings:
            body += ["<h2>%s</h2>" % esc(ui["warningsHeading"])] + [_html_finding(f, view) for f in warnings]
    registry = view.get("registry")
    if registry is not None:
        body.append("<h2>%s</h2><p>%s: %s</p>" % (esc(registry["title"]), esc(registry["source"]["label"]), esc(registry["source"]["value"])))
        for entry in registry["entries"]:
            rows = "".join('<li>%s: <span style="white-space: pre-wrap">%s</span></li>' % (esc(label), esc(value))
                           if value else "<li>%s</li>" % esc(label) for label, value in registry_rows(registry, entry))
            body.append("<h3>%s</h3><ul>%s</ul>" % (entry["code"], rows))
    if view["sourceNotes"]:
        body.append("<h2>%s</h2><ul>%s</ul>" % (esc(ui["notes"]), "".join("<li>%s</li>" % esc(note) for note in view["sourceNotes"])))
    return (
        "<!doctype html>\n"
        '<html lang="' + view["language"] + '">\n'
        '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>" + esc(ui["title"]) + " · Logisticshub</title><style>" + REPORT_CSS + "</style></head>\n"
        "<body><main>\n"
        '<div class="brand">Logistics<b>hub</b></div>\n'
        "<h1>" + esc(ui["title"]) + "</h1>\n"
        + "\n".join(body) + "\n"
        "<footer>" + esc(ui["generatedBy"]) + "</footer>\n"
        "</main></body></html>\n"
    )


def render_json(result, view):
    findings = sorted(view["errors"] + view["warnings"], key=lambda f: f["index"])
    out_findings = []
    for i, f in enumerate(result["findings"]):
        item = dict(f)
        shown = findings[i]["evidence"] if i < len(findings) else []
        item["evidence"] = [dict(e, label=shown[j]["label"] if j < len(shown) else None) for j, e in enumerate(f["evidence"])]
        item["ruleTitle"] = findings[i]["ruleTitle"] if i < len(findings) else UNDEFINED
        item["message"] = findings[i]["message"] if i < len(findings) else UNDEFINED
        item["check"] = findings[i]["check"] if i < len(findings) else UNDEFINED
        out_findings.append(item)
    report = {
        "reportVersion": REPORT_VERSION,
        "language": view["language"],
        "ok": result["ok"],
        "summary": result["summary"],
        "documents": view["documents"],
        "extractionIssues": result["extractionIssues"],
        "findings": out_findings,
        **({"sourceNotes": view["sourceNotes"]} if view["sourceNotes"] else {}),
        **({"registry": view["registry"]} if "registry" in view else {}),
    }
    return js_stringify(report) + "\n"


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

FORMATS = ["md", "json", "html"]
USAGE = """Logisticshub %s: cross-check trade documents (Python port)

Usage:
  python3 check.py <extraction.json> [--lang en|ka|ru|tr] [--out <dir>] [--format md,json,html]
                  [--registry <file>]
  python3 check.py --schema
  python3 check.py declaration-from-rs <response.json> [--registration <number>] [--append <extraction.json>]
  python3 check.py hs <code or Georgian words> [--json] [--limit <n>]

Writes report.md, report.json and report.html (default: next to the extraction)
and prints the report. Same reports as check.mjs. The PDFs are not
read: no marked copies and no check that each quote is printed on its page
(--pdf-dir and --no-annotate are accepted and ignored). --registry reads a saved
snapshot. The Python checker never connects to the Revenue Service.

Exit codes:
  0  checked, with or without findings
  1  the extraction is not usable: the reports list what to fix
  2  nothing was checked: a bad option, a file that cannot be read or is not
     JSON, a malformed registry snapshot, or reports that cannot be written""" % VERSION


class UsageExit(Exception):
    pass


def write_out(stream, text):
    stream.buffer.write(to_bytes(text))
    stream.flush()


def fail(message):
    """A wrong command line: the message and how to call the script."""
    write_out(sys.stderr, "%s\n\n%s\n" % (message, USAGE))
    sys.exit(2)


def stop(message):
    """A file that cannot be read or written: one line, nothing else."""
    write_out(sys.stderr, message + "\n")
    sys.exit(2)


def parse_args(argv):
    options = {"file": None, "lang": None, "out": None, "pdfDir": None, "annotate": True, "formats": FORMATS,
               "schema": False, "parseWords": None, "dumpTables": False, "registry": None}
    i = 0
    while i < len(argv):
        arg = argv[i]

        def next_value():
            if i + 1 >= len(argv):
                fail("Missing value for %s." % arg)
            return argv[i + 1]

        if arg in ("--help", "-h"):
            write_out(sys.stdout, USAGE + "\n")
            sys.exit(0)
        elif arg == "--version":
            write_out(sys.stdout, VERSION + "\n")
            sys.exit(0)
        elif arg == "--schema":
            options["schema"] = True
        elif arg == "--lang":
            lang = next_value()
            i += 1
            if lang not in REPORT_LANGUAGES:
                fail("--lang must be one of %s." % ", ".join(REPORT_LANGUAGES))
            options["lang"] = lang
        elif arg == "--out":
            options["out"] = next_value()
            i += 1
        elif arg == "--registry":
            options["registry"] = next_value()
            i += 1
        elif arg == "--pdf-dir":
            options["pdfDir"] = next_value()
            i += 1
        elif arg == "--no-annotate":
            options["annotate"] = False
        elif arg == "--format":
            formats = [js_trim(f) for f in next_value().split(",")]
            i += 1
            formats = list(dict.fromkeys(formats))
            unknown = [f for f in formats if f not in FORMATS]
            if unknown:
                fail('--format takes a comma list of %s; got "%s".' % (", ".join(FORMATS), '", "'.join(unknown)))
            options["formats"] = formats
        elif arg == "--parse-words-file":
            options["parseWords"] = next_value()
            i += 1
        elif arg == "--dump-tables":
            options["dumpTables"] = True
        elif arg.startswith("-"):
            fail("Unknown option %s." % arg)
        elif options["file"]:
            fail("Give one extraction file.")
        else:
            options["file"] = arg
        i += 1
    return options


def parse_words_file(path):
    """Test hook: [{"text", "language"}] -> parse results as JSON."""
    with open(path, encoding="utf-8") as f:
        phrases = json.load(f)
    results = []
    for phrase in phrases:
        r = parse_amount_in_words(phrase["text"], phrase.get("language"))
        if r["ok"]:
            amount = r["value"]["amount"]
            results.append({"ok": True, "amount": to_fixed(amount, amount[1]), "currency": r["value"]["currency"], "language": r["value"]["language"]})
        else:
            results.append({"ok": False, "code": r["error"]["code"], "word": r["error"].get("word")})
    return js_stringify(results) + "\n"


def read_text(path):
    with open(path, "rb") as f:
        return decode_text(f.read())


def describe_hs_entry(row):
    code, description, depth, *unit = row
    level = {4: "heading", 11: "national code"}.get(len(code), "subheading")
    return {"code": code, "level": level, "description": description, "depth": depth, "supplementaryUnit": unit[0] if unit else None}


def hs_lookup(argv):
    if "--help" in argv or "-h" in argv:
        write_out(sys.stdout, USAGE + "\n")
        return 0
    parser = argparse.ArgumentParser(prog="check.py hs", allow_abbrev=False)
    parser.add_argument("query")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--limit", default=str(DATA["hsLookupLimit"]))
    args = parser.parse_args(argv)
    if not js_trim(args.query):
        stop("Give one HS code or Georgian description.")
    digits = args.limit.lstrip("0")
    limit = int(digits) if re.fullmatch(r"[0-9]{1,16}", digits) else 0
    if not 1 <= limit <= 9007199254740991:
        stop("Limit must be a positive integer.")

    data, by_code, _ = hs_nomenclature()
    digits = args.query.translate(HS_CODE_SEPARATORS)
    numeric = re.fullmatch(r"[0-9]+", digits)
    needle = args.query.lower().translate(HS_DESCRIPTION_SEPARATORS)
    matches = []
    for row in data["entries"]:
        code, description = row[:2]
        if not (code.startswith(digits) if numeric else needle in description.lower().translate(HS_DESCRIPTION_SEPARATORS)):
            continue
        ancestors = [describe_hs_entry(by_code[code[:length]]) for length in (4, 6, 8, 9) if length < len(code) and code[:length] in by_code]
        matches.append(dict(describe_hs_entry(row), ancestors=ancestors))
        if len(matches) == limit:
            break

    edition, url = data["edition"], data["sourceUrl"]
    if args.json:
        write_out(sys.stdout, js_stringify({"edition": edition, "sourceUrl": url, "matches": matches}) + "\n")
        return 0
    lines = [
        "Georgian nomenclature · Order No. {orderNumber} of {orderDate} · publication {publication} (original text). Later amendments were not verified.".format(**edition),
        url, "",
    ]
    for match in matches:
        unit = " [%s]" % match["supplementaryUnit"] if match["supplementaryUnit"] else ""
        lines.append("{code} ({level}) · {description}".format(**match) + unit)
        if match["ancestors"]:
            lines.append("  " + " › ".join("{code} {description}".format(**parent) for parent in match["ancestors"]))
    if not matches:
        lines.append("No matches.")
    write_out(sys.stdout, "\n".join(lines) + "\n")
    return 0


def read_registry(path):
    def invalid():
        raise ValueError("Invalid registry snapshot. Expected registry schema version %s, its source URL and valid entries." % REGISTRY_VERSION)

    ok, data = parse_json(read_text(path))
    if not ok:
        raise ValueError(data)
    if (not isinstance(data, dict) or set(data) != {"schemaVersion", "sourceUrl", "entries"}
            or data["schemaVersion"] != REGISTRY_VERSION or data["sourceUrl"] != REGISTRY_SOURCE
            or not isinstance(data["entries"], list)):
        invalid()
    entries = []
    for entry in data["entries"]:
        if not isinstance(entry, dict):
            invalid()
        code, checked_at = entry.get("code"), entry.get("checkedAt")
        if (not isinstance(code, str) or not re.fullmatch(r"[0-9]{9}", code)
                or not isinstance(checked_at, str)
                or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z", checked_at)
                or checked_at.startswith("0000-") or not is_iso_date(checked_at[:10])):
            invalid()
        normalized = {"code": code, "checkedAt": checked_at}
        if set(entry) == {"code", "checkedAt", "answer"}:
            answer = entry["answer"]
            if (not isinstance(answer, list) or any(not isinstance(row, dict)
                    or any(not isinstance(row.get(key), str) for key in REGISTRY_FIELDS) for row in answer)):
                invalid()
            normalized["answer"] = [{key: row[key] for key in REGISTRY_FIELDS} for row in answer]
        elif set(entry) == {"code", "checkedAt", "error"}:
            error = entry["error"]
            if not isinstance(error, dict):
                invalid()
            if set(error) == {"Status", "Message"} and error["Status"] in (-1, -100, -101) and isinstance(error["Message"], str):
                normalized["error"] = {"Status": error["Status"], "Message": error["Message"]}
            elif set(error) == {"transport"} and isinstance(error["transport"], str) and error["transport"]:
                normalized["error"] = {"transport": error["transport"]}
            else:
                invalid()
        else:
            invalid()
        entries.append(normalized)
    if len({entry["code"] for entry in entries}) != len(entries):
        raise ValueError("Invalid registry snapshot: duplicate company codes.")
    return dict(data, entries=entries)


DECLARATION_USAGE = "declaration-from-rs <response.json> [--registration <number>] [--append <extraction.json>]"


class JsonNumber:
    def __init__(self, raw):
        self.raw = raw


def _json_fact(value, quote=None):
    return {"value": value, "quote": value if quote is None else quote, "page": None}


def _declaration_blank(schema):
    kind = schema[0]
    if kind == "obj":
        return {key: _declaration_blank(child) for key, child in schema[1]}
    if kind == "cited":
        return _json_fact(None)
    if kind == "arr":
        return []
    if kind == "literal":
        return schema[1]
    return None


def _reject_constant(_name):
    raise ValueError("Non-JSON numeric constant.")


def declarations_from_rs(raw, source_file, registration=None):
    try:
        response = json.loads(raw, parse_int=JsonNumber, parse_float=JsonNumber, parse_constant=_reject_constant)
    except ValueError:
        raise ValueError("The Revenue Service response is not valid JSON.") from None
    status = response.get("STATUS") if isinstance(response, dict) else None
    if not isinstance(status, dict) or not isinstance(status.get("ID"), JsonNumber) or not isinstance(status.get("TEXT"), str):
        raise ValueError("Expected Revenue Service response with numeric STATUS.ID and string STATUS.TEXT.")
    status_id = json_decimal(status["ID"].raw)
    if not status_id or not re.fullmatch(r"-?0(?:\.0+)?", status_id):
        raise ValueError("Revenue Service STATUS.ID is %s." % status["ID"].raw)
    if not isinstance(response.get("DATA"), list):
        raise ValueError("Expected Revenue Service response with a DATA array.")

    groups = {}
    fields = DATA["rsFields"]
    for index, row in enumerate(response["DATA"]):
        def bad(key, expected):
            raise ValueError("DATA[%d]%s: expected %s." % (index, "." + key if key else "", expected))

        if not isinstance(row, dict):
            bad("", "an object")

        def get_text(key):
            if key not in row:
                return None
            value = row[key]
            if not isinstance(value, str):
                bad(key, "a string")
            return value if js_trim(value) else None

        def get_date(key):
            quote = get_text(key)
            if quote is None:
                return _json_fact(None)
            value = rs_date(quote)
            if value is None:
                bad(key, "a valid DD.MM.YYYY date")
            return _json_fact(value, quote)

        def get_number(key):
            if key not in row:
                return _json_fact(None)
            number = row[key]
            if not isinstance(number, JsonNumber):
                bad(key, "a JSON number")
            value = json_decimal(number.raw)
            if value is None:
                bad(key, "a usable JSON decimal")
            return _json_fact(value, number.raw)

        header = _declaration_blank(DOCUMENT_SCHEMAS["customs_declaration"])
        header.update(id="declaration", sourceFile=source_file, sourceKind="rs_json")
        for key, field in fields["header"].items():
            header[field] = _json_fact(get_text(key))
        header["date"] = get_date("RegistrationDate")
        header["assessmentDate"] = get_date("AssessmentDate")
        header["exporter"]["taxId"] = _json_fact(get_text("ExporterCode"))
        header["importer"]["taxId"] = _json_fact(get_text("ImporterCode"))
        if not header["customsOfficeCode"]["value"]:
            bad("CustomsCode", "a nonempty customs office code")
        if not header["number"]["value"]:
            bad("RegistrationNumber", "a nonempty registration number")
        if not header["date"]["value"]:
            bad("RegistrationDate", "a valid DD.MM.YYYY date")

        item = {field: _json_fact(get_text(key)) for key, field in fields["item"].items()}
        item.update({field: get_number(key) for key, field in fields["numeric"].items()})
        item.update({field: _json_fact(None) for field in ("packages", "packingMethod", "invoiceValue", "customsValueGel")})
        item_number = re.fullmatch(r"([1-9][0-9]*)(?:\.0+)?", item["itemNumber"]["value"] or "")
        if not item_number:
            bad("ItemNumber", "a positive whole number")
        identity = tuple(header[field]["value"] for field in ("customsOfficeCode", "number", "date"))
        original, items, seen = groups.setdefault(identity, (header, [], set()))
        if original != header:
            bad("", "the same header values on every row of this declaration")
        if item_number[1] in seen:
            bad("ItemNumber", "a unique item number within this declaration")
        seen.add(item_number[1])
        items.append(item)
    docs = [dict(doc, items=items) for doc, items, _ in groups.values() if registration is None or doc["number"]["value"] == registration]
    if registration is not None and len(docs) != 1:
        raise ValueError("Registration number %s %s." % (registration, "matches several offices or dates" if docs else "was not found"))
    return docs


def declaration_command(argv):
    if "-h" in argv or "--help" in argv:
        write_out(sys.stdout, USAGE + "\n")
        return 0
    paths, options = [], {}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            paths.extend(argv[i + 1:])
            break
        if arg.startswith("--"):
            key, equals, value = arg.partition("=")
            if key not in ("--registration", "--append"):
                stop("Unknown option %s." % key)
            if not equals:
                i += 1
                if i >= len(argv) or argv[i].startswith("--"):
                    stop("%s needs a value." % key)
                value = argv[i]
            options[key] = value
        else:
            paths.append(arg)
        i += 1
    if len(paths) != 1:
        stop("Usage: " + DECLARATION_USAGE)

    def read(path):
        try:
            return read_text(path)
        except (OSError, ValueError) as error:
            stop("Cannot read %s: %s." % (path, io_problem(error)))

    try:
        docs = declarations_from_rs(read(paths[0]), os.path.basename(paths[0]), options.get("--registration"))
    except ValueError as error:
        stop(str(error))
    extraction = {"schemaVersion": SCHEMA_VERSION, "documents": []}
    append = options.get("--append")
    if append is not None:
        ok, extraction = parse_json(read(append))
        if not ok:
            stop("Cannot read %s: %s." % (append, extraction))
        issues = shape_issues(extraction)
        if issues:
            stop("Cannot append to %s: %s" % (append, issues[0][1]))
    ids = {doc["id"] for doc in extraction["documents"]}
    index = 1
    for doc in docs:
        while True:
            doc["id"] = "declaration" if index == 1 else "declaration-%d" % index
            if doc["id"] not in ids:
                break
            index += 1
        ids.add(doc["id"])
        extraction["documents"].append(doc)
    write_out(sys.stdout, js_stringify(extraction) + "\n")
    return 0


def main(argv):
    if argv[:1] == ["declaration-from-rs"]:
        return declaration_command(argv[1:])
    if argv[:1] == ["hs"]:
        return hs_lookup(argv[1:])
    options = parse_args(argv)
    if options["parseWords"] is not None:
        write_out(sys.stdout, parse_words_file(options["parseWords"]))
        return 0
    if options["dumpTables"]:
        # Test hook: tables kept in this file rather than check-data.json.
        tables = {"incotermNames": INCOTERM_NAMES, "legalFormPhrases": LEGAL_FORM_PHRASES, "packingKinds": PACKING_KINDS}
        write_out(sys.stdout, js_stringify(tables) + "\n")
        return 0
    if options["schema"]:
        path = os.path.join(HERE, "..", "references", "extraction-schema.json")
        try:
            schema = js_json_parse(read_text(path))
        except OSError as error:
            stop("Cannot read %s: %s." % (os.path.normpath(path), io_problem(error)))
        except ValueError:
            stop("Cannot read %s: not valid JSON." % os.path.normpath(path))
        write_out(sys.stdout, js_stringify(schema) + "\n")
        return 0
    if not options["file"]:
        fail("Missing extraction file.")

    file = os.path.abspath(options["file"])
    try:
        text = read_text(file)
    except OSError as error:
        stop("Cannot read %s: %s." % (file, io_problem(error)))
    ok, data = parse_json(text)
    if not ok:
        stop("Cannot read %s: %s. Fix the file and run the check again." % (file, data))

    registry_path = options["registry"]
    registry = None
    if registry_path is not None:
        registry_path = os.path.abspath(registry_path)
        try:
            registry = read_registry(registry_path)
        except (OSError, ValueError) as error:
            stop("Cannot read registry snapshot %s: %s" % (registry_path, io_problem(error)))
    result = check_documents(data, {"registry": registry})
    language = options["lang"] or pick_language(result["extraction"])
    view = build_report(result, language)
    reports = {
        "md": lambda: render_markdown(view),
        "json": lambda: render_json(result, view),
        "html": lambda: render_html(view),
    }
    out_dir = os.path.abspath(options["out"] if options["out"] is not None else os.path.dirname(file))
    advice = "Give --out a folder that can be written to."
    written = []
    for fmt in options["formats"]:
        content = to_bytes(reports[fmt]())
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as error:
            stop("Cannot write to %s: %s. %s" % (out_dir, io_problem(error), advice))
        path = os.path.join(out_dir, "report.%s" % fmt)
        try:
            with open(path, "wb") as f:
                f.write(content)
        except OSError as error:
            stop("Cannot write %s: %s. %s" % (path, io_problem(error), advice))
        written.append(path)
    # The terminal gets the report without Markdown escapes; report.md keeps them.
    write_out(sys.stdout, "%s\nFiles:\n%s\n" % (render_text(view), "\n".join("- " + p for p in written)))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception as error:  # Not expected: every known failure ends in stop() or fail() above.
        stop("Unexpected error, nothing was checked: %s" % io_problem(error))
    sys.exit(code)
