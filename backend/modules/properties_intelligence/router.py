"""
FastAPI router for Property Intelligence System
File: backend/modules/properties_intelligence/router.py

Add to main.py:
    from modules.properties_intelligence.router import router as properties_intelligence_router
    app.include_router(properties_intelligence_router, prefix="/api/properties", tags=["properties"])
"""

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, avg
from uuid import UUID
from typing import List, Optional
from datetime import datetime, timedelta
from supabase import create_client, Client as SupabaseClient
import os

from database.db import get_db
from database.models import PropertyProfile, PropertyPhoto, TimeEstimateHistory, Client

router = APIRouter()

# Supabase client for photo uploads (lazy init to avoid crash when env vars missing)
STORAGE_BUCKET = "property-photos"
_supabase: Optional[SupabaseClient] = None

def _get_supabase() -> SupabaseClient:
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise HTTPException(status_code=503, detail="Supabase not configured")
        _supabase = create_client(url, key)
    return _supabase


# ────────────────────────────────────────────────────────────────────
# Pydantic Schemas
# ────────────────────────────────────────────────────────────────────

from pydantic import BaseModel, Field, validator

class PropertyProfileCreate(BaseModel):
    client_id: UUID
    address: str
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    property_type: str = "residential"  # residential, commercial, rental
    square_footage: Optional[int] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
    construction_type: Optional[str] = None
    access_type: Optional[str] = None
    access_instructions: Optional[str] = None
    hazard_notes: Optional[str] = None
    pet_alerts: Optional[str] = None
    equipment_required: Optional[List[str]] = []
    avg_condition_rating: Optional[float] = None
    condition_notes: Optional[str] = None

    @validator('avg_condition_rating')
    def validate_rating(cls, v):
        if v is not None and (v < 1 or v > 5):
            raise ValueError('Condition rating must be between 1 and 5')
        return v


class PropertyProfileUpdate(BaseModel):
    address: Optional[str] = None
    property_type: Optional[str] = None
    square_footage: Optional[int] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
    avg_condition_rating: Optional[float] = None
    condition_notes: Optional[str] = None
    hazard_notes: Optional[str] = None
    pet_alerts: Optional[str] = None
    equipment_required: Optional[List[str]] = None
    last_service_date: Optional[datetime] = None


class PropertyProfileResponse(BaseModel):
    id: UUID
    client_id: UUID
    address: str
    property_type: str
    square_footage: Optional[int]
    bedrooms: Optional[int]
    bathrooms: Optional[int]
    avg_condition_rating: Optional[float]
    complexity_score: Optional[int]
    historical_avg_time_minutes: Optional[int]
    historical_sample_size: int
    photos_count: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PropertyPhotoResponse(BaseModel):
    id: UUID
    property_id: UUID
    job_id: Optional[UUID]
    photo_url: str
    photo_type: str
    room_name: Optional[str]
    uploaded_at: datetime

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────────────────────────
# Create Property
# ────────────────────────────────────────────────────────────────────

