"""SQLAlchemy persistence models.

Importing the record classes here registers their tables on ``Base.metadata``,
which ``migrations/env.py`` uses as the Alembic autogenerate target.
"""

from margen_api.adapters.models.base import Base
from margen_api.adapters.models.transaction import TransactionRecord

__all__ = ["Base", "TransactionRecord"]
