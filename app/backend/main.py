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
        logger.info("Database pool created.")
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


class TrackSubmission(BaseModel):
    lat: float
    lng: float
    name: str | None = None
    submitted_by: str | None = None


class TrackStatusUpdate(BaseModel):
    status: Literal["verified", "rejected"]
    verified_by: str | None = None
    lat: float | None = None
    lng: float | None = None


class AdminLoginRequest(BaseModel):
    token: str


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
    track_id = await _db.submit_track(
        app.state.db_pool, body.lat, body.lng, body.name, body.submitted_by
    )
    return {"id": track_id}


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
