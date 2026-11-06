"""Receivables REST entrypoint (ADR-204, ADR-206, ADR-207, ADR-130).

Owner-scoped CRUD over the receivables cluster — people, their itemized debts (flat or split
into cuotas, ADR-214), and the paybacks that settle them — plus the fuzzy income-match
review/confirm flow, the suggested default allocation (ADR-221) and the expense picker behind
the reference-only item → expense link (ADR-217, ADR-220). Writes go through the message bus
as commands; reads use the query-side :class:`AbstractReceivableReader` and
:class:`AbstractReceivableMatchReader` (ADR-028). Outstanding figures are computed as of the
request's ``Today`` dependency so the due/upcoming split is injectable (ADR-215, ADR-223).
Money crosses the boundary as decimal strings inside the ``ResponseModel[T]`` envelope with
camelCase JSON (ADR-030). Domain invariant violations (ADR-031) and the ADR-206 settlement
rules are translated to HTTP here:

- :class:`PersonNotFoundError` / :class:`ReceivableItemNotFoundError` /
  :class:`ReceivableInstallmentNotFoundError` -> ``404 Not Found`` (incl. cross-tenant,
  existence never leaked, ADR-111)
- :class:`MatchedIncomeNotFoundError` -> ``404 Not Found`` (confirm-match links an income
  that is missing, owned by another user, or not ``kind='income'``; ADR-207, ADR-111)
- :class:`SourceTransactionNotFoundError` -> ``404 Not Found`` (an item links an expense that
  is missing, owned by another user, or not ``kind='expense'``; ADR-217, ADR-111)
- :class:`IncomeAlreadyClaimedError` -> ``409 Conflict`` with a machine-readable ``code``
  (confirm-match links an income already settled onto another payment; ADR-207)
- :class:`InstallmentScheduleLockedError` -> ``409 Conflict`` with code
  ``installment_schedule_locked`` (re-shaping a plan that has allocations or pardons; ADR-216)
- :class:`ReceivableItemConflictError` -> ``409 Conflict`` with code ``item_id_conflict`` (a
  client-chosen item id already used with other terms)
- :class:`AllocationExceedsPaymentError` / :class:`InstallmentAllocationTargetError` /
  :class:`InvalidInstallmentScheduleError` / :class:`InvalidAmountError` ->
  ``422 Unprocessable Entity`` (hard invariants)
- :class:`InstallmentAmountBelowPaidError` -> ``422`` with code
  ``installment_amount_below_paid`` (a cuota edited below what was paid toward it)
- :class:`ReceivableOverpaymentError` -> ``409 Conflict`` with a machine-readable body
  ``{code, outstanding, requested}`` so the client can confirm the credit and retry with
  ``allowOverpayment=true`` (the ADR-206 overpayment warning; never a silent clamp)
- :class:`AllocationExceedsTargetError` -> ``409 Conflict`` with code
  ``allocation_exceeds_target`` — the same confirm-and-retry warning for one item or cuota

Item and cuota routes address the item through its person: an item of another person is a
``404``, and every write locks that person first so writes on it are serialized.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Path, Query, Response, status

from margen_api.domain.commands.receivable import (
    DeletePerson,
    DeleteReceivableItem,
    RecordReceivablePayment,
    SetReceivableInstallmentPardon,
    SetReceivableItemPardon,
)
from margen_api.domain.messages import Command
from margen_api.domain.models.exceptions import (
    AllocationExceedsPaymentError,
    AllocationExceedsTargetError,
    IncomeAlreadyClaimedError,
    InstallmentAllocationTargetError,
    InstallmentAmountBelowPaidError,
    InstallmentScheduleLockedError,
    InvalidAmountError,
    InvalidInstallmentScheduleError,
    MatchedIncomeNotFoundError,
    PersonNotFoundError,
    ReceivableInstallmentNotFoundError,
    ReceivableItemConflictError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
    SourceTransactionNotFoundError,
)
from margen_api.entrypoint.dependencies import (
    AuthUser,
    AuthUserModel,
    Bus,
    ReceivableMatchReader,
    ReceivableReader,
    Today,
)
from margen_api.entrypoint.receivables_schemas import (
    ConfirmMatchRequest,
    ExpenseCandidateResponse,
    IncomeMatchResponse,
    ItemCreatedResponse,
    PaymentRequest,
    PersonCreateRequest,
    PersonDetailResponse,
    PersonRenameRequest,
    PersonSummaryResponse,
    ReceivableInstallmentPatchRequest,
    ReceivableItemCreateRequest,
    ReceivableItemPatchRequest,
    SuggestedAllocationResponse,
)
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.receivable_read_models import PersonDetailReadModel
from margen_api.service_layer.receivable_reader import AbstractReceivableReader
from margen_api.service_layer.receivable_statement import build_statement_pdf, normalize_locale, pdf_filename

router = APIRouter(prefix="/receivables", tags=["Receivables"])

# The machine-readable code the client keys the overpayment confirm-warning off (ADR-206).
_OVERPAYMENT_CODE = "receivable_overpayment"

# The machine-readable code distinguishing the claimed-income 409 from the overpayment 409
# so the confirm-match client can tell "already settled elsewhere" apart from "overpaying"
# (ADR-207). Unlike the overpayment warning this is terminal — there is no retry flag.
_INCOME_ALREADY_CLAIMED_CODE = "income_already_claimed"

# The machine-readable code of the 409 refusing to re-shape a cuota plan that has payments
# allocated or pardons (ADR-216); terminal until the allocations/pardons are removed.
_SCHEDULE_LOCKED_CODE = "installment_schedule_locked"

# The machine-readable code of the 409 per-target overpayment warning: one allocation pays an
# item or cuota beyond what it still owes. Confirmable with ``allowOverpayment`` (ADR-206).
_TARGET_OVERRUN_CODE = "allocation_exceeds_target"

# The machine-readable code of the 422 refusing to lower a cuota below what was paid (ADR-216).
_BELOW_PAID_CODE = "installment_amount_below_paid"

# The machine-readable code of the 409 for a client-chosen item id already used otherwise.
_ITEM_ID_CONFLICT_CODE = "item_id_conflict"

# The generated per-person receivable document's content type (ADR-209).
_PDF_MEDIA_TYPE = "application/pdf"

# The verified-JWT claim carrying the user's profile metadata (name, avatar, ...), from which
# the owner's display name is derived for the PDF's covered section (ADR-092, ADR-209).
_USER_METADATA_CLAIM = "user_metadata"

# The expense link picker's page size: 20 by default, never more than 50 (ADR-220).
_DEFAULT_CANDIDATES = 20
_MAX_CANDIDATES = 50

# A cuota's 1-based position, as addressed in the URL (ADR-214).
InstallmentIndex = Annotated[int, Path(ge=1, description="The cuota's 1-based position in its plan.")]


def _owner_display_name(user: AuthUserModel) -> str:
    """Derive the current owner's display name for the covered section (ADR-209 amended).

    The statement is handed to the debtor, so the covered section reads with the OWNER'S name
    rather than an ambiguous "you". This mirrors the web ``AccountMenu`` identity chain: the
    verified JWT's ``user_metadata.full_name``, then ``user_metadata.name``, then the email
    local-part. When none yields a non-empty value the empty string is returned so the PDF
    drops the "by {owner}" suffix gracefully rather than rendering a blank name.

    Args:
        user: The authenticated owner resolved from the verified Supabase JWT (ADR-092).

    Returns:
        The owner's display name, or the empty string when it cannot be derived.
    """
    metadata = user.claims.get(_USER_METADATA_CLAIM)
    if isinstance(metadata, dict):
        for key in ("full_name", "name"):
            candidate = metadata.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    if user.email:
        local_part = user.email.split("@")[0].strip()
        if local_part:
            return local_part
    return ""


def _person_not_found(person_id: UUID) -> HTTPException:
    """Build the 404 raised when no person matches an identity for the owner (ADR-111)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Person {person_id} not found.",
    )


