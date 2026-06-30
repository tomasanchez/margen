"""Boundary schemas for the budgets REST contract (ADR-125, ADR-030, ADR-138, ADR-143).

These Pydantic models translate the budgets read models to and from the JSON the
frontend builds to (the pinned contract). Money crosses the boundary as a decimal
string exactly as the rest of the app serializes ``Decimal`` (ADR-025, ADR-030).
``target`` and ``remaining`` are nullable: a category with no target reads back
``null`` for both (ADR-125). The upsert body carries the ``YYYY-MM`` month the
entrypoint parses into a period (ADR-040), mirroring the summaries month-navigator
contract.

The MVP additions ride alongside the existing spend surface (ADR-138, ADR-143): a
``savings`` array (one line per saving bucket), a ``floor`` readout, and the
``suggestedStrategy`` / ``pressure`` advisory fields. Saving rows never leak into
``categories`` — they are a separate array (ADR-138).

Pinned JSON contract:

* GET ``/budgets?month=YYYY-MM`` -> ``{ month, currency, categories: [...],
  savings: [{ bucket, amount, percent: string|null }],
  floor: { amount: string|null, source: string|null },
  suggestedStrategy: string|null, pressure: string|null }``
* PUT ``/budgets`` body ``{ category, month, amount, currency?, kind? }``
* DELETE ``/budgets?category&month&kind?``
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import Field

from margen_api.domain.commands.budget import UpsertBudget
from margen_api.domain.models.value_objects import BudgetKind, Currency
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.budget_read_models import (
    BudgetLine,
    CategoryHistory,
    CategoryHistoryLine,
    Floor,
    MonthlyBudget,
    SavingLine,
)


class BudgetLineResponse(CamelCaseModel):
    """One expense category's target vs actual for the month (ADR-125)."""

    category: str = Field(description="The expense category label.")
    target: Decimal | None = Field(
        default=None,
        description="The budget target for the category this month; null when unset (ADR-125).",
    )
    spent: Decimal = Field(description="The category's ARS-equivalent expense total for the month (ADR-042).")
    remaining: Decimal | None = Field(
        default=None,
        description="target - spent when a target is set; null otherwise (ADR-125).",
    )
    is_essential: bool = Field(
        description="Whether the category is an essential 'Needs' floor category, serialized as 'isEssential' (ADR-143).",
    )
    target_currency: str | None = Field(
        default=None,
        description=(
            "The native currency the target was STORED in ('USD'/'ARS'); null when "
            "no target is set. Independent of the requested spend currency — the "
            "client converts it to the preferred display currency (ADR-152/155). "
            "Serialized as 'targetCurrency'."
        ),
    )

    @classmethod
    def from_read_model(cls, model: BudgetLine) -> BudgetLineResponse:
        """Build the response line from a budget read model (ADR-030)."""
        return cls(
            category=model.category,
            target=model.target,
            spent=model.spent,
            remaining=model.remaining,
            is_essential=model.is_essential,
            target_currency=model.target_currency,
        )


class SavingLineResponse(CamelCaseModel):
    """One saving bucket's monthly allocation for the month (ADR-138)."""

    bucket: str = Field(description="The saving-bucket key (a SAVING_BUCKETS value).")
    amount: Decimal = Field(description="The bucket's ARS-equivalent monthly allocation (ADR-025).")
    percent: Decimal | None = Field(
        default=None,
        description="The bucket as a percentage of net income; null when no income base exists.",
    )

    @classmethod
    def from_read_model(cls, model: SavingLine) -> SavingLineResponse:
        """Build the response line from a saving read model (ADR-030)."""
        return cls(bucket=model.bucket, amount=model.amount, percent=model.percent)


class FloorResponse(CamelCaseModel):
    """The household-floor readout for the month (ADR-143)."""

    amount: Decimal | None = Field(default=None, description="The essentials floor; null when unset.")
    source: str | None = Field(default=None, description="Floor provenance: 'manual' or 'computed'; null when unset.")

    @classmethod
    def from_read_model(cls, model: Floor) -> FloorResponse:
        """Build the floor response from the read model (ADR-030)."""
        return cls(amount=model.amount, source=model.source)


