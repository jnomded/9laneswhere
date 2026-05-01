import { useState, useCallback, useRef, useEffect } from 'react'
import Map, {
  Source,
  Layer,
  Marker,
  Popup,
  NavigationControl,
} from 'react-map-gl'
import type { MapRef, MapLayerMouseEvent } from 'react-map-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'
import type { Detection, GeocodingFeature, ScanResult, Track } from './types'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'
const ADMIN_PASSKEY = import.meta.env.VITE_ADMIN_PASSKEY as string

function circleGeoJSON(lat: number, lng: number, radiusKm: number, steps = 64) {
  const R = 6371
  const coords: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI
    const dlat = (radiusKm / R) * (180 / Math.PI) * Math.sin(angle)
    const dlng =
      ((radiusKm / R) * (180 / Math.PI) * Math.cos(angle)) /
      Math.cos((lat * Math.PI) / 180)
    coords.push([lng + dlng, lat + dlat])
  }
  return {
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [coords] },
    properties: {},
  }
}

function confidenceColor(conf: number): string {
  return conf >= 0.85 ? '#00c48c' : '#f5a623'
}

export default function App() {
  const mapRef = useRef<MapRef>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [viewState, setViewState] = useState({
    longitude: -98.5795,
    latitude: 39.8283,
    zoom: 4,
  })

  // Admin access
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const [passkeyInput, setPasskeyInput] = useState('')
  const [adminMode, setAdminMode] = useState(false)

  // Pick mode: which field is waiting for a map click
  const [pickMode, setPickMode] = useState<'scan-center' | 'add-track' | null>(null)

  // Scanner state (admin only)
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState<GeocodingFeature[]>([])
  const [center, setCenter] = useState<{ lat: number; lng: number; name: string } | null>(null)
  const [radiusKm, setRadiusKm] = useState(5)
  const [threshold, setThreshold] = useState(65)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<Detection | null>(null)

  // Verified/pending tracks
  const [verifiedTracks, setVerifiedTracks] = useState<Track[]>([])
  const [pendingTracks, setPendingTracks] = useState<Track[]>([])
  const [selectedVerified, setSelectedVerified] = useState<Track | null>(null)

  // Manual add form (admin)
  const [manualLat, setManualLat] = useState('')
  const [manualLng, setManualLng] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualBy, setManualBy] = useState('')

  useEffect(() => {
    loadVerifiedTracks()
  }, [])

  useEffect(() => {
    if (adminMode) loadPendingTracks()
    else setPickMode(null)
  }, [adminMode])

  // Exit pick mode if user switches away
  useEffect(() => {
    if (!adminMode) setPickMode(null)
  }, [adminMode])

  const loadVerifiedTracks = async () => {
    try {
      const res = await fetch(`${API_URL}/tracks?status=verified`)
      if (res.ok) setVerifiedTracks((await res.json()).tracks)
    } catch { /* silently fail */ }
  }

  const loadPendingTracks = async () => {
    try {
      const res = await fetch(`${API_URL}/tracks?status=pending&min_confidence=0`)
      if (res.ok) setPendingTracks((await res.json()).tracks)
    } catch {}
  }

  const handleVerifyTrack = async (id: number, status: 'verified' | 'rejected') => {
    try {
      await fetch(`${API_URL}/tracks/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, verified_by: 'admin' }),
      })
      setSelectedMarker(null)
      setSelectedVerified(null)
      await Promise.all([loadPendingTracks(), loadVerifiedTracks()])
    } catch {}
  }

  const handleManualAdd = async () => {
    const lat = parseFloat(manualLat)
    const lng = parseFloat(manualLng)
    if (isNaN(lat) || isNaN(lng)) return
    try {
      await fetch(`${API_URL}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, name: manualName || null, submitted_by: manualBy || null }),
      })
      setManualLat('')
      setManualLng('')
      setManualName('')
      setManualBy('')
      await loadPendingTracks()
    } catch {}
  }

  const handleMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const { lng, lat } = e.lngLat
      setSuggestions([])

      if (pickMode === 'scan-center') {
        setCenter({ lat, lng, name: `${lat.toFixed(4)}°, ${lng.toFixed(4)}°` })
        setPickMode(null)
        return
      }

      if (pickMode === 'add-track') {
        setManualLat(lat.toFixed(6))
        setManualLng(lng.toFixed(6))
        setPickMode(null)
        return
      }

      setSelectedMarker(null)
      setSelectedVerified(null)
    },
    [pickMode]
  )

  const fetchSuggestions = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) { setSuggestions([]); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
            `?country=US&types=place,address,poi&limit=5&access_token=${MAPBOX_TOKEN}`
        )
        setSuggestions((await res.json()).features ?? [])
      } catch { setSuggestions([]) }
    }, 300)
  }, [])

  const selectSuggestion = (feature: GeocodingFeature) => {
    const [lng, lat] = feature.center
    const shortName = feature.place_name.split(',')[0]
    setCenter({ lat, lng, name: shortName })
    setSearchQuery(shortName)
    setSuggestions([])
    setResult(null)
    setSelectedMarker(null)
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 12, duration: 1500 })
  }

  const handlePasskey = () => {
    if (passkeyInput === ADMIN_PASSKEY) {
      setAdminUnlocked(true)
      setPasskeyInput('')
    } else {
      setPasskeyInput('')
    }
  }

  const handleScan = async () => {
    if (!center || scanning) return
    setScanning(true)
    setResult(null)
    setSelectedMarker(null)
    try {
      const res = await fetch(`${API_URL}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: center.lat, lng: center.lng, radius_km: radiusKm, threshold: threshold / 100 }),
      })
      if (!res.ok) throw new Error(`API error ${res.status}`)
      setResult(await res.json())
    } catch (err) {
      console.error('Scan failed:', err)
    } finally {
      setScanning(false)
    }
  }

  const scanCircle = center ? circleGeoJSON(center.lat, center.lng, radiusKm) : null
  const scanBtnLabel = scanning ? 'Scanning...' : center
    ? `Scan ${radiusKm} km around ${center.name}`
    : 'Set a location first'

  return (
    <div className="app">
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="header-top">
            <div>
              <h1>TrackFinder</h1>
              <p>AI-powered running track detection</p>
            </div>
            <div className="mode-tabs">
              <button className={`mode-tab${!adminMode ? ' active' : ''}`} onClick={() => setAdminMode(false)}>
                Map
              </button>
              {adminUnlocked && (
                <button className={`mode-tab${adminMode ? ' active' : ''}`} onClick={() => setAdminMode(true)}>
                  Admin
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="sidebar-body">
          {adminMode ? (
            /* ── Admin panel ─────────────────────────── */
            <>
              {/* Scanner section */}
              <div className="section-label">Scanner</div>

              <div className="search-container">
                <input
                  className="search-input"
                  placeholder="Search location..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); fetchSuggestions(e.target.value) }}
                  onKeyDown={(e) => e.key === 'Escape' && setSuggestions([])}
                />
                {suggestions.length > 0 && (
                  <div className="suggestions">
                    {suggestions.map((s, i) => (
                      <div key={i} className="suggestion-item" onClick={() => selectSuggestion(s)}>
                        {s.place_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                className={`pick-btn${pickMode === 'scan-center' ? ' active' : ''}`}
                onClick={() => setPickMode(pickMode === 'scan-center' ? null : 'scan-center')}
              >
                {pickMode === 'scan-center' ? '✕ Cancel pick' : '⊕ Pick from map'}
              </button>

              {center && (
                <div className="center-display">
                  Center: {center.lat.toFixed(4)}°, {center.lng.toFixed(4)}°
                </div>
              )}

              <div className="control-group">
                <div className="control-label">
                  <span>Radius</span><span>{radiusKm} km</span>
                </div>
                <input className="slider" type="range" min={1} max={15} step={1}
                  value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
              </div>

              <div className="control-group">
                <div className="control-label">
                  <span>Confidence threshold</span><span>{threshold}%</span>
                </div>
                <input className="slider" type="range" min={50} max={95} step={5}
                  value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
              </div>

              <button className="scan-btn" onClick={handleScan} disabled={!center || scanning}>
                {scanBtnLabel}
              </button>

              {result && (
                <>
                  <div className="stats-bar">
                    <strong>{result.tiles_scanned}</strong> tiles ·{' '}
                    {result.tiles_from_cache != null && <><strong>{result.tiles_from_cache}</strong> cached · </>}
                    <strong>{result.detections.length}</strong> track{result.detections.length !== 1 ? 's' : ''} found
                  </div>
                  {result.detections.length > 0 && (
                    <div className="results-list">
                      {result.detections.map((d, i) => (
                        <div
                          key={i}
                          className={`result-item${selectedMarker === d ? ' active' : ''}`}
                          onClick={() => {
                            setSelectedMarker(d)
                            mapRef.current?.flyTo({ center: [d.lng, d.lat], zoom: 15, duration: 800 })
                          }}
                        >
                          <div className="result-coords">{d.lat.toFixed(4)}°, {d.lng.toFixed(4)}°</div>
                          <div className={`result-confidence${d.confidence < 0.85 ? ' medium' : ''}`}>
                            {Math.round(d.confidence * 100)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Add Track section */}
              <div className="section-label" style={{ marginTop: 4 }}>
                Add Track
              </div>

              <div className="manual-form">
                <button
                  className={`pick-btn${pickMode === 'add-track' ? ' active' : ''}`}
                  onClick={() => setPickMode(pickMode === 'add-track' ? null : 'add-track')}
                >
                  {pickMode === 'add-track' ? '✕ Cancel pick' : '⊕ Pick from map'}
                </button>

                <div className="form-row">
                  <input className="form-input" placeholder="Latitude" value={manualLat}
                    onChange={(e) => setManualLat(e.target.value)} />
                  <input className="form-input" placeholder="Longitude" value={manualLng}
                    onChange={(e) => setManualLng(e.target.value)} />
                </div>
                <input className="form-input" placeholder="Track name (optional)" value={manualName}
                  onChange={(e) => setManualName(e.target.value)} />
                <input className="form-input" placeholder="Added by" value={manualBy}
                  onChange={(e) => setManualBy(e.target.value)} />
                <button className="scan-btn" onClick={handleManualAdd} disabled={!manualLat || !manualLng}>
                  Add Track
                </button>
              </div>

              {/* Pending section */}
              <div className="section-label">
                Pending ({pendingTracks.length})
                <button className="refresh-btn" onClick={loadPendingTracks}>↻</button>
              </div>

              {pendingTracks.length === 0 ? (
                <p className="no-results">No pending tracks.</p>
              ) : (
                <div className="results-list">
                  {pendingTracks.map((t) => (
                    <div key={t.id} className="pending-item">
                      <div className="result-coords" style={{ cursor: 'pointer' }}
                        onClick={() => mapRef.current?.flyTo({ center: [t.lng, t.lat], zoom: 15, duration: 800 })}>
                        {t.lat.toFixed(4)}°, {t.lng.toFixed(4)}°
                      </div>
                      {t.name && <div className="track-name">{t.name}</div>}
                      <div className="track-meta">
                        {t.confidence > 0 ? `${Math.round(t.confidence * 100)}% · ` : ''}
                        {t.scan_count} scan{t.scan_count !== 1 ? 's' : ''}
                        {t.submitted_by ? ` · ${t.submitted_by}` : ''}
                      </div>
                      <div className="pending-actions">
                        <button className="action-btn verify" onClick={() => handleVerifyTrack(t.id, 'verified')}>✓ Verify</button>
                        <button className="action-btn reject" onClick={() => handleVerifyTrack(t.id, 'rejected')}>✗ Reject</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            /* ── User / map panel ─────────────────────── */
            <>
              <p className="map-hint">
                {verifiedTracks.length > 0
                  ? `${verifiedTracks.length} verified track${verifiedTracks.length !== 1 ? 's' : ''} on the map.`
                  : 'No verified tracks yet.'}
              </p>
              
            </>
          )}
        </div>

        {/* ── Sidebar footer (admin passkey) ────────── */}
        <div className="sidebar-footer">
          {adminUnlocked ? (
            <div className="admin-unlocked">
              <span>Admin access active</span>
              <button className="lock-btn" onClick={() => { setAdminUnlocked(false); setAdminMode(false) }}>
                Lock
              </button>
            </div>
          ) : (
            <div className="passkey-entry">
              <input
                className="passkey-input"
                type="password"
                placeholder="Admin passkey"
                value={passkeyInput}
                onChange={(e) => setPasskeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePasskey()}
              />
            </div>
          )}
        </div>
      </aside>

      {/* ── Map ─────────────────────────────────────── */}
      <div className={`map-container${pickMode ? ' picking' : ''}`}>
        <Map
          ref={mapRef}
          {...viewState}
          onMove={(e) => setViewState(e.viewState)}
          mapStyle="mapbox://styles/mapbox/satellite-v9"
          mapboxAccessToken={MAPBOX_TOKEN}
          style={{ width: '100%', height: '100%' }}
          onClick={handleMapClick}
        >
          <NavigationControl position="top-right" />

          {scanCircle && (
            <Source id="scan-radius" type="geojson" data={scanCircle}>
              <Layer id="scan-radius-fill" type="fill"
                paint={{ 'fill-color': '#00c48c', 'fill-opacity': scanning ? 0.12 : 0.06 }} />
              <Layer id="scan-radius-outline" type="line"
                paint={{ 'line-color': '#00c48c', 'line-width': 1.5, 'line-opacity': 0.5 }} />
            </Source>
          )}

          {/* Verified track markers */}
          {verifiedTracks.map((t) => (
            <Marker key={`v-${t.id}`} longitude={t.lng} latitude={t.lat} anchor="center">
              <div
                className="verified-marker"
                style={{ transform: selectedVerified?.id === t.id ? 'rotate(45deg) scale(1.3)' : 'rotate(45deg)' }}
                onClick={(e) => { e.stopPropagation(); setSelectedVerified(t); setSelectedMarker(null) }}
              />
            </Marker>
          ))}

          {/* Detection markers (admin scan results) */}
          {result?.detections.map((d, i) => (
            <Marker key={i} longitude={d.lng} latitude={d.lat} anchor="center">
              <div
                style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: confidenceColor(d.confidence),
                  border: '2.5px solid rgba(255,255,255,0.9)',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                  transform: selectedMarker === d ? 'scale(1.3)' : 'scale(1)',
                  transition: 'transform 0.15s',
                }}
                onClick={(e) => { e.stopPropagation(); setSelectedMarker(d); setSelectedVerified(null) }}
              />
            </Marker>
          ))}

          {/* Detection popup (admin: verify / reject) */}
          {selectedMarker && (
            <Popup longitude={selectedMarker.lng} latitude={selectedMarker.lat}
              anchor="bottom" offset={14} onClose={() => setSelectedMarker(null)} closeButton>
              <div className="popup-content">
                <div className={`popup-confidence${selectedMarker.confidence < 0.85 ? ' medium' : ''}`}>
                  {Math.round(selectedMarker.confidence * 100)}% confident
                </div>
                <div className="popup-subtitle">Running track detected</div>
                {selectedMarker.track_id != null && (
                  <div className="popup-actions">
                    <button className="action-btn verify" onClick={() => handleVerifyTrack(selectedMarker.track_id!, 'verified')}>✓ Verify</button>
                    <button className="action-btn reject" onClick={() => handleVerifyTrack(selectedMarker.track_id!, 'rejected')}>✗ Reject</button>
                  </div>
                )}
                <a className="popup-link"
                  href={`https://www.google.com/maps/@${selectedMarker.lat},${selectedMarker.lng},18z`}
                  target="_blank" rel="noopener noreferrer">
                  Open in Google Maps ↗
                </a>
              </div>
            </Popup>
          )}

          {/* Verified track popup */}
          {selectedVerified && (
            <Popup longitude={selectedVerified.lng} latitude={selectedVerified.lat}
              anchor="bottom" offset={14} onClose={() => setSelectedVerified(null)} closeButton>
              <div className="popup-content">
                <div className="popup-verified-badge">✓ Verified Track</div>
                {selectedVerified.name && <div className="popup-track-name">{selectedVerified.name}</div>}
                <div className="popup-subtitle">
                  {selectedVerified.lat.toFixed(4)}°, {selectedVerified.lng.toFixed(4)}°
                </div>
                {adminMode && (
                  <div className="popup-actions">
                    <button className="action-btn reject" onClick={() => handleVerifyTrack(selectedVerified.id, 'rejected')}>✗ Reject</button>
                  </div>
                )}
                <a className="popup-link"
                  href={`https://www.google.com/maps/@${selectedVerified.lat},${selectedVerified.lng},18z`}
                  target="_blank" rel="noopener noreferrer">
                  Open in Google Maps ↗
                </a>
              </div>
            </Popup>
          )}

        </Map>

        {/* Pick mode banner */}
        {pickMode && (
          <div className="pick-banner">
            {pickMode === 'scan-center' ? 'Click map to set scan center' : 'Click map to place track'}
            <button className="pick-cancel" onClick={() => setPickMode(null)}>✕</button>
          </div>
        )}

        {scanning && <div className="scanning-badge">Scanning satellite imagery...</div>}
      </div>
    </div>
  )
}
