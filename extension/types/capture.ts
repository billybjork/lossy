export interface TextRegionPayload {
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  polygon?: Array<{ x: number; y: number }>;
  confidence: number;
}

export interface CapturePayload {
  source_url: string;
  capture_mode: 'screenshot' | 'direct_asset';
  image_url?: string;
  image_data?: string;
  bounding_rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // Actual image dimensions in pixels (for skeleton placeholder sizing)
  image_width?: number;
  image_height?: number;
  // Local text detection results (optional, skips cloud detection if provided)
  text_regions?: TextRegionPayload[];
  detection_backend?: 'webgpu' | 'wasm' | null;
  detection_time_ms?: number;
}

export interface CaptureResponse {
  id: string;
  status: string;
}
