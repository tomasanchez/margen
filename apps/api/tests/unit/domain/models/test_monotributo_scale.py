"""Unit tests for the Monotributo scale constants and helpers (ADR-048).

The scale is a versioned constant; these tests pin its shape and the pure
lookup/projection helpers used by the trailing-12-month reader (ADR-046).
"""

from __future__ import annotations

from decimal import Decimal
from itertools import pairwise

import pytest

from margen_api.domain.models.monotributo_scale import (
    MONOTRIBUTO_SCALE,
    SCALE_VERSION,
    SCALE_YEAR,
    get_category,
    get_ceiling,
    smallest_category_for,
)


class TestScaleShape:
    """The scale covers A-K with monotonically-increasing ceilings."""

    def test_scale_letters_are_a_to_k_in_order(self) -> None:
        """GIVEN the scale WHEN listing letters THEN they run A through K in order."""
        # WHEN
        letters = [row.letter for row in MONOTRIBUTO_SCALE]
        # THEN
        assert letters == list("ABCDEFGHIJK")

    def test_ceilings_strictly_increase(self) -> None:
        """GIVEN the scale THEN each ceiling is strictly larger than the previous."""
        ceilings = [row.annual_ceiling for row in MONOTRIBUTO_SCALE]
        assert all(b > a for a, b in pairwise(ceilings))

    def test_version_markers_are_present(self) -> None:
        """GIVEN the module THEN the vintage markers are populated."""
        assert SCALE_YEAR == 2026
        assert SCALE_VERSION.startswith("2026")


class TestGetCategoryAndCeiling:
    """Letter lookups resolve rows and ceilings case-insensitively."""

    def test_get_category_is_case_insensitive(self) -> None:
        """GIVEN a lowercase letter WHEN looked up THEN the matching row returns."""
        assert get_category("c").letter == "C"

    def test_get_ceiling_matches_row(self) -> None:
        """GIVEN a letter WHEN fetching its ceiling THEN it matches the row value."""
        assert get_ceiling("A") == MONOTRIBUTO_SCALE[0].annual_ceiling

    def test_unknown_letter_raises(self) -> None:
        """GIVEN an unknown letter WHEN looked up THEN KeyError is raised."""
        with pytest.raises(KeyError):
            get_category("Z")


class TestSmallestCategoryFor:
    """``smallest_category_for`` picks the first covering band, else the top."""

    def test_amount_below_first_ceiling_returns_a(self) -> None:
        """GIVEN a tiny amount WHEN classified THEN the smallest category A returns."""
        assert smallest_category_for(Decimal("1.00")) == "A"

    def test_amount_at_ceiling_boundary_is_inclusive(self) -> None:
        """GIVEN an amount equal to a ceiling THEN that same category is chosen."""
        ceiling_b = MONOTRIBUTO_SCALE[1].annual_ceiling
        assert smallest_category_for(ceiling_b) == "B"

    def test_amount_above_all_ceilings_returns_top(self) -> None:
        """GIVEN an amount over every ceiling THEN the top category K returns."""
        over = MONOTRIBUTO_SCALE[-1].annual_ceiling + Decimal("1.00")
        assert smallest_category_for(over) == "K"
