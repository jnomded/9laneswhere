import hmac
import logging
import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db as _db
from inference import load_model, scan_area

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    token = os.getenv("MAPBOX_TOKEN", "")
    if not token:
        logger.error("MAPBOX_TOKEN is not set — tile fetching will fail. Check app/backend/.env")
    else:
        logger.info("MAPBOX_TOKEN loaded (%s...)", token[:8])

    if not os.getenv("ADMIN_TOKEN", ""):
        logger.error("ADMIN_TOKEN is not set — admin endpoints will reject every request.")
    else:
        logger.info("ADMIN_TOKEN loaded.")

    load_model()

    dsn = os.getenv("DATABASE_URL", "")
    if dsn:
        app.state.db_pool = await _db.create_pool(dsn)
        await _db.ensure_schema(app.state.db_pool)
        logger.info("Database pool created and schema migrations applied.")
    else:
        app.state.db_pool = None
        logger.warning("DATABASE_URL not set — running without database (no caching).")

    yield

    if app.state.db_pool is not None:
        await app.state.db_pool.close()


app = FastAPI(title="TrackFinder API", lifespan=lifespan)

_extra_origin = os.getenv("ALLOWED_ORIGIN", "")
_origins = ["http://localhost:5173"] + ([_extra_origin] if _extra_origin else [])

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)


# ── Auth ─────────────────────────────────────────────────────────────────────

def _check_admin_token(token: str | None) -> bool:
    expected = os.getenv("ADMIN_TOKEN", "")
    if not expected or not token:
        return False
    return hmac.compare_digest(token, expected)


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    if not os.getenv("ADMIN_TOKEN", ""):
        raise HTTPException(status_code=503, detail="Admin auth not configured.")
    if not _check_admin_token(x_admin_token):
        raise HTTPException(status_code=401, detail="Invalid or missing admin token.")


# ── Request / Response models ────────────────────────────────────────────────

class ScanRequest(BaseModel):
    lat: float
    lng: float
    radius_km: float = Field(default=5.0, ge=1.0, le=15.0)
    threshold: float = Field(default=0.65, ge=0.5, le=0.99)


SURFACE_VALUES = {"synthetic", "dirt", "grass", "asphalt", "cinder", "other", "unknown"}
ACCESS_VALUES  = {"public", "school", "university", "private", "unknown"}


class TrackSubmission(BaseModel):
    lat: float
    lng: float
    name: str | None = None
    submitted_by: str | None = None
    lane_count: int | None = Field(default=None, ge=1, le=20)
    surface: str | None = None
    length_m: int | None = Field(default=None, ge=50, le=1000)
    is_indoor: bool | None = None
    access_type: str | None = None
    country: str | None = None
    notes: str | None = None


class TrackStatusUpdate(BaseModel):
    status: Literal["verified", "rejected"]
    verified_by: str | None = None
    lat: float | None = None
    lng: float | None = None


class TrackMetadataUpdate(BaseModel):
    name: str | None = None
    submitted_by: str | None = None
    lane_count: int | None = Field(default=None, ge=1, le=20)
    surface: str | None = None
    length_m: int | None = Field(default=None, ge=50, le=1000)
    is_indoor: bool | None = None
    access_type: str | None = None
    country: str | None = None
    notes: str | None = None


class AdminLoginRequest(BaseModel):
    token: str


def _validate_enum(value: str | None, allowed: set[str], field: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid {field}: must be one of {sorted(allowed)} or null.",
        )


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/admin/login")
def admin_login(body: AdminLoginRequest):
    if not os.getenv("ADMIN_TOKEN", ""):
        raise HTTPException(status_code=503, detail="Admin auth not configured.")
    if not _check_admin_token(body.token):
        raise HTTPException(status_code=401, detail="Invalid token.")
    return {"ok": True}


@app.post("/scan", dependencies=[Depends(require_admin)])
async def scan(req: ScanRequest):
    return await scan_area(
        req.lat, req.lng, req.radius_km, req.threshold,
        db_pool=app.state.db_pool,
    )


@app.post("/tracks", dependencies=[Depends(require_admin)])
async def submit_track(body: TrackSubmission):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    _validate_enum(body.surface, SURFACE_VALUES, "surface")
    _validate_enum(body.access_type, ACCESS_VALUES, "access_type")
    metadata = body.model_dump(exclude={"lat", "lng", "name", "submitted_by"}, exclude_none=True)
    return await _db.submit_track(
        app.state.db_pool,
        body.lat,
        body.lng,
        body.name,
        body.submitted_by,
        metadata=metadata,
    )


@app.get("/tracks")
async def list_tracks(
    min_lat: float | None = Query(default=None),
    min_lng: float | None = Query(default=None),
    max_lat: float | None = Query(default=None),
    max_lng: float | None = Query(default=None),
    status: str | None = Query(default="verified"),
    min_confidence: float = Query(default=0.0, ge=0.0, le=1.0),
    x_admin_token: str | None = Header(default=None),
):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    if status is not None and status != "verified" and not _check_admin_token(x_admin_token):
        raise HTTPException(status_code=401, detail="Admin token required for non-verified listings.")
    tracks = await _db.get_tracks(
        app.state.db_pool,
        min_lat=min_lat, min_lng=min_lng, max_lat=max_lat, max_lng=max_lng,
        status=status, min_confidence=min_confidence,
    )
    return {"tracks": tracks, "count": len(tracks)}


@app.get("/tracks/{track_id}")
async def get_track(track_id: int):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    track = await _db.get_track(app.state.db_pool, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return track


@app.patch("/tracks/{track_id}/status", dependencies=[Depends(require_admin)])
async def update_track_status(track_id: int, body: TrackStatusUpdate):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    updated = await _db.set_track_status(
        app.state.db_pool,
        track_id,
        body.status,
        body.verified_by,
        lat=body.lat,
        lng=body.lng,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Track not found.")
    return {"id": track_id, "status": body.status}


@app.patch("/tracks/{track_id}", dependencies=[Depends(require_admin)])
async def update_track_metadata(
    track_id: int,
    body: TrackMetadataUpdate,
    x_admin_token: str | None = Header(default=None),
):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    _validate_enum(body.surface, SURFACE_VALUES, "surface")
    _validate_enum(body.access_type, ACCESS_VALUES, "access_type")
    fields = body.model_dump(exclude_none=True)
    updated = await _db.update_track_metadata(
        app.state.db_pool, track_id, fields, revised_by="admin"
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return updated


@app.get("/tracks/{track_id}/revisions", dependencies=[Depends(require_admin)])
async def get_track_revisions(track_id: int):
    if app.state.db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured.")
    revisions = await _db.get_track_revisions(app.state.db_pool, track_id)
    return {"revisions": revisions, "count": len(revisions)}
