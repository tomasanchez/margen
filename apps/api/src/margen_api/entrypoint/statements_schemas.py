"""Boundary schemas for the credit-card statement import contract (ADR-078, ADR-030).

These Pydantic models translate the stateless parse result into the camelCase JSON
the multi-row review UI prefills from (ADR-080), and translate the user-confirmed
import body back into an :class:`ImportStatement` command (ADR-078). The parse
response carries the detected bank identity, the per-line drafts, the computed
``naturalKey``, an advisory ``duplicate`` flag, and a ``document`` payload (base64
PDF + metadata) the client echoes back on import. Money is serialized as ``Decimal``
exactly as the transactions endpoint does (ADR-025).
"""

from __future__ import annotations

import base64
import binascii
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, model_validator

from margen_api.domain.commands.statement import (
    ImportStatement,
    StatementDocumentPayload,
    StatementLineInput,
    StatementLineResolution,
)
from margen_api.domain.models.value_objects import Currency, FxRateType
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.statement_matcher import ReconCandidate
from margen_api.service_layer.statement_parser_read_models import (
    LineKind,
    ParsedStatement,
    ParseStatus,
    StatementLineDraft,
    StatementNaturalKey,
)

# Installment marker note prefix written to a transaction's ``notes`` (ADR-079).
_CUOTA_NOTE_PREFIX = "Cuota "


class InvalidDocumentBase64Error(ValueError):
    """Raised when the import document's ``pdfBase64`` is not valid base64 (ADR-078)."""

    def __init__(self) -> None:
        super().__init__("pdfBase64 is not valid base64.")


class MergeRequiresMatchError(ValueError):
    """Raised when a ``merge`` import line omits its ``matchTransactionId`` (ADR-085).

    A :class:`ValueError` subclass so Pydantic surfaces it as a ``422`` at the
    boundary; the message lives on the class to keep the raise site terse.
    """

    def __init__(self) -> None:
        super().__init__("matchTransactionId is required when resolution is 'merge'.")


# --------------------------------------------------------------------------- #
# Parse response (POST /statements/parse).                                     #
# --------------------------------------------------------------------------- #


class StatementNaturalKeyResponse(CamelCaseModel):
    """The statement identity computed from a parsed statement (ADR-077).

    The tuple ``(issuerCuit, cardLast4, statementNumber)`` identifies a statement
    and backs the advisory dedupe check. Every field is optional because a
    malformed statement may not yield each one.
    """

    issuer_cuit: str | None = Field(default=None, description="Issuing bank CUIT.")
    card_last4: str | None = Field(default=None, description="Last four digits of the card.")
    statement_number: str | None = Field(default=None, description="The statement's printed number.")

    @classmethod
    def from_natural_key(cls, key: StatementNaturalKey) -> StatementNaturalKeyResponse:
        """Build the response from a parsed natural key."""
        return cls(
            issuer_cuit=key.issuer_cuit,
            card_last4=key.card_last4,
            statement_number=key.statement_number,
        )


class StatementLineMatchResponse(CamelCaseModel):
    """A likely existing manual expense flagged for a statement line (ADR-084, ADR-085).

    Present on a parse-response line only when the matcher reconciled it against an
    existing manual expense (kind expense, ``statement_document_id`` is null). Carries
    just what the review UI needs to highlight and compare the candidate; money is
    ``Decimal`` (ADR-025). ``null`` when the line was not matched.
    """

    transaction_id: str = Field(description="The matched existing transaction identity.")
    name: str = Field(description="The user's manual label for the matched expense.")
    occurred_on: date = Field(description="The date the user recorded the matched expense on.")
    amount: Decimal = Field(description="The matched expense's positive ARS-equivalent amount.")
    category: str | None = Field(default=None, description="The matched expense's category, or null.")
    payment_method: str | None = Field(default=None, description="The matched expense's bank / card label, or null.")

    @classmethod
    def from_candidate(cls, candidate: ReconCandidate) -> StatementLineMatchResponse:
        """Build the match response from a reconciliation candidate (ADR-085)."""
        return cls(
            transaction_id=str(candidate.transaction_id),
            name=candidate.name,
            occurred_on=candidate.occurred_on,
            amount=candidate.amount,
            category=candidate.category,
            payment_method=candidate.payment_method,
        )


