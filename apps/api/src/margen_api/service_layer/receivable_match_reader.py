"""Reader port for the receivable income-match suggestions (ADR-207, ADR-130).

The read-only query port behind the fuzzy income-match feature: for one of the owner's
people it returns the ranked, unclaimed ``kind='income'`` transactions whose name
plausibly matches the person (ADR-207). It is strictly read-only and owner-scoped — a
foreign or unknown person yields no suggestions rather than leaking existence (ADR-111).
The concrete adapter (``margen_api.adapters.receivable_matching_queries``) does the I/O and
delegates scoring to the pure matcher; this port keeps the entrypoint free of SQLAlchemy so
the router depends on the abstraction the composition root injects (AGENTS.md).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.service_layer.receivable_matcher import IncomeMatch


class AbstractReceivableMatchReader(ABC):
    """Async, read-only query port for a person's ranked income suggestions (ADR-207)."""

    @abstractmethod
    async def suggest_income_matches(self, person_id: UUID, user_id: str) -> list[IncomeMatch]:
        """Rank the owner's unclaimed incomes that plausibly match a person (ADR-207, ADR-130).

        Args:
            person_id: The debtor whose paybacks to find income matches for.
            user_id: The authenticated owner; the person, the candidate incomes and the
                claimed set are all scoped to it (ADR-108, ADR-130).

        Returns:
            The matching incomes as scored, ranked :class:`IncomeMatch` records, best-first;
            an empty list when the person is absent for this owner, has no items (no date
            window), or no unclaimed income clears the match threshold.
        """
