/**
 * EditableText Hook
 *
 * Handles contenteditable text regions for the Canva-style editing experience.
 * Auto-focuses, selects text on mount, and commits changes on Enter or blur.
 */

import type { Hook } from 'phoenix_live_view';

interface EditableTextState {
  handleKeyDown: (e: KeyboardEvent) => void;
  handleBlur: (e: FocusEvent) => void;
}

export const EditableText: Hook<EditableTextState, HTMLElement> = {
  mounted() {
    // Focus the element
    this.el.focus();

    // Select all text on focus for easy editing
    const range = document.createRange();
    range.selectNodeContents(this.el);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Handle Enter key to commit (without shift)
    this.handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    };

    this.el.addEventListener('keydown', this.handleKeyDown);

    // Handle blur to auto-commit
    this.handleBlur = (_e: FocusEvent) => {
      // Small delay to allow click events to fire first
      setTimeout(() => {
        this.commit();
      }, 100);
    };

    this.el.addEventListener('blur', this.handleBlur);
  },

  destroyed() {
    // Clean up event listeners
    if (this.handleKeyDown) {
      this.el.removeEventListener('keydown', this.handleKeyDown);
    }
    if (this.handleBlur) {
      this.el.removeEventListener('blur', this.handleBlur);
    }
  },

  commit() {
    const text = this.el.textContent?.trim() || '';
    const regionId = this.el.dataset.regionId;

    // Push event to LiveView
    this.pushEvent("commit_text_change", {
      "region-id": regionId,
      text: text
    });
  },

  cancel() {
    // Could implement cancel logic here
    // For now, just blur which will commit
    this.el.blur();
  }
};