def _item_not_found(item_id: object) -> HTTPException:
    """Build the 404 raised when no receivable item matches an identity for the owner (ADR-111).

    Accepts ``object`` because :class:`ReceivableItemNotFoundError` carries its ``item_id``
    as ``object`` (the record-payment path raises it from an allocation's target id).
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Receivable item {item_id} not found.",
    )


def _installment_not_found(error: ReceivableInstallmentNotFoundError) -> HTTPException:
    """Build the 404 raised when a cuota is not a valid target on the owner's item (ADR-221, ADR-111)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Installment {error.installment} of receivable item {error.item_id} not found.",
    )


def _source_transaction_not_found(transaction_id: object) -> HTTPException:
    """Build the 404 raised when an item links an unusable expense (ADR-217, ADR-111).

    Covers a missing, cross-tenant, or non-``expense`` transaction alike — the message never
    distinguishes them so existence is not leaked (ADR-111).
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Source expense transaction {transaction_id} not found.",
    )


def _schedule_locked_conflict(error: InstallmentScheduleLockedError) -> HTTPException:
    """Build the 409 refusing to re-shape a plan with allocations or pardons (ADR-216).

    The body is machine-readable: ``code`` identifies the conflict and ``reason`` says what
    pins the plan (``allocations`` or ``pardons``), so the client can explain what to undo.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": _SCHEDULE_LOCKED_CODE,
            "itemId": str(error.item_id),
            "reason": error.reason,
        },
    )


