"""
SQLAlchemy models for Property Intelligence System (Sprint 1)
Add to: backend/database/models.py
"""

from datetime import datetime
from typing import Optional, List
from enum import Enum
from uuid import uuid4
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, ARRAY, Text, Date, Enum as SQLEnum,
    ForeignKey, DateTime, Numeric, Index, UniqueConstraint, func, CheckConstraint
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.ext.hybrid import hybrid_property

# Enum definitions
class PropertyTypeEnum(str, Enum):
    RESIDENTIAL = "residential"
    COMMERCIAL = "commercial"
    RENTAL = "rental"

class AccessTypeEnum(str, Enum):
    ENTRY_CODE = "entry_code"
    LANDLORD = "landlord"
    TENANT = "tenant"
    KEY_PICKUP = "key_pickup"
    OTHER = "other"

class ConstructionTypeEnum(str, Enum):
    CARPET = "carpet"
    HARDWOOD = "hardwood"
    TILE = "tile"
    LAMINATE = "laminate"
    MIXED = "mixed"
    CONCRETE = "concrete"

class PhotoTypeEnum(str, Enum):
    BEFORE = "before"
    DURING = "during"
    AFTER = "after"
    REFERENCE = "reference"


class PropertyProfile(Base):
    """
    Comprehensive property profile for intelligent scheduling.
    Links to Client and tracks historical performance data.
    """
    __tablename__ = "property_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    client_id = Column(UUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)

    # Location
    address = Column(String(255), nullable=False)
    city = Column(String(100))
    state = Column(String(2))
    zip_code = Column(String(10))
    lat = Column(Numeric(10, 8))
    lng = Column(Numeric(11, 8))

    # Property Details
    property_type = Column(SQLEnum(PropertyTypeEnum), nullable=False, default=PropertyTypeEnum.RESIDENTIAL)
    square_footage = Column(Integer)
    bedrooms = Column(Integer)
    bathrooms = Column(Integer)
    construction_type = Column(SQLEnum(ConstructionTypeEnum))

    # Access & Safety
    access_type = Column(SQLEnum(AccessTypeEnum))
    access_instructions = Column(Text)
    hazard_notes = Column(Text)
    pet_alerts = Column(Text)
    equipment_required = Column(ARRAY(String), default=[])

    # Condition & Complexity
    avg_condition_rating = Column(Numeric(3, 2))  # 1-5 scale
    condition_notes = Column(Text)
    complexity_score = Column(Integer)  # 1-10 calculated score

    # Time Tracking for ML
    historical_avg_time_minutes = Column(Integer)
    historical_sample_size = Column(Integer, default=0)
    time_confidence_interval = Column(Numeric(3, 2))  # Standard deviation
    last_service_date = Column(Date)

    # Metadata
    photos_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=func.now(), onupdate=func.now())

    # Relationships
    client = relationship("Client", back_populates="properties")
    photos = relationship("PropertyPhoto", back_populates="property", cascade="all, delete-orphan")
    time_estimates = relationship("TimeEstimateHistory", back_populates="property", cascade="all, delete-orphan")
    jobs = relationship("Job", back_populates="property")

    # Indexes
    __table_args__ = (
        UniqueConstraint('client_id', 'address', name='uq_property_client_address'),
        Index('idx_property_type', 'property_type'),
        Index('idx_complexity_score', 'complexity_score'),
        Index('idx_coordinates', 'lat', 'lng'),
        CheckConstraint('avg_condition_rating >= 1 AND avg_condition_rating <= 5'),
        CheckConstraint('complexity_score >= 1 AND complexity_score <= 10'),
    )

    @hybrid_property
    def is_complex_property(self) -> bool:
        """Quick check: is this property complex? (score > 6)"""
        if self.complexity_score is None:
            return False
        return self.complexity_score > 6

    def calculate_complexity_score(self) -> int:
        """
        AI-driven complexity calculation based on property attributes.
        Returns 1-10 score.
        """
        score = 1

        # Property type multiplier
        if self.property_type == PropertyTypeEnum.RENTAL:
            score += 3  # Rentals always more complex
        elif self.property_type == PropertyTypeEnum.COMMERCIAL:
            score += 2  # Commercial more complex than residential

        # Size multiplier
        if self.square_footage:
            if self.square_footage > 5000:
                score += 3
            elif self.square_footage > 3000:
                score += 2
            elif self.square_footage > 1500:
                score += 1

        # Condition multiplier
        if self.avg_condition_rating:
            if self.avg_condition_rating < 2:
                score += 3  # Very poor = very complex
            elif self.avg_condition_rating < 3:
                score += 2

        # Construction type multiplier
        if self.construction_type == ConstructionTypeEnum.MIXED:
            score += 2
        elif self.construction_type == ConstructionTypeEnum.HARDWOOD:
            score += 1

        # Equipment/special needs
        if self.equipment_required and len(self.equipment_required) > 2:
            score += 1

        # Hazards
        if self.hazard_notes:
            score += 1
        if self.pet_alerts:
            score += 1

        # Cap at 10
        return min(score, 10)

    def estimate_clean_time(self) -> Optional[int]:
        """
        Estimate cleaning time in minutes based on historical data and property characteristics.
        Returns minutes, or None if insufficient data.
        """
        if self.historical_sample_size < 3:
            # Not enough data, use formula instead
            return self._formula_estimate()

        # Use historical data with complexity adjustment
        base_time = self.historical_avg_time_minutes
        complexity_multiplier = 1 + (self.complexity_score or 5) / 20
        return int(base_time * complexity_multiplier)

    def _formula_estimate(self) -> int:
        """Fallback formula-based time estimation"""
        base_time = 90  # 1.5 hours default for residential

        if self.property_type == PropertyTypeEnum.COMMERCIAL:
            base_time = 30  # Per 1000 sqft for commercial
            if self.square_footage:
                return int((self.square_footage / 1000) * base_time)

        if self.square_footage:
            rate = 0.05  # hours per sqft
            base_time = int(self.square_footage * rate * 60)

        # Apply complexity multiplier
        if self.complexity_score:
            base_time = int(base_time * (1 + self.complexity_score / 20))

        return base_time


