"""Unit tests for the settings update handler (ADR-054).

These drive the handler through the in-memory :class:`FakeUnitOfWork` so they run
with no database (ADR-032). They verify the partial-PATCH merge (only the
provided fields change, the rest stay put), the per-field validation (currency,
FX default, category) raising the right domain error, normalization
(trim + upper-case), and that a valid update commits through the unit of work.
"""

from __future__ import annotations

import pytest

from margen_api.domain.commands.settings import UpdateSettings
from margen_api.domain.models.monotributo_scale import UnknownCategoryError
from margen_api.domain.models.settings import (
    UnknownDisplayCurrencyError,
    UnknownFxRateTypeError,
)
from margen_api.service_layer.settings_handlers import update_settings
from tests.fakes.persistence import FakeUnitOfWork

# The owner the per-user settings update is scoped to (ADR-108, ADR-110).
OWNER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


class TestPartialMerge:
    """``update_settings`` merges only the provided fields onto the single row."""

    async def test_single_field_update_leaves_others_unchanged(self):
        """
        GIVEN an existing settings row (USD / official / H / bienes)
        WHEN only the display currency is updated
        THEN that field changes and the other three keep their values, committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        uow.config.update(
            {
                "preferred_display_currency": "USD",
                "fx_default_rate_type": "official",
                "current_category": "H",
                "activity_type": "bienes",
            }
        )

        # WHEN
        result = await update_settings(UpdateSettings(user_id=OWNER, preferred_display_currency="ARS"), uow)

        # THEN — only the currency changed; the merge committed through the unit of work.
        assert result.preferred_display_currency == "ARS"
        assert result.fx_default_rate_type == "official"
        assert result.monotributo_current_category == "H"
        assert result.monotributo_activity_type == "bienes"
        assert uow.committed is True

    async def test_all_fields_update(self):
        """GIVEN a full body WHEN updated THEN all four fields are applied."""
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        result = await update_settings(
            UpdateSettings(
                user_id=OWNER,
                preferred_display_currency="USD",
                fx_default_rate_type="official",
                monotributo_current_category="K",
                monotributo_activity_type="bienes",
                monotributo_enabled=True,
            ),
            uow,
        )

        # THEN
        assert result.preferred_display_currency == "USD"
        assert result.fx_default_rate_type == "official"
        assert result.monotributo_current_category == "K"
        assert result.monotributo_activity_type == "bienes"
        assert result.monotributo_enabled is True

    async def test_toggles_monotributo_enabled_without_validation(self):
        """
        GIVEN an empty unit of work
        WHEN only ``monotributo_enabled`` is set
        THEN the boolean flag is applied (no validation) and the write commits (ADR-126)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        result = await update_settings(UpdateSettings(user_id=OWNER, monotributo_enabled=True), uow)

        # THEN
        assert result.monotributo_enabled is True
        assert uow.committed is True

    async def test_empty_update_returns_defaults_and_commits(self):
        """
        GIVEN no settings row and an empty command
        WHEN the handler runs
        THEN the documented defaults are returned and the (no-op) write still commits
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        result = await update_settings(UpdateSettings(user_id=OWNER), uow)

        # THEN — defaults from the fake's single-row store.
        assert result.preferred_display_currency == "ARS"
        assert result.fx_default_rate_type == "MEP"
        assert result.monotributo_current_category == "C"
        assert result.monotributo_activity_type == "services"
        # New users default to the Monotributo module OFF (ADR-126).
        assert result.monotributo_enabled is False
        assert uow.committed is True


class TestNormalization:
    """Provided values are trimmed and case-normalized before validation."""

    async def test_currency_and_category_are_trimmed_and_upcased(self):
        """GIVEN lower-case, padded values WHEN updated THEN they are normalized."""
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        result = await update_settings(
            UpdateSettings(
                user_id=OWNER,
                preferred_display_currency="  usd  ",
                monotributo_current_category=" h ",
                monotributo_activity_type="  bienes  ",
            ),
            uow,
        )

        # THEN
        assert result.preferred_display_currency == "USD"
        assert result.monotributo_current_category == "H"
        assert result.monotributo_activity_type == "bienes"


class TestValidation:
    """Each provided field is validated against its bounded domain set."""

    async def test_unknown_currency_raises(self):
        """GIVEN an unknown currency WHEN updated THEN the currency error is raised, no commit."""
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(UnknownDisplayCurrencyError):
            await update_settings(UpdateSettings(user_id=OWNER, preferred_display_currency="EUR"), uow)
        assert uow.committed is False

    async def test_unknown_fx_default_raises(self):
        """GIVEN an unknown FX default WHEN updated THEN the FX error is raised, no commit."""
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(UnknownFxRateTypeError):
            await update_settings(UpdateSettings(user_id=OWNER, fx_default_rate_type="manual"), uow)
        assert uow.committed is False

    async def test_unknown_category_raises(self):
        """GIVEN an out-of-scale category WHEN updated THEN the category error is raised."""
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(UnknownCategoryError):
            await update_settings(UpdateSettings(user_id=OWNER, monotributo_current_category="Z"), uow)
        assert uow.committed is False
