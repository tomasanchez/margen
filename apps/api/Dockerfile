FROM python:3.13-slim AS builder

ARG APP_DIR=/app

ENV PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    PYTHONFAULTHANDLER=1 \
    UV_PYTHON=python3.13 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Install uv.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR ${APP_DIR}

# Copy dependency definition files.
COPY pyproject.toml uv.lock .python-version README.md ${APP_DIR}/

# Build the virtual environment from the lock file, excluding dev dependencies.
# This creates a self-contained .venv directory.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Copy the project into the image and sync it.
COPY src ${APP_DIR}/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.13-slim AS runtime

ARG APP_DIR=/app

# UVICORN_PORT is intentionally NOT set here. The app's UvicornSettings honors
# the unprefixed `PORT` that PaaS hosts (Render) inject and falls back to 8000
# when neither PORT nor UVICORN_PORT is present. Hardcoding UVICORN_PORT would
# take precedence and break the host-assigned port binding.
ENV PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    PYTHONFAULTHANDLER=1 \
    PATH="${APP_DIR}/.venv/bin:$PATH" \
    UVICORN_HOST=0.0.0.0 \
    UVICORN_RELOAD=0

# Native runtime dependency for QR decoding: pyzbar wraps the system zbar shared
# library (ADR-069). PyMuPDF needs no apt deps (manylinux wheels). Installed as
# root before dropping privileges, then the apt lists are pruned to keep slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libzbar0 \
    && rm -rf /var/lib/apt/lists/*

# Create an unprivileged application user.
RUN groupadd --system app && useradd --system --gid app --home-dir ${APP_DIR} app

WORKDIR ${APP_DIR}

# Copy the prebuilt virtual environment and the application source.
COPY --from=builder --chown=app:app ${APP_DIR}/.venv ${APP_DIR}/.venv
COPY --from=builder --chown=app:app ${APP_DIR}/src ${APP_DIR}/src

USER app

# Documentation only — the default local port. On Render the listen port comes
# from the injected $PORT (UvicornSettings reads it); EXPOSE does not affect that.
EXPOSE 8000

# Run the application using the Python from the prebuilt venv.
CMD ["python", "-m", "margen_api.main"]
