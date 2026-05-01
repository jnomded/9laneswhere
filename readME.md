# 9 Lanes Where

A personal project with two goals: practice building a production ML pipeline, and start building a database of every 400m athletics track in the world.

The live app is at https://track-eight-pi.vercel.app/ (domain subject to change).

## What it does

You pick a point on a satellite map and set a search radius. The backend fetches satellite image tiles from Mapbox, runs each tile through a MobileNet classifier to score the likelihood of a track being present, clusters the positive detections, and returns map pins for any candidates above a confidence threshold. Detections are stored in a PostGIS database. Users can manually submit track locations. An admin panel (password-protected) lets you verify or reject submissions. In the future a moderator tier of access will be added allowing trusted users to request reviews of track locations or currently placed pins. 

## Stack

**Frontend**
- React 18 + TypeScript, built with Vite
- Mapbox GL via react-map-gl

**Backend**
- Python, FastAPI, uvicorn
- asyncpg for async database access
- httpx for tile fetching (16 concurrent requests)
- TensorFlow/Keras for inference

**Database**
- PostgreSQL 16 + PostGIS 3.4, run via Docker
- Two tables: `scanned_tiles` (ML result cache) and `detected_tracks` (track records with status)

**Model**
- MobileNet trained with transfer learning on a dataset of satellite tiles labeled from OpenStreetMap data
- Training data is in `dataset_osm/` (track vs. not-track image classification)
- Training followed the TensorFlow transfer learning guide: https://www.tensorflow.org/tutorials/images/transfer_learning
- The trained model file is `app/backend/track_model.keras`

## Running locally

### 1. Set up environment files

Root `.env` (used by Docker Compose for the database):
```
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=trackdb
```

`app/backend/.env`:
```
MAPBOX_TOKEN=your_mapbox_token_here
DATABASE_URL=postgresql://your_db_user:your_db_password@localhost:5432/trackdb
ALLOWED_ORIGIN=http://localhost:5173
MODEL_PATH=/app/track_model.keras
```

`app/frontend/.env`:
```
VITE_MAPBOX_TOKEN=your_mapbox_token_here
VITE_API_URL=http://localhost:8000
VITE_ADMIN_PASSKEY=your_admin_passkey_here
```

You need a Mapbox account to get a token (free tier works plenty).

### 2. Start the database and backend

```bash
docker compose up --build
```

This starts a PostGIS container and the FastAPI backend on port 8000. The database schema is applied automatically on first run.

### 3. Start the frontend

```bash
cd app/frontend
npm install
npm run dev
```

The app runs at http://localhost:5173.

## Project structure

```
app/
  backend/
    main.py          # FastAPI app and endpoints
    inference.py     # tile fetching, ML inference, clustering logic
    db.py            # database queries (asyncpg)
    schema.sql       # table definitions (applied by Docker on init)
    track_model.keras
    Dockerfile
    requirements.txt
  frontend/
    src/
      App.tsx
      types.ts
dataset_osm/         # labeled satellite tile images used for training
docker-compose.yml
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/scan` | Run ML scan over an area (lat, lng, radius_km, threshold) |
| GET | `/tracks` | List tracks, filterable by bounding box, status, confidence |
| POST | `/tracks` | Submit a track manually |
| GET | `/tracks/{id}` | Get a single track |
| PATCH | `/tracks/{id}/status` | Set status to verified or rejected |

## Notes

- Scanned tiles are cached in the database to avoid re-fetching the same satellite images. Cache entries expire automatically.
- The scan endpoint deduplicates tiles to canonical slippy-map tile coordinates before fetching.
- The training dataset has been removed from git. It may be uploaded to Kaggle later.

