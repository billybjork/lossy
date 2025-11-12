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
}

export interface CaptureResponse {
  id: string;
  status: string;
}
