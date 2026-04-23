export interface Detection {
  lat: number
  lng: number
  confidence: number
  track_id?: number
}

export interface ScanResult {
  detections: Detection[]
  tiles_scanned: number
  tiles_from_cache?: number
  tiles_fetched_live?: number
}

export interface Track {
  id: number
  lat: number
  lng: number
  confidence: number
  status: 'pending' | 'verified' | 'rejected'
  name: string | null
  submitted_by: string | null
  verified_by: string | null
  first_seen_at: string
  last_confirmed_at: string
  scan_count: number
}

export interface GeocodingFeature {
  place_name: string
  center: [number, number] // [lng, lat]
}
