"""Receivables REST entrypoint (ADR-204, ADR-206, ADR-207, ADR-130).

Owner-scoped CRUD over the receivables cluster — people, their itemized debts, and the
paybacks that settle them — plus the fuzzy income-match review/confirm flow. Writes go
through the message bus as commands; reads use the query-side
:class:`AbstractReceivableReader` and :class:`AbstractReceivableMatchReader` (ADR-028).
Money crosses the boundary as decimal strings inside the ``ResponseModel[T]`` envelope with
camelCase JSON (ADR-030). Domain invariant violations (ADR-031) and the ADR-206 settlement
rules are translated to HTTP here:

- :class:`PersonNotFoundError` / :class:`ReceivableItemNotFoundError` -> ``404 Not Found``
  (incl. cross-tenant, existence never leaked, ADR-111)
- :class:`MatchedIncomeNotFoundError` -> ``404 Not Found`` (confirm-match links an income
  that is missing, owned by another user, or not ``kind='income'``; ADR-207, ADR-111)
- :class:`IncomeAlreadyClaimedError` -> ``409 Conflict`` with a machine-readable ``code``
  (confirm-match links an income already settled onto another payment; ADR-207)
- :class:`AllocationExceedsPaymentError` -> ``422 Unprocessable Entity`` (a hard invariant:
  a payment may not allocate more than it received)
- :class:`ReceivableOverpaymentError` -> ``409 Conflict`` with a machine-readable body
  ``{code, outstanding, requested}`` so the client can confirm the credit and retry with
  ``allowOverpayment=true`` (the ADR-206 overpayment warning; never a silent clamp)
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status

from margen_api.domain.commands.receivable import (
    DeletePerson,
    DeleteReceivableItem,
    RecordReceivablePayment,
)
from margen_api.domain.models.exceptions import (
    AllocationExceedsPaymentError,
    IncomeAlreadyClaimedError,
    MatchedIncomeNotFoundError,
    PersonNotFoundError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
)
from margen_api.entrypoint.dependencies import (
    AuthUser,
    Bus,
    ReceivableMatchReader,
    ReceivableReader,
)
from margen_api.entrypoint.receivables_schemas import (
    ConfirmMatchRequest,
    IncomeMatchResponse,
    PaymentRequest,
    PersonCreateRequest,
    PersonDetailResponse,
    PersonRenameRequest,
    PersonSummaryResponse,
    ReceivableItemCreateRequest,
    ReceivableItemPatchRequest,
)
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.service_layer.receivable_pdf import build_person_pdf, pdf_filename
from margen_api.service_layer.receivable_reader import AbstractReceivableReader

router = APIRouter(prefix="/receivables", tags=["Receivables"])

# The machine-readable code the client keys the overpayment confirm-warning off (ADR-206).
_OVERPAYMENT_CODE = "receivable_overpayment"

# The machine-readable code distinguishing the claimed-income 409 from the overpayment 409
# so the confirm-match client can tell "already settled elsewhere" apart from "overpaying"
# (ADR-207). Unlike the overpayment warning this is terminal — there is no retry flag.
_INCOME_ALREADY_CLAIMED_CODE = "income_already_claimed"

# The generated per-person receivable document's content type (ADR-209).
_PDF_MEDIA_TYPE = "application/pdf"


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


async def _reload_person(reader: AbstractReceivableReader, person_id: UUID, user_id: str) -> PersonDetailResponse:
    """Re-read a person's detail after a write and build its response (ADR-030).

    The person was just verified/created by the handler in the same request, so a missing
    read-back is an unreachable defensive branch (mirrors the debts entrypoint).
    """
    detail = await reader.get_person(person_id, user_id)
    if detail is None:  # pragma: no cover - the row was just written in this request
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Person could not be read back.",
        )
    return PersonDetailResponse.from_read_model(detail)


@router.get(
    "/people",
    name="List people",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonSummaryResponse],
)
async def list_people(reader: ReceivableReader, user: AuthUser) -> ResponseModel[PersonSummaryResponse]:
    """List the caller's people with their outstanding totals, newest-first (ADR-204, ADR-130)."""
    models = await reader.list_people(user.id)
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
) -> ResponseModel[PersonDetailResponse]:
    """Create a person owned by the caller and return their (empty) detail (ADR-204, ADR-130)."""
    person_id = await bus.handle(body.to_command(user.id))
    return ResponseModel(data=await _reload_person(reader, person_id, user.id))


