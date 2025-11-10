export interface CapturePayload {
  source_url: string;
  capture_mode: 'screenshot' | 'direct_asset' | 'composited_region';
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
