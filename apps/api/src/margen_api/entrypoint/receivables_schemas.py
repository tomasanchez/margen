"""Boundary schemas for the receivables REST contract (ADR-204, ADR-206, ADR-207, ADR-130).

These Pydantic models translate the receivables read models and commands to and from the
camelCase JSON the frontend builds to. Money crosses the boundary as a decimal string
exactly as the rest of the app serializes ``Decimal`` (ADR-025, ADR-030), ARS-only for v1.
Requests carry input fields only — ``createdAt`` and every allocation's payment id are
server-managed and never supplied by the caller (ADR-026); the one exception is the optional
client-generated item ``id`` that makes ``POST .../items`` idempotent.

Pinned JSON contract:

* Person (summary) = ``{ id, name, createdAt, outstanding: string, upcomingTotal: string }``
* Person (detail) = the summary plus ``items: ReceivableItem[]``
* ReceivableItem = ``{ id, occurredOn, amount: string, detail: string | null,
  allocated: string, remaining: string, pardoned, dueOutstanding: string,
  upcomingTotal: string, installments: ReceivableInstallment[],
  sourceTransaction: SourceTransaction | null, linkedTotalExceedsExpense: boolean }``
* ReceivableInstallment = ``{ id, index, dueOn, amount: string, paid: string,
  remaining: string, pardoned, status: "due" | "upcoming" | "paid" | "pardoned" }``
* SourceTransaction / ExpenseCandidate = ``{ id, name, occurredOn, amount: string,
  currency, usdAmount: string | null, installmentsIndex, installmentsTotal,
  planTotal: string, linkedItemsTotal: string }``
* ItemCreated (``POST .../items``) = the Person (detail) plus ``createdItemId``
* SuggestedAllocation = ``{ asOf, amount, allocated, unallocated,
  allocations: { itemId, installmentId: string | null, amount }[] }``
* IncomeMatch = ``{ transactionId, name, amount: string, occurredOn, score: number }``

Outstanding figures are as of the request's "today" (ADR-215): ``outstanding`` and
``dueOutstanding`` count only cuotas already due (plus any credit), ``upcomingTotal`` the ones
still ahead (never negative). Every request date is bounded to 2000-01-01..2100-12-31.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Self
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.receivable import (
    MAX_INSTALLMENTS,
    AddReceivableItem,
    AllocationInput,
    CreatePerson,
    EditReceivableInstallment,
    EditReceivableItem,
    InstallmentAdjustmentInput,
    InstallmentPlanInput,
    NewInstallmentPlanInput,
    RecordReceivablePayment,
    RenamePerson,
)
from margen_api.domain.models.receivable_settlement import InstallmentStatus
from margen_api.domain.models.value_objects import Currency, PaymentSource
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.receivable_matcher import IncomeMatch
from margen_api.service_layer.receivable_read_models import (
    ExpenseCandidateReadModel,
    PersonDetailReadModel,
    PersonReadModel,
    ReceivableInstallmentReadModel,
    ReceivableItemReadModel,
    SourceTransactionReadModel,
    SuggestedAllocationReadModel,
)

# Request dates are bounded to a sane window, so a typo such as year 9999 is a 422 at the
# boundary rather than a failure deep in the monthly due-date arithmetic.
EARLIEST_DATE = date(2000, 1, 1)
LATEST_DATE = date(2100, 12, 31)
ReceivableDate = Annotated[date, Field(ge=EARLIEST_DATE, le=LATEST_DATE)]


class ReceivableInstallmentResponse(CamelCaseModel):
    """One cuota of an installment item with its as-of settlement state (ADR-214, ADR-215)."""

    id: UUID = Field(description="The cuota's identity; a payment allocation targets it as installmentId (ADR-221).")
    index: int = Field(description="The cuota's 1-based position in its plan.")
    due_on: date = Field(description="The date the cuota falls due.")
    amount: Decimal = Field(description="The cuota amount in ARS; a decimal string.")
    paid: Decimal = Field(description="The sum allocated to this cuota so far; a decimal string.")
    remaining: Decimal = Field(description="amount - paid; a decimal string, negative once overpaid.")
    pardoned: bool = Field(description="Whether the owner forgave this cuota (ADR-221).")
    status: InstallmentStatus = Field(
        description="As of today: 'pardoned' when forgiven, else 'paid' when nothing remains, else 'due' when "
        "dueOn <= today, else 'upcoming' (ADR-215).",
    )

    @classmethod
    def from_read_model(cls, model: ReceivableInstallmentReadModel) -> ReceivableInstallmentResponse:
        """Build the response from a query-side cuota read model (ADR-030)."""
        return cls(
            id=model.id,
            index=model.index,
            due_on=model.due_on,
            amount=model.amount,
            paid=model.paid,
            remaining=model.remaining,
            pardoned=model.pardoned,
            status=model.status,
        )


class SourceTransactionResponse(CamelCaseModel):
    """The expense a receivable item references — display only, never netted (ADR-217, ADR-219)."""

    id: UUID = Field(description="The expense transaction's identity.")
    name: str = Field(description="The expense's display label.")
    occurred_on: date = Field(description="The date the expense happened.")
    amount: Decimal = Field(description="The expense's positive ARS-equivalent magnitude; a decimal string.")
    currency: Currency = Field(description="The expense's currency (ARS or USD).")
    usd_amount: Decimal | None = Field(default=None, description="The native USD amount of a USD expense, else null.")
    installments_index: int | None = Field(
        default=None,
        description="The expense's card-cuota position (the N of N/M), else null (ADR-174).",
    )
    installments_total: int | None = Field(
        default=None,
        description="The expense's card-cuota plan length (the M of N/M), else null (ADR-174).",
    )
    plan_total: Decimal = Field(
        description="What the expense stands for in full: amount x installmentsTotal for a card cuota, else amount; "
        "the basis linked items are compared against (ADR-218). A decimal string.",
    )
    linked_items_total: Decimal = Field(
        description="Sum of every receivable item (any person) linking this expense; a decimal string (ADR-218).",
    )

    @classmethod
    def from_read_model(cls, model: SourceTransactionReadModel | ExpenseCandidateReadModel) -> Self:
        """Build the response from a linked-expense or expense-candidate read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            occurred_on=model.occurred_on,
            amount=model.amount,
            currency=model.currency,
            usd_amount=model.usd_amount,
            installments_index=model.installments_index,
            installments_total=model.installments_total,
            plan_total=model.plan_total,
            linked_items_total=model.linked_items_total,
        )


