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
    submitted_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_detected_tracks_location ON detected_tracks USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_detected_tracks_status   ON detected_tracks (status);