def _item_id_conflict(error: ReceivableItemConflictError) -> HTTPException:
    """Build the 409 for a client-chosen item id already used with other terms (ADR-204).

    Never says whose item holds the id (ADR-111); the client should generate a fresh id or
    refetch the person if it was retrying.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": _ITEM_ID_CONFLICT_CODE, "itemId": str(error.item_id)},
    )


def _below_paid(error: InstallmentAmountBelowPaidError) -> HTTPException:
    """Build the 422 refusing to lower a cuota below what was already paid toward it (ADR-216)."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "code": _BELOW_PAID_CODE,
            "itemId": str(error.item_id),
            "index": error.index,
            "paid": str(error.paid),
            "amount": str(error.amount),
        },
    )


def _target_overrun_conflict(error: AllocationExceedsTargetError) -> HTTPException:
    """Build the 409 per-target overpayment warning carrying the confirm-and-retry payload (ADR-206).

    Like the person-level warning it is never a silent clamp: the client shows how much the
    item or cuota still owes and may retry with ``allowOverpayment=true`` to record a credit.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": _TARGET_OVERRUN_CODE,
            "itemId": str(error.item_id),
            "installmentId": str(error.installment_id) if error.installment_id is not None else None,
            "remaining": str(error.remaining),
            "requested": str(error.requested),
        },
    )


def _unprocessable(error: Exception) -> HTTPException:
    """Build the 422 raised for a hard invariant violation, carrying its message (ADR-031)."""
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error))


def _overpayment_conflict(error: ReceivableOverpaymentError) -> HTTPException:
    """Build the 409 overpayment warning carrying the confirm-and-retry payload (ADR-206).

    The body is machine-readable so the web client can recognize the warning (``code``),
    show the outstanding vs. requested figures, and retry with ``allowOverpayment=true``
    rather than the amount being silently clamped or the outstanding driven negative.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": _OVERPAYMENT_CODE,
            "outstanding": str(error.outstanding),
            "requested": str(error.requested),
        },
    )


def _matched_income_not_found(transaction_id: object) -> HTTPException:
    """Build the 404 raised when a confirm-match links an unusable income (ADR-207, ADR-111).

    Covers a missing, cross-tenant, or non-``income`` transaction alike — the message never
    distinguishes them so existence is not leaked (ADR-111).
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Matched income transaction {transaction_id} not found.",
    )


def _income_already_claimed_conflict(error: IncomeAlreadyClaimedError) -> HTTPException:
    """Build the 409 raised when a confirm-match links an already-claimed income (ADR-207).

    The body carries a machine-readable ``code`` so the client can tell this terminal
    conflict apart from the retryable overpayment warning (both are 409s). There is no
    confirm-and-retry path: a claimed income has already settled another debt.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": _INCOME_ALREADY_CLAIMED_CODE,
            "transactionId": str(error.transaction_id),
        },
    )


async def _reload_detail(
    reader: AbstractReceivableReader,
    person_id: UUID,
    user_id: str,
    as_of: date,
) -> PersonDetailReadModel:
    """Re-read a person's detail as of ``as_of`` after a write (ADR-030).

    The person was just verified/created by the handler in the same request, so a missing
    read-back is an unreachable defensive branch (mirrors the debts entrypoint).
    """
    detail = await reader.get_person(person_id, user_id, as_of=as_of)
    if detail is None:  # pragma: no cover - the row was just written in this request
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Person could not be read back.",
        )
    return detail