class ExpenseCandidateResponse(SourceTransactionResponse):
    """One of the owner's expenses offered by the receivable link picker (ADR-220).

    Same shape as :class:`SourceTransactionResponse`; already-linked expenses are included
    (one expense may back many items, ADR-218) with their ``linkedItemsTotal``.
    """


class ReceivableItemResponse(CamelCaseModel):
    """One itemized debt with its settlement roll-up returned to clients (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    occurred_on: date = Field(description="The calendar date the debt was incurred.")
    amount: Decimal = Field(description="The positive ARS magnitude originally owed; a decimal string (ADR-025).")
    detail: str | None = Field(default=None, description="Optional free-text justification, or null.")
    allocated: Decimal = Field(description="Sum of payment allocations applied to this item so far; a string.")
    remaining: Decimal = Field(
        description="The item's gross remainder (amount - allocated) over all its cuotas, due or not; a string, "
        "may be negative after a confirmed overpayment (ADR-206). For a pardoned item this is the amount covered by "
        "you. What is owed today is dueOutstanding (ADR-215).",
    )
    pardoned: bool = Field(
        description="Whether the owner has forgiven this item (ADR-210). A pardoned item is excluded from the "
        "person's outstanding and cannot be paid, but is shown as covered by you. For an installment item: every "
        "cuota is paid or pardoned and at least one is pardoned (ADR-221).",
    )
    due_outstanding: Decimal = Field(
        description="What the item contributes to the person's outstanding today: the remainder of a non-pardoned "
        "flat item, or the remainders of the due, non-pardoned cuotas of an installment item (ADR-215).",
    )
    upcoming_total: Decimal = Field(
        description="The remainders of the cuotas not yet due (informational, not owed yet); 0 for a flat item.",
    )
    installments: list[ReceivableInstallmentResponse] = Field(
        description="The cuota schedule ordered by index; empty for a flat item (ADR-214).",
    )
    source_transaction: SourceTransactionResponse | None = Field(
        default=None,
        description="The expense this debt came from, or null (ADR-217). Reference only: never netted (ADR-219).",
    )
    linked_total_exceeds_expense: bool = Field(
        description="True when the items linking the same expense add up to more than its planTotal, a "
        "non-blocking over-split warning (ADR-218).",
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
            due_outstanding=model.due_outstanding,
            upcoming_total=model.upcoming_total,
            installments=[ReceivableInstallmentResponse.from_read_model(cuota) for cuota in model.installments],
            source_transaction=(
                SourceTransactionResponse.from_read_model(model.source_transaction)
                if model.source_transaction is not None
                else None
            ),
            linked_total_exceeds_expense=model.linked_total_exceeds_expense,
        )


class PersonSummaryResponse(CamelCaseModel):
    """A person with their overall outstanding total, for the people list (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="The debtor's display label.")
    created_at: datetime = Field(description="Server-managed creation timestamp (drives newest-first ordering).")
    outstanding: Decimal = Field(
        description="What the person owes today: the items' remainders, counting only cuotas already due; a "
        "string, may be negative after a confirmed overpayment (ADR-206, ADR-215).",
    )
    upcoming_total: Decimal = Field(
        description="The person's not-yet-due cuotas — informational, not part of outstanding (ADR-215).",
    )

    @classmethod
    def from_read_model(cls, model: PersonReadModel) -> PersonSummaryResponse:
        """Build the summary from a query-side person read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            created_at=model.created_at,
            outstanding=model.outstanding,
            upcoming_total=model.upcoming_total,
        )


class PersonDetailResponse(CamelCaseModel):
    """A person with their itemized debts and per-item remainders (ADR-204, ADR-206)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="The debtor's display label.")
    created_at: datetime = Field(description="Server-managed creation timestamp.")
    outstanding: Decimal = Field(
        description="What the person owes today — the items' dueOutstanding summed (ADR-206, ADR-215).",
    )
    upcoming_total: Decimal = Field(
        description="The person's not-yet-due cuotas — informational, not part of outstanding (ADR-215).",
    )
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
            upcoming_total=model.upcoming_total,
            items=[ReceivableItemResponse.from_read_model(item) for item in model.items],
        )


