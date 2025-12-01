/**
 * EditorArrival hook - Cinematic arrival animation for fresh captures.
 *
 * Server renders (when @fresh_arrival is true):
 * - Dark overlay at z-50
 * - Figure container at z-60 (spotlight above overlay)
 * - Image/skeleton with .hero-entrance class (scale 1.02, drop-shadow glow)
 * - Header/toolbar hidden (opacity-0)
 *
 * This hook animates the transition:
 * 1. Brief hold for spotlight moment (150ms)
 * 2. Removes .hero-entrance class to trigger CSS transition
 * 3. Fades overlay, fades in UI elements
 * 4. Cleans up and tells server to clear fresh_arrival
 *
 * The .hero-entrance class is shared between skeleton and image, ensuring
 * seamless visual continuity when the image replaces the skeleton.
 *
 * IMPORTANT: We must delay pushEvent("clear_fresh_arrival") until AFTER the
 * animation completes. If called too early, the server re-renders the template
 * without the hero-entrance class, causing the animation to fail.
 */
export const EditorArrival = {
  mounted() {
    this.isFresh = this.el.hasAttribute('data-fresh')
    this.hasAnimated = false

    if (this.isFresh) {
      // Clean URL of ?fresh parameter without reload
      history.replaceState({}, '', window.location.pathname)

      // Only animate the actual image, not the skeleton.
      // This ensures we don't run the animation twice (once on skeleton, once on image)
      // and that the visual transition happens when the real content is ready.
      const image = this.el.querySelector('#editor-image.hero-entrance')
      if (image) {
        this.animateSettle(image)
      }
    }
  },

  updated() {
    // Handle case where image loads after initial mount (async asset loading)
    // The image replaces the skeleton, so we check for the image specifically
    if (this.isFresh && !this.hasAnimated) {
      const image = this.el.querySelector('#editor-image.hero-entrance')
      if (image) {
        this.animateSettle(image)
      }
    }
  },

  animateSettle(hero) {
    if (this.hasAnimated) return
    this.hasAnimated = true

    const overlay = document.getElementById('arrival-overlay')
    const header = document.getElementById('editor-header')
    const toolbar = document.getElementById('editor-toolbar')
    const container = this.el

    // Brief hold for spotlight moment - let user see the dramatic entrance
    setTimeout(() => {
      // Fade overlay from dark to transparent
      if (overlay) {
        overlay.style.transition = 'opacity 400ms ease-out'
        overlay.style.opacity = '0'
      }

      // Add transition before removing class so the change animates
      hero.style.transition = 'transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1), filter 600ms ease-out'

      // Remove hero-entrance class to trigger transition to normal state
      hero.classList.remove('hero-entrance')

      // Fade in UI elements (slightly delayed for staggered effect)
      setTimeout(() => {
        if (header) header.style.opacity = '1'
        if (toolbar) toolbar.style.opacity = '1'
      }, 200)

      // Cleanup after all animations complete
      setTimeout(() => {
        if (overlay) overlay.remove()

        // Clear z-index class (was z-60 for spotlight effect)
        container.classList.remove('z-60')

        // Clear inline transition style
        hero.style.transition = ''

        if (header) header.style.opacity = ''
        if (toolbar) toolbar.style.opacity = ''

        // NOW tell server to clear fresh_arrival flag
        // This must happen AFTER animation completes to prevent re-render
        // from stripping styles mid-animation
        this.pushEvent("clear_fresh_arrival", {})
      }, 700)
    }, 150)
  }
}
