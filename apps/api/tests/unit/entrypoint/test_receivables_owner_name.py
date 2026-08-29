"""Unit tests for the receivable PDF owner-name derivation (ADR-209 amended, ADR-092).

The per-person statement is handed to the debtor, so its covered section reads with the
OWNER'S name rather than an ambiguous "you". :func:`_owner_display_name` derives that name
from the verified JWT, mirroring the web ``AccountMenu`` identity chain:
``user_metadata.full_name`` then ``user_metadata.name`` then the email local-part, falling
back to the empty string (so the PDF drops the "by {owner}" suffix) when none is usable.
"""

from __future__ import annotations

from typing import Any

import pytest

from margen_api.entrypoint.dependencies import AuthUserModel
from margen_api.entrypoint.receivables import _owner_display_name

_USER_ID = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


def _user(*, email: str | None = "owner@example.com", claims: dict[str, Any] | None = None) -> AuthUserModel:
    """Build an authenticated user with the given email and JWT claims."""
    return AuthUserModel(id=_USER_ID, email=email, claims=claims if claims is not None else {"sub": _USER_ID})


class TestOwnerDisplayName:
    """The owner-name derivation chain for the covered section (ADR-209 amended)."""

    def test_prefers_user_metadata_full_name(self):
        """
        GIVEN a JWT carrying user_metadata.full_name
        WHEN the owner name is derived
        THEN the trimmed full name is used (the top of the chain)
        """
        # GIVEN
        user = _user(claims={"user_metadata": {"full_name": "  Tomas Sanchez  ", "name": "ignored"}})

        # WHEN / THEN
        assert _owner_display_name(user) == "Tomas Sanchez"

    def test_falls_back_to_user_metadata_name(self):
        """
        GIVEN user_metadata with a blank full_name but a name
        WHEN the owner name is derived
        THEN the name is used next in the chain
        """
        # GIVEN
        user = _user(claims={"user_metadata": {"full_name": "   ", "name": "Ada Lovelace"}})

        # WHEN / THEN
        assert _owner_display_name(user) == "Ada Lovelace"

    def test_falls_back_to_email_local_part(self):
        """
        GIVEN no usable user_metadata but an email
        WHEN the owner name is derived
        THEN the email local-part is used
        """
        # GIVEN — user_metadata is absent (claims carry only sub), like the real stub token.
        user = _user(email="tomas.sanchez@wheels.com")

        # WHEN / THEN
        assert _owner_display_name(user) == "tomas.sanchez"

    def test_dict_metadata_without_name_keys_falls_back_to_email(self):
        """
        GIVEN user_metadata that is an object but carries no full_name or name
        WHEN the owner name is derived
        THEN the name chain falls through to the email local-part
        """
        # GIVEN — a metadata object present (e.g. only an avatar), but no usable name key.
        user = _user(email="grace@example.com", claims={"user_metadata": {"avatar_url": "https://x/y.png"}})

        # WHEN / THEN
        assert _owner_display_name(user) == "grace"

    def test_ignores_non_dict_user_metadata(self):
        """
        GIVEN a malformed user_metadata claim (not an object)
        WHEN the owner name is derived
        THEN it is ignored and the email local-part is used instead
        """
        # GIVEN
        user = _user(email="june@example.com", claims={"user_metadata": "not-a-dict"})

        # WHEN / THEN
        assert _owner_display_name(user) == "june"

    @pytest.mark.parametrize("email", [None, "@example.com"])
    def test_returns_empty_when_nothing_derivable(self, email: str | None):
        """
        GIVEN no user_metadata and no usable email (missing or empty local-part)
        WHEN the owner name is derived
        THEN the empty string is returned so the PDF drops the "by {owner}" suffix
        """
        # GIVEN
        user = _user(email=email)

        # WHEN / THEN
        assert _owner_display_name(user) == ""