class ItemCreatedResponse(PersonDetailResponse):
    """The person's refreshed detail after an item was added, plus that item's id (ADR-204).

    Same shape as :class:`PersonDetailResponse` with ``createdItemId`` added, so the client can
    tell which item it just created — the one it named with ``id``, or the one the server
    generated.
    """

    created_item_id: UUID = Field(description="The id of the item this request created (or replayed).")

    @classmethod
    def from_created(cls, model: PersonDetailReadModel, created_item_id: UUID) -> ItemCreatedResponse:
        """Build the response from the person's detail and the created item's id (ADR-030)."""
        detail = PersonDetailResponse.from_read_model(model)
        return cls(
            id=detail.id,
            name=detail.name,
            created_at=detail.created_at,
            outstanding=detail.outstanding,
            upcoming_total=detail.upcoming_total,
            items=detail.items,
            created_item_id=created_item_id,
        )


class SuggestedAllocationLineResponse(CamelCaseModel):
    """One suggested slice — the same shape a payment's ``allocations`` entry takes (ADR-221)."""

    item_id: UUID = Field(description="The item the slice pays down.")
    installment_id: UUID | None = Field(
        default=None,
        description="The cuota the slice settles on an installment item, else null.",
    )
    amount: Decimal = Field(description="The suggested amount; a decimal string.")


