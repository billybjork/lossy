/**
 * Image Loading Utilities
 *
 * Helpers for working with the editor image element.
 * Provides safe image loading with timeout protection.
 */

export interface ImageLoadOptions {
  timeout?: number; // Default 10000ms
}

/**
 * Wait for an image to finish loading
 * Returns immediately if image is already loaded
 * Rejects if loading fails or times out
 */
export async function waitForImageLoad(
  img: HTMLImageElement,
  options?: ImageLoadOptions
): Promise<void> {
  if (img.complete) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = options?.timeout ?? 10000;
    const timeoutId = setTimeout(() => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      reject(new Error(`Image load timeout after ${timeout}ms`));
    }, timeout);

    const onLoad = () => {
      clearTimeout(timeoutId);
      img.removeEventListener('error', onError);
      resolve();
    };

    const onError = () => {
      clearTimeout(timeoutId);
      img.removeEventListener('load', onLoad);
      reject(new Error('Image failed to load'));
    };

    img.addEventListener('load', onLoad, { once: true });
    img.addEventListener('error', onError, { once: true });
  });
}

/**
 * Get the main editor image element
 * Returns null if not found
 */
export function getEditorImage(): HTMLImageElement | null {
  return document.getElementById('editor-image') as HTMLImageElement | null;
}
