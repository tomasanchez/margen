"""Unit tests for the ``Transfer`` aggregate and ``build_transfer`` (ADR-135).

These exercise the domain invariants (source != destination, both legs positive),
the lenient note normalization (blank trimmed to ``None``), the Decimal coercion of
amounts, and the cross-currency allowance (``amount_out`` may differ from
``amount_in``). They use plain Python objects only — no database, no I/O.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.exceptions import InvalidAmountError, SameAccountTransferError
from margen_api.domain.models.transfer import Transfer, build_transfer

A_USER = "00000000-0000-4000-8000-000000000001"
A_FROM = UUID("00000000-0000-4000-8000-0000000000a1")
A_TO = UUID("00000000-0000-4000-8000-0000000000a2")
A_DATE = date(2026, 6, 12)


def _build(**overrides: object) -> Transfer:
    """Build a valid same-currency transfer, letting tests override fields."""
    defaults: dict[str, object] = {
        "from_account_id": A_FROM,
        "to_account_id": A_TO,
        "amount_out": Decimal("1000"),
        "amount_in": Decimal("1000"),
        "occurred_on": A_DATE,
        "user_id": A_USER,
    }
    defaults.update(overrides)
    return build_transfer(**defaults)  # type: ignore[arg-type]


class TestDifferentAccountsInvariant:
    """A transfer must move money between two DIFFERENT accounts (ADR-135)."""

    async def test_same_account_is_rejected(self):
        """
        GIVEN a build request whose source and destination are the same account
        WHEN the transfer is built
        THEN a SameAccountTransferError is raised
        """
        # WHEN / THEN
        with pytest.raises(SameAccountTransferError):
            _build(from_account_id=A_FROM, to_account_id=A_FROM)

    async def test_distinct_accounts_are_accepted(self):
        """
        GIVEN a build request with two distinct accounts
        WHEN the transfer is built
        THEN both ids are carried verbatim
        """
        # WHEN
        transfer = _build()

        # THEN
        assert transfer.from_account_id == A_FROM
        assert transfer.to_account_id == A_TO


class TestAmountInvariants:
    """Both legs are positive money magnitudes; cross-currency legs may differ."""

    @pytest.mark.parametrize("leg", ["amount_out", "amount_in"])
    async def test_non_positive_leg_is_rejected(self, leg: str):
        """
        GIVEN a build request with a zero or negative leg
        WHEN the transfer is built
        THEN an InvalidAmountError is raised (ADR-025)
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError):
            _build(**{leg: Decimal("0")})

    async def test_cross_currency_legs_may_differ(self):
        """
        GIVEN a cross-currency transfer where amount_out != amount_in
        WHEN the transfer is built
        THEN no invariant rejects the difference (ADR-135)
        """
        # WHEN — 100 USD out, 95000 ARS in (the actual amount received).
        transfer = _build(amount_out=Decimal("100"), amount_in=Decimal("95000"))

        # THEN
        assert transfer.amount_out == Decimal("100")
        assert transfer.amount_in == Decimal("95000")

    async def test_non_decimal_legs_are_coerced(self):
        """
        GIVEN a build request whose legs arrive as non-Decimal values
        WHEN the transfer is built
        THEN both legs are normalized to Decimal
        """
        # WHEN
        transfer = _build(amount_out="1500.50", amount_in="1500.50")

        # THEN
        assert transfer.amount_out == Decimal("1500.50")
        assert isinstance(transfer.amount_out, Decimal)
        assert isinstance(transfer.amount_in, Decimal)


class TestNoteNormalization:
    """The optional note is trimmed; a blank note becomes None (ADR-024 style)."""

    async def test_blank_note_becomes_none(self):
        """
        GIVEN a build request with a whitespace-only note
        WHEN the transfer is built
        THEN the note is normalized to None
        """
        # WHEN
        transfer = _build(note="   ")

        # THEN
        assert transfer.note is None

    async def test_note_is_trimmed(self):
        """
        GIVEN a build request with a padded note
        WHEN the transfer is built
        THEN the note is trimmed
        """
        # WHEN
        transfer = _build(note="  monthly top-up  ")

        # THEN
        assert transfer.note == "monthly top-up"


class TestIdentityAndTimestamps:
    """The factory generates identity/timestamps when not injected (ADR-026)."""

    async def test_generates_id_and_timestamps_when_omitted(self):
        """
        GIVEN a build request without an explicit id or timestamps
        WHEN the transfer is built
        THEN a UUID identity and creation/update timestamps are generated
        """
        # WHEN
        transfer = _build()

        # THEN
        assert isinstance(transfer.id, UUID)
        assert isinstance(transfer.created_at, datetime)
        assert isinstance(transfer.updated_at, datetime)

    async def test_injected_identity_and_timestamps_are_preserved(self):
        """
        GIVEN explicit id and timestamps (as the handler injects)
        WHEN the transfer is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        transfer_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        transfer = _build(transfer_id=transfer_id, created_at=moment, updated_at=moment)

        # THEN
        assert transfer.id == transfer_id
        assert transfer.created_at == moment
        assert transfer.updated_at == moment