class SuggestedAllocationResponse(CamelCaseModel):
    """The default allocation of a payment over what a person owes today (ADR-221).

    Due cuotas are filled oldest due date first, then open flat items newest first; upcoming
    cuotas are never suggested. ``allocations`` can be posted back as a payment's allocations.
    """

    as_of: date = Field(description="The date due-ness was assessed on (today).")
    amount: Decimal = Field(description="The payment amount that was spread; a decimal string.")
    allocated: Decimal = Field(description="Sum of the suggested slices; a decimal string.")
    unallocated: Decimal = Field(description="What nothing currently due could absorb; a decimal string.")
    allocations: list[SuggestedAllocationLineResponse] = Field(description="The suggested slices, in fill order.")

    @classmethod
    def from_read_model(cls, model: SuggestedAllocationReadModel) -> SuggestedAllocationResponse:
        """Build the response from the query-side suggestion read model (ADR-030)."""
        return cls(
            as_of=model.as_of,
            amount=model.amount,
            allocated=model.allocated,
            unallocated=model.unallocated,
            allocations=[
                SuggestedAllocationLineResponse(
                    item_id=line.item_id,
                    installment_id=line.installment_id,
                    amount=line.amount,
                )
                for line in model.lines
            ],
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


class InstallmentPlanRequest(CamelCaseModel):
    """A cuota plan: ``{ count, firstDueOn }`` (ADR-216).

    The server splits the item amount evenly (rounded to cents, the remainder on the last
    cuota) into ``count`` cuotas due monthly from ``firstDueOn`` (same day of month, clamped
    to the month's end).
    """

    count: int = Field(ge=2, le=MAX_INSTALLMENTS, description="How many cuotas (2 to 120).")
    first_due_on: ReceivableDate = Field(description="The due date of cuota 1; later cuotas fall due monthly.")

    def to_input(self) -> InstallmentPlanInput:
        """Translate the request into the command's nested :class:`InstallmentPlanInput`."""
        return InstallmentPlanInput(count=self.count, first_due_on=self.first_due_on)


class InstallmentAdjustmentRequest(CamelCaseModel):
    """A tweak to one cuota of a new plan: ``{ index, amount?, dueOn? }`` (ADR-216)."""

    index: int = Field(ge=1, description="The 1-based cuota to adjust; must exist in the plan (422 otherwise).")
    amount: Decimal | None = Field(
        default=None,
        gt=Decimal(0),
        description="The cuota's amount instead of its even share; omit to keep it.",
    )
    due_on: ReceivableDate | None = Field(
        default=None,
        description="The cuota's due date instead of the monthly one; omit to keep it.",
    )

    def to_input(self) -> InstallmentAdjustmentInput:
        """Translate the request into the command's nested :class:`InstallmentAdjustmentInput`."""
        return InstallmentAdjustmentInput(index=self.index, amount=self.amount, due_on=self.due_on)


class NewInstallmentPlanRequest(InstallmentPlanRequest):
    """The cuota plan of an item being created: ``{ count, firstDueOn, cuotas? }`` (ADR-216).

    ``cuotas`` tweaks individual cuotas of the even split (each index at most once) in the
    same atomic write that creates the item; the item amount is the resulting cuotas' sum.
    """

    cuotas: list[InstallmentAdjustmentRequest] = Field(
        default_factory=list,
        max_length=MAX_INSTALLMENTS,
        description="Per-cuota tweaks applied on creation; each index within 1..count and at most once (422).",
    )

    def to_input(self) -> NewInstallmentPlanInput:
        """Translate the request into the command's nested :class:`NewInstallmentPlanInput`."""
        return NewInstallmentPlanInput(
            count=self.count,
            first_due_on=self.first_due_on,
            cuotas=tuple(cuota.to_input() for cuota in self.cuotas),
        )


class ReceivableItemCreateRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/items`` (maps to :class:`AddReceivableItem`).

    ``id`` makes the creation idempotent: a retry with the same ``id`` and the same terms
    returns the existing item (no duplicate), while the same ``id`` with different terms — or an
    ``id`` already used by any other item — answers ``409 item_id_conflict``.
    """

    id: UUID | None = Field(
        default=None,
        description="Optional client-generated item id; makes a retried create idempotent (ADR-204).",
    )
    occurred_on: ReceivableDate = Field(description="The calendar date the debt was incurred; backdating allowed.")
    amount: Decimal = Field(
        gt=Decimal(0),
        description="The positive ARS magnitude owed for this item (ADR-025); with installments, the total split "
        "into cuotas.",
    )
    detail: str | None = Field(default=None, description="Optional free-text justification.")
    installments: NewInstallmentPlanRequest | None = Field(
        default=None,
        description="Split the debt into cuotas, optionally tweaking some (ADR-214, ADR-216); omit or null for a "
        "flat item.",
    )
    source_transaction_id: UUID | None = Field(
        default=None,
        description="Optional link to the owner's expense this debt came from (ADR-217); reference only, never "
        "netted (ADR-219). 404 when it is not one of the owner's expenses.",
    )

    def to_command(self, person_id: UUID, user_id: str) -> AddReceivableItem:
        """Translate the request into an :class:`AddReceivableItem` command (ADR-130)."""
        return AddReceivableItem(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            detail=self.detail,
            installments=self.installments.to_input() if self.installments is not None else None,
            source_transaction_id=self.source_transaction_id,
            item_id=self.id,
        )


class ReceivableItemPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /receivables/people/{id}/items/{itemId}`` (maps to :class:`EditReceivableItem`).

    Every field is optional; an omitted field leaves the stored value unchanged (ADR-028).
    ``installments`` and ``sourceTransactionId`` are tri-state: omitted keeps the current
    value, ``null`` removes the plan / the link, a value sets it. Re-shaping a plan (count,
    first due date, or the amount of an installment item, or converting either way) answers
    ``409`` while the item has payments allocated or pardons (ADR-216); re-sending the current
    plan unchanged is a no-op that keeps per-cuota edits.
    """

    occurred_on: ReceivableDate | None = Field(default=None, description="New date the debt was incurred.")
    amount: Decimal | None = Field(
        default=None,
        gt=Decimal(0),
        description="New positive ARS magnitude owed; on an installment item, a new total re-split evenly.",
    )
    detail: str | None = Field(default=None, description="New free-text justification.")
    installments: InstallmentPlanRequest | None = Field(
        default=None,
        description="New cuota plan; null turns the item back into a flat one; omit to keep the current plan.",
    )
    source_transaction_id: UUID | None = Field(
        default=None,
        description="New linked expense; null unlinks; omit to keep the current link (ADR-217).",
    )

    def to_command(self, item_id: UUID, person_id: UUID, user_id: str) -> EditReceivableItem:
        """Translate the patch into an :class:`EditReceivableItem` command (ADR-130).

        An explicit ``null`` for ``installments`` / ``sourceTransactionId`` (present in the
        body, as opposed to omitted) becomes the command's remove / unlink flag.
        """
        sent = self.model_fields_set
        return EditReceivableItem(
            id=item_id,
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            detail=self.detail,
            installments=self.installments.to_input() if self.installments is not None else None,
            remove_installments="installments" in sent and self.installments is None,
            source_transaction_id=self.source_transaction_id,
            unlink_source_transaction="source_transaction_id" in sent and self.source_transaction_id is None,
        )


class ReceivableInstallmentPatchRequest(CamelCaseModel):
    """Request body for ``PATCH .../items/{itemId}/installments/{index}`` (maps to :class:`EditReceivableInstallment`).

    Edits one cuota (e.g. interest or a recargo); the item amount is re-derived as the sum of
    the cuotas (ADR-216). Omitted fields are left unchanged; allowed even after payments, but
    never below what was already paid toward the cuota (``422 installment_amount_below_paid``).
    """

    amount: Decimal | None = Field(
        default=None,
        gt=Decimal(0),
        description="The cuota's new ARS amount; not below what was already paid toward it.",
    )
    due_on: ReceivableDate | None = Field(default=None, description="The cuota's new due date.")

    def to_command(self, item_id: UUID, person_id: UUID, index: int, user_id: str) -> EditReceivableInstallment:
        """Translate the patch into an :class:`EditReceivableInstallment` command (ADR-130)."""
        return EditReceivableInstallment(
            item_id=item_id,
            user_id=user_id,
            person_id=person_id,
            index=index,
            amount=self.amount,
            due_on=self.due_on,
        )


class AllocationRequest(CamelCaseModel):
    """One slice of a payment applied to a specific item — or one of its cuotas (ADR-206, ADR-221)."""

    item_id: UUID = Field(description="The receivable item this slice pays down.")
    installment_id: UUID | None = Field(
        default=None,
        description="The cuota this slice settles: required when the item has installments, must be null/omitted "
        "for a flat item (422 otherwise).",
    )
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude applied to the item (ADR-025).")

    def to_input(self) -> AllocationInput:
        """Translate the request slice into the command's nested :class:`AllocationInput`."""
        return AllocationInput(item_id=self.item_id, installment_id=self.installment_id, amount=self.amount)


class PaymentRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/payments`` (maps to :class:`RecordReceivablePayment`).

    Records a manually entered payback allocated across one or more items. When the
    allocations would drive the person's outstanding balance below zero — or pay one item or
    cuota beyond what it still owes — and ``allowOverpayment`` is not set, the endpoint answers
    ``409`` with a machine-readable body (``receivable_overpayment`` or
    ``allocation_exceeds_target``) so the client can confirm the credit and retry with
    ``allowOverpayment=true`` (ADR-206).
    """

    occurred_on: ReceivableDate = Field(description="The calendar date the payback was received; backdating allowed.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive ARS magnitude received (ADR-025).")
    allocations: list[AllocationRequest] = Field(
        min_length=1,
        description="How the payment is split across the person's items; at least one slice (ADR-206).",
    )
    allow_overpayment: bool = Field(
        default=False,
        description="Set true to confirm a genuine overpayment credit after the 409 warning (ADR-206).",
    )

    def to_command(self, person_id: UUID, user_id: str, as_of: date) -> RecordReceivablePayment:
        """Translate the request into a manual :class:`RecordReceivablePayment` command (ADR-206).

        ``as_of`` is the request's "today", the date the overpayment threshold counts due
        cuotas on (ADR-215).
        """
        return RecordReceivablePayment(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            allocations=tuple(allocation.to_input() for allocation in self.allocations),
            source=PaymentSource.MANUAL,
            matched_income_transaction_id=None,
            allow_overpayment=self.allow_overpayment,
            as_of=as_of,
        )


class ConfirmMatchRequest(CamelCaseModel):
    """Request body for ``POST /receivables/people/{id}/confirm-match`` (maps to :class:`RecordReceivablePayment`).

    Confirms a reviewed fuzzy income match (ADR-207): creates a payback with
    ``source='matched_income'`` linked to the chosen income transaction and allocates it
    across the person's items (ADR-206). Shares the same overpayment contract as a manual
    payment: an unconfirmed overpayment answers ``409`` and the client retries with
    ``allowOverpayment=true``.
    """

    occurred_on: ReceivableDate = Field(description="The calendar date the payback was received.")
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

    def to_command(self, person_id: UUID, user_id: str, as_of: date) -> RecordReceivablePayment:
        """Translate the request into a matched-income :class:`RecordReceivablePayment` command (ADR-207).

        ``as_of`` is the request's "today" for the due-only overpayment threshold (ADR-215).
        """
        return RecordReceivablePayment(
            user_id=user_id,
            person_id=person_id,
            occurred_on=self.occurred_on,
            amount=self.amount,
            allocations=tuple(allocation.to_input() for allocation in self.allocations),
            source=PaymentSource.MATCHED_INCOME,
            matched_income_transaction_id=self.matched_income_transaction_id,
            allow_overpayment=self.allow_overpayment,
            as_of=as_of,
        )
