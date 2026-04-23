import asyncpg


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=2, max_size=10)


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
            return existing["id"]

        row = await conn.fetchrow(
            """
            INSERT INTO detected_tracks (location, confidence)
            VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)
            RETURNING id
            """,
            lng, lat, confidence,
        )
        return row["id"]


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
        SELECT id,
               ST_Y(location) AS lat,
               ST_X(location) AS lng,
               confidence, status, name, submitted_by, verified_by, verified_at,
               first_seen_at, last_confirmed_at, scan_count
        FROM detected_tracks
        WHERE {where}
        ORDER BY confidence DESC
        """,
        *params,
    )
    return [dict(r) for r in rows]


async def get_track(pool: asyncpg.Pool, track_id: int) -> dict | None:
    row = await pool.fetchrow(
        """
        SELECT id,
               ST_Y(location) AS lat,
               ST_X(location) AS lng,
               confidence, status, name, submitted_by, verified_by, verified_at,
               first_seen_at, last_confirmed_at, scan_count
        FROM detected_tracks WHERE id = $1
        """,
        track_id,
    )
    return dict(row) if row else None


async def set_track_status(
    pool: asyncpg.Pool, track_id: int, status: str, verified_by: str | None
) -> bool:
    result = await pool.execute(
        """
        UPDATE detected_tracks
        SET status      = $2,
            verified_by = $3,
            verified_at = CASE WHEN $2 IN ('verified', 'rejected') THEN now() ELSE NULL END
        WHERE id = $1
        """,
        track_id, status, verified_by,
    )
    return result != "UPDATE 0"


async def submit_track(
    pool: asyncpg.Pool,
    lat: float,
    lng: float,
    name: str | None = None,
    submitted_by: str | None = None,
) -> int:
    """
    User-submitted track. Finds existing track within 600 m and updates metadata,
    or inserts a new pending row. Does not increment scan_count.
    """
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT id FROM detected_tracks
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
            await conn.execute(
                """
                UPDATE detected_tracks
                SET name         = COALESCE($2, name),
                    submitted_by = COALESCE($3, submitted_by)
                WHERE id = $1
                """,
                existing["id"], name, submitted_by,
            )
            return existing["id"]

        row = await conn.fetchrow(
            """
            INSERT INTO detected_tracks (location, confidence, name, submitted_by, scan_count)
            VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0, $3, $4, 0)
            RETURNING id
            """,
            lng, lat, name, submitted_by,
        )
        return row["id"]