@router.get(
    "/people/{person_id}",
    name="Get person",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[PersonDetailResponse],
)
async def get_person(person_id: UUID, reader: ReceivableReader, user: AuthUser) -> ResponseModel[PersonDetailResponse]:
    """Return one of the caller's people with their itemized debts (ADR-204, ADR-206, ADR-111)."""
    detail = await reader.get_person(person_id, user.id)
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
async def export_person_pdf(person_id: UUID, reader: ReceivableReader, user: AuthUser) -> Response:
    """Download a person's outstanding-balance statement as a PDF (ADR-209, ADR-111).

    Loads the caller's person detail through the owner-scoped reader (ADR-108/130) — a
    missing or cross-tenant id answers ``404`` without leaking existence (ADR-111) — then
    renders the deliberate English (en-US) document (name, total outstanding, itemized
    outstanding entries) server-side with PyMuPDF and returns it as an
    ``application/pdf`` attachment, mirroring the CSV export response pattern (ADR-165).
    The debtor name is slugified into the download filename.
    """
    detail = await reader.get_person(person_id, user.id)
    if detail is None:
        raise _person_not_found(person_id)
    pdf_bytes = build_person_pdf(detail)
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
) -> ResponseModel[PersonDetailResponse]:
    """Rename one of the caller's people and return their detail (ADR-204, ADR-130).

    A missing id OR another user's id surfaces :class:`PersonNotFoundError` mapped to
    ``404`` (existence never leaked, ADR-111).
    """
    try:
        await bus.handle(body.to_command(person_id, user.id))
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user.id))


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
    response_model=ResponseModel[PersonDetailResponse],
)
async def add_item(
    person_id: UUID,
    body: ReceivableItemCreateRequest,
    bus: Bus,
    reader: ReceivableReader,
    user: AuthUser,
) -> ResponseModel[PersonDetailResponse]:
    """Add an itemized debt to one of the caller's people (ADR-204, ADR-130).

    A missing or cross-tenant ``person_id`` surfaces :class:`PersonNotFoundError` mapped to
    ``404`` (ADR-111). Returns the person's refreshed detail (items + outstanding).
    """
    try:
        await bus.handle(body.to_command(person_id, user.id))
    except PersonNotFoundError as error:
        raise _person_not_found(person_id) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user.id))


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
) -> ResponseModel[PersonDetailResponse]:
    """Patch one of the caller's receivable items (ADR-204, ADR-028, ADR-130).

    Omitted fields are left unchanged (ADR-028). A missing or cross-tenant ``item_id``
    surfaces :class:`ReceivableItemNotFoundError` mapped to ``404`` (ADR-111). Returns the
    owning person's refreshed detail.
    """
    try:
        await bus.handle(body.to_command(item_id, user.id))
    except ReceivableItemNotFoundError as error:
        raise _item_not_found(item_id) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user.id))


@router.delete(
    "/people/{person_id}/items/{item_id}",
    name="Delete receivable item",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_item(person_id: UUID, item_id: UUID, bus: Bus, user: AuthUser) -> None:
    """Delete one of the caller's receivable items, cascading its allocations (ADR-204, ADR-208).

    A missing or cross-tenant ``item_id`` surfaces a not-found mapped to ``404`` (ADR-111).
    ``person_id`` scopes the URL to its owning person but ownership is enforced on the item.
    """
    try:
        await bus.handle(DeleteReceivableItem(id=item_id, user_id=user.id))
    except ReceivableItemNotFoundError as error:
        raise _item_not_found(item_id) from error


async def _record_payment(
    command: RecordReceivablePayment,
    person_id: UUID,
    bus: Bus,
    reader: AbstractReceivableReader,
    user_id: str,
) -> ResponseModel[PersonDetailResponse]:
    """Dispatch a payment/confirm-match command and translate the settlement outcomes (ADR-206).

    Shared by the manual-payment and confirm-match endpoints so both surface the exact same
    HTTP contract:

    - :class:`PersonNotFoundError` / :class:`ReceivableItemNotFoundError` -> ``404``.
    - :class:`MatchedIncomeNotFoundError` -> ``404`` (confirm-match only: the linked income is
      missing, cross-tenant, or not a ``kind='income'`` row; existence never leaked, ADR-111).
    - :class:`IncomeAlreadyClaimedError` -> ``409`` with a machine-readable ``code`` (confirm-
      match only: the income already settled another debt; terminal, no retry — ADR-207).
    - :class:`AllocationExceedsPaymentError` -> ``422`` (a hard invariant, never a warning).
    - :class:`ReceivableOverpaymentError` -> ``409`` with the confirm-and-retry body.

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
    except AllocationExceedsPaymentError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error
    except ReceivableOverpaymentError as error:
        raise _overpayment_conflict(error) from error
    return ResponseModel(data=await _reload_person(reader, person_id, user_id))


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
) -> ResponseModel[PersonDetailResponse]:
    """Record a manual payback allocated across the person's items (ADR-206, ADR-130).

    See :func:`_record_payment` for the full settlement HTTP contract, including the ADR-206
    overpayment ``409`` warning the client confirms and retries with ``allowOverpayment``.
    """
    return await _record_payment(body.to_command(person_id, user.id), person_id, bus, reader, user.id)


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
) -> ResponseModel[PersonDetailResponse]:
    """Confirm a reviewed income match, creating a matched-income payback (ADR-207, ADR-206).

    Creates a ``source='matched_income'`` payment linked to the chosen income transaction
    and allocates it across the person's items — reusing the same settlement path (and HTTP
    contract) as a manual payment (see :func:`_record_payment`).
    """
    return await _record_payment(body.to_command(person_id, user.id), person_id, bus, reader, user.id)