async def _reload_person(
    reader: AbstractReceivableReader,
    person_id: UUID,
    user_id: str,
    as_of: date,
) -> PersonDetailResponse:
    """Re-read a person's detail as of ``as_of`` after a write and build its response (ADR-030)."""
    return PersonDetailResponse.from_read_model(await _reload_detail(reader, person_id, user_id, as_of))


async def _dispatch_item_write(command: Command, person_id: UUID, *, bus: MessageBus) -> UUID:
    """Dispatch an item/cuota write, translating its domain outcomes to HTTP (ADR-030).

    Shared by every item and cuota write so they surface one HTTP contract: a missing or
    cross-tenant person, item or cuota — or an item of another person — is ``404`` (ADR-111),
    as is an expense link that is not the owner's expense (ADR-217); re-shaping a locked plan
    is a ``409``, as is a client item id already used with other terms (ADR-216, ADR-204); an
    impossible schedule, a non-positive cuota amount, or a cuota lowered below what was paid is
    a ``422``.

    Returns:
        The id of the item the handler wrote (every item and cuota handler returns it).
    """
    try:
        return await bus.handle(command)
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    except ReceivableItemNotFoundError as error:
        raise _item_not_found(error.item_id) from error
    except ReceivableInstallmentNotFoundError as error:
        raise _installment_not_found(error) from error
    except SourceTransactionNotFoundError as error:
        raise _source_transaction_not_found(error.transaction_id) from error
    except InstallmentScheduleLockedError as error:
        raise _schedule_locked_conflict(error) from error
    except ReceivableItemConflictError as error:
        raise _item_id_conflict(error) from error
    except InstallmentAmountBelowPaidError as error:
        raise _below_paid(error) from error
    except (InvalidInstallmentScheduleError, InvalidAmountError) as error:
        raise _unprocessable(error) from error


async def _write_item(
    command: Command,
    person_id: UUID,
    *,
    bus: MessageBus,
    reader: AbstractReceivableReader,
    user_id: str,
    as_of: date,
) -> ResponseModel[PersonDetailResponse]:
    """Dispatch an item/cuota write and return the owning person's refreshed detail (ADR-030).

    See :func:`_dispatch_item_write` for the error contract. On success the person's detail is
    re-read as of today, so the response carries the recomputed outstanding.
    """
    await _dispatch_item_write(command, person_id, bus=bus)
    return ResponseModel(data=await _reload_person(reader, person_id, user_id, as_of))


@router.get(
    "/people",
    name="List people",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonSummaryResponse],
)
async def list_people(reader: ReceivableReader, user: AuthUser, today: Today) -> ResponseModel[PersonSummaryResponse]:
    """List the caller's people with their outstanding and upcoming totals, newest-first (ADR-204, ADR-215)."""
    models = await reader.list_people(user.id, as_of=today)
    return ResponseModel(data=[PersonSummaryResponse.from_read_model(model) for model in models])


