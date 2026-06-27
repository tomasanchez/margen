"""Mapping between the ``Institution`` aggregate and its SQLAlchemy record (ADR-134).

The domain aggregate stays plain Python while the ``InstitutionRecord`` holds the
relational shape. This module is the single place that translates between the two,
so the repository never reaches into ORM internals and the domain never learns
about SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.institution import InstitutionRecord
from margen_api.domain.models.institution import Institution
from margen_api.domain.models.value_objects import InstitutionType


def to_domain(record: InstitutionRecord) -> Institution:
    """Build a domain :class:`Institution` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are
    already valid, so this is a faithful rehydration rather than fresh validation.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Institution`` aggregate.
    """
    return Institution(
        id=record.id,
        name=record.name,
        type=InstitutionType.parse(record.type),
        user_id=str(record.user_id) if record.user_id is not None else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(institution: Institution) -> InstitutionRecord:
    """Build a fresh persistence record from a domain :class:`Institution`.

    Used when adding a new aggregate. ``type`` is stored as its string value since
    the column is a plain string (ADR-027 style).

    Args:
        institution: The aggregate to persist.

    Returns:
        A new, unattached ``InstitutionRecord`` carrying every field.
    """
    record = InstitutionRecord()
    update_record(record, institution)
    return record


def update_record(record: InstitutionRecord, institution: Institution) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row
    (update/persist semantics). ``id`` is set so a detached record carries its
    identity; for an attached row it is already the same value.

    Args:
        record: The relational row to update in place.
        institution: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write
            path threads the authenticated owner (ADR-130), so a missing id is a
            programming error rather than a persistable state.
    """
    record.id = institution.id
    record.name = institution.name
    record.type = institution.type.value
    if institution.user_id is None:
        msg = "Cannot persist an institution without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(institution.user_id)
    record.created_at = institution.created_at
    record.updated_at = institution.updated_at
