import json

import asyncpg


# Columns on detected_tracks that are user-editable metadata (i.e. tracked in revisions).
METADATA_COLUMNS = (
    "name",
    "submitted_by",
    "lane_count",
    "surface",
    "length_m",
    "is_indoor",
    "access_type",
    "notes",
)


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=2, max_size=10)


async def ensure_schema(pool: asyncpg.Pool) -> None:
    """
    Idempotent migration applied at startup. schema.sql covers fresh installs,
    but existing DBs need ALTER statements to pick up new columns/tables.
    """
    async with pool.acquire() as conn:
        await conn.execute(
            """
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS lane_count   SMALLINT;
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS surface      TEXT;
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS length_m     SMALLINT;
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS is_indoor    BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS access_type  TEXT;
            ALTER TABLE detected_tracks ADD COLUMN IF NOT EXISTS notes        TEXT;
            -- country was added briefly then removed before the feature went out.
            ALTER TABLE detected_tracks DROP COLUMN IF EXISTS country;

            CREATE TABLE IF NOT EXISTS track_revisions (
                id           BIGSERIAL    PRIMARY KEY,
                track_id     BIGINT       NOT NULL REFERENCES detected_tracks(id) ON DELETE CASCADE,
                revised_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
                revised_by   TEXT,
                action       TEXT         NOT NULL,
                old_data     JSONB,
                new_data     JSONB,
                note         TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_track_revisions_track
                ON track_revisions (track_id, revised_at DESC);
            """
        )


async def _record_revision(
    conn: asyncpg.Connection,
    track_id: int,
    action: str,
    revised_by: str | None,
    old_data: dict | None,
    new_data: dict | None,
    note: str | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO track_revisions (track_id, revised_by, action, old_data, new_data, note)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        """,
        track_id,
        revised_by,
        action,
        json.dumps(old_data) if old_data is not None else None,
        json.dumps(new_data) if new_data is not None else None,
        note,
    )


def _row_to_track_dict(row: asyncpg.Record) -> dict:
    d = dict(row)
    # Convert any datetime fields to isoformat for JSON serialization in revisions.
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


async def get_cached_tiles(
    pool: asyncpg.Pool,
    zxy_list: list[tuple[int, int, int]],
) -> dict[tuple[int, int, int], dict]:
    """Return cached tile entries for the given (z,x,y) keys that have not expired."""
    if not zxy_list:
        return {}

    zs = [k[0] for k in zxy_list]
    xs = [k[1] for k in zxy_list]
    ys = [k[2] for k in zxy_list]

    rows = await pool.fetch(
        """
        SELECT z, x, y, ml_score
        FROM scanned_tiles
        WHERE expires_at > now()
          AND (z, x, y) IN (
              SELECT unnest($1::smallint[]), unnest($2::int[]), unnest($3::int[])
          )
        """,
        zs, xs, ys,
    )

    return {(r["z"], r["x"], r["y"]): {"ml_score": r["ml_score"]} for r in rows}


async def upsert_tiles(pool: asyncpg.Pool, entries: list[dict]) -> None:
    """Insert or refresh tile cache entries. Resets expires_at on conflict."""
    if not entries:
        return
    await pool.executemany(
        """
        INSERT INTO scanned_tiles (z, x, y, tile_lat, tile_lng, ml_score, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, now() + INTERVAL '30 days')
        ON CONFLICT (z, x, y) DO UPDATE
            SET ml_score   = EXCLUDED.ml_score,
                scanned_at = now(),
                expires_at = now() + INTERVAL '30 days'
        """,
        [(e["z"], e["x"], e["y"], e["tile_lat"], e["tile_lng"], e["ml_score"]) for e in entries],
    )


_TRACK_SELECT = """
    id,
    ST_Y(location) AS lat,
    ST_X(location) AS lng,
    confidence, status, name, submitted_by, verified_by, verified_at,
    first_seen_at, last_confirmed_at, scan_count,
    lane_count, surface, length_m, is_indoor, access_type, notes
"""


async def _fetch_track(conn: asyncpg.Connection, track_id: int) -> dict | None:
    row = await conn.fetchrow(
        f"SELECT {_TRACK_SELECT} FROM detected_tracks WHERE id = $1",
        track_id,
    )
    return _row_to_track_dict(row) if row else None


async def upsert_detected_track(
    pool: asyncpg.Pool, lat: float, lng: float, confidence: float
) -> int:
    """
    Insert a new detected track or update an existing one within 600 m.
    Returns the track id.
    """
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT id, confidence FROM detected_tracks
            WHERE ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                600
            )
            ORDER BY location::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            LIMIT 1
            """,
            lng, lat,
        )
        if existing:
            new_conf = max(existing["confidence"], confidence)
            # Only record a revision if the ML score actually improved — every
            # scan would otherwise spam the revisions table with no-op rows.
            if new_conf > existing["confidence"]:
                old = await _fetch_track(conn, existing["id"])
                await conn.execute(
                    """
                    UPDATE detected_tracks
                    SET last_confirmed_at = now(),
                        scan_count        = scan_count + 1,
                        confidence        = $2
                    WHERE id = $1
                    """,
                    existing["id"], new_conf,
                )
                new = await _fetch_track(conn, existing["id"])
                await _record_revision(
                    conn, existing["id"], "ml_reconfirm", None, old, new
                )
            else:
                await conn.execute(
                    """
                    UPDATE detected_tracks
                    SET last_confirmed_at = now(),
                        scan_count        = scan_count + 1
                    WHERE id = $1
                    """,
                    existing["id"],
                )
            return existing["id"]

        row = await conn.fetchrow(
            """
            INSERT INTO detected_tracks (location, confidence)
            VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)
            RETURNING id
            """,
            lng, lat, confidence,
        )
        track_id = row["id"]
        new = await _fetch_track(conn, track_id)
        await _record_revision(conn, track_id, "ml_detect", None, None, new)
        return track_id


