import Dexie from 'dexie';

const db = new Dexie('LossyExtensionDB');

db.version(1).stores({
  notes: 'id, video_id, timestamp_seconds, cached_at, [video_id+timestamp_seconds]',
  videos: 'id, user_id, status, platform, last_viewed_at, cached_at',
  sync_metadata: 'key',
});

export default db;
