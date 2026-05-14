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

export type Surface = 'synthetic' | 'dirt' | 'grass' | 'asphalt' | 'cinder' | 'other' | 'unknown'
export type AccessType = 'public' | 'school' | 'university' | 'private' | 'unknown'

export interface TrackMetadata {
  lane_count: number | null
  surface: Surface | null
  length_m: number | null
  is_indoor: boolean
  access_type: AccessType | null
  country: string | null
  notes: string | null
}

export interface Track extends TrackMetadata {
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

export interface SubmitTrackResponse {
  id: number
  lat: number
  lng: number
  status: Track['status']
  resurrected: boolean
  matched_existing: boolean
}

export const SURFACE_VALUES: Surface[] = ['synthetic', 'dirt', 'grass', 'asphalt', 'cinder', 'other', 'unknown']
export const ACCESS_VALUES: AccessType[] = ['public', 'school', 'university', 'private', 'unknown']

export interface Revision {
  id: number
  track_id: number
  revised_at: string
  revised_by: string | null
  action: string
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  note: string | null
}

export interface GeocodingFeature {
  place_name: string
  center: [number, number] // [lng, lat]
}