class MonthlyBudgetResponse(CamelCaseModel):
    """The budgets-vs-actuals + savings + floor surface returned to clients (ADR-125, ADR-138)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    currency: Currency = Field(description="The currency targets and spend are expressed in; ARS for the MVP.")
    categories: list[BudgetLineResponse] = Field(
        description="One line per expense category, sorted by category name (kind='spend' only).",
    )
    savings: list[SavingLineResponse] = Field(
        description="One line per saving bucket, sorted by bucket name (kind='saving').",
    )
    floor: FloorResponse = Field(description="The household-floor readout (essentials vs income).")
    suggested_strategy: str | None = Field(
        default=None,
        description="Strategy suggestion (conservative/balanced/aggressive); null without an income base.",
    )
    pressure: str | None = Field(
        default=None,
        description="Income-pressure segment (constrained/stable/comfortable); null without an income base.",
    )
    unconverted: int = Field(
        description="Count of the month's expense transactions lacking a USD snapshot; 0 for ARS budgets (ADR-152).",
    )

    @classmethod
    def from_read_model(cls, model: MonthlyBudget) -> MonthlyBudgetResponse:
        """Build the response from a monthly-budget read model (ADR-030)."""
        return cls(
            month=model.month,
            currency=model.currency,
            categories=[BudgetLineResponse.from_read_model(line) for line in model.categories],
            savings=[SavingLineResponse.from_read_model(line) for line in model.savings],
            floor=FloorResponse.from_read_model(model.floor),
            suggested_strategy=model.suggested_strategy,
            pressure=model.pressure,
            unconverted=model.unconverted,
        )


class CategoryHistoryLineResponse(CamelCaseModel):
    """One expense category's trailing spend history for budget templating (ADR-145)."""

    category: str = Field(description="The expense category label.")
    # Pin the alias to 'avg3mo': the camel-case generator would otherwise capitalize
    # the segment after the digit ('avg3Mo'), breaking the pinned contract (ADR-030).
    avg3mo: Decimal = Field(
        alias="avg3mo",
        description="Mean ARS-equivalent spend over the 3 calendar months before the requested month (ADR-025).",
    )
    last_month: Decimal = Field(
        description="The category's ARS-equivalent spend in the single prior month; serialized as 'lastMonth'.",
    )

    @classmethod
    def from_read_model(cls, model: CategoryHistoryLine) -> CategoryHistoryLineResponse:
        """Build the response line from a category-history read model (ADR-030)."""
        return cls(category=model.category, avg3mo=model.avg3mo, last_month=model.last_month)


class CategoryHistoryResponse(CamelCaseModel):
    """The trailing per-category spend history returned to clients (ADR-145).

    Backs the Budgets redesign templates ("Match 3-mo avg" / "Match last month")
    and the per-row "use avg" chips. Pinned JSON contract::

        GET /budgets/history?month=YYYY-MM ->
            { categories: [ { category, avg3mo, lastMonth } ] }
    """

    categories: list[CategoryHistoryLineResponse] = Field(
        description="One line per expense category seen in the trailing spend, sorted by category name.",
    )

    @classmethod
    def from_read_model(cls, model: CategoryHistory) -> CategoryHistoryResponse:
        """Build the response from a category-history read model (ADR-030)."""
        return cls(categories=[CategoryHistoryLineResponse.from_read_model(line) for line in model.categories])