class StatementLineResponse(CamelCaseModel):
    """One editable line draft the review UI renders and the user confirms (ADR-080).

    Mirrors a :class:`StatementLineDraft`; money is ``Decimal`` (ADR-025). The
    ``include`` flag drives the per-row checkbox in the review table. ``match`` carries
    a likely existing manual expense when one was reconciled (ADR-084, ADR-085), else
    ``null``.
    """

    occurred_on: date = Field(description="The purchase date as printed (not the due date).")
    name: str = Field(description="The merchant / reference text as printed.")
    amount: Decimal = Field(description="Positive ARS (PESOS) amount.")
    currency: Currency = Field(description="'ARS' or 'USD'.")
    usd_amount: Decimal | None = Field(default=None, description="Stated dollar figure for a USD line.")
    fx_rate: Decimal | None = Field(default=None, description="Stated cotización for a USD line, else null.")
    fx_rate_type: FxRateType | None = Field(default=None, description="'official' when a rate is stated, else null.")
    category: str | None = Field(default=None, description="Keyword-guessed category, editable in review.")
    cuota: str | None = Field(default=None, description="Installment marker such as '3/3', else null.")
    line_kind: LineKind = Field(description="Internal classification: 'purchase' or 'fee'.")
    include: bool = Field(description="Whether the line is selected for import (default true).")
    match: StatementLineMatchResponse | None = Field(
        default=None,
        description="A likely existing manual expense flagged for this line, or null (ADR-085).",
    )

    @classmethod
    def from_draft(
        cls,
        draft: StatementLineDraft,
        match: ReconCandidate | None = None,
    ) -> StatementLineResponse:
        """Build the response from a parsed line draft and an optional match (ADR-085)."""
        return cls(
            occurred_on=draft.occurred_on,
            name=draft.name,
            amount=draft.amount,
            currency=draft.currency,
            usd_amount=draft.usd_amount,
            fx_rate=draft.fx_rate,
            fx_rate_type=draft.fx_rate_type,
            category=draft.category,
            cuota=draft.cuota,
            line_kind=draft.line_kind,
            include=draft.include,
            match=StatementLineMatchResponse.from_candidate(match) if match is not None else None,
        )


class StatementDocumentResponse(CamelCaseModel):
    """The document payload the client echoes back on import (ADR-078).

    The PDF crosses the JSON boundary as base64 (``pdfBase64``); the rest is the
    statement metadata produced by parse. The client returns this verbatim on the
    import call so the parse step stays fully stateless (ADR-078). Money is
    ``Decimal`` (ADR-025).
    """

    pdf_base64: str = Field(description="The original statement PDF, base64-encoded for the JSON body.")
    content_type: str = Field(default="application/pdf", description="MIME type of the upload.")
    byte_size: int = Field(description="The PDF size in bytes.")
    extracted_text: str | None = Field(default=None, description="Parsed PDF text, echoed from parse.")
    bank_name: str | None = Field(default=None, description="Issuing bank name, if parsed.")
    network: str | None = Field(default=None, description="Card network, if parsed.")
    card_last4: str | None = Field(default=None, description="Last four digits of the card, if parsed.")
    issuer_cuit: str | None = Field(default=None, description="Issuing bank CUIT, if parsed.")
    statement_number: str | None = Field(default=None, description="The statement's printed number, if parsed.")
    period_close: date | None = Field(default=None, description="Current-statement closing date, if parsed.")
    period_due: date | None = Field(default=None, description="Current-statement due date, if parsed.")
    total_amount: Decimal | None = Field(default=None, description="Pesos statement total, if parsed.")

    @classmethod
    def from_parsed(cls, parsed: ParsedStatement, pdf_bytes: bytes) -> StatementDocumentResponse:
        """Build the echo-back document payload from a parse result and the bytes."""
        return cls(
            pdf_base64=base64.b64encode(pdf_bytes).decode("ascii"),
            content_type="application/pdf",
            byte_size=len(pdf_bytes),
            extracted_text=parsed.extracted_text,
            bank_name=parsed.bank_name,
            network=parsed.network,
            card_last4=parsed.card_last4,
            issuer_cuit=parsed.issuer_cuit,
            statement_number=parsed.statement_number,
            period_close=parsed.period_close,
            period_due=parsed.period_due,
            total_amount=parsed.total_amount,
        )


