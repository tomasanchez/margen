"""
Applicant Main File.
"""

from fastapi import FastAPI

from margen_api.asgi import get_application

app: FastAPI = get_application()


if __name__ == "__main__":
    import uvicorn

    from margen_api.settings.uvicorn_settings import UvicornSettings

    settings = UvicornSettings()

    uvicorn.run(
        "margen_api.main:app",
        host=str(settings.HOST),
        port=settings.PORT,
        log_level=settings.LOG_LEVEL,
        reload=settings.RELOAD,
    )
