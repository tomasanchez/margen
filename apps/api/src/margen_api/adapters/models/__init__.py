"""SQLAlchemy persistence models.

Importing the record classes here registers their tables on ``Base.metadata``,
which ``migrations/env.py`` uses as the Alembic autogenerate target.
"""

from margen_api.adapters.models.account import AccountRecord
from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.base import Base
from margen_api.adapters.models.invoice_document import InvoiceDocumentRecord
from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.models.statement_document import StatementDocumentRecord
from margen_api.adapters.models.transaction import TransactionRecord

__all__ = [
    "AccountRecord",
    "AppSettingsRecord",
    "Base",
    "InvoiceDocumentRecord",
    "MonotributoSnapshotRecord",
    "StatementDocumentRecord",
    "TransactionRecord",
]
