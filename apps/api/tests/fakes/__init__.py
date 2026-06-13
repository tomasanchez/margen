"""In-memory fakes for owned persistence ports.

Unit tests for handlers and readers use these fakes instead of a database, per
AGENTS.md (fakes for owned ports such as repositories and units of work) and
ADR-028/ADR-032. They implement the same abstract ports as the SQLAlchemy
adapters, so a handler tested against a fake exercises the real contract.
"""

from tests.fakes.persistence import (
    FakeTransactionReader,
    FakeTransactionRepository,
    FakeUnitOfWork,
)

__all__ = [
    "FakeTransactionReader",
    "FakeTransactionRepository",
    "FakeUnitOfWork",
]