class StatementParseResponse(CamelCaseModel):
    """The stateless parse result the review UI prefills from (ADR-078, ADR-080).

    Carries the parse ``status`` (for the calm unsupported fallback — ADR-080), the
    advisory ``duplicate`` flag, the detected bank identity, the computed
    ``naturalKey``, the editable ``lines``, and the ``document`` payload the client
    echoes back on import. On an unsupported / unparseable PDF the line list is
    empty — a calm result, not an error.
    """

    status: ParseStatus = Field(description="Parse outcome: ok / unsupported / unparseable.")
    duplicate: bool = Field(description="Advisory flag: a statement with this natural key already exists (ADR-077).")
    bank_name: str | None = Field(default=None, description="Issuing bank name, or null when unsupported.")
    network: str | None = Field(default=None, description="Card network, or null.")
    card_last4: str | None = Field(default=None, description="Last four digits of the card, or null.")
    payment_method: str | None = Field(default=None, description="Composed bank/network/last4 label, or null.")
    statement_number: str | None = Field(default=None, description="The statement's printed number, or null.")
    issuer_cuit: str | None = Field(default=None, description="Issuing bank CUIT, or null.")
    period_close: date | None = Field(default=None, description="Current-statement closing date, or null.")
    period_due: date | None = Field(default=None, description="Current-statement due date, or null.")
    total_amount: Decimal | None = Field(default=None, description="Pesos statement total, or null.")
    natural_key: StatementNaturalKeyResponse | None = Field(
        default=None,
        description="The computed statement identity, or null when not derivable.",
    )
    lines: list[StatementLineResponse] = Field(
        default_factory=list,
        description="The editable per-line drafts (empty when none were extracted).",
    )
    document: StatementDocumentResponse | None = Field(
        default=None,
        description="The document payload to echo back on import; null when unsupported.",
    )

    @classmethod
    def from_parsed(
        cls,
        parsed: ParsedStatement,
        pdf_bytes: bytes,
        *,
        duplicate: bool,
        matches: dict[int, ReconCandidate] | None = None,
    ) -> StatementParseResponse:
        """Build the response from a parse result, the PDF bytes, and the dedupe flag.

        Args:
            parsed: The structured parse result from the parser service.
            pdf_bytes: The uploaded PDF bytes (echoed back as base64 for import).
            duplicate: Whether a stored document already matches the natural key.
            matches: Per-line-index reconciliation matches against existing manual
                expenses (ADR-085); a line index absent from the map is unmatched and
                serializes ``match: null``. ``None`` when no matching was run.

        Returns:
            The camelCase boundary representation. When the PDF is unsupported the
            ``document`` is omitted (nothing to import); otherwise the document
            payload and line drafts are populated.
        """
        matched = matches or {}
        natural_key = (
            StatementNaturalKeyResponse.from_natural_key(parsed.natural_key) if parsed.natural_key is not None else None
        )
        document = (
            StatementDocumentResponse.from_parsed(parsed, pdf_bytes)
            if parsed.status is not ParseStatus.UNSUPPORTED
            else None
        )
        return cls(
            status=parsed.status,
            duplicate=duplicate,
            bank_name=parsed.bank_name,
            network=parsed.network,
            card_last4=parsed.card_last4,
            payment_method=parsed.payment_method,
            statement_number=parsed.statement_number,
            issuer_cuit=parsed.issuer_cuit,
            period_close=parsed.period_close,
            period_due=parsed.period_due,
            total_amount=parsed.total_amount,
            natural_key=natural_key,
            lines=[
                StatementLineResponse.from_draft(line, matched.get(index)) for index, line in enumerate(parsed.lines)
            ],
            document=document,
        )


