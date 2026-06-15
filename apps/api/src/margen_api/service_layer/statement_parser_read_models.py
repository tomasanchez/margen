"""Read models for the credit-card statement parser (ADR-076, ADR-079).

Purpose-built, immutable DTOs describing the result of parsing a credit-card
statement PDF: the overall parse outcome (:class:`ParsedStatement` with a
:class:`ParseStatus`), the natural identity of the statement
(:class:`StatementNaturalKey`), and the per-line drafts the review UI edits
before import (:class:`StatementLineDraft`).

These mirror the invoice parser's read models (``invoice_parser_read_models``)
and stay deliberately separate from the transaction write aggregate so the import
side evolves independently (AGENTS.md: reader ports + read models). Money is
carried as :class:`~decimal.Decimal` (ADR-025). Unlike the ARCA invoice 1:1
relationship, one statement yields many line drafts (ADR-077).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum

from margen_api.domain.models.value_objects import Currency, FxRateType


class ParseStatus(StrEnum):
    """Outcome of parsing a credit-card statement PDF (ADR-076).

    Attributes:
        OK: A bank parser matched and extracted at least one line item.
        UNSUPPORTED: No bank parser fingerprint matched the document, so manual
            entry remains the fallback (ADR-080); not an error.
        UNPARSEABLE: A bank parser matched but yielded nothing extractable.
    """

    OK = "ok"
    UNSUPPORTED = "unsupported"
    UNPARSEABLE = "unparseable"


class LineKind(StrEnum):
    """Internal classification of a parsed statement line (ADR-079).

    Used by the parser to net fee/waiver pairs separately from purchases; it is
    not a transaction ``kind`` — every imported line is an EXPENSE (ADR-079).

    Attributes:
        PURCHASE: A merchant purchase from the DETALLE DEL CONSUMO section.
        FEE: A bank fee/interest charge (e.g. ``COM MANT``) kept with its sign so
            waivers can net it to zero before emission.
    """

    PURCHASE = "purchase"
    FEE = "fee"


@dataclass(frozen=True, slots=True)
class StatementNaturalKey:
    """The natural identity of a credit-card statement (ADR-077).

    The tuple ``(issuer_cuit, card_last4, statement_number)`` identifies a
    statement and backs the advisory dedupe check at the import step.

    Attributes:
        issuer_cuit: Issuing bank CUIT (e.g. ``30-50000173-5`` for Galicia).
        card_last4: Last four digits of the card.
        statement_number: The statement's printed number (``Resumen N°``).
    """

    issuer_cuit: str | None
    card_last4: str | None
    statement_number: str | None


@dataclass(slots=True)
class StatementLineDraft:
    """One editable line item from a parsed statement (ADR-079).

    Each line maps to one EXPENSE transaction on import. ``amount`` is the
    positive ARS (PESOS) figure (ADR-025); for a USD-denominated line the FX block
    follows ADR-044/045 and ``amount`` may be left for the review UI to confirm.
    ``include`` lets the user deselect a line before import. Not frozen because the
    review UI / boundary may toggle ``include`` and edit fields.

    Attributes:
        occurred_on: The statement pay/due date — the date the charge is debited and
            the date the imported expense counts on (ADR-089). Falls back to the
            line's own ``purchase_date`` when the statement carries no parseable due
            date.
        purchase_date: The original purchase date as printed (the line's FECHA). Kept
            distinct from ``occurred_on`` so reconciliation can match on it and the
            import can preserve it in the transaction notes (ADR-089).
        name: The merchant / reference text as printed on the statement.
        amount: Positive ARS (PESOS) amount.
        currency: ``ARS`` or ``USD``.
        usd_amount: The stated dollar figure for a USD line, else ``None``.
        fx_rate: The stated cotización for a USD line when present, else ``None``.
        fx_rate_type: ``OFFICIAL`` when a rate is stated, else ``None`` (left for
            manual confirmation in the review UI — ADR-079).
        category: A keyword-guessed category, or ``None`` when no guess applies.
        cuota: The installment marker such as ``"3/3"``, else ``None``.
        line_kind: Internal classification (purchase vs fee) — not a transaction
            ``kind``; every emitted line is an EXPENSE (ADR-079).
        include: Whether the line is selected for import (default ``True``).
    """

    occurred_on: date
    purchase_date: date
    name: str
    amount: Decimal
    currency: Currency
    line_kind: LineKind
    usd_amount: Decimal | None = None
    fx_rate: Decimal | None = None
    fx_rate_type: FxRateType | None = None
    category: str | None = None
    cuota: str | None = None
    include: bool = True


@dataclass(frozen=True, slots=True)
class ParsedStatement:
    """The structured result of parsing one credit-card statement PDF (ADR-076).

    Carries the detected bank identity, the editable line drafts, the computed
    natural key, and the statement-level metadata the import path stores on the
    ``statement_document`` row (ADR-077). On an unsupported issuer or an
    unparseable match the line list is empty and ``status`` reflects the outcome —
    a calm result, never an error (ADR-080).

    Attributes:
        status: The parse outcome (:class:`ParseStatus`).
        bank_name: The issuing bank name (e.g. ``"Galicia"``), or ``None``.
        network: The card network (e.g. ``"VISA"``), or ``None``.
        card_last4: Last four digits of the card, or ``None``.
        payment_method: The composed bank/network/last4 label (e.g.
            ``"Galicia VISA ·5771"``), or ``None``.
        statement_number: The statement's printed number, or ``None``.
        issuer_cuit: Issuing bank CUIT, or ``None``.
        period_close: The current-statement closing date, or ``None``.
        period_due: The current-statement due date, or ``None``.
        total_amount: The pesos ``TOTAL A PAGAR`` figure, or ``None``.
        natural_key: The statement identity when derivable, or ``None``.
        lines: The editable per-line drafts (empty when none were extracted).
        extracted_text: The concatenated PDF text (best effort; may be empty).
    """

    status: ParseStatus
    extracted_text: str
    bank_name: str | None = None
    network: str | None = None
    card_last4: str | None = None
    payment_method: str | None = None
    statement_number: str | None = None
    issuer_cuit: str | None = None
    period_close: date | None = None
    period_due: date | None = None
    total_amount: Decimal | None = None
    natural_key: StatementNaturalKey | None = None
    lines: list[StatementLineDraft] = field(default_factory=list)
