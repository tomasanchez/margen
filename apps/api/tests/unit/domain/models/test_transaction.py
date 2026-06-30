"""Unit tests for the ``Transaction`` aggregate and ``build_transaction``.

These exercise the domain invariants (ADR-031), the ``kind`` -> ``type``
derivation and monotributo gating (ADR-027), the lenient FX handling (ADR-029,
ADR-031) and the value-object parsing (ADR-027). They use plain Python objects
only — no database, no I/O.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.exceptions import (
    EmptyNameError,
    InvalidAmountError,
    UnknownCurrencyError,
    UnknownKindError,
)
from margen_api.domain.models.transaction import (
    Transaction,
    build_transaction,
    materialize_usd_amount,
)
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType

A_DATE = date(2026, 6, 12)


def _build(**overrides: object) -> Transaction:
    """Build a valid transaction, letting individual tests override fields."""
    defaults: dict[str, object] = {
        "occurred_on": A_DATE,
        "name": "Coto supermarket",
        "kind": Kind.EXPENSE,
        "amount": Decimal("1500.00"),
    }
    defaults.update(overrides)
    return build_transaction(**defaults)  # type: ignore[arg-type]


class TestAmountInvariant:
    """The ARS-equivalent amount must be a positive magnitude (ADR-031)."""

    async def test_zero_amount_is_rejected(self):
        """
        GIVEN a build request with an amount of zero
        WHEN the transaction is built
        THEN an InvalidAmountError is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError):
            _build(amount=Decimal("0"))

    async def test_negative_amount_is_rejected(self):
        """
        GIVEN a build request with a negative amount
        WHEN the transaction is built
        THEN an InvalidAmountError carrying the offending value is raised
        """
        # WHEN / THEN
        with pytest.raises(InvalidAmountError) as exc_info:
            _build(amount=Decimal("-1"))
        assert exc_info.value.amount == Decimal("-1")

    async def test_non_decimal_amount_is_coerced(self):
        """
        GIVEN a build request whose amount arrives as a non-Decimal value
        WHEN the transaction is built
        THEN the amount is normalized to a Decimal
        """
        # WHEN
        transaction = _build(amount="2500.50")

        # THEN
        assert transaction.amount == Decimal("2500.50")
        assert isinstance(transaction.amount, Decimal)

    async def test_very_large_amount_is_accepted(self):
        """
        GIVEN a build request with a very large amount
        WHEN the transaction is built
        THEN it is accepted with full precision
        """
        # WHEN
        huge = Decimal("9999999999999999.99")
        transaction = _build(amount=huge)

        # THEN
        assert transaction.amount == huge


class TestNameInvariant:
    """The display ``name`` is required and non-empty (ADR-024)."""

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a build request with an empty name
        WHEN the transaction is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name="")

    async def test_whitespace_only_name_is_rejected(self):
        """
        GIVEN a build request whose name is only whitespace
        WHEN the transaction is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name="   ")

    async def test_name_is_trimmed(self):
        """
        GIVEN a build request with surrounding whitespace in the name
        WHEN the transaction is built
        THEN the stored name is trimmed
        """
        # WHEN
        transaction = _build(name="  Apartment rent  ")

        # THEN
        assert transaction.name == "Apartment rent"

    async def test_non_string_name_skips_strip_and_is_rejected(self):
        """
        GIVEN a build request whose name is not a string at all
        WHEN the transaction is built
        THEN the falsy non-string value is treated as empty and rejected
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name=None)


class TestKindToTypeDerivation:
    """``type`` is derived from the persisted ``kind`` (ADR-027)."""

    @pytest.mark.parametrize(
        ("kind", "expected_type"),
        [
            (Kind.EXPENSE, TxType.EXPENSE),
            (Kind.INCOME, TxType.INCOME),
            (Kind.INVOICE, TxType.INCOME),
        ],
    )
    async def test_type_is_derived_from_kind(self, kind: Kind, expected_type: TxType):
        """
        GIVEN a transaction of a given kind
        WHEN its derived type is read
        THEN expense maps to EXPENSE and income/invoice map to INCOME
        """
        # WHEN
        transaction = _build(kind=kind)

        # THEN
        assert transaction.type is expected_type

    async def test_refund_is_modeled_as_income(self):
        """
        GIVEN a refund recorded as positive income
        WHEN the transaction is built
        THEN its direction is INCOME with a positive amount
        """
        # WHEN
        transaction = _build(kind=Kind.INCOME, name="Refund", amount=Decimal("500"))

        # THEN
        assert transaction.type is TxType.INCOME
        assert transaction.amount > Decimal("0")


