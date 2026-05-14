CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS scanned_tiles (
    z             SMALLINT         NOT NULL,
    x             INTEGER          NOT NULL,
    y             INTEGER          NOT NULL,
    tile_lat      DOUBLE PRECISION NOT NULL,
    tile_lng      DOUBLE PRECISION NOT NULL,
    ml_score      REAL             NOT NULL,
    scanned_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ      NOT NULL,
    PRIMARY KEY (z, x, y)
);

CREATE INDEX IF NOT EXISTS idx_scanned_tiles_expires ON scanned_tiles (expires_at);

CREATE TABLE IF NOT EXISTS detected_tracks (
    id                BIGSERIAL    PRIMARY KEY,
    location          GEOMETRY(Point, 4326) NOT NULL,
    confidence        REAL         NOT NULL,
    status            TEXT         NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'verified', 'rejected')),
    verified_by       TEXT,
    verified_at       TIMESTAMPTZ,
    first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_confirmed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    scan_count        INTEGER      NOT NULL DEFAULT 1,
    name              TEXT,
    submitted_by      TEXT,
    lane_count        SMALLINT,
    surface           TEXT,
    length_m          SMALLINT,
    is_indoor         BOOLEAN      NOT NULL DEFAULT FALSE,
    access_type       TEXT,
    country           TEXT,
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_detected_tracks_location ON detected_tracks USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_detected_tracks_status   ON detected_tracks (status);

-- Append-only audit log of every change made to a track row.
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

CREATE INDEX IF NOT EXISTS idx_track_revisions_track ON track_revisions (track_id, revised_at DESC);
