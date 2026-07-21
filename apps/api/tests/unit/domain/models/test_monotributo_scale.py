"""Unit tests for the effective-dated Monotributo scale registry (ADR-067, ADR-048).

The scale is a versioned, effective-dated registry; these tests pin its shape,
the date-based vintage selection (with the earliest-vintage fallback) and the
pure lookup helpers used by the trailing-12-month reader (ADR-046).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from itertools import pairwise

import pytest

from margen_api.domain.models.monotributo_scale import (
    CURRENT_SCALE_VERSION,
    CURRENT_SCALE_YEAR,
    KNOWN_CATEGORIES,
    MONOTRIBUTO_SCALES,
    MonotributoScaleVersion,
    current_scale,
    get_category,
    get_ceiling,
    next_scale_review,
    scale_for,
    smallest_category_for,
)


class TestScaleShape:
    """Each vintage covers A-K with monotonically-increasing ceilings."""

    @pytest.mark.parametrize("vintage", MONOTRIBUTO_SCALES, ids=[v.version for v in MONOTRIBUTO_SCALES])
    def test_scale_letters_are_a_to_k_in_order(self, vintage: MonotributoScaleVersion) -> None:
        """GIVEN a vintage WHEN listing letters THEN they run A through K in order."""
        # WHEN
        letters = [row.letter for row in vintage.categories]
        # THEN
        assert letters == list("ABCDEFGHIJK")

    @pytest.mark.parametrize("vintage", MONOTRIBUTO_SCALES, ids=[v.version for v in MONOTRIBUTO_SCALES])
    def test_ceilings_strictly_increase(self, vintage: MonotributoScaleVersion) -> None:
        """GIVEN a vintage THEN each ceiling is strictly larger than the previous."""
        ceilings = [row.annual_ceiling for row in vintage.categories]
        assert all(b > a for a, b in pairwise(ceilings))

    def test_registry_is_ordered_by_effective_from(self) -> None:
        """GIVEN the registry THEN vintages are ordered by effective_from ascending."""
        dates = [vintage.effective_from for vintage in MONOTRIBUTO_SCALES]
        assert all(a < b for a, b in pairwise(dates))

    def test_current_markers_track_latest_vintage(self) -> None:
        """GIVEN the module THEN the current markers reflect the latest vintage."""
        latest = MONOTRIBUTO_SCALES[-1]
        assert CURRENT_SCALE_VERSION == latest.version == "2026-08"
        assert CURRENT_SCALE_YEAR == 2026
        assert current_scale() is latest

    def test_known_categories_derived_from_latest(self) -> None:
        """GIVEN the latest vintage THEN KNOWN_CATEGORIES are its A-K letters."""
        assert frozenset("ABCDEFGHIJK") == KNOWN_CATEGORIES


class TestScaleFor:
    """``scale_for`` selects the vintage in effect on a date (ADR-067)."""

    def test_none_returns_latest_vintage(self) -> None:
        """GIVEN no date WHEN selecting THEN the latest vintage returns (clock-free)."""
        assert scale_for(None) is MONOTRIBUTO_SCALES[-1]
        assert scale_for().version == "2026-08"

    def test_date_in_2025_window_returns_2025_vintage(self) -> None:
        """GIVEN a date in the 2025 second-semester window THEN the 2025-08 vintage returns."""
        assert scale_for(date(2025, 9, 1)).version == "2025-08"
        # The day before the next vintage's effective_from still resolves to 2025-08.
        assert scale_for(date(2026, 1, 31)).version == "2025-08"

    def test_date_in_2026_first_semester_returns_2026_02_vintage(self) -> None:
        """GIVEN a Feb-Jul-2026 date THEN the 2026-02 vintage returns (2026-08 not yet effective)."""
        assert scale_for(date(2026, 2, 1)).version == "2026-02"
        assert scale_for(date(2026, 6, 14)).version == "2026-02"
        # Temporal correctness: today (2026-07-21) is before the 2026-08 effective_from,
        # so the live standing + best-category recommendation still resolve to 2026-02.
        assert scale_for(date(2026, 7, 21)).version == "2026-02"
        # The day before the 2026-08 effective_from still resolves to 2026-02.
        assert scale_for(date(2026, 7, 31)).version == "2026-02"

    def test_date_on_or_after_2026_08_effective_from_returns_2026_08_vintage(self) -> None:
        """GIVEN an Aug-2026-or-later date THEN the 2026-08 vintage returns (auto-switch on Aug 1)."""
        assert scale_for(date(2026, 8, 1)).version == "2026-08"
        assert scale_for(date(2026, 9, 15)).version == "2026-08"

    def test_date_before_all_vintages_falls_back_to_earliest(self) -> None:
        """GIVEN a date before every vintage THEN the earliest vintage is the fallback."""
        assert scale_for(date(2024, 1, 1)) is MONOTRIBUTO_SCALES[0]
        assert scale_for(date(2024, 1, 1)).version == "2025-08"


class TestNextScaleReview:
    """``next_scale_review`` returns the next vintage's date, else the review-cadence estimate (ADR-067)."""

    def test_returns_next_vintage_effective_from_when_a_later_vintage_exists(self) -> None:
        """
        GIVEN an as_of resolving to the 2026-02 vintage, with 2026-08 later in the registry
        WHEN the next review is computed
        THEN it is the 2026-08 vintage's effective_from (the exact date the scale changes)
        """
        assert next_scale_review(date(2026, 6, 14)) == date(2026, 8, 1)
        # A 2025-08-window date's next review is the 2026-02 effective_from.
        assert next_scale_review(date(2025, 9, 1)) == date(2026, 2, 1)

    def test_estimates_six_months_when_resolved_vintage_is_latest(self) -> None:
        """
        GIVEN an as_of resolving to the LATEST vintage (2026-08), with no later vintage
        WHEN the next review is computed
        THEN it is the latest vintage's effective_from advanced by the six-month cadence
        """
        # 2026-08-01 + 6 months = 2027-02-01.
        assert next_scale_review(date(2026, 9, 15)) == date(2027, 2, 1)

    def test_none_uses_latest_vintage_and_estimates_six_months(self) -> None:
        """GIVEN no date THEN the latest vintage anchors the six-month estimate (clock-free)."""
        latest = MONOTRIBUTO_SCALES[-1].effective_from
        index = latest.year * 12 + (latest.month - 1) + 6
        year, month = divmod(index, 12)
        assert next_scale_review(None) == date(year, month + 1, latest.day)


