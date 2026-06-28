"""Unit tests for the ``Institution`` aggregate and ``build_institution`` (ADR-134).

These exercise the domain invariants (non-empty name, known type) and the
value-object parsing, including the new ``wallet`` member. They use plain Python
objects only — no database, no I/O.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from margen_api.domain.models.exceptions import EmptyNameError, UnknownInstitutionTypeError
from margen_api.domain.models.institution import Institution, build_institution
from margen_api.domain.models.value_objects import InstitutionType

A_USER = "00000000-0000-4000-8000-000000000001"


def _build(**overrides: object) -> Institution:
    """Build a valid institution, letting individual tests override fields."""
    defaults: dict[str, object] = {
        "name": "Galicia",
        "type": InstitutionType.BANK,
        "user_id": A_USER,
    }
    defaults.update(overrides)
    return build_institution(**defaults)  # type: ignore[arg-type]


class TestNameInvariant:
    """The display name must be a non-empty label (mirrors ADR-024)."""

    async def test_empty_name_is_rejected(self):
        """
        GIVEN a build request with an empty name
        WHEN the institution is built
        THEN an EmptyNameError is raised
        """
        # WHEN / THEN
        with pytest.raises(EmptyNameError):
            _build(name="   ")

    async def test_name_is_trimmed(self):
        """
        GIVEN a build request whose name has surrounding whitespace
        WHEN the institution is built
        THEN the stored name is trimmed
        """
        # WHEN
        institution = _build(name="  Deel  ")

        # THEN
        assert institution.name == "Deel"


class TestTypeParsing:
    """``type`` parses known strings, including ``wallet``, and rejects unknowns (ADR-134)."""

    async def test_type_parses_from_string(self):
        """
        GIVEN a build request whose type arrives as a string
        WHEN the institution is built
        THEN the type is the matching InstitutionType member
        """
        # WHEN
        institution = _build(type="cash")

        # THEN
        assert institution.type is InstitutionType.CASH

    async def test_wallet_type_is_supported(self):
        """
        GIVEN a wallet provider such as Deel
        WHEN the institution is built with type "wallet"
        THEN the type is InstitutionType.WALLET (ADR-134)
        """
        # WHEN
        institution = _build(name="Deel", type="wallet")

        # THEN
        assert institution.type is InstitutionType.WALLET

    async def test_unknown_type_is_rejected(self):
        """
        GIVEN a build request with an unknown type
        WHEN the institution is built
        THEN an UnknownInstitutionTypeError carrying the value is raised
        """
        # WHEN / THEN
        with pytest.raises(UnknownInstitutionTypeError) as exc_info:
            _build(type="crypto")
        assert exc_info.value.institution_type == "crypto"

    async def test_parse_passes_through_member(self):
        """
        GIVEN an InstitutionType member
        WHEN it is parsed
        THEN the same member is returned (idempotent)
        """
        # WHEN / THEN
        assert InstitutionType.parse(InstitutionType.WALLET) is InstitutionType.WALLET


class TestIdentityAndTimestamps:
    """The factory generates identity/timestamps when not injected (ADR-026)."""

    async def test_generates_id_and_timestamps_when_omitted(self):
        """
        GIVEN a build request without an explicit id or timestamps
        WHEN the institution is built
        THEN a UUID identity and creation/update timestamps are generated
        """
        # WHEN
        institution = _build()

        # THEN
        assert isinstance(institution.id, UUID)
        assert isinstance(institution.created_at, datetime)
        assert isinstance(institution.updated_at, datetime)

    async def test_injected_identity_and_timestamps_are_preserved(self):
        """
        GIVEN explicit id and timestamps (as the handler injects)
        WHEN the institution is built
        THEN they are preserved verbatim (ADR-026)
        """
        # GIVEN
        institution_id = uuid4()
        moment = datetime(2026, 1, 1, tzinfo=UTC)

        # WHEN
        institution = _build(institution_id=institution_id, created_at=moment, updated_at=moment)

        # THEN
        assert institution.id == institution_id
        assert institution.created_at == moment
        assert institution.updated_at == moment
