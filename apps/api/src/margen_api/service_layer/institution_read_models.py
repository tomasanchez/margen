"""Read models for the institution query side (ADR-130, ADR-134).

Purpose-built, immutable DTOs for the institutions list — deliberately separate
from the write aggregate so the two evolve independently (AGENTS.md reader ports +
read models).
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from margen_api.domain.models.value_objects import InstitutionType


@dataclass(frozen=True, slots=True)
class InstitutionReadModel:
    """Query-optimized projection of a persisted institution (ADR-134).

    Attributes:
        id: Stable UUID identity.
        name: Required human display label.
        type: Institution kind — bank / card / cash / wallet.
    """

    id: UUID
    name: str
    type: InstitutionType