class TestMonotributoGating:
    """Monotributo counting only applies to income / invoice (ADR-027, ADR-031)."""

    async def test_expense_forces_counts_false(self):
        """
        GIVEN an expense flagged to count toward monotributo
        WHEN the transaction is built
        THEN the flag is forced to False
        """
        # WHEN
        transaction = _build(kind=Kind.EXPENSE, counts_toward_monotributo=True)

        # THEN
        assert transaction.counts_toward_monotributo is False

    @pytest.mark.parametrize("kind", [Kind.INCOME, Kind.INVOICE])
    async def test_income_preserves_counts_flag(self, kind: Kind):
        """
        GIVEN an income or invoice flagged to count toward monotributo
        WHEN the transaction is built
        THEN the flag is preserved
        """
        # WHEN
        transaction = _build(kind=kind, counts_toward_monotributo=True)

        # THEN
        assert transaction.counts_toward_monotributo is True


class TestForeignExchangeHandling:
    """USD rows are lenient; ARS rows drop FX metadata (ADR-029, ADR-031)."""

    async def test_usd_without_rate_is_accepted_as_incomplete(self):
        """
        GIVEN a USD transaction with no FX rate
        WHEN the transaction is built
        THEN it is accepted and has_complete_fx is False
        """
        # WHEN
        transaction = _build(currency=Currency.USD, usd_amount=Decimal("100"))

        # THEN
        assert transaction.has_complete_fx is False
        # The rate family defaults to MEP for USD rows.
        assert transaction.fx_rate_type is FxRateType.MEP

    async def test_usd_with_rate_is_complete(self):
        """
        GIVEN a USD transaction carrying both its USD amount and rate
        WHEN the transaction is built
        THEN has_complete_fx is True
        """
        # WHEN
        transaction = _build(
            currency=Currency.USD,
            usd_amount=Decimal("100"),
            fx_rate=Decimal("1000.50"),
        )

        # THEN
        assert transaction.has_complete_fx is True

    async def test_usd_preserves_explicit_rate_family(self):
        """
        GIVEN a USD transaction with an explicit OFFICIAL rate family
        WHEN the transaction is built
        THEN the chosen family is preserved instead of defaulting to MEP
        """
        # WHEN
        transaction = _build(currency=Currency.USD, fx_rate_type=FxRateType.OFFICIAL)

        # THEN
        assert transaction.fx_rate_type is FxRateType.OFFICIAL

    async def test_ars_row_drops_fx_fields(self):
        """
        GIVEN an ARS transaction carrying FX metadata
        WHEN the transaction is built
        THEN every FX field is dropped to None and has_complete_fx is False
        """
        # WHEN
        transaction = _build(
            currency=Currency.ARS,
            usd_amount=Decimal("100"),
            fx_rate=Decimal("1000"),
            fx_rate_type=FxRateType.MEP,
            fx_rate_as_of=datetime(2026, 6, 12, tzinfo=UTC),
        )

        # THEN
        assert transaction.usd_amount is None
        assert transaction.fx_rate is None
        assert transaction.fx_rate_type is None
        assert transaction.fx_rate_as_of is None
        assert transaction.has_complete_fx is False