@router.post(
    "/people",
    name="Create person",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[PersonDetailResponse],
)
async def create_person(
    body: PersonCreateRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Create a person owned by the caller and return their (empty) detail (ADR-204, ADR-130)."""
    person_id = await bus.handle(body.to_command(user.id))
    return ResponseModel(data=await _reload_person(reader, person_id, user.id, today))


@router.get(
    "/people/{person_id}",
    name="Get person",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def get_person(
    person_id: UUID,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Return one of the caller's people with their itemized debts as of today (ADR-204, ADR-215, ADR-111)."""
    detail = await reader.get_person(person_id, user.id, as_of=today)
    if detail is None:
        raise _person_not_found(person_id)
    return ResponseModel(data=PersonDetailResponse.from_read_model(detail))


@router.get(
    "/people/{person_id}/pdf",
    name="Export person receivable PDF",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={
        status.HTTP_200_OK: {
            "content": {_PDF_MEDIA_TYPE: {}},
            "description": "The person's outstanding-balance statement as a PDF attachment.",
        }
    },
)
async def export_person_pdf(
    person_id: UUID,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
    lang: str = "es",
    full: bool = False,
) -> Response:
    """Download a person's outstanding-balance statement as a PDF (ADR-209/211/212, ADR-111).

    Loads the caller's person detail through the owner-scoped reader (ADR-108/130): a
    missing or cross-tenant id answers ``404`` without leaking existence (ADR-111). It then
    renders the "Estado de cuenta entre amigos" statement (header, red outstanding hero, the
    3-stat bar, the ledger, the optional covered box, footer) from an HTML/CSS Jinja2 template
    rasterized with WeasyPrint (ADR-211) and returns it as an ``application/pdf`` attachment,
    mirroring the CSV export response pattern (ADR-165). The statement is dated, and its
    outstanding assessed, as of the request's ``Today`` (ADR-215).

    By default the ledger is **outstanding-only** (only items still owed, at their remaining
    amount, no payment rows; ADR-212). Passing ``?full=true`` restores the full running-balance
    history (every non-pardoned charge at its gross amount interleaved with payment rows) as
    ADR-211 shipped it. Installment items render one row per cuota in both modes; upcoming
    cuotas never count toward the balance (ADR-222).

    The document follows the app language via the ``lang`` query param (``es`` or ``en``);
    unknown or omitted values normalize to Spanish, the app default (ADR-209/211, ADR-102).
    The footer is signed with the OWNER'S name derived from the auth user (ADR-209 amended);
    the person's name is slugified into the download filename.
    """
    detail = await reader.get_person(person_id, user.id, as_of=today)
    if detail is None:
        raise _person_not_found(person_id)
    pdf_bytes = build_statement_pdf(
        detail,
        owner_name=_owner_display_name(user),
        lang=normalize_locale(lang),
        full_history=full,
        today=today,
    )
    filename = pdf_filename(detail.name)
    return Response(
        content=pdf_bytes,
        media_type=_PDF_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch(
    "/people/{person_id}",
    name="Rename person",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def rename_person(
    person_id: UUID,
    body: PersonRenameRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Rename one of the caller's people and return their detail (ADR-204, ADR-130).

    A missing id OR another user's id surfaces :class:`PersonNotFoundError` mapped to
    ``404`` (existence never leaked, ADR-111).
    """
    try:
        await bus.handle(body.to_command(person_id, user.id))
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user.id, today))


@router.delete(
    "/people/{person_id}",
    name="Delete person",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_person(person_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Delete one of the caller's people, cascading their subtree (ADR-204, ADR-208, ADR-130).

    A missing id or another user's id surfaces a not-found mapped to ``404`` (ADR-111).
    """
    try:
        await bus.handle(DeletePerson(id=person_id, user_id=user.id))
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error


@router.post(
    "/people/{person_id}/items",
    name="Add receivable item",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[ItemCreatedResponse],
)
async def add_item(
    person_id: UUID,
    body: ReceivableItemCreateRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[ItemCreatedResponse]:
    """Add an itemized debt — flat or split into cuotas — to one of the caller's people (ADR-204, ADR-214).

    ``installments: {count, firstDueOn, cuotas?}`` splits the amount evenly into monthly cuotas
    and applies the per-cuota tweaks in the same transaction (ADR-216); ``sourceTransactionId``
    links the expense it came from, reference only (ADR-217, ADR-219). An optional client ``id``
    makes the request idempotent: retrying it with the same terms returns the same item instead
    of a duplicate, other terms answer ``409 item_id_conflict``. A missing or cross-tenant
    ``person_id`` — or a link that is not one of the caller's expenses — answers ``404``
    (ADR-111); an amount too small for the plan or an invalid cuota tweak is a ``422``. Returns
    the person's refreshed detail (items + outstanding as of today) plus ``createdItemId``.
    """
    created_item_id = await _dispatch_item_write(body.to_command(person_id, user.id), person_id, bus=bus)
    detail = await _reload_detail(reader, person_id, user.id, today)
    return ResponseModel(data=ItemCreatedResponse.from_created(detail, created_item_id))


@router.patch(
    "/people/{person_id}/items/{item_id}",
    name="Edit receivable item",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def edit_item(
    person_id: UUID,
    item_id: UUID,
    body: ReceivableItemPatchRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Patch one of the caller's receivable items (ADR-204, ADR-028, ADR-216, ADR-217).

    Omitted fields are left unchanged (ADR-028); ``installments`` / ``sourceTransactionId``
    set to ``null`` remove the plan / the link. Re-shaping the plan of an item with payments
    allocated or pardons answers ``409`` with code ``installment_schedule_locked`` (ADR-216). A
    missing or cross-tenant ``item_id``, or a link that is not one of the caller's expenses,
    answers ``404`` (ADR-111). Returns the owning person's refreshed detail.
    """
    return await _write_item(
        body.to_command(item_id, person_id, user.id),
        person_id,
        bus=bus,
        reader=reader,
        user_id=user.id,
        as_of=today,
    )


@router.patch(
    "/people/{person_id}/items/{item_id}/installments/{index}",
    name="Edit receivable installment",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def edit_installment(
    person_id: UUID,
    item_id: UUID,
    index: InstallmentIndex,
    body: ReceivableInstallmentPatchRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Edit one cuota's amount and/or due date; the item amount becomes the cuotas' sum (ADR-216).

    Allowed even after payments (only the plan's shape is locked). A missing or cross-tenant
    item, or an index the item does not have, answers ``404`` (ADR-111); an amount that rounds
    to zero cents is a ``422``. Returns the owning person's refreshed detail.
    """
    return await _write_item(
        body.to_command(item_id, person_id, index, user.id),
        person_id,
        bus=bus,
        reader=reader,
        user_id=user.id,
        as_of=today,
    )


@router.post(
    "/people/{person_id}/items/{item_id}/installments/{index}/pardon",
    name="Pardon receivable installment",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def pardon_installment(
    person_id: UUID,
    item_id: UUID,
    index: InstallmentIndex,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Forgive a single cuota, dropping it from what is owed (ADR-221, ADR-130).

    Reversible (see :func:`unpardon_installment`). Forgiving the whole remaining plan is
    ``POST .../items/{itemId}/pardon``. A missing or cross-tenant item, or an unknown index,
    answers ``404`` (ADR-111). Returns the owning person's refreshed detail.
    """
    command = SetReceivableInstallmentPardon(
        item_id=item_id, user_id=user.id, person_id=person_id, index=index, pardoned=True
    )
    return await _write_item(command, person_id, bus=bus, reader=reader, user_id=user.id, as_of=today)


@router.post(
    "/people/{person_id}/items/{item_id}/installments/{index}/unpardon",
    name="Un-pardon receivable installment",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def unpardon_installment(
    person_id: UUID,
    item_id: UUID,
    index: InstallmentIndex,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Restore a forgiven cuota into what the person owes (ADR-221, ADR-130).

    The inverse of :func:`pardon_installment`. A missing or cross-tenant item, or an unknown
    index, answers ``404`` (ADR-111). Returns the owning person's refreshed detail.
    """
    command = SetReceivableInstallmentPardon(
        item_id=item_id, user_id=user.id, person_id=person_id, index=index, pardoned=False
    )
    return await _write_item(command, person_id, bus=bus, reader=reader, user_id=user.id, as_of=today)


@router.post(
    "/people/{person_id}/items/{item_id}/pardon",
    name="Pardon receivable item",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def pardon_item(
    person_id: UUID,
    item_id: UUID,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Forgive one of the caller's items, dropping it from what is owed (ADR-210, ADR-221, ADR-130).

    Reversible (see :func:`unpardon_item`) and distinct from delete: the item is kept so it
    can be shown as "covered by you" on the statement. On an installment item this forgives
    the whole remaining plan — every cuota still owing. A missing or cross-tenant ``item_id``
    returns ``404`` (ADR-111). Returns the owning person's refreshed detail with the item now
    flagged ``pardoned`` and excluded from ``outstanding``.
    """
    command = SetReceivableItemPardon(id=item_id, user_id=user.id, person_id=person_id, pardoned=True)
    return await _write_item(command, person_id, bus=bus, reader=reader, user_id=user.id, as_of=today)


@router.post(
    "/people/{person_id}/items/{item_id}/unpardon",
    name="Un-pardon receivable item",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def unpardon_item(
    person_id: UUID,
    item_id: UUID,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Restore a previously pardoned item back into what the person owes (ADR-210, ADR-221, ADR-130).

    The inverse of :func:`pardon_item`: clears the pardon so the item counts toward the
    person's ``outstanding`` again and becomes a valid allocation target once more; on an
    installment item every pardoned cuota is restored. A missing or cross-tenant ``item_id``
    returns ``404`` (ADR-111). Returns the person's refreshed detail.
    """
    command = SetReceivableItemPardon(id=item_id, user_id=user.id, person_id=person_id, pardoned=False)
    return await _write_item(command, person_id, bus=bus, reader=reader, user_id=user.id, as_of=today)


@router.delete(
    "/people/{person_id}/items/{item_id}",
    name="Delete receivable item",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_item(person_id: UUID, item_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Delete one of the caller's receivable items, cascading its allocations (ADR-204, ADR-208).

    A missing or cross-tenant ``person_id`` or ``item_id`` — or an item that belongs to another
    person — surfaces a not-found mapped to ``404`` (ADR-111).
    """
    try:
        await bus.handle(DeleteReceivableItem(id=item_id, user_id=user.id, person_id=person_id))
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    except ReceivableItemNotFoundError as error:
        raise _item_not_found(item_id) from error


async def _record_payment(
    command: RecordReceivablePayment,
    person_id: UUID,
    *,
    bus: MessageBus,
    reader: AbstractReceivableReader,
    user_id: str,
    as_of: date,
) -> ResponseModel[PersonDetailResponse]:
    """Dispatch a payment/confirm-match command and translate the settlement outcomes (ADR-206).

    Shared by the manual-payment and confirm-match endpoints so both surface the exact same
    HTTP contract:

    - :class:`PersonNotFoundError` / :class:`ReceivableItemNotFoundError` /
      :class:`ReceivableInstallmentNotFoundError` -> ``404`` (an allocation to a pardoned item
      or cuota is a not-found too, ADR-210/221).
    - :class:`MatchedIncomeNotFoundError` -> ``404`` (confirm-match only: the linked income is
      missing, cross-tenant, or not a ``kind='income'`` row; existence never leaked, ADR-111).
    - :class:`IncomeAlreadyClaimedError` -> ``409`` with a machine-readable ``code`` (confirm-
      match only: the income already settled another debt; terminal, no retry — ADR-207).
    - :class:`AllocationExceedsPaymentError` -> ``422`` (a hard invariant, never a warning).
    - :class:`InstallmentAllocationTargetError` -> ``422`` (an installment item allocated
      without ``installmentId``, or a flat item with one; ADR-221, ADR-223).
    - :class:`ReceivableOverpaymentError` -> ``409`` with the confirm-and-retry body; the
      threshold counts only cuotas due by the command's ``as_of`` (ADR-215).
    - :class:`AllocationExceedsTargetError` -> ``409`` ``allocation_exceeds_target`` with the
      same confirm-and-retry semantics, for one item or cuota paid beyond what it owes.

    The two confirm-match errors can only arise when the command carries a
    ``matched_income_transaction_id``, so a manual payment never triggers them.

    On success returns the paying person's refreshed detail with updated remainders.
    """
    try:
        await bus.handle(command)
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    except MatchedIncomeNotFoundError as error:
        raise _matched_income_not_found(error.transaction_id) from error
    except IncomeAlreadyClaimedError as error:
        raise _income_already_claimed_conflict(error) from error
    except ReceivableItemNotFoundError as error:
        raise _item_not_found(error.item_id) from error
    except ReceivableInstallmentNotFoundError as error:
        raise _installment_not_found(error) from error
    except (AllocationExceedsPaymentError, InstallmentAllocationTargetError) as error:
        raise _unprocessable(error) from error
    except ReceivableOverpaymentError as error:
        raise _overpayment_conflict(error) from error
    except AllocationExceedsTargetError as error:
        raise _target_overrun_conflict(error) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user_id, as_of))


@router.post(
    "/people/{person_id}/payments",
    name="Record receivable payment",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[PersonDetailResponse],
)
async def record_payment(
    person_id: UUID,
    body: PaymentRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Record a manual payback allocated across the person's items or cuotas (ADR-206, ADR-221).

    Each allocation names ``installmentId`` when its item has installments. See
    :func:`_record_payment` for the full settlement HTTP contract, including the ADR-206
    overpayment ``409`` warning the client confirms and retries with ``allowOverpayment``.
    """
    return await _record_payment(
        body.to_command(person_id, user.id, today),
        person_id,
        bus=bus,
        reader=reader,
        user_id=user.id,
        as_of=today,
    )


@router.get(
    "/people/{person_id}/suggested-allocation",
    name="Suggest payment allocation",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[SuggestedAllocationResponse],
)
async def suggest_allocation(
    person_id: UUID,
    amount: Annotated[Decimal, Query(gt=0, description="The payment amount to spread; a decimal.")],
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[SuggestedAllocationResponse]:
    """Suggest how to allocate a payment over what the person owes today (ADR-221).

    The ADR-221 default: due, unpaid cuotas oldest due date first, then open flat items
    newest first; upcoming cuotas are never suggested and whatever nothing due can absorb is
    returned as ``unallocated``. Read-only — the client prefills its allocation form with it
    and posts the (possibly edited) result as a payment. A missing or cross-tenant person
    answers ``404`` (ADR-111).
    """
    suggestion = await reader.suggest_allocation(person_id, user.id, amount=amount, as_of=today)
    if suggestion is None:
        raise _person_not_found(person_id)
    return ResponseModel(data=SuggestedAllocationResponse.from_read_model(suggestion))


@router.get(
    "/expense-candidates",
    name="Search receivable expense candidates",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[ExpenseCandidateResponse],
)
async def search_expense_candidates(
    reader: ReceivableReader,
    user: AuthUser,
    q: Annotated[
        str | None,
        Query(max_length=200, description="Case-insensitive fragment of the expense name."),
    ] = None,
    date_from: Annotated[
        date | None,
        Query(alias="from", description="Earliest expense date to include (inclusive)."),
    ] = None,
    date_to: Annotated[
        date | None,
        Query(alias="to", description="Latest expense date to include (inclusive)."),
    ] = None,
    limit: Annotated[
        int,
        Query(ge=1, le=_MAX_CANDIDATES, description="How many candidates to return (1-50)."),
    ] = _DEFAULT_CANDIDATES,
) -> ResponseModel[ExpenseCandidateResponse]:
    """Search the caller's expenses a receivable item may link to, newest first (ADR-217, ADR-220).

    Only the caller's own ``kind='expense'`` transactions are returned (ADR-130). Expenses
    that already back other items are included — one expense may be split among several
    people (ADR-218) — each with the ``linkedItemsTotal`` its items already add up to. Purely
    a reference picker: linking never changes balances, budgets or category spend (ADR-219).
    """
    candidates = await reader.search_expense_candidates(
        user.id,
        query=(q or "").strip() or None,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )
    return ResponseModel(data=[ExpenseCandidateResponse.from_read_model(candidate) for candidate in candidates])


@router.get(
    "/people/{person_id}/match-suggestions",
    name="Suggest income matches",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[IncomeMatchResponse],
)
async def suggest_income_matches(
    person_id: UUID,
    reader: ReceivableMatchReader,
    user: AuthUser,
) -> ResponseModel[IncomeMatchResponse]:
    """Rank the caller's unclaimed incomes that plausibly match a person (ADR-207, ADR-130).

    Suggestion-only (ADR-207): the owner reviews the ranked candidates and confirms one via
    ``POST /people/{id}/confirm-match``. An unknown or cross-tenant person yields an empty
    list rather than leaking existence (ADR-111).
    """
    matches = await reader.suggest_income_matches(person_id, user.id)
    return ResponseModel(data=[IncomeMatchResponse.from_match(match) for match in matches])


@router.post(
    "/people/{person_id}/confirm-match",
    name="Confirm income match",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[PersonDetailResponse],
)
async def confirm_income_match(
    person_id: UUID,
    body: ConfirmMatchRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
    today: Today,
) -> ResponseModel[PersonDetailResponse]:
    """Confirm a reviewed income match, creating a matched-income payback (ADR-207, ADR-206).

    Creates a ``source='matched_income'`` payment linked to the chosen income transaction
    and allocates it across the person's items — reusing the same settlement path (and HTTP
    contract) as a manual payment (see :func:`_record_payment`).
    """
    return await _record_payment(
        body.to_command(person_id, user.id, today),
        person_id,
        bus=bus,
        reader=reader,
        user_id=user.id,
        as_of=today,
    )