async def get_tracks(
    pool: asyncpg.Pool,
    min_lat: float | None = None,
    min_lng: float | None = None,
    max_lat: float | None = None,
    max_lng: float | None = None,
    status: str | None = "verified",
    min_confidence: float = 0.0,
) -> list[dict]:
    conditions = ["confidence >= $1"]
    params: list = [min_confidence]

    if status is not None:
        params.append(status)
        conditions.append(f"status = ${len(params)}")

    has_bbox = all(v is not None for v in (min_lat, min_lng, max_lat, max_lng))
    if has_bbox:
        params += [min_lng, min_lat, max_lng, max_lat]
        n = len(params)
        conditions.append(
            f"ST_Within(location, ST_MakeEnvelope(${n-3}, ${n-2}, ${n-1}, ${n}, 4326))"
        )

    where = " AND ".join(conditions)
    rows = await pool.fetch(
        f"""
        SELECT {_TRACK_SELECT}
        FROM detected_tracks
        WHERE {where}
        ORDER BY confidence DESC
        """,
        *params,
    )
    return [dict(r) for r in rows]


async def get_track(pool: asyncpg.Pool, track_id: int) -> dict | None:
    async with pool.acquire() as conn:
        return await _fetch_track(conn, track_id)


async def set_track_status(
    pool: asyncpg.Pool,
    track_id: int,
    status: str,
    verified_by: str | None,
    lat: float | None = None,
    lng: float | None = None,
) -> bool:
    async with pool.acquire() as conn:
        old = await _fetch_track(conn, track_id)
        if old is None:
            return False

        if lat is not None and lng is not None:
            await conn.execute(
                """
                UPDATE detected_tracks
                SET status      = $2,
                    verified_by = $3,
                    verified_at = CASE WHEN $2 IN ('verified', 'rejected') THEN now() ELSE NULL END,
                    location    = ST_SetSRID(ST_MakePoint($4, $5), 4326)
                WHERE id = $1
                """,
                track_id, status, verified_by, lng, lat,
            )
        else:
            await conn.execute(
                """
                UPDATE detected_tracks
                SET status      = $2,
                    verified_by = $3,
                    verified_at = CASE WHEN $2 IN ('verified', 'rejected') THEN now() ELSE NULL END
                WHERE id = $1
                """,
                track_id, status, verified_by,
            )

        new = await _fetch_track(conn, track_id)
        await _record_revision(conn, track_id, status, verified_by, old, new)
        return True


