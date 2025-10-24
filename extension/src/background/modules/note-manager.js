/**
 * Note Manager Module
 *
 * Responsibilities:
 * - Load notes for videos
 * - Delete notes
 * - Sync timeline markers to content scripts
 *
 * Dependencies (injected):
 * - getOrCreateVideoChannel: Function to get/create video channel
 */

// Dependencies (will be injected via init)
let getOrCreateVideoChannel = null;

/**
 * Initialize note manager with dependencies
 */
export function initNoteManager(deps) {
  getOrCreateVideoChannel = deps.getOrCreateVideoChannel;
}

/**
 * Load notes for a video and send to content script
 */
export async function loadNotesForVideo(videoDbId, tabId) {
  console.log('[NoteManager] 📝 Loading notes for video:', videoDbId, 'in tab:', tabId);

  // Get or create video channel
  const videoChannel = await getOrCreateVideoChannel();

  // Request notes
  return new Promise((resolve, reject) => {
    videoChannel
      .push('get_notes', { video_id: videoDbId })
      .receive('ok', (notesResponse) => {
        console.log(
          '[NoteManager] 📝 Received',
          notesResponse.notes?.length || 0,
          'existing notes for content script'
        );

        // Send notes ONLY to content script for timeline markers (NOT to side panel)
        chrome.tabs
          .sendMessage(tabId, {
            action: 'load_markers',
            notes: notesResponse.notes,
          })
          .catch(() => console.log('[NoteManager] ⚠️ No content script on this page'));

        resolve();
      })
      .receive('error', (err) => {
        console.error('[NoteManager] Failed to get notes:', err);
        reject(err);
      });
  });
}

/**
 * Delete a note
 */
export async function deleteNote(noteId) {
  console.log('[NoteManager] 🗑️ Deleting note:', noteId);

  // Get or create video channel
  const videoChannel = await getOrCreateVideoChannel();

  // Delete the note
  return new Promise((resolve, reject) => {
    videoChannel
      .push('delete_note', { note_id: noteId })
      .receive('ok', () => {
        console.log('[NoteManager] 🗑️ Note deleted successfully');
        resolve();
      })
      .receive('error', (err) => {
        console.error('[NoteManager] Failed to delete note:', err);
        reject(err);
      });
  });
}
