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
import type {
  Detection,
  GeocodingFeature,
  ScanResult,
  Track,
  SubmitTrackResponse,
  Surface,
  AccessType,
  Revision,
} from './types'
import { SURFACE_VALUES, ACCESS_VALUES } from './types'

type MetadataEdits = Partial<{
  name: string | null
  lane_count: number | null
  surface: Surface | null
  length_m: number | null
  is_indoor: boolean
  access_type: AccessType | null
  notes: string | null
  lat: number
  lng: number
}>

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000'

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
  const moveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [viewState, setViewState] = useState({
    longitude: -98.5795,
    latitude: 39.8283,
    zoom: 4,
  })

  // Admin access
  const [adminToken, setAdminToken] = useState<string | null>(
    () => sessionStorage.getItem('admin_token')
  )
  const adminUnlocked = adminToken !== null
  const [passkeyInput, setPasskeyInput] = useState('')
  const [adminMode, setAdminMode] = useState(false)

  // Per-pin coordinate overrides while admin is dragging.
  const [draggedPositions, setDraggedPositions] = useState<
    Record<number, { lat: number; lng: number }>
  >({})
  const [selectedPending, setSelectedPending] = useState<Track | null>(null)

  // Per-track in-flight metadata edits (admin). Flushed on Save or Verify.
  const [editedMetadata, setEditedMetadata] = useState<Record<number, MetadataEdits>>({})
  // Which verified track id is currently showing the inline edit form.
  const [editingVerifiedId, setEditingVerifiedId] = useState<number | null>(null)

  // Revision history (admin only). Cached per track id, lazy-loaded on first open.
  const [revisionsCache, setRevisionsCache] = useState<Record<number, Revision[]>>({})
  const [revisionsLoadingFor, setRevisionsLoadingFor] = useState<number | null>(null)
  const [showRevisionsFor, setShowRevisionsFor] = useState<number | null>(null)

  // Pick mode: which field is waiting for a map click
  const [pickMode, setPickMode] = useState<'scan-center' | 'add-track' | null>(null)

  // Scanner state (admin only)
  const [searchQuery, setSearchQuery] = useState('')
  const [suggestions, setSuggestions] = useState<GeocodingFeature[]>([])
  const [center, setCenter] = useState<{ lat: number; lng: number; name: string } | null>(null)
  const [radiusKm, setRadiusKm] = useState(5)
  const [threshold, setThreshold] = useState(65)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ phase: string; completed: number; total: number } | null>(null)
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
  const [manualLanes, setManualLanes] = useState('')
  const [manualSurface, setManualSurface] = useState<Surface | ''>('')
  const [manualLengthM, setManualLengthM] = useState('')
  const [manualAccess, setManualAccess] = useState<AccessType | ''>('')
  const [manualIndoor, setManualIndoor] = useState(false)
  const [manualNotice, setManualNotice] = useState<string | null>(null)

  useEffect(() => {
    loadVerifiedTracks()
  }, [])

  // On first load, try to recenter on the user's location at city-level zoom.
  // If geolocation is unavailable or denied, the default US-wide view stays.
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        const map = mapRef.current
        if (map) {
          map.flyTo({ center: [longitude, latitude], zoom: 11, duration: 1200 })
        } else {
          setViewState({ latitude: 44.04225175495486, longitude: -123.07078716926397, zoom: 11 })
        }
      },
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    )
  }, [])

  useEffect(() => {
    if (adminMode) loadPendingTracks()
    else setPickMode(null)
  }, [adminMode])

  // Exit pick mode if user switches away
  useEffect(() => {
    if (!adminMode) setPickMode(null)
  }, [adminMode])

  // Bbox of the current viewport, padded so panning isn't constantly refetching.
  // Returns null if the map isn't ready, or if we're zoomed out far enough that
  // the bbox would cover most of the planet (just fetch unbounded then).
  const computeBboxParams = (): Record<string, string> | null => {
    const map = mapRef.current?.getMap()
    if (!map) return null
    const b = map.getBounds()
    if (!b) return null
    const south = b.getSouth()
    const north = b.getNorth()
    const west = b.getWest()
    const east = b.getEast()
    if (east - west >= 300) return null  // close to whole-world view
    const padLng = (east - west) * 0.5
    const padLat = (north - south) * 0.5
    return {
      min_lat: String(Math.max(-85, south - padLat)),
      min_lng: String(Math.max(-180, west - padLng)),
      max_lat: String(Math.min(85, north + padLat)),
      max_lng: String(Math.min(180, east + padLng)),
    }
  }

  const buildTracksUrl = (base: Record<string, string>): string => {
    const params = new URLSearchParams(base)
    const bbox = computeBboxParams()
    if (bbox) for (const [k, v] of Object.entries(bbox)) params.set(k, v)
    return `${API_URL}/tracks?${params}`
  }

  const loadVerifiedTracks = async () => {
    try {
      const res = await fetch(buildTracksUrl({ status: 'verified' }))
      if (res.ok) setVerifiedTracks((await res.json()).tracks)
    } catch { /* silently fail */ }
  }

  const loadPendingTracks = async () => {
    try {
      const res = await authedFetch(buildTracksUrl({ status: 'pending', min_confidence: '0' }))
      if (res.ok) setPendingTracks((await res.json()).tracks)
    } catch {}
  }

  const handleMapMoveEnd = () => {
    if (moveDebounceRef.current) clearTimeout(moveDebounceRef.current)
    moveDebounceRef.current = setTimeout(() => {
      loadVerifiedTracks()
      if (adminMode) loadPendingTracks()
    }, 250)
  }

  const flushMetadataEdits = async (id: number): Promise<void> => {
    const edits = editedMetadata[id]
    if (!edits || Object.keys(edits).length === 0) return
    await authedFetch(`${API_URL}/tracks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
    })
  }

  const clearMetadataEdits = (id: number) => {
    setEditedMetadata((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const setMetadataField = <K extends keyof MetadataEdits>(
    id: number, field: K, value: MetadataEdits[K],
  ) => {
    setEditedMetadata((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  const handleSaveMetadata = async (id: number) => {
    try {
      const edits = editedMetadata[id] ?? {}
      const dragged = draggedPositions[id]
      const body: Record<string, unknown> = { ...edits }
      if (dragged) {
        body.lat = dragged.lat
        body.lng = dragged.lng
      }
      if (Object.keys(body).length > 0) {
        await authedFetch(`${API_URL}/tracks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      clearMetadataEdits(id)
      setDraggedPositions((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setEditingVerifiedId((cur) => (cur === id ? null : cur))
      // Invalidate the revisions cache so the new metadata entry shows up.
      setRevisionsCache((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await Promise.all([loadPendingTracks(), loadVerifiedTracks()])
    } catch {}
  }

  const loadRevisions = async (trackId: number) => {
    setRevisionsLoadingFor(trackId)
    try {
      const res = await authedFetch(`${API_URL}/tracks/${trackId}/revisions`)
      if (res.ok) {
        const data = await res.json() as { revisions: Revision[] }
        setRevisionsCache((prev) => ({ ...prev, [trackId]: data.revisions }))
      }
    } catch {}
    finally {
      setRevisionsLoadingFor((cur) => (cur === trackId ? null : cur))
    }
  }

  const toggleRevisions = (trackId: number) => {
    if (showRevisionsFor === trackId) {
      setShowRevisionsFor(null)
      return
    }
    setShowRevisionsFor(trackId)
    if (!revisionsCache[trackId]) loadRevisions(trackId)
  }

  const handleVerifyTrack = async (id: number, status: 'verified' | 'rejected') => {
    try {
      // Persist any pending metadata edits before the status change so the
      // revision log records them under their own action.
      await flushMetadataEdits(id)

      const body: Record<string, unknown> = { status, verified_by: 'admin' }
      const dragged = draggedPositions[id]
      if (status === 'verified' && dragged) {
        body.lat = dragged.lat
        body.lng = dragged.lng
      }
      await authedFetch(`${API_URL}/tracks/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setSelectedMarker(null)
      setSelectedVerified(null)
      setSelectedPending(null)
      setDraggedPositions((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      // Strip the just-acted-on detection from the scan result so its old
      // tile-centroid marker doesn't keep prompting verify on top of the new
      // verified marker.
      setResult((prev) =>
        prev
          ? { ...prev, detections: prev.detections.filter((d) => d.track_id !== id) }
          : prev,
      )
      clearMetadataEdits(id)
      setEditingVerifiedId((cur) => (cur === id ? null : cur))
      setRevisionsCache((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await Promise.all([loadPendingTracks(), loadVerifiedTracks()])
    } catch {}
  }

  const handleManualAdd = async () => {
    const lat = parseFloat(manualLat)
    const lng = parseFloat(manualLng)
    if (isNaN(lat) || isNaN(lng)) return
    try {
      const body: Record<string, unknown> = {
        lat,
        lng,
        name: manualName || null,
        submitted_by: manualBy || null,
      }
      if (manualLanes) body.lane_count = parseInt(manualLanes, 10)
      if (manualSurface) body.surface = manualSurface
      if (manualLengthM) body.length_m = parseInt(manualLengthM, 10)
      if (manualAccess) body.access_type = manualAccess
      if (manualIndoor) body.is_indoor = true

      const res = await authedFetch(`${API_URL}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return
      const data = (await res.json()) as SubmitTrackResponse

      setManualLat('')
      setManualLng('')
      setManualName('')
      setManualBy('')
      setManualLanes('')
      setManualSurface('')
      setManualLengthM('')
      setManualAccess('')
      setManualIndoor(false)

      if (data.resurrected) {
        setManualNotice('A previously rejected track was resurrected at this location.')
      } else if (data.matched_existing) {
        setManualNotice(
          `Existing track found within 600 m (status: ${data.status}). Metadata updated; coords were not changed.`,
        )
      } else {
        setManualNotice(null)
      }

      // Center on the resolved position (which may differ from the clicked coords
      // if the backend merged into an existing nearby track).
      mapRef.current?.flyTo({ center: [data.lng, data.lat], zoom: 17, duration: 800 })
      // The moveEnd handler will refetch; call explicitly too in case zoom doesn't change.
      await Promise.all([loadPendingTracks(), loadVerifiedTracks()])
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
      setSelectedPending(null)
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
    // The scan-center selection only makes sense in admin mode; in the public
    // view we just fly to the location so users can browse for nearby tracks.
    if (adminMode) {
      setCenter({ lat, lng, name: shortName })
      setResult(null)
      setSelectedMarker(null)
    }
    setSearchQuery(shortName)
    setSuggestions([])
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 12, duration: 1500 })
  }

  const handlePasskey = async () => {
    if (!passkeyInput) return
    try {
      const res = await fetch(`${API_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: passkeyInput }),
      })
      if (res.ok) {
        sessionStorage.setItem('admin_token', passkeyInput)
        setAdminToken(passkeyInput)
      }
    } catch { /* network error — treat as invalid */ }
    setPasskeyInput('')
  }

  const lockAdmin = () => {
    sessionStorage.removeItem('admin_token')
    setAdminToken(null)
    setAdminMode(false)
    setDraggedPositions({})
    setSelectedPending(null)
  }

  const authedFetch = async (url: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
    }
    if (adminToken) headers['X-Admin-Token'] = adminToken
    const res = await fetch(url, { ...options, headers })
    if (res.status === 401) {
      sessionStorage.removeItem('admin_token')
      setAdminToken(null)
      setAdminMode(false)
    }
    return res
  }

  const handleScan = async () => {
    if (!center || scanning) return
    setScanning(true)
    setResult(null)
    setSelectedMarker(null)
    setScanProgress({ phase: 'starting', completed: 0, total: 0 })
    try {
      const res = await authedFetch(`${API_URL}/scan/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: center.lat, lng: center.lng, radius_km: radiusKm, threshold: threshold / 100 }),
      })
      if (!res.ok || !res.body) throw new Error(`API error ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are separated by a blank line.
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.trim()
          if (!line.startsWith('data: ')) continue
          let data: any
          try { data = JSON.parse(line.slice(6)) } catch { continue }
          if (data.type === 'progress') {
            setScanProgress({ phase: data.phase, completed: data.completed, total: data.total })
          } else if (data.type === 'result') {
            setResult({
              detections: data.detections,
              tiles_scanned: data.tiles_scanned,
              tiles_from_cache: data.tiles_from_cache,
              tiles_fetched_live: data.tiles_fetched_live,
            })
          }
        }
      }
    } catch (err) {
      console.error('Scan failed:', err)
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }

  const scanCircle = center ? circleGeoJSON(center.lat, center.lng, radiusKm) : null
  const scanBtnLabel = scanning ? 'Scanning...' : center
    ? `Scan ${radiusKm} km around ${center.name}`
    : 'Set a location first'

  // Compact one-line metadata summary, or null if nothing is set.
  const renderMetadataSummary = (t: Track) => {
    const parts: string[] = []
    if (t.lane_count) parts.push(`${t.lane_count} lanes`)
    if (t.surface) parts.push(t.surface)
    if (t.length_m) parts.push(`${t.length_m}m`)
    if (t.is_indoor) parts.push('indoor')
    if (t.access_type) parts.push(t.access_type)
    return parts.length ? <div className="popup-meta">{parts.join(' · ')}</div> : null
  }

  // Per-revision diff: list of "field: old → new" for non-noise fields.
  const summarizeRevisionDiff = (r: Revision): string | null => {
    if (!r.old_data) return null
    const old_data = r.old_data ?? {}
    const new_data = r.new_data ?? {}
    const noise = new Set(['last_confirmed_at', 'scan_count', 'id', 'first_seen_at'])
    const parts: string[] = []
    for (const k of Object.keys(new_data)) {
      if (noise.has(k)) continue
      const a = JSON.stringify(old_data[k] ?? null)
      const b = JSON.stringify(new_data[k] ?? null)
      if (a === b) continue
      const fmt = (s: string) => (s.length > 22 ? s.slice(0, 22) + '…' : s)
      parts.push(`${k}: ${fmt(a)} → ${fmt(b)}`)
    }
    return parts.length ? parts.join(' · ') : null
  }

  const renderRevisionsBlock = (trackId: number) => {
    const showing = showRevisionsFor === trackId
    const revs = revisionsCache[trackId]
    const loading = revisionsLoadingFor === trackId
    return (
      <div className="popup-revisions">
        <button className="action-btn revisions-toggle" onClick={() => toggleRevisions(trackId)}>
          {showing ? '▾' : '▸'} History{revs ? ` (${revs.length})` : ''}
        </button>
        {showing && (
          <div className="revisions-list">
            {loading && <div className="revisions-loading">Loading…</div>}
            {revs && revs.length === 0 && <div className="revisions-empty">No history.</div>}
            {revs && revs.map((r) => (
              <div key={r.id} className="revision-row">
                <div className="revision-meta">
                  <span className={`revision-action revision-action-${r.action}`}>{r.action}</span>
                  {' · '}{new Date(r.revised_at).toLocaleString()}
                  {r.revised_by ? ` · ${r.revised_by}` : ''}
                </div>
                {summarizeRevisionDiff(r) && (
                  <div className="revision-changes">{summarizeRevisionDiff(r)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Inline admin edit form for a track's metadata. Writes go to editedMetadata,
  // flushed on Save (or on Verify via handleVerifyTrack).
  const renderMetadataForm = (t: Track) => {
    const e = editedMetadata[t.id] ?? {}
    const v = <K extends keyof MetadataEdits>(k: K, fallback: MetadataEdits[K]): MetadataEdits[K] =>
      (e[k] === undefined ? fallback : e[k])
    const dirty = Object.keys(e).length > 0 || draggedPositions[t.id] != null
    return (
      <div className="popup-meta-form">
        <input className="popup-input" placeholder="Track name"
          value={(v('name', t.name) ?? '') as string}
          onChange={(ev) => setMetadataField(t.id, 'name', ev.target.value || null)} />
        <div className="form-row">
          <input className="popup-input" type="number" placeholder="Lanes" min={1} max={20}
            value={(v('lane_count', t.lane_count) ?? '') as number | string}
            onChange={(ev) => setMetadataField(t.id, 'lane_count', ev.target.value ? parseInt(ev.target.value, 10) : null)} />
          <input className="popup-input" type="number" placeholder="Length (m)" min={50} max={1000}
            value={(v('length_m', t.length_m) ?? '') as number | string}
            onChange={(ev) => setMetadataField(t.id, 'length_m', ev.target.value ? parseInt(ev.target.value, 10) : null)} />
        </div>
        <div className="form-row">
          <select className="popup-input"
            value={(v('surface', t.surface) ?? '') as string}
            onChange={(ev) => setMetadataField(t.id, 'surface', (ev.target.value || null) as Surface | null)}>
            <option value="">Surface…</option>
            {SURFACE_VALUES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="popup-input"
            value={(v('access_type', t.access_type) ?? '') as string}
            onChange={(ev) => setMetadataField(t.id, 'access_type', (ev.target.value || null) as AccessType | null)}>
            <option value="">Access…</option>
            {ACCESS_VALUES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <label className="checkbox-row">
          <input type="checkbox"
            checked={Boolean(v('is_indoor', t.is_indoor))}
            onChange={(ev) => setMetadataField(t.id, 'is_indoor', ev.target.checked)} />
          Indoor
        </label>
        <textarea className="popup-input" placeholder="Notes" rows={2}
          value={(v('notes', t.notes) ?? '') as string}
          onChange={(ev) => setMetadataField(t.id, 'notes', ev.target.value || null)} />
        {dirty && (
          <button className="action-btn verify" onClick={() => handleSaveMetadata(t.id)}>
            Save metadata
          </button>
        )}
      </div>
    )
  }

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

                <div className="form-row">
                  <input className="form-input" type="number" placeholder="Lanes" min={1} max={20}
                    value={manualLanes} onChange={(e) => setManualLanes(e.target.value)} />
                  <input className="form-input" type="number" placeholder="Length (m)" min={50} max={1000}
                    value={manualLengthM} onChange={(e) => setManualLengthM(e.target.value)} />
                </div>
                <div className="form-row">
                  <select className="form-input" value={manualSurface}
                    onChange={(e) => setManualSurface(e.target.value as Surface | '')}>
                    <option value="">Surface…</option>
                    {SURFACE_VALUES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className="form-input" value={manualAccess}
                    onChange={(e) => setManualAccess(e.target.value as AccessType | '')}>
                    <option value="">Access…</option>
                    {ACCESS_VALUES.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
                <label className="checkbox-row">
                  <input type="checkbox" checked={manualIndoor}
                    onChange={(e) => setManualIndoor(e.target.checked)} />
                  Indoor
                </label>

                <button className="scan-btn" onClick={handleManualAdd} disabled={!manualLat || !manualLng}>
                  Add Track
                </button>

                {manualNotice && (
                  <div className="manual-notice">
                    {manualNotice}
                    <button className="manual-notice-dismiss" onClick={() => setManualNotice(null)}>✕</button>
                  </div>
                )}
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
                        onClick={() => {
                          const pos = draggedPositions[t.id] ?? { lat: t.lat, lng: t.lng }
                          setSelectedPending(t)
                          setSelectedMarker(null)
                          setSelectedVerified(null)
                          mapRef.current?.flyTo({ center: [pos.lng, pos.lat], zoom: 17, duration: 800 })
                        }}>
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
              <button className="lock-btn" onClick={lockAdmin}>
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
          onMoveEnd={handleMapMoveEnd}
          onLoad={handleMapMoveEnd}
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

          {/* Verified track markers — draggable while their inline edit form is open */}
          {verifiedTracks.map((t) => {
            const isEditing = adminMode && editingVerifiedId === t.id
            const pos = isEditing
              ? (draggedPositions[t.id] ?? { lat: t.lat, lng: t.lng })
              : { lat: t.lat, lng: t.lng }
            return (
              <Marker
                key={`v-${t.id}`}
                longitude={pos.lng}
                latitude={pos.lat}
                anchor="center"
                draggable={isEditing}
                onDragEnd={(e) =>
                  setDraggedPositions((prev) => ({
                    ...prev,
                    [t.id]: { lat: e.lngLat.lat, lng: e.lngLat.lng },
                  }))
                }
              >
                <div
                  className="verified-marker"
                  style={{
                    transform: selectedVerified?.id === t.id ? 'rotate(45deg) scale(1.3)' : 'rotate(45deg)',
                    cursor: isEditing ? 'grab' : 'pointer',
                  }}
                  onClick={(e) => { e.stopPropagation(); setSelectedVerified(t); setSelectedMarker(null) }}
                />
              </Marker>
            )
          })}

          {/* Pending track markers (admin mode) — draggable to refine before verify */}
          {adminMode && pendingTracks
            .filter((t) => !result?.detections.some((d) => d.track_id === t.id))
            .map((t) => {
              const pos = draggedPositions[t.id] ?? { lat: t.lat, lng: t.lng }
              return (
                <Marker
                  key={`p-${t.id}`}
                  longitude={pos.lng}
                  latitude={pos.lat}
                  anchor="center"
                  draggable
                  onDragEnd={(e) =>
                    setDraggedPositions((prev) => ({
                      ...prev,
                      [t.id]: { lat: e.lngLat.lat, lng: e.lngLat.lng },
                    }))
                  }
                >
                  <div
                    style={{
                      width: 16, height: 16, borderRadius: '50%',
                      background: '#f5a623',
                      border: '2.5px solid rgba(255,255,255,0.9)',
                      cursor: 'grab',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                      transform: selectedPending?.id === t.id ? 'scale(1.3)' : 'scale(1)',
                      transition: 'transform 0.15s',
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedPending(t)
                      setSelectedMarker(null)
                      setSelectedVerified(null)
                    }}
                  />
                </Marker>
              )
            })}

          {/* Detection markers (admin scan results) — draggable in admin mode */}
          {result?.detections.map((d, i) => {
            const pos =
              adminMode && d.track_id != null && draggedPositions[d.track_id]
                ? draggedPositions[d.track_id]
                : { lat: d.lat, lng: d.lng }
            return (
              <Marker
                key={i}
                longitude={pos.lng}
                latitude={pos.lat}
                anchor="center"
                draggable={adminMode && d.track_id != null}
                onDragEnd={(e) => {
                  if (d.track_id != null) {
                    setDraggedPositions((prev) => ({
                      ...prev,
                      [d.track_id!]: { lat: e.lngLat.lat, lng: e.lngLat.lng },
                    }))
                  }
                }}
              >
                <div
                  style={{
                    width: 18, height: 18, borderRadius: '50%',
                    background: confidenceColor(d.confidence),
                    border: '2.5px solid rgba(255,255,255,0.9)',
                    cursor: adminMode && d.track_id != null ? 'grab' : 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                    transform: selectedMarker === d ? 'scale(1.3)' : 'scale(1)',
                    transition: 'transform 0.15s',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedMarker(d)
                    setSelectedVerified(null)
                    setSelectedPending(null)
                  }}
                />
              </Marker>
            )
          })}

          {/* Detection popup (admin: verify / reject) */}
          {selectedMarker && (() => {
            const pos =
              adminMode && selectedMarker.track_id != null && draggedPositions[selectedMarker.track_id]
                ? draggedPositions[selectedMarker.track_id]
                : { lat: selectedMarker.lat, lng: selectedMarker.lng }
            // The detection may correspond to an existing pending track row;
            // grab it so admins can fill in metadata before verifying.
            const trackForEdit = selectedMarker.track_id != null
              ? pendingTracks.find((t) => t.id === selectedMarker.track_id)
              : undefined
            return (
              <Popup longitude={pos.lng} latitude={pos.lat}
                anchor="bottom" offset={14} onClose={() => setSelectedMarker(null)} closeButton>
                <div className="popup-content">
                  <div className={`popup-confidence${selectedMarker.confidence < 0.85 ? ' medium' : ''}`}>
                    {Math.round(selectedMarker.confidence * 100)}% confident
                  </div>
                  <div className="popup-subtitle">Running track detected</div>
                  {adminMode && selectedMarker.track_id != null && (
                    <div className="popup-hint">Drag the pin onto the actual track before verifying.</div>
                  )}
                  {adminMode && trackForEdit && renderMetadataForm(trackForEdit)}
                  {selectedMarker.track_id != null && (
                    <div className="popup-actions">
                      <button className="action-btn verify" onClick={() => handleVerifyTrack(selectedMarker.track_id!, 'verified')}>✓ Verify</button>
                      <button className="action-btn reject" onClick={() => handleVerifyTrack(selectedMarker.track_id!, 'rejected')}>✗ Reject</button>
                    </div>
                  )}
                  {adminMode && selectedMarker.track_id != null && renderRevisionsBlock(selectedMarker.track_id)}
                  <a className="popup-link"
                    href={`https://www.google.com/maps/@${pos.lat},${pos.lng},18z`}
                    target="_blank" rel="noopener noreferrer">
                    Open in Google Maps ↗
                  </a>
                </div>
              </Popup>
            )
          })()}

          {/* Pending track popup (admin only) */}
          {selectedPending && adminMode && (() => {
            const pos = draggedPositions[selectedPending.id] ?? { lat: selectedPending.lat, lng: selectedPending.lng }
            return (
              <Popup longitude={pos.lng} latitude={pos.lat}
                anchor="bottom" offset={14} onClose={() => setSelectedPending(null)} closeButton>
                <div className="popup-content">
                  <div className="popup-pending-badge">⏳ Pending verification</div>
                  {selectedPending.name && <div className="popup-track-name">{selectedPending.name}</div>}
                  <div className="popup-subtitle">{pos.lat.toFixed(4)}°, {pos.lng.toFixed(4)}°</div>
                  <div className="popup-hint">Drag the pin onto the actual track before verifying.</div>
                  {renderMetadataForm(selectedPending)}
                  <div className="popup-actions">
                    <button className="action-btn verify" onClick={() => handleVerifyTrack(selectedPending.id, 'verified')}>✓ Verify</button>
                    <button className="action-btn reject" onClick={() => handleVerifyTrack(selectedPending.id, 'rejected')}>✗ Reject</button>
                  </div>
                  {renderRevisionsBlock(selectedPending.id)}
                  <a className="popup-link"
                    href={`https://www.google.com/maps/@${pos.lat},${pos.lng},18z`}
                    target="_blank" rel="noopener noreferrer">
                    Open in Google Maps ↗
                  </a>
                </div>
              </Popup>
            )
          })()}

          {/* Verified track popup */}
          {selectedVerified && (() => {
            const isEditing = adminMode && editingVerifiedId === selectedVerified.id
            const pos = isEditing
              ? (draggedPositions[selectedVerified.id] ?? { lat: selectedVerified.lat, lng: selectedVerified.lng })
              : { lat: selectedVerified.lat, lng: selectedVerified.lng }
            return (
              <Popup longitude={pos.lng} latitude={pos.lat}
                anchor="bottom" offset={14} onClose={() => setSelectedVerified(null)} closeButton>
                <div className="popup-content">
                  <div className="popup-verified-badge">✓ Verified Track</div>
                  {selectedVerified.name && <div className="popup-track-name">{selectedVerified.name}</div>}
                  <div className="popup-subtitle">
                    {pos.lat.toFixed(4)}°, {pos.lng.toFixed(4)}°
                  </div>
                  {isEditing && (
                    <div className="popup-hint">Drag the pin to relocate. Save to commit both metadata and location.</div>
                  )}
                  {isEditing
                    ? renderMetadataForm(selectedVerified)
                    : renderMetadataSummary(selectedVerified)}
                  {selectedVerified.notes && !isEditing && (
                    <div className="popup-notes">{selectedVerified.notes}</div>
                  )}
                  {adminMode && (
                    <>
                      <div className="popup-actions">
                        <button
                          className="action-btn"
                          onClick={() => setEditingVerifiedId(isEditing ? null : selectedVerified.id)}
                        >
                          {isEditing ? 'Done editing' : 'Edit metadata'}
                        </button>
                        <button className="action-btn reject" onClick={() => handleVerifyTrack(selectedVerified.id, 'rejected')}>✗ Reject</button>
                      </div>
                      {renderRevisionsBlock(selectedVerified.id)}
                    </>
                  )}
                  <a className="popup-link"
                    href={`https://www.google.com/maps/@${pos.lat},${pos.lng},18z`}
                    target="_blank" rel="noopener noreferrer">
                    Open in Google Maps ↗
                  </a>
                </div>
              </Popup>
            )
          })()}

        </Map>

        {/* Pick mode banner */}
        {pickMode && (
          <div className="pick-banner">
            {pickMode === 'scan-center' ? 'Click map to set scan center' : 'Click map to place track'}
            <button className="pick-cancel" onClick={() => setPickMode(null)}>✕</button>
          </div>
        )}

        {scanning && (
          <div className="scanning-badge">
            <div className="scanning-label">
              {scanProgress
                ? `${scanProgress.phase === 'fetching' ? 'Fetching tiles' :
                    scanProgress.phase === 'inferring' ? 'Running model' :
                    scanProgress.phase === 'clustering' ? 'Clustering detections' :
                    'Starting'}` +
                  (scanProgress.total > 0 ? `: ${scanProgress.completed}/${scanProgress.total}` : '')
                : 'Scanning satellite imagery...'}
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: scanProgress && scanProgress.total > 0
                    ? `${(scanProgress.completed / scanProgress.total) * 100}%`
                    : '0%',
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
