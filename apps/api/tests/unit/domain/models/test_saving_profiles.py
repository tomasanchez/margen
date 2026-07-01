"""Unit tests for the saving-profile presets + allocation math (ADR-138).

Cover that the three profiles sum to the research's 20 / 30 / 40 to-savings totals,
that ``compute_saving_rows`` applies the percentages to a base, and that ``parse``
is closed.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from margen_api.domain.models.exceptions import UnknownSavingProfileError
from margen_api.domain.models.saving_profiles import (
    MAINTENANCE_RESERVE_PCT,
    PROFILE_BUCKETS,
    SavingProfile,
    compute_saving_rows,
    profile_total_pct,
)
from margen_api.domain.models.value_objects import SAVING_BUCKETS


class TestProfileTotals:
    """Each profile's six investing/goal buckets sum to its headline percentage."""

    @pytest.mark.parametrize(
        ("profile", "expected"),
        [
            (SavingProfile.CONSERVATIVE, 20),
            (SavingProfile.BALANCED, 30),
            (SavingProfile.AGGRESSIVE, 40),
        ],
    )
    def test_profile_buckets_sum_to_headline(self, profile: SavingProfile, expected: int):
        """
        GIVEN a saving profile
        WHEN its profile-bucket percentages are summed
        THEN they total the research's 20 / 30 / 40 (excluding maintenance reserve)
        """
        # WHEN / THEN
        assert profile_total_pct(profile) == expected
        assert sum(PROFILE_BUCKETS[profile].values()) == expected

    def test_every_profile_bucket_is_a_known_saving_bucket(self):
        """
        GIVEN the profile bucket maps
        WHEN their keys are checked against SAVING_BUCKETS
        THEN every key (plus MaintenanceReserve) is a known bucket
        """
        # THEN
        for buckets in PROFILE_BUCKETS.values():
            assert set(buckets) <= SAVING_BUCKETS
        assert "MaintenanceReserve" in SAVING_BUCKETS


class TestComputeSavingRows:
    """``compute_saving_rows`` turns a base + profile into per-bucket amounts."""

    def test_applies_percentages_to_base(self):
        """
        GIVEN a 1,000,000 base and the Balanced profile
        WHEN the saving rows are computed
        THEN each bucket carries the base x its percentage, rounded to cents
        """
        # WHEN
        rows = compute_saving_rows(Decimal("1000000"), SavingProfile.BALANCED)

        # THEN — Balanced: EmergencyFund 7%, FxHedge 3%, MaintenanceReserve 2%.
        assert rows["EmergencyFund"] == Decimal("70000.00")
        assert rows["FxHedge"] == Decimal("30000.00")
        assert rows["MaintenanceReserve"] == Decimal("20000.00")

    def test_includes_maintenance_reserve_separate_from_headline(self):
        """
        GIVEN a base and a profile
        WHEN the rows are computed
        THEN MaintenanceReserve uses the spend-side reserve percentage, not the
             headline total, and the six profile buckets still sum to the headline
        """
        # WHEN
        base = Decimal("500000")
        rows = compute_saving_rows(base, SavingProfile.CONSERVATIVE)

        # THEN — Conservative reserve is 5%.
        assert rows["MaintenanceReserve"] == base * Decimal(MAINTENANCE_RESERVE_PCT[SavingProfile.CONSERVATIVE]) / 100
        headline = sum(rows[bucket] for bucket in PROFILE_BUCKETS[SavingProfile.CONSERVATIVE])
        assert headline == base * Decimal(20) / 100

    def test_zero_base_emits_every_bucket_at_zero(self):
        """
        GIVEN a zero base
        WHEN the rows are computed
        THEN every bucket is present at 0 (so a re-apply overwrites the full set)
        """
        # WHEN
        rows = compute_saving_rows(Decimal("0"), SavingProfile.AGGRESSIVE)

        # THEN
        assert set(rows) == set(PROFILE_BUCKETS[SavingProfile.AGGRESSIVE]) | {"MaintenanceReserve"}
        assert all(amount == Decimal("0.00") for amount in rows.values())


class TestSavingProfileParse:
    """``SavingProfile.parse`` is closed: unknown values raise."""

    def test_parses_a_member_and_a_string(self):
        """
        GIVEN a member and a matching string
        WHEN parsed
        THEN both coerce to the member
        """
        # WHEN / THEN
        assert SavingProfile.parse(SavingProfile.BALANCED) is SavingProfile.BALANCED
        assert SavingProfile.parse("aggressive") is SavingProfile.AGGRESSIVE

    def test_unknown_profile_raises(self):
        """
        GIVEN an out-of-set profile
        WHEN parsed
        THEN UnknownSavingProfileError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownSavingProfileError):
            SavingProfile.parse("reckless")