class BudgetUpsertRequest(CamelCaseModel):
    """Request body for ``PUT /budgets`` (maps to :class:`UpsertBudget`).

    Sets or replaces a category's target for a month (upsert, ADR-125). ``month`` is
    the ``YYYY-MM`` month-navigator period the entrypoint parses into the first day
    of the month (ADR-040). ``amount`` is a positive decimal string (ADR-025);
    ``currency`` defaults to ARS (ADR-125). ``kind`` selects the spend or saving row
    (ADR-138); it defaults to ``spend`` so existing callers are unchanged.
    """

    category: str = Field(description="The expense category the target applies to.", min_length=1)
    month: str = Field(description="The budget month as 'YYYY-MM'.")
    amount: Decimal = Field(description="The target spend for the category this month; a decimal string (ADR-025).")
    currency: Currency = Field(default=Currency.ARS, description="The target currency; ARS for the MVP (ADR-125).")
    kind: BudgetKind = Field(default=BudgetKind.SPEND, description="The row kind: 'spend' or 'saving' (ADR-138).")

    def to_command(self, period: date, user_id: str) -> UpsertBudget:
        """Translate the request into an :class:`UpsertBudget` command.

        Args:
            period: The first day of the parsed ``month`` (the entrypoint parses the
                ``YYYY-MM`` string and validates it before dispatch).
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the target is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        # ``CamelCaseModel`` sets ``use_enum_values=True``, so an explicitly-supplied
        # enum field arrives as its string value while an unset field keeps the enum
        # default; normalize through the enum so both shapes yield the string token.
        return UpsertBudget(
            user_id=user_id,
            category=self.category,
            period=period,
            amount=self.amount,
            currency=Currency(self.currency).value,
            kind=BudgetKind(self.kind).value,
        )


class ApplyProfileRequest(CamelCaseModel):
    """Request body for ``POST /budgets/apply-profile`` (maps to :class:`ApplySavingProfile`).

    Applies a saving profile to a month's net-income base, writing ``kind='saving'``
    rows (ADR-138). ``profile`` is one of ``conservative`` / ``balanced`` /
    ``aggressive``; the entrypoint validates it through the domain.
    """

    month: str = Field(description="The budget month as 'YYYY-MM'.")
    profile: str = Field(description="The saving profile: 'conservative', 'balanced' or 'aggressive'.")
    currency: Currency = Field(
        default=Currency.ARS,
        description="The budget currency the refreshed surface is denominated in (ADR-152).",
    )


class ApplyProfileResponse(CamelCaseModel):
    """Response for ``POST /budgets/apply-profile``: the refreshed month + guard (ADR-138)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    currency: Currency = Field(description="The currency targets and spend are expressed in.")
    categories: list[BudgetLineResponse] = Field(description="One line per expense category (kind='spend').")
    savings: list[SavingLineResponse] = Field(description="One line per saving bucket (kind='saving').")
    floor: FloorResponse = Field(description="The household-floor readout.")
    suggested_strategy: str | None = Field(default=None, description="Strategy suggestion; null without income base.")
    pressure: str | None = Field(default=None, description="Income-pressure segment; null without income base.")
    unconverted: int = Field(
        description="Count of the month's expense transactions lacking a USD snapshot; 0 for ARS budgets (ADR-152).",
    )
    floor_breached: bool = Field(description="Whether the profile would underfund the household floor (warn-only).")
    gap: Decimal | None = Field(
        default=None,
        description="How far essentials fall short of the floor when breached; null otherwise.",
    )

    @classmethod
    def build(cls, model: MonthlyBudget, *, floor_breached: bool, gap: Decimal) -> ApplyProfileResponse:
        """Build the apply-profile response from the refreshed surface and the guard (ADR-030)."""
        return cls(
            month=model.month,
            currency=model.currency,
            categories=[BudgetLineResponse.from_read_model(line) for line in model.categories],
            savings=[SavingLineResponse.from_read_model(line) for line in model.savings],
            floor=FloorResponse.from_read_model(model.floor),
            suggested_strategy=model.suggested_strategy,
            pressure=model.pressure,
            unconverted=model.unconverted,
            floor_breached=floor_breached,
            gap=gap if floor_breached else None,
        )


class RepriceRequest(CamelCaseModel):
    """Request body for ``POST /budgets/reprice`` (maps to :class:`RepriceMonth`).

    Reprices the owner's ``kind='spend'`` caps from ``fromMonth`` into ``toMonth`` via
    ``round(cap x (1 + monthlyInflation/100)) + stepUp`` (ADR-137). ``monthlyInflation``
    is a percentage (e.g. ``"2.1"`` for 2.1%/month). ``stepUps`` is an optional map of
    per-category discrete jumps keyed by category.
    """

    from_month: str = Field(description="The source month as 'YYYY-MM' to reprice from.")
    to_month: str = Field(description="The target month as 'YYYY-MM' to reprice into.")
    monthly_inflation: Decimal = Field(description="The manual monthly inflation percentage (e.g. '2.1').")
    step_ups: dict[str, Decimal] = Field(
        default_factory=dict,
        description="Optional per-category discrete step-ups (rent index, tariff), keyed by category.",
    )
    currency: Currency = Field(
        default=Currency.ARS,
        description="The budget currency the repriced surface is denominated in (ADR-152).",
    )
