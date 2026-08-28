"""Pure, name-tuned fuzzy matcher for receivable income suggestions (ADR-207).

Recording every payback by hand is tedious when the money already exists as an
ordinary ``kind='income'`` transaction (e.g. a friend's Mercado Pago transfer). This
module scores how well a :class:`Person`'s name matches an income transaction's name and
ranks the likely candidates, so the owner can review-then-confirm a suggestion (ADR-207,
mirroring the statement-reconcile UX of ADR-084/086).

It reuses the SHAPE of the statement reconciliation heuristic
(:mod:`margen_api.service_layer.statement_matcher`) — accent/case-fold normalization,
shared-significant-token overlap, whole-string prefix, and a :class:`difflib.SequenceMatcher`
typo-tolerance fallback — but is deliberately **decoupled** from its tuning constants
(ADR-207): human names have different characteristics than merchant labels, so the two
may diverge over time. The key divergence is the token floor: a human first name like
``"Ana"`` or ``"Leo"`` is only three characters, so :data:`_MIN_NAME_TOKEN_LENGTH` is 3
(not the merchant matcher's 4) and short connectors like ``"de"`` / ``"la"`` are still
dropped.

Everything here is PURE and fully unit-testable — no session, no HTTP, no clock. The
owner-scoped reader (``adapters.receivable_matching_queries``) fetches the candidate pool
and the person name, then feeds plain :class:`IncomeMatchCandidate` records in;
:func:`rank_income_matches` returns the scored, ranked suggestions. Matching keys on the
NAME only (ADR-207): the amount is carried through for the review UI but never gates a
suggestion, because a payback amount need not equal any single item — the owner allocates
it across items on confirm (ADR-206).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from difflib import SequenceMatcher
from uuid import UUID

# A token must be at least this many characters AND non-numeric to be "significant" for
# shared-word matching. Tuned DOWN to 3 for human names (the merchant matcher uses 4) so a
# short first name like "Ana" / "Leo" counts, while 1-2 char connectors ("de", "la", "y")
# and bare numbers are still dropped (ADR-207 — decoupled tuning).
_MIN_NAME_TOKEN_LENGTH = 3

# A whole-string prefix must be at least this long to count, so a 1-2 char fragment does
# not prefix-match everything.
_MIN_PREFIX_LENGTH = 3

# The score a whole-string prefix match contributes (e.g. a bank glues the name into one
# token: "Juan" is a prefix of "Juancarlosdelgado"). A prefix is a strong-but-not-certain
# signal, so it sits comfortably above the threshold without claiming a perfect match.
_PREFIX_SCORE = 0.75

# The minimum score a candidate must reach to be SUGGESTED (inclusive). Suggestion-only
# and reviewed by the owner (ADR-207), so the bar favors recall: a shared full name, a
# clean typo, or the person's name embedded in a noisy bank description all clear it, while
# an unrelated label ("Gimnasio Boca") or a mere coincidental substring does not.
_MATCH_THRESHOLD = 0.6

# Non-alphanumeric runs collapse to a single space during normalization.
_NON_ALNUM = re.compile(r"[^0-9a-z]+")


@dataclass(frozen=True, slots=True)
class IncomeMatchCandidate:
    """A ``kind='income'`` transaction a person's payback may correspond to (ADR-207).

    A lightweight, immutable projection of an income transaction carrying only what the
    matcher scores on (``name``) and what the review UI shows (``amount``, ``occurred_on``)
    plus its identity. Built by the reader from persisted rows; the matcher never touches
    persistence. Money is :class:`~decimal.Decimal` (ADR-025).

    Attributes:
        transaction_id: The income transaction's stable identity (ADR-026).
        name: The income transaction's name/description — the string matched against the
            person's name.
        amount: The positive ARS-equivalent magnitude of the income (display only; not a
            gate, ADR-207).
        occurred_on: The date the income was received (drives the recency tiebreak).
    """

    transaction_id: UUID
    name: str
    amount: Decimal
    occurred_on: date


@dataclass(frozen=True, slots=True)
class IncomeMatch:
    """A scored income suggestion for a person (ADR-207).

    Pairs a candidate income with its name-match ``score`` in ``[0.0, 1.0]``. The reader
    returns these ranked best-first; the boundary (task 4) serializes them for the
    review-then-confirm UI.

    Attributes:
        candidate: The income transaction being suggested.
        score: The name-match score in ``[0.0, 1.0]`` — ``1.0`` for an exact
            (accent/case-insensitive) name, grading down through partial and typo matches.
    """

    candidate: IncomeMatchCandidate
    score: float


def _normalize(text: str) -> str:
    """Normalize a name for comparison: casefold, strip accents/punctuation (PURE).

    Decomposes accents (``á`` -> ``a``), lowercases, replaces every non-alphanumeric run
    with a single space, and collapses surrounding whitespace. Deliberately mirrors the
    statement matcher's normalization but is kept independent so the two heuristics can be
    tuned separately (ADR-207).

    Args:
        text: The raw name text.

    Returns:
        The normalized, space-separated lowercase token string (may be empty).
    """
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    lowered = stripped.casefold()
    return _NON_ALNUM.sub(" ", lowered).strip()


def _name_tokens(normalized: str) -> set[str]:
    """Return the significant tokens of a normalized name (PURE).

    A token is significant when it is at least :data:`_MIN_NAME_TOKEN_LENGTH` characters
    and not purely numeric, so short connectors and bare numbers do not create spurious
    overlaps. Position does not matter — the person's name appearing anywhere in a noisy
    bank description ("Pago recibido de Ana") still overlaps.

    Args:
        normalized: A string already run through :func:`_normalize`.

    Returns:
        The set of significant tokens (possibly empty).
    """
    return {token for token in normalized.split() if len(token) >= _MIN_NAME_TOKEN_LENGTH and not token.isdigit()}


def name_match_score(person_name: str, candidate_name: str) -> float:
    """Score how well an income name matches a person's name, in ``[0.0, 1.0]`` (PURE).

    Both inputs are normalized (casefold, accent/punctuation strip, whitespace collapse);
    the score is the strongest of three name-tuned signals (ADR-207):

    * **Exact** — the two normalized names are equal (``"José Pérez"`` ~ ``"jose perez"``):
      score ``1.0``.
    * **Token containment** — the fraction of the SHORTER name's significant tokens that
      also appear in the other, so a clean human name embedded in a noisy bank description
      (``"Ana"`` in ``"Pago recibido de Ana"``) scores ``1.0`` while sharing only one of
      two surnames scores ``0.5``. The person's name is the clean query, so noise on the
      candidate side only matters where it coincides with a real name token.
    * **Prefix** — one normalized name is a prefix of the other (a bank glued the name into
      one token, ``"Juan"`` prefixing ``"Juancarlosdelgado"``): a fixed :data:`_PREFIX_SCORE`.
    * **Typo tolerance** — the :class:`difflib.SequenceMatcher` ratio over the whole
      normalized strings, catching a misspelled name (``"Juan Peraz"`` ~ ``"Juan Perez"``).

    Two empty/whitespace normalizations score ``0.0``. The result is rounded to four
    decimals for stable ranking and serialization.

    Args:
        person_name: The debtor's name the owner typed (the clean query).
        candidate_name: The income transaction's name/description.

    Returns:
        The name-match score in ``[0.0, 1.0]``; ``0.0`` when either name normalizes empty.
    """
    normalized_person = _normalize(person_name)
    normalized_candidate = _normalize(candidate_name)
    if not normalized_person or not normalized_candidate:
        return 0.0
    if normalized_person == normalized_candidate:
        return 1.0

    # Typo tolerance baseline: the whole-string similarity ratio.
    score = SequenceMatcher(None, normalized_person, normalized_candidate).ratio()

    # Token containment: how much of the shorter name's token set the other contains.
    person_tokens = _name_tokens(normalized_person)
    candidate_tokens = _name_tokens(normalized_candidate)
    overlap = person_tokens & candidate_tokens
    if overlap:
        containment = len(overlap) / min(len(person_tokens), len(candidate_tokens))
        score = max(score, containment)

    # Prefix: a name glued into a single token still matches (e.g. "Juan" ⊂ "Juanperez").
    shorter, longer = sorted((normalized_person, normalized_candidate), key=len)
    if len(shorter) >= _MIN_PREFIX_LENGTH and longer.startswith(shorter):
        score = max(score, _PREFIX_SCORE)

    return round(score, 4)


def rank_income_matches(
    person_name: str,
    candidates: list[IncomeMatchCandidate],
    *,
    threshold: float = _MATCH_THRESHOLD,
) -> list[IncomeMatch]:
    """Rank the candidate incomes that plausibly match a person's name (PURE).

    Scores every candidate with :func:`name_match_score`, keeps those at or above
    ``threshold`` (inclusive — the bar favors recall for a reviewed suggestion, ADR-207),
    and returns them best-first. Ties are broken deterministically: higher score first,
    then more recent income (``occurred_on`` descending — a recent transfer is the more
    likely payback), then ascending ``transaction_id`` as a stable final tiebreak.

    Args:
        person_name: The debtor's name to match income names against.
        candidates: The candidate income pool (already owner-scoped and date-windowed and
            with claimed incomes excluded by the reader — ADR-207).
        threshold: The minimum score to suggest (inclusive); defaults to
            :data:`_MATCH_THRESHOLD`.

    Returns:
        The matching incomes as scored :class:`IncomeMatch` records, ranked best-first;
        an empty list when nothing clears the threshold.
    """
    matches = [
        IncomeMatch(candidate=candidate, score=score)
        for candidate in candidates
        if (score := name_match_score(person_name, candidate.name)) >= threshold
    ]
    matches.sort(
        key=lambda match: (
            -match.score,
            -match.candidate.occurred_on.toordinal(),
            str(match.candidate.transaction_id),
        )
    )
    return matches
