"""Reader port for the transfer query side (ADR-135, ADR-130).

The reader serves the transfers list. It is strictly read-only — transfer writes go
through commands on the unit of work (ADR-028) — and is owner-scoped so a caller
only ever sees their own transfers (ADR-130). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.transfer_read_models import TransferReadModel


class AbstractTransferReader(ABC):
    """Async, read-only query port for transfers (ADR-135)."""

    @abstractmethod
    async def list_transfers(self, user_id: str) -> list[TransferReadModel]:
        """List the owner's transfers, newest-first (ADR-130, ADR-135).

        Args:
            user_id: The authenticated owner; every transfer is scoped to it so a
                caller only sees their own (ADR-108, ADR-130).

        Returns:
            The owner's transfer read models, newest-first by ``occurred_on`` then
            ``created_at``.
        """
