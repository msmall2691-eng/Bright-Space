"""
Shared SQLAlchemy Base declarative class.

This is in its own module to avoid circular imports between db.py and models.py
"""
from sqlalchemy.orm import declarative_base

Base = declarative_base()