# --------------------------------------------------------------------------- #
# Import request (POST /statements/import).                                    #
# --------------------------------------------------------------------------- #


class StatementDocumentRequest(CamelCaseModel):
    """The document payload echoed back on ``POST /statements/import`` (ADR-078).

    The PDF crosses the JSON boundary as base64 (``pdfBase64``); the rest is the
    statement metadata from parse. Decoding to raw bytes happens in
    :meth:`to_payload` so the bytes never enter a transaction aggregate (they
    become the shared parent record). Money is ``Decimal`` (ADR-025).
    """

    pdf_base64: str = Field(description="The original statement PDF, base64-encoded.")
    content_type: str = Field(default="application/pdf", description="MIME type of the upload.")
    extracted_text: str | None = Field(default=None, description="Parsed PDF text, echoed from parse.")
    bank_name: str | None = Field(default=None, description="Issuing bank name.")
    network: str | None = Field(default=None, description="Card network.")
    card_last4: str | None = Field(default=None, description="Last four digits of the card.")
    issuer_cuit: str | None = Field(default=None, description="Issuing bank CUIT.")
    statement_number: str | None = Field(default=None, description="The statement's printed number.")
    period_close: date | None = Field(default=None, description="Current-statement closing date.")
    period_due: date | None = Field(default=None, description="Current-statement due date.")
    total_amount: Decimal | None = Field(default=None, description="Pesos statement total.")

    def to_payload(self) -> StatementDocumentPayload:
        """Decode the base64 PDF and build the command's document payload.

        Returns:
            The :class:`StatementDocumentPayload` carrying raw PDF bytes (kept out
            of the aggregate) and the statement metadata.

        Raises:
            InvalidDocumentBase64Error: When ``pdfBase64`` is not valid base64.
        """
        try:
            pdf_bytes = base64.b64decode(self.pdf_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise InvalidDocumentBase64Error from error
        return StatementDocumentPayload(
            pdf_bytes=pdf_bytes,
            content_type=self.content_type,
            byte_size=len(pdf_bytes),
            extracted_text=self.extracted_text,
            bank_name=self.bank_name,
            network=self.network,
            card_last4=self.card_last4,
            issuer_cuit=self.issuer_cuit,
            statement_number=self.statement_number,
            period_close=self.period_close,
            period_due=self.period_due,
            total_amount=self.total_amount,
        )


class StatementLineRequest(CamelCaseModel):
    """One user-confirmed line on ``POST /statements/import`` (ADR-078, ADR-079, ADR-085).

    Mirrors the create contract's expense fields plus the per-line reconciliation
    choice (ADR-085). The installment ``cuota`` marker is folded into ``notes`` as
    ``"Cuota 3/3"`` (ADR-079) by :meth:`to_input` when no explicit note is supplied.
    A ``merge`` resolution must carry ``matchTransactionId`` (validated here → 422).
    Money is ``Decimal`` (ADR-025).
    """

    occurred_on: date = Field(description="The purchase date (ISO 8601).")
    name: str = Field(min_length=1, description="The merchant / reference label.")
    amount: Decimal = Field(gt=Decimal(0), description="Positive ARS-equivalent magnitude.")
    currency: Currency = Field(default=Currency.ARS, description="'ARS' or 'USD'.")
    usd_amount: Decimal | None = Field(default=None, description="Stated dollar figure for a USD line.")
    fx_rate: Decimal | None = Field(default=None, description="Stated cotización for a USD line, else null.")
    fx_rate_type: FxRateType | None = Field(default=None, description="FX rate family; null for manual confirm.")
    fx_rate_as_of: datetime | None = Field(default=None, description="Timestamp the FX rate was observed.")
    category: str | None = Field(default=None, description="Category label, editable in review.")
    payment_method: str | None = Field(
        default=None,
        validation_alias="bank",
        serialization_alias="bank",
        description="Bank / card / channel label. Aliased to the mock's 'bank'.",
    )
    notes: str | None = Field(default=None, description="Free-form note, distinct from name.")
    cuota: str | None = Field(default=None, description="Installment marker such as '3/3'; folded into notes.")
    resolution: StatementLineResolution = Field(
        default=StatementLineResolution.IMPORT,
        description="Per-line reconciliation: 'import' (default), 'merge', or 'keep_both' (ADR-085).",
    )
    match_transaction_id: UUID | None = Field(
        default=None,
        description="Existing transaction to enrich; required when resolution is 'merge' (ADR-085).",
    )

    @model_validator(mode="after")
    def _require_match_for_merge(self) -> StatementLineRequest:
        """Enforce that a ``merge`` resolution carries a ``matchTransactionId`` (ADR-085)."""
        if self.resolution == StatementLineResolution.MERGE and self.match_transaction_id is None:
            raise MergeRequiresMatchError
        return self

    def to_input(self) -> StatementLineInput:
        """Translate the request line into a :class:`StatementLineInput`.

        Folds the installment ``cuota`` marker into ``notes`` as ``"Cuota 3/3"``
        when present and no explicit note is supplied (ADR-079), and carries the
        per-line reconciliation choice through (ADR-085).
        """
        notes = self.notes
        if notes is None and self.cuota is not None:
            notes = f"{_CUOTA_NOTE_PREFIX}{self.cuota}"
        return StatementLineInput(
            occurred_on=self.occurred_on,
            name=self.name,
            amount=self.amount,
            currency=self.currency,
            usd_amount=self.usd_amount,
            fx_rate=self.fx_rate,
            fx_rate_type=self.fx_rate_type,
            fx_rate_as_of=self.fx_rate_as_of,
            category=self.category,
            payment_method=self.payment_method,
            notes=notes,
            resolution=self.resolution,
            match_transaction_id=self.match_transaction_id,
        )


class StatementImportRequest(CamelCaseModel):
    """Request body for ``POST /statements/import`` (maps to :class:`ImportStatement`).

    Carries the ``document`` payload echoed from parse plus the user-confirmed
    ``lines``. A malformed ``pdfBase64`` yields ``422`` (ADR-078).
    """

    document: StatementDocumentRequest = Field(description="The document payload echoed from parse.")
    lines: list[StatementLineRequest] = Field(description="The user-confirmed lines to import.")

    def to_command(self) -> ImportStatement:
        """Translate the request into an :class:`ImportStatement` command.

        Returns:
            The boundary-agnostic command the message bus dispatches; the document
            is decoded to a payload with raw bytes (kept out of the aggregate).

        Raises:
            InvalidDocumentBase64Error: When the document's ``pdfBase64`` is invalid.
        """
        return ImportStatement(
            document=self.document.to_payload(),
            lines=[line.to_input() for line in self.lines],
        )


class StatementImportResponse(CamelCaseModel):
    """The result of a successful import (ADR-078, ADR-085).

    Carries the created and merged transaction counts and ids plus the shared
    ``statementDocumentId`` so the client can deep-link to the stored PDF.
    ``mergedCount`` / ``mergedTransactionIds`` surface the per-line reconciliation
    merges (ADR-085); they are empty when no line resolved to ``merge``.
    """

    statement_document_id: str = Field(description="The stored statement document identity.")
    created_count: int = Field(description="The number of new EXPENSE transactions created.")
    merged_count: int = Field(description="The number of existing transactions enriched via merge (ADR-085).")
    created_transaction_ids: list[str] = Field(description="The created transaction identities, in line order.")
    merged_transaction_ids: list[str] = Field(description="The merged transaction identities, in line order.")
