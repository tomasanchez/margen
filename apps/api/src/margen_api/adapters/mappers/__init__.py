"""Adapter-layer mappers between domain aggregates and persistence records.

Mappers translate plain Python domain objects to and from their SQLAlchemy
records. They keep the conversion logic out of the repository while ensuring
SQLAlchemy stays strictly inside the adapter layer (AGENTS.md).
"""
