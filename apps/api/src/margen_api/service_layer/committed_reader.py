"""Reader port for the committed-spend accent query side (ADR-179).

The reader serves the committed paid/pending split for a target month and is strictly
read-only — no writes flow through it. It is owner-scoped so a caller only ever sees
their own committed streams (ADR-108, ADR-131). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.committed_read_models import CommittedSplit


class AbstractCommittedReader(ABC):
    """Async, read-only query port for the committed-spend accent (ADR-179)."""

    @abstractmethod
    async def committed(
        self,
        month: date,
        user_id: str,
        *,
        currency: Currency = Currency.ARS,
    ) -> CommittedSplit:
        """Return the owner's committed paid/pending split for a month (ADR-179, ADR-131).

        Splits the month's COMMITTED expense universe (recurring subscriptions,
        instalment cuotas and the monotributo cuota) into **paid** (committed rows
        already posted this month, already inside the month's Expenses total) and
        **pending** (expected-this-month committed outflows not yet posted, evaluated per
        stream at offset 0 with the no-double-count rule, ADR-176). A stream flips out of
        pending the moment its row lands this month (ADR-179).

        Every figure is denominated in ``currency`` (ADR-168): the ARS path sums the
        authoritative ``amount``; the USD path sums the ``usd_amount`` snapshot, excludes
        streams that lack one and surfaces their count as ``unconverted`` (ADR-152). The
        monotributo cuota is AFIP-ARS and is summed into a total only on the ARS path
        (ADR-177). Scoped to ``user_id`` so a caller only sees their own commitments
        (ADR-108, ADR-131).

        Args:
            month: The target month (first day); its year/month select the window.
            user_id: The authenticated owner; every committed stream is scoped to it.
            currency: The denomination currency; ``ARS`` (default) or ``USD``.

        Returns:
            The assembled :class:`CommittedSplit`.
        """
