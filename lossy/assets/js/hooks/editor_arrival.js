/**
 * EditorArrival hook - Cinematic arrival animation for fresh captures.
 *
 * Server renders:
 * - Dark overlay at z-50
 * - Image container at z-60 (spotlight above overlay)
 * - Image with glow effect
 * - Header/toolbar hidden (opacity-0)
 *
 * This hook:
 * - Brief hold for spotlight moment
 * - Fades overlay, settles image glow
 * - Fades in UI elements
 * - Cleans up styles
 */
export const EditorArrival = {
  mounted() {
    this.isFresh = this.el.hasAttribute('data-fresh')
    this.hasAnimated = false

    if (this.isFresh) {
      history.replaceState({}, '', window.location.pathname)

      const image = this.el.querySelector('img')
      if (image) {
        this.animateSettle(image)
      }
    }
  },

  updated() {
    if (this.isFresh && !this.hasAnimated) {
      const image = this.el.querySelector('img')
      if (image) {
        this.animateSettle(image)
      }
    }
  },

  animateSettle(image) {
    if (this.hasAnimated) return
    this.hasAnimated = true

    const overlay = document.getElementById('arrival-overlay')
    const header = document.getElementById('editor-header')
    const toolbar = document.getElementById('editor-toolbar')
    const container = this.el

    // Tell server to clear fresh_arrival so re-renders don't re-hide elements
    this.pushEvent("clear_fresh_arrival", {})

    // Brief hold for spotlight moment
    setTimeout(() => {
      // Fade overlay
      if (overlay) {
        overlay.style.transition = 'opacity 400ms ease-out'
        overlay.style.opacity = '0'
      }

      // Settle image
      Object.assign(image.style, {
        transition: 'transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1), filter 600ms ease-out',
        transform: 'scale(1)',
        filter: 'none'
      })

      // Fade in UI elements (slightly delayed)
      setTimeout(() => {
        if (header) header.style.opacity = '1'
        if (toolbar) toolbar.style.opacity = '1'
      }, 200)

      // Cleanup after all animations
      setTimeout(() => {
        if (overlay) overlay.remove()

        // Clear z-index class
        container.classList.remove('z-[60]')

        // Clear inline styles
        image.style.transform = ''
        image.style.filter = ''
        image.style.transition = ''

        if (header) header.style.opacity = ''
        if (toolbar) toolbar.style.opacity = ''
      }, 700)
    }, 150)
  }
}
