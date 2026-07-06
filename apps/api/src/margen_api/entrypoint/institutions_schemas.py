"""Boundary schemas for the institutions REST contract (ADR-130, ADR-134).

These Pydantic models translate the institution read models to and from the
camelCase JSON the frontend builds to (the pinned contract). ``type`` reuses the
domain value object so the contract stays aligned with the aggregate.

Pinned JSON contract:

* Institution = ``{ id, name, type: 'bank'|'card'|'cash'|'wallet', brand, last4 }``
  where ``brand`` (card network, e.g. "VISA") and ``last4`` (four-digit suffix) are
  the optional card identity — ``null`` for non-card institutions (ADR-190).
"""

from __future__ import annotations

from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.institution import CreateInstitution, UpdateInstitution
from margen_api.domain.models.value_objects import InstitutionType
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.institution_read_models import InstitutionReadModel


class InstitutionResponse(CamelCaseModel):
    """The institution shape returned to clients (ADR-134)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="Required human display label for the institution.")
    type: InstitutionType = Field(description="Institution kind: bank / card / cash / wallet.")
    brand: str | None = Field(
        default=None,
        description="Card network label (e.g. 'VISA'); null for non-card institutions (ADR-190).",
    )
    last4: str | None = Field(
        default=None,
        description="Four-digit card suffix; null for non-card institutions (ADR-190).",
    )

    @classmethod
    def from_read_model(cls, model: InstitutionReadModel) -> InstitutionResponse:
        """Build the response from a query-side read model (ADR-030)."""
        return cls(id=model.id, name=model.name, type=model.type, brand=model.brand, last4=model.last4)


class InstitutionCreateRequest(CamelCaseModel):
    """Request body for ``POST /institutions`` (maps to :class:`CreateInstitution`).

    Lenient validation (ADR-031): only true invariant violations are rejected here
    (empty ``name``, unknown ``type``).
    """

    name: str = Field(min_length=1, description="Required human display label.")
    type: InstitutionType = Field(default=InstitutionType.BANK, description="Institution kind.")
    brand: str | None = Field(
        default=None,
        description="Card network label (parser 'network', e.g. 'VISA'); omit for non-card kinds (ADR-190).",
    )
    last4: str | None = Field(
        default=None,
        description="Four-digit card suffix (parser 'cardLast4'); omit for non-card kinds (ADR-190).",
    )

    def to_command(self, user_id: str) -> CreateInstitution:
        """Translate the request into a :class:`CreateInstitution` command.

        Args:
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the created institution is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return CreateInstitution(
            user_id=user_id,
            name=self.name,
            type=self.type,
            brand=self.brand,
            last4=self.last4,
        )


class InstitutionPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /institutions/{id}`` (maps to :class:`UpdateInstitution`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028).
    """

    name: str | None = Field(default=None, min_length=1, description="New display label.")
    type: InstitutionType | None = Field(default=None, description="New institution kind.")
    brand: str | None = Field(default=None, description="New card network label (ADR-190).")
    last4: str | None = Field(default=None, description="New four-digit card suffix (ADR-190).")

    def to_command(self, institution_id: UUID, user_id: str) -> UpdateInstitution:
        """Translate the patch into an :class:`UpdateInstitution` command.

        Args:
            institution_id: The identity from the URL path.
            user_id: The authenticated owner (``AuthUser.id``) the handler scopes
                the load/persist by, so a cross-tenant patch is a 404 (ADR-111).

        Returns:
            The command addressing one aggregate; ``None`` fields are left unchanged.
        """
        return UpdateInstitution(
            id=institution_id,
            user_id=user_id,
            name=self.name,
            type=self.type,
            brand=self.brand,
            last4=self.last4,
        )
