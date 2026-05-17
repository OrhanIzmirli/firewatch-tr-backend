// Fire Interface
export interface Fire {
  id: number;
  title: string;
  location: string;
  city: string;
  district?: string;
  description?: string;
  latitude: number;
  longitude: number;
  status: 'Aktif' | 'Kontrol Altında' | 'Söndürüldü';
  risk_level: number;
  severity?: string;
  source_url?: string;
  created_at: Date;
  updated_at: Date;
}

// News Interface
export interface News {
  id: number;
  title: string;
  summary?: string;
  body: string;
  source?: string;
  source_url?: string;
  category?: 'Risk' | 'Safety' | 'Alert' | 'General';
  is_breaking: boolean;
  published_at?: Date;
  read_minutes?: number;
  related_region?: string;
  highlights?: string;
  paragraphs?: string;
  created_at: Date;
}

// FCM Token Interface
export interface FCMToken {
  id: number;
  token: string;
  latitude?: number;
  longitude?: number;
  device_info?: string;
  is_active: boolean;
  last_updated: Date;
  created_at: Date;
}

// Notification Interface
export interface Notification {
  id: number;
  fire_id: number;
  title: string;
  body: string;
  sent_count: number;
  created_at: Date;
}

// Risk Data Interface
export interface RiskData {
  id: number;
  region: string;
  date: Date;
  general_risk_score?: number;
  risk_level?: string;
  temperature?: number;
  humidity?: number;
  wind_speed?: number;
  wind_direction?: string;
  dryness_index?: number;
  vegetation_density?: number;
  accessibility?: string;
  created_at: Date;
}

// GeoJSON Feature Interface
export interface GeoJSONFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  properties: {
    id: number;
    title: string;
    city: string;
    status: string;
    risk_level: number;
  };
}

// GeoJSON FeatureCollection Interface
export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

// API Response Interface
export interface ApiResponse<T> {
  status: 'success' | 'error';
  message: string;
  data?: T;
  error?: string;
  timestamp: string;
}

// Pagination Interface
export interface PaginationParams {
  limit: number;
  offset: number;
  total?: number;
}

// Fire Filter Interface
export interface FireFilter {
  status?: string;
  city?: string;
  risk_level?: number;
  limit?: number;
  offset?: number;
}

// Database Config Interface
export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// Redis Config Interface
export interface RedisConfig {
  host: string;
  port: number;
  db?: number;
}