class TestFxSnapshotMaterialization:
    """The FX snapshot materializes usd_amount as pure arithmetic (ADR-148, ADR-149)."""

    def test_materialize_usd_amount_rounds_half_up(self):
        """
        GIVEN an ARS amount and an ARS-per-USD rate that does not divide evenly
        WHEN the USD equivalent is materialized
        THEN it is amount ÷ rate rounded HALF_UP to two decimals (ADR-148)
        """
        # 12345 / 1000 = 12.345 -> 12.35 (HALF_UP), not 12.34.
        assert materialize_usd_amount(Decimal("12345"), Decimal("1000")) == Decimal("12.35")

    async def test_snapshot_recomputes_usd_from_amount_and_rate(self):
        """
        GIVEN a USD row with an fx_source snapshot and a positive rate
        WHEN the transaction is built
        THEN usd_amount is re-materialized from amount ÷ rate, ignoring any supplied usd
        """
        # GIVEN — amount 50000 ARS at 1000 ARS/USD with a 'bolsa' snapshot.
        transaction = _build(
            currency=Currency.USD,
            amount=Decimal("50000"),
            usd_amount=Decimal("999"),  # stale client value, must be overwritten
            fx_rate=Decimal("1000"),
            fx_source="bolsa",
        )

        # THEN — the server-computed snapshot wins: 50000 / 1000 = 50.00.
        assert transaction.usd_amount == Decimal("50.00")
        assert transaction.fx_source == "bolsa"
        assert transaction.has_complete_fx is True

    async def test_legacy_usd_without_source_keeps_supplied_amount(self):
        """
        GIVEN a USD row carrying usd + rate but NO fx_source (the legacy ADR-029 flow)
        WHEN the transaction is built
        THEN the supplied usd_amount is preserved (no snapshot recompute)
        """
        # WHEN
        transaction = _build(
            currency=Currency.USD,
            amount=Decimal("50"),
            usd_amount=Decimal("50"),
            fx_rate=Decimal("1000"),
        )

        # THEN — the legacy value stands; the snapshot recompute did not fire.
        assert transaction.usd_amount == Decimal("50")
        assert transaction.fx_source is None

    async def test_non_decimal_rate_is_coerced_before_materializing(self):
        """
        GIVEN a USD snapshot whose fx_rate arrives as a plain int (not a Decimal)
        WHEN the transaction is built
        THEN the rate is coerced to Decimal and usd_amount is materialized from it
        """
        # WHEN — rate supplied as an int 1000, amount 50000 ARS.
        transaction = _build(
            currency=Currency.USD,
            amount=Decimal("50000"),
            fx_rate=1000,  # type: ignore[arg-type]
            fx_source="bolsa",
        )

        # THEN — coerced to Decimal('1000') and materialized: 50000 / 1000 = 50.00.
        assert transaction.fx_rate == Decimal("1000")
        assert transaction.usd_amount == Decimal("50.00")

    async def test_ars_row_drops_fx_source(self):
        """
        GIVEN an ARS transaction carrying an fx_source
        WHEN the transaction is built
        THEN fx_source is dropped to None alongside the rest of the FX block (ADR-029)
        """
        # WHEN
        transaction = _build(currency=Currency.ARS, fx_rate=Decimal("1000"), fx_source="bolsa")

        # THEN
        assert transaction.fx_source is None
        assert transaction.usd_amount is None


class TestUnknownValueObjects:
    """Unknown kind / currency are closed-enum violations (ADR-027)."""

    async def test_unknown_kind_is_rejected(self):
        """
        GIVEN a build request with an unknown kind string
        WHEN the transaction is built
        THEN an UnknownKindError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownKindError):
            _build(kind="transfer")

    async def test_unknown_currency_is_rejected(self):
        """
        GIVEN a build request with an unknown currency string
        WHEN the transaction is built
        THEN an UnknownCurrencyError is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownCurrencyError):
            _build(currency="EUR")

    async def test_kind_parse_accepts_member(self):
        """
        GIVEN an existing Kind member
        WHEN Kind.parse is called with it
        THEN the same member is returned
        """
        # WHEN / THEN
        assert Kind.parse(Kind.INCOME) is Kind.INCOME

    async def test_currency_parse_accepts_string(self):
        """
        GIVEN a known currency string
        WHEN Currency.parse is called with it
        THEN the matching member is returned
        """
        # WHEN / THEN
        assert Currency.parse("USD") is Currency.USD


class TestBuildTransactionDefaults:
    """``build_transaction`` injects identity and timestamps as a convenience."""

    async def test_generates_identity_and_timestamps_when_omitted(self):
        """
        GIVEN a build request without identity or timestamps
        WHEN the transaction is built
        THEN a UUID and created_at/updated_at are generated
        """
        # WHEN
        transaction = _build()

        # THEN
        assert isinstance(transaction.id, UUID)
        assert isinstance(transaction.created_at, datetime)
        assert isinstance(transaction.updated_at, datetime)

    async def test_preserves_supplied_identity_and_timestamps(self):
        """
        GIVEN explicit identity and timestamps (as a handler injects them)
        WHEN the transaction is built
        THEN those exact values are preserved
        """
        # GIVEN
        identity = uuid4()
        created = datetime(2026, 1, 1, tzinfo=UTC)
        updated = datetime(2026, 2, 1, tzinfo=UTC)

        # WHEN
        transaction = _build(transaction_id=identity, created_at=created, updated_at=updated)

        # THEN
        assert transaction.id == identity
        assert transaction.created_at == created
        assert transaction.updated_at == updated

    async def test_string_fx_rate_type_is_resolved(self):
        """
        GIVEN a USD build request whose fx_rate_type arrives as a string
        WHEN the transaction is built
        THEN it is resolved into the FxRateType member
        """
        # WHEN
        transaction = _build(currency=Currency.USD, fx_rate_type="manual")

        # THEN
        assert transaction.fx_rate_type is FxRateType.MANUAL