@router.post("/", response_model=PropertyProfileResponse, tags=["property-intelligence"])
async def create_property(
    property_data: PropertyProfileCreate,
    db: Session = Depends(get_db)
):
    """Create a new property profile with intelligent defaults."""

    # Verify client exists
    client = db.query(Client).filter(Client.id == property_data.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    # Create property
    property_profile = PropertyProfile(**property_data.dict())

    # Calculate complexity score
    property_profile.complexity_score = property_profile.calculate_complexity_score()

    db.add(property_profile)
    db.commit()
    db.refresh(property_profile)

    return property_profile


# ────────────────────────────────────────────────────────────────────
# Get Property Details
# ────────────────────────────────────────────────────────────────────

@router.get("/{property_id}", response_model=PropertyProfileResponse, tags=["property-intelligence"])
async def get_property(property_id: UUID, db: Session = Depends(get_db)):
    """Get detailed property profile with time estimates and photos."""
    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")
    return property_profile


# ────────────────────────────────────────────────────────────────────
# Update Property
# ────────────────────────────────────────────────────────────────────

@router.put("/{property_id}", response_model=PropertyProfileResponse, tags=["property-intelligence"])
async def update_property(
    property_id: UUID,
    property_data: PropertyProfileUpdate,
    db: Session = Depends(get_db)
):
    """Update property profile and recalculate complexity."""
    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")

    # Update fields
    for field, value in property_data.dict(exclude_unset=True).items():
        setattr(property_profile, field, value)

    # Recalculate complexity
    property_profile.complexity_score = property_profile.calculate_complexity_score()

    db.commit()
    db.refresh(property_profile)
    return property_profile


# ────────────────────────────────────────────────────────────────────
# Upload Property Photos
# ────────────────────────────────────────────────────────────────────

@router.post("/{property_id}/upload-photo", response_model=PropertyPhotoResponse, tags=["property-intelligence"])
async def upload_property_photo(
    property_id: UUID,
    file: UploadFile = File(...),
    photo_type: str = Query("reference"),  # before, during, after, reference
    room_name: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Upload property photo to S3 and track in database."""

    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")

    try:
        file_key = f"properties/{property_id}/{datetime.now().isoformat()}_{file.filename}"
        file_content = await file.read()

        sb = _get_supabase()
        response = sb.storage.from_(STORAGE_BUCKET).upload(
            file_key,
            file_content,
            file_options={"content-type": file.content_type}
        )

        photo_url = sb.storage.from_(STORAGE_BUCKET).get_public_url(file_key)

        # Save to database
        photo = PropertyPhoto(
            property_id=property_id,
            photo_url=photo_url,
            photo_type=photo_type,
            room_name=room_name
        )
        db.add(photo)

        # Increment photo count
        property_profile.photos_count += 1

        db.commit()
        db.refresh(photo)
        return photo

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Photo upload failed: {str(e)}")


# ────────────────────────────────────────────────────────────────────
# Get Property Photos
# ────────────────────────────────────────────────────────────────────

@router.get("/{property_id}/photos", response_model=List[PropertyPhotoResponse], tags=["property-intelligence"])
async def get_property_photos(
    property_id: UUID,
    photo_type: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Get all photos for a property, optionally filtered by type."""
    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")

    query = db.query(PropertyPhoto).filter(PropertyPhoto.property_id == property_id)

    if photo_type:
        query = query.filter(PropertyPhoto.photo_type == photo_type)

    return query.order_by(PropertyPhoto.uploaded_at.desc()).all()


# ────────────────────────────────────────────────────────────────────
# Estimate Clean Time
# ────────────────────────────────────────────────────────────────────

class TimeEstimateResponse(BaseModel):
    estimated_minutes: int
    confidence: str  # "high", "medium", "low"
    reasoning: str
    sample_size: int


@router.get("/{property_id}/estimate-time", response_model=TimeEstimateResponse, tags=["property-intelligence"])
async def estimate_clean_time(property_id: UUID, db: Session = Depends(get_db)):
    """Get intelligent time estimate for property based on historical data + complexity."""

    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")

    estimated_minutes = property_profile.estimate_clean_time()
    sample_size = property_profile.historical_sample_size or 0

    # Determine confidence level
    if sample_size >= 10:
        confidence = "high"
        reasoning = f"Based on {sample_size} historical jobs at this property"
    elif sample_size >= 3:
        confidence = "medium"
        reasoning = f"Based on {sample_size} jobs (small sample)"
    else:
        confidence = "low"
        reasoning = "Formula-based estimate (no historical data)"

    return {
        "estimated_minutes": estimated_minutes,
        "confidence": confidence,
        "reasoning": reasoning,
        "sample_size": sample_size
    }


# ────────────────────────────────────────────────────────────────────
# Record Job Completion Time (For ML Training)
# ────────────────────────────────────────────────────────────────────

class TimeEstimateRecordRequest(BaseModel):
    job_id: UUID
    estimated_time_minutes: int
    actual_time_minutes: int
    crew_size: Optional[int] = None
    crew_id: Optional[UUID] = None
    property_condition_rating: Optional[int] = None
    equipment_used: Optional[List[str]] = []
    notes: Optional[str] = None


@router.post("/{property_id}/record-time", tags=["property-intelligence"])
async def record_job_time(
    property_id: UUID,
    time_data: TimeEstimateRecordRequest,
    db: Session = Depends(get_db)
):
    """Record actual job time for ML model training."""

    property_profile = db.query(PropertyProfile).filter(PropertyProfile.id == property_id).first()
    if not property_profile:
        raise HTTPException(status_code=404, detail="Property not found")

    # Save to history
    time_estimate = TimeEstimateHistory(
        property_id=property_id,
        **time_data.dict()
    )
    db.add(time_estimate)

    # Update property's historical averages
    all_estimates = db.query(TimeEstimateHistory).filter(
        TimeEstimateHistory.property_id == property_id,
        TimeEstimateHistory.actual_time_minutes.isnot(None)
    ).all()

    if all_estimates:
        avg_time = sum(e.actual_time_minutes for e in all_estimates) / len(all_estimates)
        property_profile.historical_avg_time_minutes = int(avg_time)
        property_profile.historical_sample_size = len(all_estimates)

    db.commit()
    return {"status": "recorded", "sample_size": property_profile.historical_sample_size}


# ────────────────────────────────────────────────────────────────────
# List Client Properties
# ────────────────────────────────────────────────────────────────────

@router.get("/client/{client_id}/all", response_model=List[PropertyProfileResponse], tags=["property-intelligence"])
async def list_client_properties(
    client_id: UUID,
    property_type: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """List all properties for a client."""

    query = db.query(PropertyProfile).filter(PropertyProfile.client_id == client_id)

    if property_type:
        query = query.filter(PropertyProfile.property_type == property_type)

    return query.order_by(PropertyProfile.updated_at.desc()).all()


# ────────────────────────────────────────────────────────────────────
# Analytics: Property Complexity Distribution
# ────────────────────────────────────────────────────────────────────

@router.get("/analytics/complexity-distribution", tags=["property-intelligence"])
async def complexity_distribution(db: Session = Depends(get_db)):
    """Analytics: How are properties distributed by complexity?"""

    results = db.query(
        PropertyProfile.complexity_score,
        func.count(PropertyProfile.id).label("count")
    ).filter(
        PropertyProfile.complexity_score.isnot(None)
    ).group_by(
        PropertyProfile.complexity_score
    ).order_by(
        PropertyProfile.complexity_score
    ).all()

    return {
        "distribution": [
            {"complexity_score": score, "count": count}
            for score, count in results
        ],
        "total_properties": sum(count for _, count in results)
    }


# ────────────────────────────────────────────────────────────────────
# Analytics: Time Estimation Accuracy
# ────────────────────────────────────────────────────────────────────

@router.get("/analytics/estimation-accuracy", tags=["property-intelligence"])
async def estimation_accuracy(
    days_back: int = Query(30, ge=7, le=365),
    db: Session = Depends(get_db)
):
    """Analytics: How accurate are our time estimates?"""

    cutoff_date = datetime.now() - timedelta(days=days_back)

    completed_estimates = db.query(TimeEstimateHistory).filter(
        TimeEstimateHistory.recorded_at >= cutoff_date,
        TimeEstimateHistory.actual_time_minutes.isnot(None)
    ).all()

    if not completed_estimates:
        return {
            "avg_accuracy_ratio": None,
            "sample_size": 0,
            "message": "No completed jobs in this period"
        }

    accuracy_ratios = [e.estimation_accuracy for e in completed_estimates if e.estimation_accuracy]
    avg_accuracy = sum(accuracy_ratios) / len(accuracy_ratios)

    return {
        "avg_accuracy_ratio": round(avg_accuracy, 3),  # 1.0 = perfect
        "sample_size": len(completed_estimates),
        "over_estimated_count": sum(1 for r in accuracy_ratios if r < 1),
        "accurate_count": sum(1 for r in accuracy_ratios if 0.95 <= r <= 1.05),
        "under_estimated_count": sum(1 for r in accuracy_ratios if r > 1.05),
        "reasoning": "Over 1.0 = we underestimated time, Under 1.0 = we overestimated"
    }
