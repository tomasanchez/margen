"""Unit tests for the pure per-line statement reconciliation matcher (ADR-084, ADR-085).

These exercise the matcher's PURE surface from plain :class:`StatementLineDraft`
objects and :class:`ReconCandidate` records — no session, no HTTP, no clock
(ADR-085). They prove :func:`names_similar` (shared significant token, accent /
case / punctuation insensitivity, containment, the unrelated and short/numeric
non-matches) and :func:`match_lines` (the three-condition gate, the ±N-day date
window, and the deterministic greedy 1:1 assignment).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.statement_matcher import (
    WINDOW_DAYS,
    ReconCandidate,
    match_lines,
    names_similar,
)
from margen_api.service_layer.statement_parser_read_models import LineKind, StatementLineDraft

# A reference date the line/candidate dates orbit so date-window edges are exact.
_BASE_DATE = date(2026, 5, 8)


def _line(
    *,
    name: str = "Express Av Cordoba 3721",
    amount: str = "10180.00",
    occurred_on: date = _BASE_DATE,
    purchase_date: date | None = None,
    currency: Currency = Currency.ARS,
) -> StatementLineDraft:
    """Build a plain statement line draft for the matcher.

    The matcher's date window is on the purchase date (ADR-089). By default
    ``purchase_date`` mirrors ``occurred_on`` so the existing scenarios drive on the
    intended date; pass ``purchase_date`` explicitly to decouple the FECHA from the
    statement pay date and prove which one the window keys on.
    """
    return StatementLineDraft(
        occurred_on=occurred_on,
        purchase_date=purchase_date if purchase_date is not None else occurred_on,
        name=name,
        amount=Decimal(amount),
        currency=currency,
        line_kind=LineKind.PURCHASE,
    )


def _candidate(
    *,
    transaction_id: object = "tx-1",
    name: str = "Express Cordoba",
    amount: str = "10180.00",
    occurred_on: date = _BASE_DATE,
    currency: str = "ARS",
    category: str | None = None,
    payment_method: str | None = None,
) -> ReconCandidate:
    """Build a reconciliation candidate for the matcher."""
    return ReconCandidate(
        transaction_id=transaction_id,
        occurred_on=occurred_on,
        name=name,
        amount=Decimal(amount),
        currency=currency,
        category=category,
        payment_method=payment_method,
    )


class TestNamesSimilar:
    """names_similar judges two labels the same expense by shared word / prefix / ratio."""

    def test_shared_significant_word_matches(self):
        """
        GIVEN two labels that share a significant word
        WHEN names_similar compares them
        THEN they are similar (the shared-word branch)
        """
        # WHEN / THEN — both contain "sushi".
        assert names_similar("Sushi dinner", "SUSHI RECOLETA-SUSHI REC") is True

    @pytest.mark.parametrize(
        ("a", "b"),
        [
            ("Sushi Hatsu", "Hatsu"),  # brand at the END is matched (lenient).
            ("Sushi Hatsu", "Sushi Pop"),  # only generic "sushi" shared — accepted
            ("Kawaii Sushi", "Fabric Sushi"),  # over-flag (amount+date gate; 1-click dismiss).
        ],
    )
    def test_lenient_shared_word_in_any_position(self, a: str, b: str):
        """
        GIVEN labels sharing a significant word anywhere in the name
        WHEN names_similar compares them
        THEN they are similar (lenient — recall over precision, ADR-085)
        """
        # WHEN / THEN — a shared 4+ word in any position is enough; amount+date still
        # gate every candidate and the user reviews each flag.
        assert names_similar(a, b) is True

    @pytest.mark.parametrize(
        ("statement_name", "expected"),
        [
            ("Sushiclub Recoleta", True),  # same leading brand token.
            ("Sushi", True),  # prefix of "sushiclub".
            ("Fabric Sushi", False),  # only the generic word "sushi" is shared.
            ("Kawaii Sushi", False),  # only the generic word "sushi" is shared.
        ],
    )
    def test_brand_prefix_examples(self, statement_name: str, expected: bool):
        """
        GIVEN a manual label "Sushiclub" and various statement merchant labels
        WHEN names_similar compares them
        THEN only the same-brand / prefix cases match, not a shared generic word
        """
        # WHEN / THEN
        assert names_similar("Sushiclub", statement_name) is expected

    def test_accent_case_and_punctuation_insensitive(self):
        """
        GIVEN two labels differing only by accents, case and punctuation
        WHEN names_similar compares them
        THEN normalization makes them similar
        """
        # WHEN / THEN
        assert names_similar("Almacén López", "almacen lopez!!!") is True

    def test_prefix_matches(self):
        """
        GIVEN one normalized label that is a prefix of the other
        WHEN names_similar compares them
        THEN they are similar (the prefix branch) even without an equal leading token
        """
        # WHEN / THEN — leading tokens differ ("uber" != "ubereats"), but "uber" is a
        # prefix of "ubereats", so the prefix branch flags them similar.
        assert names_similar("Ubereats", "Uber") is True

    def test_too_short_prefix_does_not_match(self):
        """
        GIVEN a label too short to anchor a leading token or a prefix
        WHEN names_similar compares it to a longer label it starts
        THEN it is NOT similar (the prefix floor rejects a 2-char overlap)
        """
        # WHEN / THEN — "ab" has no 4+ leading token and is below the prefix floor.
        assert names_similar("Ab", "Abcdef") is False

    def test_unrelated_names_do_not_match(self):
        """
        GIVEN two unrelated labels
        WHEN names_similar compares them
        THEN they are not similar
        """
        # WHEN / THEN
        assert names_similar("Sushi dinner", "Gym membership") is False

    def test_short_and_numeric_only_tokens_do_not_force_a_match(self):
        """
        GIVEN labels whose only overlap is short connectors or bare numbers
        WHEN names_similar compares them
        THEN the insignificant overlap does not make them similar
        """
        # WHEN / THEN — "de"/"sa" too short, "5771" purely numeric: no significant overlap.
        assert names_similar("Pago de SA 5771", "Cobro de SA 5771 distinto rubro xyz") is False

    def test_empty_normalization_is_never_similar(self):
        """
        GIVEN a label that normalizes to empty (only punctuation)
        WHEN names_similar compares it to anything
        THEN it is not similar (the empty-norm guard)
        """
        # WHEN / THEN
        assert names_similar("---", "Anything") is False

    def test_high_ratio_typo_matches(self):
        """
        GIVEN the same brand with a transposed-letter typo (no equal token, no prefix)
        WHEN names_similar compares them
        THEN the high-ratio fallback makes them similar
        """
        # WHEN / THEN — "sushiclbu" is "sushiclub" with the last two letters swapped;
        # the ratio (~0.89) clears the high threshold while different brands do not.
        assert names_similar("Sushiclub", "Sushiclbu") is True


class TestMatchLines:
    """match_lines assigns each line its best candidate under the three-condition gate."""

    def test_exact_amount_required(self):
        """
        GIVEN a candidate one cent off the line amount
        WHEN match_lines runs
        THEN no match is produced (amount must be exact)
        """
        # GIVEN
        lines = [_line(amount="10180.00")]
        candidates = [_candidate(amount="10180.01")]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN
        assert matches == {}

    def test_date_inside_window_matches(self):
        """
        GIVEN a candidate exactly WINDOW_DAYS away from the line date
        WHEN match_lines runs
        THEN it matches (the window is inclusive)
        """
        # GIVEN
        from datetime import timedelta

        lines = [_line(occurred_on=_BASE_DATE)]
        candidates = [_candidate(occurred_on=_BASE_DATE + timedelta(days=WINDOW_DAYS))]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN
        assert matches[0].transaction_id == "tx-1"

    def test_date_outside_window_does_not_match(self):
        """
        GIVEN a candidate one day past the window
        WHEN match_lines runs
        THEN no match is produced
        """
        # GIVEN
        from datetime import timedelta

        lines = [_line(occurred_on=_BASE_DATE)]
        candidates = [_candidate(occurred_on=_BASE_DATE + timedelta(days=WINDOW_DAYS + 1))]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN
        assert matches == {}

    def test_dissimilar_name_does_not_match_even_when_amount_and_date_align(self):
        """
        GIVEN a candidate with the exact amount and date but an unrelated name
        WHEN match_lines runs
        THEN no match is produced (all three conditions are required)
        """
        # GIVEN
        lines = [_line(name="Express Av Cordoba 3721")]
        candidates = [_candidate(name="Gym membership")]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN
        assert matches == {}

    def test_empty_candidates_returns_empty(self):
        """
        GIVEN no candidates
        WHEN match_lines runs
        THEN the result is empty
        """
        # WHEN / THEN
        assert match_lines([_line()], []) == {}

    def test_nearest_date_wins_among_multiple_candidates(self):
        """
        GIVEN two eligible candidates at different date distances
        WHEN match_lines runs
        THEN the line takes the nearer-date candidate
        """
        # GIVEN
        from datetime import timedelta

        lines = [_line(occurred_on=_BASE_DATE)]
        far = _candidate(transaction_id="tx-far", occurred_on=_BASE_DATE + timedelta(days=3))
        near = _candidate(transaction_id="tx-near", occurred_on=_BASE_DATE + timedelta(days=1))
        candidates = [far, near]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN
        assert matches[0].transaction_id == "tx-near"

    def test_greedy_one_to_one_a_candidate_is_claimed_once(self):
        """
        GIVEN two lines eligible for the SAME single candidate
        WHEN match_lines runs
        THEN only the nearer-date line claims it; the other line goes unmatched
        """
        # GIVEN — the candidate sits on 2026-05-08; the first line is one day off,
        # the second is exactly on the date (nearer). The single candidate may be
        # claimed once, and ties are broken by nearest date.
        from datetime import timedelta

        far_line = _line(occurred_on=_BASE_DATE - timedelta(days=2))
        near_line = _line(occurred_on=_BASE_DATE)
        candidates = [_candidate(transaction_id="tx-only", occurred_on=_BASE_DATE)]

        # WHEN — far_line is processed first (index 0) and claims the candidate by
        # processing order; near_line then finds nothing unclaimed.
        matches = match_lines([far_line, near_line], candidates)

        # THEN — exactly one line matched, the candidate claimed once.
        assert list(matches) == [0]
        assert matches[0].transaction_id == "tx-only"

    def test_each_line_takes_a_distinct_candidate(self):
        """
        GIVEN two lines and two eligible candidates
        WHEN match_lines runs
        THEN each line claims its own candidate (no double-claim)
        """
        # GIVEN
        lines = [_line(name="Express Cordoba"), _line(name="Express Cordoba")]
        candidates = [
            _candidate(transaction_id="tx-a", occurred_on=_BASE_DATE),
            _candidate(transaction_id="tx-b", occurred_on=_BASE_DATE),
        ]

        # WHEN
        matches = match_lines(lines, candidates)

        # THEN — both matched, to distinct candidates.
        assert set(matches) == {0, 1}
        assert {matches[0].transaction_id, matches[1].transaction_id} == {"tx-a", "tx-b"}

    def test_window_keys_on_purchase_date_not_pay_date(self):
        """
        GIVEN a line whose pay date (occurred_on) is far from the candidate but whose
              purchase date (FECHA) is inside the ±N-day window
        WHEN match_lines runs
        THEN it matches — the window keys on purchase_date, not occurred_on (ADR-089)
        """
        # GIVEN — the candidate (a manual expense) sits on the FECHA; the line's
        # occurred_on is the statement pay date, weeks later and well outside the window.
        from datetime import timedelta

        line = _line(
            occurred_on=_BASE_DATE + timedelta(days=40),  # the statement pay date, far away.
            purchase_date=_BASE_DATE + timedelta(days=1),  # the FECHA, inside the window.
        )
        candidates = [_candidate(occurred_on=_BASE_DATE)]

        # WHEN
        matches = match_lines([line], candidates)

        # THEN — matched on the purchase date despite the far pay date.
        assert matches[0].transaction_id == "tx-1"

    def test_pay_date_inside_window_does_not_match_when_purchase_date_is_outside(self):
        """
        GIVEN a line whose pay date (occurred_on) is near the candidate but whose
              purchase date (FECHA) is outside the ±N-day window
        WHEN match_lines runs
        THEN no match is produced — the near pay date is ignored (ADR-089)
        """
        # GIVEN — the line's occurred_on lands on the candidate date, but its FECHA is
        # a day past the window, so the pay-date proximity must NOT rescue the match.
        from datetime import timedelta

        line = _line(
            occurred_on=_BASE_DATE,  # the statement pay date, on the candidate.
            purchase_date=_BASE_DATE + timedelta(days=WINDOW_DAYS + 1),  # the FECHA, out of window.
        )
        candidates = [_candidate(occurred_on=_BASE_DATE)]

        # WHEN
        matches = match_lines([line], candidates)

        # THEN — the out-of-window purchase date governs, so nothing matches.
        assert matches == {}

    @pytest.mark.parametrize("window", [0, 5])
    def test_window_days_override_is_honored(self, window: int):
        """
        GIVEN a candidate three days from the line
        WHEN match_lines runs with a tighter (0) then wider (5) window
        THEN the override decides eligibility
        """
        # GIVEN
        from datetime import timedelta

        lines = [_line(occurred_on=_BASE_DATE)]
        candidates = [_candidate(occurred_on=_BASE_DATE + timedelta(days=3))]

        # WHEN
        matches = match_lines(lines, candidates, window_days=window)

        # THEN — out of a 0-day window, inside a 5-day window.
        assert (0 in matches) is (window == 5)
