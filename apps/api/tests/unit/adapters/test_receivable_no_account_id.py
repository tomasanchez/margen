"""Structural guard: the receivables tables carry no balance-affecting link (ADR-205).

Receivables are excluded from balance and net worth **by construction** (ADR-205): the four
tables (``person``, ``receivable_item``, ``receivable_payment``, ``receivable_allocation``)
carry no ``account_id`` column and no foreign key into ``accounts``, so there is no join path
from a receivable row into :mod:`margen_api.adapters.account_queries` and no filter to
remember. These tests lock that invariant at the schema level — a future migration that added
an ``account_id`` (the exact leak ADR-198 documents for the retired card-account model) would
fail here before it could ever corrupt a real balance. Pure metadata/source introspection, no
I/O, so they run in the fast unit tier and contribute to the coverage gate.
"""

from __future__ import annotations

import inspect

import pytest

from margen_api.adapters import account_queries
from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableAllocationRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)

# The four receivables tables (ADR-204). Parametrized so a new table added to the cluster
# without an entry here still forces a conscious decision about this guard.
_RECEIVABLE_RECORDS = [
    PersonRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
    ReceivableAllocationRecord,
]
_RECEIVABLE_TABLE_NAMES = {record.__tablename__ for record in _RECEIVABLE_RECORDS}


@pytest.mark.parametrize("record", _RECEIVABLE_RECORDS, ids=lambda record: record.__tablename__)
def test_receivable_table_has_no_account_id_column(record: type) -> None:
    """
    GIVEN one of the four receivables tables (ADR-204)
    WHEN its mapped columns are introspected
    THEN it exposes NO ``account_id`` column (ADR-205)

    A structural proof the receivable can never carry a per-account link: with no
    ``account_id`` there is nothing for a balance/net-worth query to accidentally sum.
    """
    # WHEN
    columns = set(record.__table__.columns.keys())

    # THEN — the balance-affecting link is absent by construction (ADR-205).
    assert "account_id" not in columns


@pytest.mark.parametrize("record", _RECEIVABLE_RECORDS, ids=lambda record: record.__tablename__)
def test_receivable_table_has_no_foreign_key_into_accounts(record: type) -> None:
    """
    GIVEN one of the four receivables tables (ADR-204)
    WHEN its foreign keys are introspected
    THEN none of them references the ``accounts`` table (ADR-205)

    Guards the reverse of the column check: even a differently named column must never
    point at ``accounts``, so no join path into net-worth aggregation can exist.
    """
    # WHEN — every table the record's FKs point at.
    referenced_tables = {fk.column.table.name for column in record.__table__.columns for fk in column.foreign_keys}

    # THEN — receivables never reach the balance-bearing accounts table (ADR-205).
    assert "accounts" not in referenced_tables


def test_receivable_records_only_external_fk_is_the_income_match() -> None:
    """
    GIVEN the whole receivables cluster's foreign keys
    WHEN the set of tables they reference outside the cluster is computed
    THEN the ONLY external reference is ``transactions`` (the confirmed income match, ADR-207)

    Pins the single deliberate seam out of the subsystem so a new cross-table FK — the way a
    balance leak would first appear — cannot slip in silently (ADR-205, ADR-207).
    """
    # WHEN — every table referenced by any receivable FK, minus the cluster's own tables.
    referenced: set[str] = set()
    for record in _RECEIVABLE_RECORDS:
        for column in record.__table__.columns:
            for fk in column.foreign_keys:
                referenced.add(fk.column.table.name)
    external = referenced - _RECEIVABLE_TABLE_NAMES

    # THEN — the only seam out of the subsystem is the income-match link (ADR-207).
    assert external == {"transactions"}


def test_account_queries_reader_never_references_a_receivable_record() -> None:
    """
    GIVEN the net-worth / per-account balance reader source (``account_queries.py``)
    WHEN it is scanned for any receivables record class or module import
    THEN it references NONE of them (ADR-205)

    A light source guard backing the behavioral integration proof: the balance reader has no
    knowledge of receivables at all, so exclusion holds because the code paths never meet.
    """
    # WHEN
    source = inspect.getsource(account_queries)

    # THEN — no receivable record class name and no receivable module import appears.
    for record in _RECEIVABLE_RECORDS:
        assert record.__name__ not in source
    assert "models.receivable" not in source
