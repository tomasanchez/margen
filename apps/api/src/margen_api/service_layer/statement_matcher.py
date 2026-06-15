"""Pure per-line reconciliation matcher for statement import (ADR-084, ADR-085).

At parse time each statement line is tested against the user's existing manual
expenses to flag likely duplicates (ADR-084). This module holds the heuristic as
PURE, fully unit-testable functions with NO I/O — no session, no HTTP, no clock
(ADR-085). The caller fetches the candidate pool through a reader and feeds plain
:class:`ReconCandidate` records in; the matcher returns line-index -> candidate
assignments.

A statement line matches a candidate when all three hold (ADR-085):

1. **Amount is exact** — ARS amounts match to the cent (exact :class:`~decimal.Decimal`).
2. **Date is within ±N days** — the line's ``purchase_date`` (the FECHA, when the
   user would have logged the manual expense) falls within :data:`WINDOW_DAYS` of the
   candidate's ``occurred_on``. The line's ``occurred_on`` (now the statement pay date)
   is NOT used for matching (ADR-089).
3. **Names are fuzzily similar** — :func:`names_similar` (share a significant word in
   ANY position, one name a prefix of the other, or a high typo-tolerance ratio).
   The bar is intentionally lenient: amount-exact + date-window already gate every
   candidate and every flag is reviewed, so recall matters more than precision here.

Assignment is **greedy 1:1**: a candidate is claimed by at most one line; ties are
resolved by nearest date, then smallest line index (ADR-085).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from difflib import SequenceMatcher

from margen_api.service_layer.statement_parser_read_models import StatementLineDraft

# The ±N-day window the date condition tolerates; a configurable default (ADR-085).
WINDOW_DAYS = 3

# Minimum SequenceMatcher ratio for the typo-tolerance fallback. Deliberately high
# so two different brands that merely share a generic word ("Fabric Sushi" vs
# "Sushiclub") never match — only a near-identical misspelling clears this bar.
_SIMILARITY_THRESHOLD = 0.85

# A token must be at least this many characters AND non-numeric to be "significant"
# for shared-word matching — drops noise like "el", "de", "sa", "5771".
_MIN_TOKEN_LENGTH = 4

# A whole-string prefix must be at least this long to count, so a 1-2 char label
# does not prefix-match everything.
_MIN_PREFIX_LENGTH = 3

# Non-alphanumeric runs collapse to a single space during normalization.
_NON_ALNUM = re.compile(r"[^0-9a-z]+")


@dataclass(frozen=True, slots=True)
class ReconCandidate:
    """A manual-expense candidate a statement line may reconcile against (ADR-085).

    A lightweight, immutable projection of an existing manual expense — ``kind`` is
    expense and ``statement_document_id`` is ``None`` (ADR-084) — carrying only what
    the matcher needs and the review UI shows. Built by the caller from a read model;
    the matcher never touches persistence. Money is ``Decimal`` (ADR-025).

    Attributes:
        transaction_id: The existing transaction's stable identity.
        occurred_on: The date the user recorded the expense on.
        name: The user's manual label (source of truth for the merge — ADR-085).
        amount: Positive ARS-equivalent magnitude.
        currency: ``ARS`` or ``USD`` (only exact-ARS amounts can match — ADR-085).
        category: The user's category, or ``None`` when uncategorized.
        payment_method: The user's bank / card / channel label, or ``None``.
    """

    transaction_id: object
    occurred_on: date
    name: str
    amount: Decimal
    currency: str
    category: str | None
    payment_method: str | None


def _normalize(text: str) -> str:
    """Normalize a label for comparison: casefold, strip accents/punctuation (PURE).

    Decomposes accents (``á`` -> ``a``), lowercases, replaces every non-alphanumeric
    run with a single space, and collapses surrounding whitespace.

    Args:
        text: The raw merchant / label text.

    Returns:
        The normalized, space-separated lowercase token string (may be empty).
    """
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    lowered = stripped.casefold()
    return _NON_ALNUM.sub(" ", lowered).strip()


def _significant_tokens(normalized: str) -> set[str]:
    """Return the significant tokens of a normalized string (PURE).

    A token is significant when it is at least :data:`_MIN_TOKEN_LENGTH` characters
    and not purely numeric, so short connectors and bare card/voucher numbers do not
    create spurious overlaps. Position does not matter — a brand at the END of the
    merchant text ("Sushi Hatsu") counts the same as one at the start.

    Args:
        normalized: A string already run through :func:`_normalize`.

    Returns:
        The set of significant tokens (possibly empty).
    """
    return {token for token in normalized.split() if len(token) >= _MIN_TOKEN_LENGTH and not token.isdigit()}


def names_similar(a: str, b: str) -> bool:
    """Return whether two labels are fuzzily similar enough to be the same (PURE).

    Both inputs are normalized (casefold, accent/punctuation strip, whitespace
    collapse), then judged similar when ANY of:

    * they share a significant word in ANY position (4+ chars, non-numeric) — so a
      brand at the end (``"Sushi Hatsu"`` ~ ``"Hatsu"``) counts, OR
    * one normalized string is a prefix of the other (``"Sushi"`` starts
      ``"Sushiclub"``; ``"Sushiclub"`` starts ``"Sushiclub Recoleta"``), OR
    * the :class:`difflib.SequenceMatcher` ratio clears a high threshold — typo
      tolerance for the same brand misspelled.

    The bar is intentionally lenient (ADR-085): amount-exact + date-window already
    gate every candidate and every flag is reviewed, so a missed duplicate costs
    more than an over-flag dismissed with one click. A one-token brand like
    ``"Sushiclub"`` still won't match ``"Fabric Sushi"`` / ``"Kawaii Sushi"`` (no
    shared word). Two empty/whitespace normalizations are never similar.

    Args:
        a: One label (e.g. the statement merchant text).
        b: The other label (e.g. the user's manual name).

    Returns:
        ``True`` when the labels are similar enough to flag as the same expense.
    """
    norm_a = _normalize(a)
    norm_b = _normalize(b)
    if not norm_a or not norm_b:
        return False

    # 1) Share a significant word in any position ("Sushi Hatsu" ~ "Hatsu").
    if _significant_tokens(norm_a) & _significant_tokens(norm_b):
        return True

    # 2) One name is a prefix of the other ("Sushi" ⊂ "Sushiclub" ⊂ "Sushiclub
    #    Recoleta"); a too-short prefix is ignored.
    shorter, longer = sorted((norm_a, norm_b), key=len)
    if len(shorter) >= _MIN_PREFIX_LENGTH and longer.startswith(shorter):
        return True

    # 3) Typo tolerance: a high ratio catches the same brand misspelled.
    return SequenceMatcher(None, norm_a, norm_b).ratio() >= _SIMILARITY_THRESHOLD


def _is_candidate_for(line: StatementLineDraft, candidate: ReconCandidate, *, window_days: int) -> bool:
    """Return whether a candidate satisfies all three match conditions for a line.

    The date window compares the line's **purchase date** against the candidate's
    ``occurred_on`` — a manual expense is logged at purchase time, not on the
    statement pay date the line now carries in ``occurred_on`` (ADR-089).
    """
    return (
        line.amount == candidate.amount
        and abs((line.purchase_date - candidate.occurred_on).days) <= window_days
        and names_similar(line.name, candidate.name)
    )


def match_lines(
    lines: list[StatementLineDraft],
    candidates: list[ReconCandidate],
    *,
    window_days: int = WINDOW_DAYS,
) -> dict[int, ReconCandidate]:
    """Assign each statement line its best matching manual-expense candidate (PURE).

    For every line, the eligible candidates are those satisfying all three
    conditions (exact ARS amount, date within ``window_days``, fuzzily similar name —
    ADR-085). Assignment is **greedy 1:1**: a candidate is claimed by at most one
    line. Contention is resolved deterministically — lines are processed by smallest
    index, and each line takes the still-unclaimed eligible candidate nearest in date
    (the smallest line index already wins by processing order). Lines with no eligible
    unclaimed candidate are omitted from the result.

    Args:
        lines: The parsed statement line drafts, in display order.
        candidates: The manual-expense candidate pool (kind expense,
            ``statement_document_id`` is ``None`` — ADR-084).
        window_days: The ±N-day date tolerance (defaults to :data:`WINDOW_DAYS`).

    Returns:
        A mapping of matched line index to the claimed :class:`ReconCandidate`;
        unmatched line indices are absent.
    """
    matches: dict[int, ReconCandidate] = {}
    claimed: set[object] = set()

    for index, line in enumerate(lines):
        eligible = [
            candidate
            for candidate in candidates
            if candidate.transaction_id not in claimed and _is_candidate_for(line, candidate, window_days=window_days)
        ]
        if not eligible:
            continue
        best = min(eligible, key=lambda candidate: abs((line.purchase_date - candidate.occurred_on).days))
        matches[index] = best
        claimed.add(best.transaction_id)

    return matches
