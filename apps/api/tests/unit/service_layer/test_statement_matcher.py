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
    currency: Currency = Currency.ARS,
) -> StatementLineDraft:
    """Build a plain statement line draft for the matcher."""
    return StatementLineDraft(
        occurred_on=occurred_on,
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
    """names_similar judges two labels the same expense by token / containment / ratio."""

    def test_shared_significant_token_matches(self):
        """
        GIVEN two labels sharing one significant token
        WHEN names_similar compares them
        THEN they are similar (the token-overlap branch)
        """
        # WHEN / THEN — "sushi" is shared and significant.
        assert names_similar("Sushi dinner", "SUSHI RECOLETA-SUSHI REC") is True

    def test_accent_case_and_punctuation_insensitive(self):
        """
        GIVEN two labels differing only by accents, case and punctuation
        WHEN names_similar compares them
        THEN normalization makes them similar
        """
        # WHEN / THEN
        assert names_similar("Almacén López", "almacen lopez!!!") is True

    def test_containment_matches(self):
        """
        GIVEN one normalized label fully contained in the other
        WHEN names_similar compares them
        THEN they are similar (the containment branch) even without a shared whole token
        """
        # WHEN / THEN — no shared whole token ("uber" != "ubereats"), but one normalized
        # label contains the other, so the containment branch flags them similar.
        assert names_similar("Ubereats", "Uber") is True

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

    def test_high_ratio_without_shared_token_matches(self):
        """
        GIVEN two near-identical labels with no 4+ char shared token but a high ratio
        WHEN names_similar compares them
        THEN the difflib-ratio branch makes them similar
        """
        # WHEN / THEN — a one-character typo; ratio well above the threshold.
        assert names_similar("netfix", "netflx") is True


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