class TestGetCategoryAndCeiling:
    """Letter lookups resolve rows and ceilings case-insensitively, honoring as_of."""

    def test_get_category_is_case_insensitive(self) -> None:
        """GIVEN a lowercase letter WHEN looked up THEN the matching row returns."""
        assert get_category("c").letter == "C"

    def test_get_ceiling_matches_latest_row_by_default(self) -> None:
        """GIVEN a letter and no date WHEN fetching its ceiling THEN it is the latest vintage value."""
        assert get_ceiling("A") == MONOTRIBUTO_SCALES[-1].categories[0].annual_ceiling

    def test_get_ceiling_honors_as_of_vintage(self) -> None:
        """GIVEN a past date WHEN fetching a ceiling THEN it is the period's historical value."""
        # 2025-08, 2026-02 (as-of first-semester) and the latest (2026-08) C ceilings.
        assert get_ceiling("C", as_of=date(2025, 9, 1)) == Decimal("18473166.15")
        assert get_ceiling("C", as_of=date(2026, 6, 14)) == Decimal("21113696.52")
        # The 2026-08 vintage is not effective until Aug 1, so as-of today it is 2026-02.
        assert get_ceiling("C", as_of=date(2026, 7, 21)) == Decimal("21113696.52")
        # No as_of resolves to the latest published vintage (2026-08).
        assert get_ceiling("C") == Decimal("24670494.31")
        assert get_ceiling("C", as_of=date(2026, 8, 1)) == Decimal("24670494.31")

    def test_get_category_honors_as_of_vintage(self) -> None:
        """GIVEN a past date WHEN fetching a row THEN its cuotas come from that vintage."""
        row_2025 = get_category("A", as_of=date(2025, 9, 1))
        assert row_2025.cuota_servicios == Decimal("37085.74")
        assert get_category("A", as_of=date(2026, 6, 14)).cuota_servicios == Decimal("42386.74")
        # No as_of resolves to the latest published vintage (2026-08).
        assert get_category("A").cuota_servicios == Decimal("49527.18")

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
        ceiling_b = MONOTRIBUTO_SCALES[-1].categories[1].annual_ceiling
        assert smallest_category_for(ceiling_b) == "B"

    def test_amount_above_all_ceilings_returns_top(self) -> None:
        """GIVEN an amount over every ceiling THEN the top category K returns."""
        over = MONOTRIBUTO_SCALES[-1].categories[-1].annual_ceiling + Decimal("1.00")
        assert smallest_category_for(over) == "K"

    def test_honors_as_of_vintage(self) -> None:
        """GIVEN an amount near a boundary WHEN classified per date THEN the vintage matters."""
        # 14M fits 2025-08 category B (ceiling 13.18M? no -> C 18.47M) but in 2026-02 fits B (15.06M).
        amount = Decimal("14000000.00")
        assert smallest_category_for(amount, as_of=date(2025, 9, 1)) == "C"
        assert smallest_category_for(amount, as_of=date(2026, 6, 14)) == "B"
