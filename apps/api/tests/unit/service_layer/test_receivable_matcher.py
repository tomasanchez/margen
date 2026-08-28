"""Unit tests for the pure, name-tuned receivable income matcher (ADR-207).

These exercise the matcher's PURE surface from plain :class:`IncomeMatchCandidate`
records — no session, no HTTP, no clock. They prove :func:`name_match_score` (exact,
accent/case, shared-token containment, glued-name prefix, typo tolerance, and the clear
non-matches) and :func:`rank_income_matches` (the threshold gate — inclusive at the
boundary — plus the best-first score / recency ordering).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

import pytest

from margen_api.service_layer.receivable_matcher import (
    IncomeMatchCandidate,
    name_match_score,
    rank_income_matches,
)

_BASE_DATE = date(2026, 8, 15)


def _candidate(
    *,
    transaction_id: UUID | None = None,
    name: str = "Juan Perez",
    amount: str = "1000.00",
    occurred_on: date = _BASE_DATE,
) -> IncomeMatchCandidate:
    """Build a plain income match candidate for the matcher."""
    return IncomeMatchCandidate(
        transaction_id=transaction_id if transaction_id is not None else UUID(int=1),
        name=name,
        amount=Decimal(amount),
        occurred_on=occurred_on,
    )


class TestNameMatchScore:
    """name_match_score grades an income name against a person's name in [0, 1]."""

    def test_exact_name_scores_one(self):
        """
        GIVEN an income name identical to the person's name
        WHEN the score is computed
        THEN it is a perfect 1.0
        """
        # WHEN / THEN
        assert name_match_score("Juan", "Juan") == 1.0

    def test_accent_and_case_differences_still_score_one(self):
        """
        GIVEN names differing only by accents and case
        WHEN the score is computed
        THEN normalization makes them an exact 1.0 match
        """
        # WHEN / THEN
        assert name_match_score("José Pérez", "jose perez") == 1.0

    def test_person_name_embedded_in_noisy_description_scores_one(self):
        """
        GIVEN a clean person name that appears inside a noisy bank description
        WHEN the score is computed
        THEN token containment yields a full 1.0 (the whole name is present)
        """
        # WHEN / THEN — "Ana" is a significant 3-char token found in the description.
        assert name_match_score("Ana", "Pago recibido de Ana") == 1.0

    def test_shared_full_name_in_transfer_label_matches(self):
        """
        GIVEN both of the person's name tokens inside a transfer label
        WHEN the score is computed
        THEN it clears the match bar (full containment)
        """
        # WHEN / THEN
        assert name_match_score("Juan Pérez", "Transferencia Juan Perez") == 1.0

    def test_glued_name_prefix_matches(self):
        """
        GIVEN a bank that glued the name into a single longer token
        WHEN the score is computed
        THEN the prefix branch lifts it to the fixed prefix score (0.75)
        """
        # WHEN / THEN — "juan" is a prefix of "juancarlosdelgado"; the ratio alone (~0.38)
        # would miss it, so the prefix signal is what makes it a match.
        assert name_match_score("Juan", "Juancarlosdelgado") == 0.75

    def test_typo_in_name_still_matches(self):
        """
        GIVEN the person's name misspelled by one letter
        WHEN the score is computed
        THEN the SequenceMatcher fallback keeps it above the threshold
        """
        # WHEN / THEN
        assert name_match_score("Juan Perez", "Juan Peraz") >= 0.6

    def test_unrelated_label_does_not_match(self):
        """
        GIVEN an income label unrelated to the person's name
        WHEN the score is computed
        THEN it scores well below the threshold
        """
        # WHEN / THEN
        assert name_match_score("Juan Pérez", "Gimnasio Boca") < 0.6

    def test_coincidental_substring_is_not_a_token_match(self):
        """
        GIVEN a person name that is a mere substring of an unrelated word
        WHEN the score is computed
        THEN tokenization prevents a spurious match ("ana" is not a token of "santana")
        """
        # WHEN / THEN
        assert name_match_score("Ana", "Santana pago") < 0.6

    def test_empty_normalization_scores_zero(self):
        """
        GIVEN a name that normalizes to empty (only punctuation)
        WHEN the score is computed against anything
        THEN it is 0.0 (the empty-norm guard)
        """
        # WHEN / THEN
        assert name_match_score("----", "Juan") == 0.0


class TestRankIncomeMatches:
    """rank_income_matches keeps candidates at/above threshold and ranks them best-first."""

    def test_returns_only_above_threshold_candidates(self):
        """
        GIVEN a mix of matching and unrelated income candidates
        WHEN they are ranked for the person
        THEN only the ones clearing the threshold are returned
        """
        # GIVEN
        match = _candidate(transaction_id=UUID(int=1), name="Juan Perez")
        miss = _candidate(transaction_id=UUID(int=2), name="Gimnasio Boca")

        # WHEN
        ranked = rank_income_matches("Juan Perez", [match, miss])

        # THEN
        assert [income.candidate.transaction_id for income in ranked] == [UUID(int=1)]

    def test_ranks_higher_score_first(self):
        """
        GIVEN an exact-name and a typo-name candidate
        WHEN they are ranked
        THEN the exact (higher score) comes first
        """
        # GIVEN
        exact = _candidate(transaction_id=UUID(int=1), name="Juan Perez")
        typo = _candidate(transaction_id=UUID(int=2), name="Juan Peraz")

        # WHEN
        ranked = rank_income_matches("Juan Perez", [typo, exact])

        # THEN
        assert [income.candidate.transaction_id for income in ranked] == [UUID(int=1), UUID(int=2)]
        assert ranked[0].score > ranked[1].score

    def test_ties_break_by_more_recent_income(self):
        """
        GIVEN two candidates that both score a perfect 1.0
        WHEN they are ranked
        THEN the more recent income (occurred_on descending) comes first
        """
        # GIVEN — both contain "Juan" and score 1.0; only the date differs.
        older = _candidate(transaction_id=UUID(int=1), name="Juan", occurred_on=date(2026, 8, 1))
        newer = _candidate(transaction_id=UUID(int=2), name="Transferencia de Juan", occurred_on=date(2026, 8, 20))

        # WHEN
        ranked = rank_income_matches("Juan", [older, newer])

        # THEN
        assert [income.score for income in ranked] == [1.0, 1.0]
        assert [income.candidate.transaction_id for income in ranked] == [UUID(int=2), UUID(int=1)]

    def test_threshold_is_inclusive_at_the_boundary(self):
        """
        GIVEN a candidate whose score equals exactly the supplied threshold
        WHEN it is ranked with that threshold, then with a hair-higher one
        THEN the equal-score candidate is INCLUDED at the boundary and EXCLUDED just above
        """
        # GIVEN — the glued-prefix candidate scores exactly 0.75 (a stable, exact value).
        boundary = _candidate(transaction_id=UUID(int=1), name="Juancarlosdelgado")

        # WHEN / THEN — inclusive at the boundary, excluded a hair above it.
        assert name_match_score("Juan", boundary.name) == 0.75
        assert rank_income_matches("Juan", [boundary], threshold=0.75) != []
        assert rank_income_matches("Juan", [boundary], threshold=0.7501) == []

    @pytest.mark.parametrize("candidates", [[], [_candidate(name="Gimnasio Boca")]])
    def test_no_matches_returns_empty(self, candidates: list[IncomeMatchCandidate]):
        """
        GIVEN no candidates, or only sub-threshold ones
        WHEN they are ranked
        THEN the result is empty
        """
        # WHEN / THEN
        assert rank_income_matches("Juan Perez", candidates) == []