async def update_track_metadata(
    pool: asyncpg.Pool,
    track_id: int,
    fields: dict,
    revised_by: str | None,
) -> dict | None:
    """
    Update any subset of editable metadata columns + optional location relocate.
    Returns the updated row, or None if the track doesn't exist. lat/lng are
    handled specially since they map to the PostGIS geometry, not a plain column.
    """
    lat = fields.get("lat")
    lng = fields.get("lng")
    safe = {k: v for k, v in fields.items() if k in METADATA_COLUMNS}

    if not safe and (lat is None or lng is None):
        return await get_track(pool, track_id)

    set_clauses = []
    params: list = [track_id]
    for col, val in safe.items():
        params.append(val)
        set_clauses.append(f"{col} = ${len(params)}")
    if lat is not None and lng is not None:
        params.append(lng)
        params.append(lat)
        set_clauses.append(
            f"location = ST_SetSRID(ST_MakePoint(${len(params) - 1}, ${len(params)}), 4326)"
        )

    async with pool.acquire() as conn:
        old = await _fetch_track(conn, track_id)
        if old is None:
            return None
        await conn.execute(
            f"UPDATE detected_tracks SET {', '.join(set_clauses)} WHERE id = $1",
            *params,
        )
        new = await _fetch_track(conn, track_id)
        await _record_revision(conn, track_id, "metadata", revised_by, old, new)
        return new


async def submit_track(
    pool: asyncpg.Pool,
    lat: float,
    lng: float,
    name: str | None = None,
    submitted_by: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """
    Admin-placed track. Reconciles against any existing track within 600 m:
      - rejected match → resurrect to 'pending' and move to the new coords
        (admin is overriding a prior rejection).
      - pending / verified match → update metadata only, keep existing coords.
      - no match → insert new 'pending' row at the given coords.

    Returns {id, lat, lng, status, resurrected, matched_existing}.
    """
    safe_meta = {k: v for k, v in (metadata or {}).items() if k in METADATA_COLUMNS}

    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT id, status FROM detected_tracks
            WHERE ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                600
            )
            ORDER BY location::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            LIMIT 1
            """,
            lng, lat,
        )

        if existing:
            existing_id = existing["id"]
            old = await _fetch_track(conn, existing_id)
            assert old is not None

            update_parts = ["name = COALESCE($2, name)", "submitted_by = COALESCE($3, submitted_by)"]
            params: list = [existing_id, name, submitted_by]

            resurrected = existing["status"] == "rejected"
            if resurrected:
                update_parts.append("status = 'pending'")
                update_parts.append("location = ST_SetSRID(ST_MakePoint($4, $5), 4326)")
                update_parts.append("verified_by = NULL")
                update_parts.append("verified_at = NULL")
                update_parts.append("last_confirmed_at = now()")
                params += [lng, lat]

            for col, val in safe_meta.items():
                params.append(val)
                update_parts.append(f"{col} = COALESCE(${len(params)}, {col})")

            await conn.execute(
                f"UPDATE detected_tracks SET {', '.join(update_parts)} WHERE id = $1",
                *params,
            )
            new = await _fetch_track(conn, existing_id)
            action = "resurrect" if resurrected else "manual_update"
            await _record_revision(conn, existing_id, action, submitted_by, old, new)
            assert new is not None
            return {
                "id": existing_id,
                "lat": new["lat"],
                "lng": new["lng"],
                "status": new["status"],
                "resurrected": resurrected,
                "matched_existing": True,
            }

        # No nearby match — insert a fresh pending row.
        cols = ["location", "confidence", "name", "submitted_by", "scan_count"]
        vals = ["ST_SetSRID(ST_MakePoint($1, $2), 4326)", "0.0", "$3", "$4", "0"]
        params = [lng, lat, name, submitted_by]
        for col, val in safe_meta.items():
            params.append(val)
            cols.append(col)
            vals.append(f"${len(params)}")

        row = await conn.fetchrow(
            f"""
            INSERT INTO detected_tracks ({', '.join(cols)})
            VALUES ({', '.join(vals)})
            RETURNING id
            """,
            *params,
        )
        track_id = row["id"]
        new = await _fetch_track(conn, track_id)
        await _record_revision(conn, track_id, "manual_add", submitted_by, None, new)
        assert new is not None
        return {
            "id": track_id,
            "lat": new["lat"],
            "lng": new["lng"],
            "status": new["status"],
            "resurrected": False,
            "matched_existing": False,
        }


async def get_track_revisions(
    pool: asyncpg.Pool, track_id: int, limit: int = 50
) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT id, track_id, revised_at, revised_by, action, old_data, new_data, note
        FROM track_revisions
        WHERE track_id = $1
        ORDER BY revised_at DESC
        LIMIT $2
        """,
        track_id, limit,
    )
    out = []
    for r in rows:
        d = dict(r)
        # asyncpg returns JSONB as str; decode for cleaner JSON serialization.
        for k in ("old_data", "new_data"):
            if isinstance(d[k], str):
                d[k] = json.loads(d[k])
        if hasattr(d["revised_at"], "isoformat"):
            d["revised_at"] = d["revised_at"].isoformat()
        out.append(d)
    return out
