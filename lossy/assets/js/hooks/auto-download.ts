/**
 * AutoDownload hook - Automatically triggers download when export is complete.
 *
 * This hook monitors the download button for changes to the data-export-path attribute.
 * When the export completes and a path is available, it automatically clicks the
 * hidden download link to initiate the browser download.
 */

import type { Hook } from 'phoenix_live_view';

interface AutoDownloadState {
  lastPath: string | null;
}

export const AutoDownload: Hook<AutoDownloadState, HTMLElement> = {
  mounted() {
    this.lastPath = null;
    this.checkAndDownload();
  },

  updated() {
    this.checkAndDownload();
  },

  checkAndDownload() {
    const exportPath = this.el.getAttribute('data-export-path');

    // Only trigger download if path just became available (wasn't there before)
    if (exportPath && exportPath !== this.lastPath) {
      this.lastPath = exportPath;

      // Get the hidden download link and trigger click
      const downloadLink = document.getElementById('export-download-link') as HTMLAnchorElement | null;
      if (downloadLink && downloadLink.href) {
        // Small delay to ensure the link attributes are fully updated
        setTimeout(() => {
          downloadLink.click();
        }, 100);
      }
    }
  }
};