class PropertyPhoto(Base):
    """
    Photo history for properties. Tracks before/after for quality verification.
    """
    __tablename__ = "property_photos"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    property_id = Column(UUID(as_uuid=True), ForeignKey("property_profiles.id", ondelete="CASCADE"), nullable=False)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))

    photo_url = Column(String(512), nullable=False)
    photo_type = Column(SQLEnum(PhotoTypeEnum), nullable=False)
    room_name = Column(String(100))
    uploaded_by_crew_id = Column(UUID(as_uuid=True), ForeignKey("crews.id", ondelete="SET NULL"))
    uploaded_at = Column(DateTime(timezone=True), nullable=False, default=func.now())

    # Relationships
    property = relationship("PropertyProfile", back_populates="photos")
    job = relationship("Job", back_populates="photos")

    __table_args__ = (
        Index('idx_property_photos_property_id', 'property_id'),
        Index('idx_property_photos_job_id', 'job_id'),
        Index('idx_property_photos_uploaded_at', 'uploaded_at'),
    )


class TimeEstimateHistory(Base):
    """
    Training data for time estimation ML model.
    Each completed job contributes a data point.
    """
    __tablename__ = "time_estimates_history"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    property_id = Column(UUID(as_uuid=True), ForeignKey("property_profiles.id", ondelete="CASCADE"), nullable=False)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))

    # Estimates
    estimated_time_minutes = Column(Integer, nullable=False)
    actual_time_minutes = Column(Integer)  # Null until job completes

    # Context
    crew_size = Column(Integer)
    crew_id = Column(UUID(as_uuid=True), ForeignKey("crews.id", ondelete="SET NULL"))
    property_condition_rating = Column(Integer)  # 1-5 as of this job
    equipment_used = Column(ARRAY(String), default=[])
    notes = Column(Text)

    recorded_at = Column(DateTime(timezone=True), nullable=False, default=func.now())

    # Relationships
    property = relationship("PropertyProfile", back_populates="time_estimates")
    job = relationship("Job", back_populates="time_estimates")

    @hybrid_property
    def estimation_accuracy(self) -> Optional[float]:
        """Calculate accuracy ratio: actual / estimated (1.0 = perfect)"""
        if not self.actual_time_minutes:
            return None
        return self.actual_time_minutes / self.estimated_time_minutes if self.estimated_time_minutes > 0 else None

    __table_args__ = (
        Index('idx_time_estimates_property_id', 'property_id'),
        Index('idx_time_estimates_job_id', 'job_id'),
        Index('idx_time_estimates_recorded_at', 'recorded_at'),
    )


# IMPORTANT: Add these relationships to existing models:
# 1. Add to Client model:
#    properties = relationship("PropertyProfile", back_populates="client", cascade="all, delete-orphan")
#
# 2. Add to Job model:
#    property_id = Column(UUID(as_uuid=True), ForeignKey("property_profiles.id", ondelete="SET NULL"))
#    property = relationship("PropertyProfile", back_populates="jobs")
#    photos = relationship("PropertyPhoto", back_populates="job")
#    time_estimates = relationship("TimeEstimateHistory", back_populates="job")
#
# 3. Add to Crew model:
#    uploaded_photos = relationship("PropertyPhoto", foreign_keys=[PropertyPhoto.uploaded_by_crew_id])
