"""Boundary schemas for the receivables REST contract (ADR-204, ADR-206, ADR-207, ADR-130).

These Pydantic models translate the receivables read models and commands to and from the
camelCase JSON the frontend builds to. Money crosses the boundary as a decimal string
exactly as the rest of the app serializes ``Decimal`` (ADR-025, ADR-030), ARS-only for v1.
Requests carry input fields only — ``id``, ``createdAt`` and every allocation's payment id
are server-managed and never supplied by the caller (ADR-026).

Pinned JSON contract:

* Person (summary) = ``{ id, name, createdAt, outstanding: string }``
* Person (detail) = the summary plus ``items: ReceivableItem[]``
* ReceivableItem = ``{ id, occurredOn, amount: string, detail: string | null,
  allocated: string, remaining: string }``
* IncomeMatch = ``{ transactionId, name, amount: string, occurredOn, score: number }``
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
    CreatePerson,
    EditReceivableItem,
    RecordReceivablePayment,
    RenamePerson,
)
from margen_api.domain.models.value_objects import PaymentSource
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.receivable_matcher import IncomeMatch
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    PersonReadModel,
    ReceivableItemReadModel,
)


class ReceivableItemResponse(CamelCaseModel):
    """One itemized debt with its settlement roll-up returned to clients (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    occurred_on: date = Field(description="The calendar date the debt was incurred.")
    amount: Decimal = Field(description="The positive ARS magnitude originally owed; a decimal string (ADR-025).")
    detail: str | None = Field(default=None, description="Optional free-text justification, or null.")
    allocated: Decimal = Field(description="Sum of payment allocations applied to this item so far; a string.")
    remaining: Decimal = Field(
        description="The item's outstanding remainder (amount - allocated); a string, may be negative "
        "after a confirmed overpayment (ADR-206). For a pardoned item this is the amount covered by you.",
    )
    pardoned: bool = Field(
        description="Whether the owner has forgiven this item (ADR-210). A pardoned item is excluded from the "
        "person's outstanding and cannot be paid, but is shown as covered by you.",
    )

    @classmethod
    def from_read_model(cls, model: ReceivableItemReadModel) -> ReceivableItemResponse:
        """Build the response from a query-side item read model (ADR-030)."""
        return cls(
            id=model.id,
            occurred_on=model.occurred_on,
            amount=model.amount,
            detail=model.detail,
            allocated=model.allocated,
            remaining=model.remaining,
            pardoned=model.pardoned,
        )


class PersonSummaryResponse(CamelCaseModel):
    """A person with their overall outstanding total, for the people list (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="The debtor's display label.")
    created_at: datetime = Field(description="Server-managed creation timestamp (drives newest-first ordering).")
    outstanding: Decimal = Field(
        description="Sum of the person's item remainders — money still owed overall; a string, may be negative "
        "after a confirmed overpayment (ADR-206).",
    )

    @classmethod
    def from_read_model(cls, model: PersonReadModel) -> PersonSummaryResponse:
        """Build the summary from a query-side person read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            created_at=model.created_at,
            outstanding=model.outstanding,
        )


class PersonDetailResponse(CamelCaseModel):
    """A person with their itemized debts and per-item remainders (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="The debtor's display label.")
    created_at: datetime = Field(description="Server-managed creation timestamp.")
    outstanding: Decimal = Field(description="Sum of the items' remainders — the person's overall outstanding.")
    items: list[ReceivableItemResponse] = Field(
        description="The person's itemized debts with their settlement roll-ups, newest-first by occurredOn.",
    )

    @classmethod
    def from_read_model(cls, model: PersonDetailReadModel) -> PersonDetailResponse:
        """Build the detail from a query-side person-detail read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            created_at=model.created_at,
            outstanding=model.outstanding,
            items=[ReceivableItemResponse.from_read_model(item) for item in model.items],
        )


class IncomeMatchResponse(CamelCaseModel):
    """A scored income suggestion for a person, for review-then-confirm (ADR-207)."""

    transaction_id: UUID = Field(description="The candidate income transaction's stable identity.")
    name: str = Field(description="The income transaction's name/description matched against the person.")
    amount: Decimal = Field(description="The positive ARS magnitude of the income; a decimal string (display only).")
    occurred_on: date = Field(description="The date the income was received.")
    score: float = Field(description="The name-match score in [0.0, 1.0]; higher is a better match.")

    @classmethod
    def from_match(cls, match: IncomeMatch) -> IncomeMatchResponse:
        """Build the response from a scored :class:`IncomeMatch` (ADR-207)."""
        return cls(
            transaction_id=match.candidate.transaction_id,
            name=match.candidate.name,
            amount=match.candidate.amount,
            occurred_on=match.candidate.occurred_on,
            score=match.score,
        )


class PersonCreateRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people`` (maps to :class:`CreatePerson`)."""

    name: str = Field(min_length=1, description="Required human display label for the debtor.")

    def to_command(self, user_id: str) -> CreatePerson:
        """Translate the request into a :class:`CreatePerson` command (ADR-130)."""
        return CreatePerson(user_id=user_id, name=self.name)


class PersonRenameRequest(CamelCaseModel):
    """Request body for ``PATCH /receivables/people/{id}`` (maps to :class:`RenamePerson`)."""

    name: str = Field(min_length=1, description="The new display label for the debtor.")

    def to_command(self, person_id: UUID, user_id: str) -> RenamePerson:
        """Translate the request into a :class:`RenamePerson` command (ADR-130)."""
        return RenamePerson(id=person_id, user_id=user_id, name=self.name)


class ReceivableItemCreateRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/items`` (maps to :class:`AddReceivableItem`)."""

    occurred_on: date = Field(description="The calendar date the debt was incurred; backdating allowed.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude owed for this item (ADR-025).")
    detail: str | None = Field(default=None, description="Optional free-text justification.")

    def to_command(self, person_id: UUID, user_id: str) -> AddReceivableItem:
        """Translate the request into an :class:`AddReceivableItem` command (ADR-130)."""
        return AddReceivableItem(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            detail=self.detail,
        )


class ReceivableItemPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /receivables/people/{id}/items/{itemId}`` (maps to :class:`EditReceivableItem`).

    Every field is optional; an omitted field leaves the stored value unchanged (ADR-028).
    """

    occurred_on: date | None = Field(default=None, description="New date the debt was incurred.")
    amount: Decimal | None = Field(default=None, gt=Decimal(0), description="New positive ARS magnitude owed.")
    detail: str | None = Field(default=None, description="New free-text justification.")

    def to_command(self, item_id: UUID, user_id: str) -> EditReceivableItem:
        """Translate the patch into an :class:`EditReceivableItem` command (ADR-130)."""
        return EditReceivableItem(
            id=item_id,
            user_id=user_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            detail=self.detail,
        )


class AllocationRequest(CamelCaseModel):
    """One slice of a payment applied to a specific item (ADR-206)."""

    item_id: UUID = Field(description="The receivable item this slice pays down.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude applied to the item (ADR-025).")

    def to_input(self) -> AllocationInput:
        """Translate the request slice into the command's nested :class:`AllocationInput`."""
        return AllocationInput(item_id=self.item_id, amount=self.amount)


class PaymentRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/payments`` (maps to :class:`RecordReceivablePayment`).

    Records a manually entered payback allocated across one or more items. When the
    allocations would drive the person's outstanding balance below zero and
    ``allowOverpayment`` is not set, the endpoint answers ``409`` with a machine-readable
    overpayment body so the client can confirm the credit and retry with
    ``allowOverpayment=true`` (ADR-206).
    """

    occurred_on: date = Field(description="The calendar date the payback was received; backdating allowed.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude received (ADR-025).")
    allocations: list[AllocationRequest] = Field(
        min_length=1,
        description="How the payment is split across the person's items; at least one slice (ADR-206).",
    )
    allow_overpayment: bool = Field(
        default=False,
        description="Set true to confirm a genuine overpayment credit after the 409 warning (ADR-206).",
    )

    def to_command(self, person_id: UUID, user_id: str) -> RecordReceivablePayment:
        """Translate the request into a manual :class:`RecordReceivablePayment` command (ADR-206)."""
        return RecordReceivablePayment(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            allocations=tuple(allocation.to_input() for allocation in self.allocations),
            source=PaymentSource.MANUAL,
            matched_income_transaction_id=None,
            allow_overpayment=self.allow_overpayment,
        )


class ConfirmMatchRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/confirm-match`` (maps to :class:`RecordReceivablePayment`).

    Confirms a reviewed fuzzy income match (ADR-207): creates a payback with
    ``source='matched_income'`` linked to the chosen income transaction and allocates it
    across the person's items (ADR-206). Shares the same overpayment contract as a manual
    payment: an unconfirmed overpayment answers ``409`` and the client retries with
    ``allowOverpayment=true``.
    """

    occurred_on: date = Field(description="The calendar date the payback was received.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude received (ADR-025).")
    matched_income_transaction_id: UUID = Field(description="The confirmed income transaction this payback links to.")
    allocations: list[AllocationRequest] = Field(
        min_length=1,
        description="How the payment is split across the person's items; at least one slice (ADR-206).",
    )
    allow_overpayment: bool = Field(
        default=False,
        description="Set true to confirm a genuine overpayment credit after the 409 warning (ADR-206).",
    )

    def to_command(self, person_id: UUID, user_id: str) -> RecordReceivablePayment:
        """Translate the request into a matched-income :class:`RecordReceivablePayment` command (ADR-207)."""
        return RecordReceivablePayment(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            allocations=tuple(allocation.to_input() for allocation in self.allocations),
            source=PaymentSource.MATCHED_INCOME,
            matched_income_transaction_id=self.matched_income_transaction_id,
            allow_overpayment=self.allow_overpayment,
        )
