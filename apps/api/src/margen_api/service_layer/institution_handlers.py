"""Application handlers for the institution aggregate (ADR-130, ADR-134).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain;
handlers contain no SQLAlchemy and no validation of their own (AGENTS.md). Every
write is owner-scoped (ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.institution import CreateInstitution, UpdateInstitution
from margen_api.domain.models.exceptions import InstitutionNotFoundError
from margen_api.domain.models.institution import Institution, build_institution
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Mutable fields a patch may carry; ``None`` in the command means "leave
# unchanged" (ADR-028). Identity, ownership and ``created_at`` are never patched.
_PATCHABLE_FIELDS = ("name", "type")


async def create_institution(command: CreateInstitution, uow: AbstractUnitOfWork) -> UUID:
    """Create a new institution owned by the caller and return its identity (ADR-130, ADR-134).

    The handler injects the UUID identity and ``created_at``/``updated_at``
    timestamps so the domain stays clock- and UUID-free in production (ADR-026),
    then builds the aggregate through the domain factory so invariants run
    (ADR-031). The institution is stamped with ``command.user_id`` so it is owned
    from creation (ADR-130).

    Args:
        command: The validated create request.
        uow: The unit of work providing the institution repository.

    Returns:
        The UUID identity of the newly persisted institution.
    """
    now = datetime.now(UTC)
    institution = build_institution(
        institution_id=uuid4(),
        created_at=now,
        updated_at=now,
        name=command.name,
        type=command.type,
        user_id=command.user_id,
    )
    async with uow:
        uow.institutions.add(institution)
        await uow.commit()
    return institution.id


async def update_institution(command: UpdateInstitution, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to one of the caller's institutions (ADR-130, ADR-134).

    Loads the aggregate by identity scoped to ``user_id`` (a foreign owner's id is
    not found, ADR-111), overlays the present fields (``None`` leaves a field
    unchanged), rebuilds it through the domain so invariants re-run (ADR-031),
    preserves ``id``, ``created_at`` and ownership, and refreshes ``updated_at``.

    Args:
        command: The validated patch request, addressing one aggregate by ``id``.
        uow: The unit of work providing the institution repository.

    Returns:
        The UUID identity of the updated institution.

    Raises:
        InstitutionNotFoundError: When no institution matches ``command.id`` for
            the owner.
    """
    async with uow:
        existing = await uow.institutions.get(command.id, command.user_id)
        if existing is None:
            raise InstitutionNotFoundError(command.id)
        patched = _apply_patch(existing, command)
        await uow.institutions.persist(patched)
        await uow.commit()
    return patched.id


def _apply_patch(existing: Institution, command: UpdateInstitution) -> Institution:
    """Build a new aggregate overlaying the patch's present fields (ADR-134).

    Rebuilding through :func:`build_institution` re-runs the domain invariants so
    the patched state is validated and normalized, while preserving identity,
    ``created_at`` and ownership (``user_id``) and bumping ``updated_at`` to now
    (ADR-026, ADR-031, ADR-130). Ownership is never patchable.
    """
    fields = {name: getattr(existing, name) for name in _PATCHABLE_FIELDS}
    for name in _PATCHABLE_FIELDS:
        value = getattr(command, name)
        if value is not None:
            fields[name] = value
    return build_institution(
        institution_id=existing.id,
        created_at=existing.created_at,
        updated_at=datetime.now(UTC),
        user_id=existing.user_id,
        **fields,
    )
