"""In-memory fakes for the transaction persistence ports.

These mirror the SQLAlchemy adapters' behavior closely enough to drive handler
and reader unit tests without a database: ``add``/``persist`` stage aggregates,
``commit`` makes them visible, ``rollback`` discards uncommitted work, ``delete``
is a hard delete (ADR-030), and the reader lists newest-first by ``occurred_on``
then ``created_at`` (ADR-030).
"""

from __future__ import annotations

from types import TracebackType
from uuid import UUID

from margen_api.domain.models.transaction import Transaction
from margen_api.domain.models.value_objects import Kind, TxType
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.repository import AbstractTransactionRepository
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork


class FakeTransactionRepository(AbstractTransactionRepository):
    """In-memory repository over a committed store and a staging buffer.

    Both stores are owned by the unit of work: ``add``/``persist`` write to the
    staging buffer, ``commit`` promotes it, ``rollback`` clears it. ``delete`` is
    a hard delete across both stores (ADR-030).
    """

    def __init__(self, committed: dict[UUID, Transaction], staged: dict[UUID, Transaction]) -> None:
        """Initialize the repository over the unit of work's stores.

        Args:
            committed: Aggregates visible after a commit, keyed by id.
            staged: Buffer of aggregates awaiting the next commit, keyed by id.
        """
        self._committed = committed
        self._staged = staged

    def add(self, transaction: Transaction) -> None:
        """Stage a new aggregate until the unit of work commits."""
        self._staged[transaction.id] = transaction

    async def get(self, transaction_id: UUID) -> Transaction | None:
        """Return a staged or committed aggregate, or ``None`` when absent."""
        return self._staged.get(transaction_id) or self._committed.get(transaction_id)

    async def persist(self, transaction: Transaction) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[transaction.id] = transaction

    async def delete(self, transaction_id: UUID) -> bool:
        """Hard-delete an aggregate from staged and committed stores."""
        staged = self._staged.pop(transaction_id, None)
        committed = self._committed.pop(transaction_id, None)
        return staged is not None or committed is not None


class FakeUnitOfWork(AbstractUnitOfWork):
    """In-memory unit of work exposing a fake transaction repository."""

    def __init__(self) -> None:
        """Initialize an empty unit of work."""
        self.committed_aggregates: dict[UUID, Transaction] = {}
        self._staged: dict[UUID, Transaction] = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.committed = False

    async def __aenter__(self) -> FakeUnitOfWork:
        """Enter the transaction boundary with a fresh staging buffer."""
        self.committed = False
        self._staged = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Roll back work that did not explicitly commit."""
        await super().__aexit__(exception_type, exception, traceback)

    async def commit(self) -> None:
        """Make staged aggregates visible to later reads."""
        self.committed_aggregates.update(self._staged)
        self._staged.clear()
        self.committed = True

    async def rollback(self) -> None:
        """Discard staged aggregates."""
        self._staged.clear()


class FakeTransactionReader(AbstractTransactionReader):
    """In-memory reader projecting a committed store into read models."""

    def __init__(self, committed: dict[UUID, Transaction]) -> None:
        """Initialize the reader over a committed store.

        Args:
            committed: The aggregates to project, keyed by id. Pass a unit of
                work's ``committed_aggregates`` to share state.
        """
        self._committed = committed

    async def list_transactions(self) -> list[TransactionReadModel]:
        """List read models newest-first by ``occurred_on`` then ``created_at``."""
        ordered = sorted(
            self._committed.values(),
            key=lambda tx: (tx.occurred_on, tx.created_at),
            reverse=True,
        )
        return [_project(tx) for tx in ordered]

    async def get_transaction(self, transaction_id: UUID) -> TransactionReadModel | None:
        """Return one read model, or ``None`` when absent."""
        transaction = self._committed.get(transaction_id)
        return _project(transaction) if transaction is not None else None


def _project(transaction: Transaction) -> TransactionReadModel:
    """Project a domain aggregate into a read model, deriving ``type``."""
    return TransactionReadModel(
        id=transaction.id,
        occurred_on=transaction.occurred_on,
        name=transaction.name,
        kind=transaction.kind,
        type=TxType.EXPENSE if transaction.kind is Kind.EXPENSE else TxType.INCOME,
        amount=transaction.amount,
        currency=transaction.currency,
        usd_amount=transaction.usd_amount,
        fx_rate=transaction.fx_rate,
        fx_rate_type=transaction.fx_rate_type,
        fx_rate_as_of=transaction.fx_rate_as_of,
        category=transaction.category,
        payment_method=transaction.payment_method,
        notes=transaction.notes,
        recurring=transaction.recurring,
        counts_toward_monotributo=transaction.counts_toward_monotributo,
        created_at=transaction.created_at,
        updated_at=transaction.updated_at,
    )
