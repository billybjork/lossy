/**
 * Telemetry Emitter
 *
 * Lightweight event pipeline for logging WARN/ERROR level events coming from shared logger.
 * Events are forwarded to the background service worker where they can be buffered, surfaced
 * in the debug drawer, or forwarded to the backend when telemetry infrastructure lands.
 *
 * The emitter is intentionally dependency-free so it can be imported from any extension context
 * (service worker, offscreen, sidepanel, content scripts).
 */

/**
 * Attempt to send a telemetry payload to the background service worker.
 * Gracefully no-ops if the runtime API is unavailable (e.g. in unit tests).
 *
 * @param {object} payload - Serializable telemetry payload
 */
function sendToRuntime(payload) {
  try {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.id || !chrome.runtime.sendMessage) {
      return;
    }

    const result = chrome.runtime.sendMessage(payload);
    // sendMessage returns a Promise in MV3. Silence rejections when nobody handles the message.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (err) {
    // Silently swallow runtime errors to avoid recursive logging loops
  }
}

/**
 * Convert values to something that survives structured clone when sent via postMessage.
 *
 * @param {any} value - Arbitrary log argument
 * @returns {any} Serializable value
 */
function toSerializable(value) {
  if (value instanceof Error) {
    return serializeError(value);
  }

  const valueType = typeof value;
  if (valueType === 'function') {
    return { type: 'function', name: value.name || 'anonymous' };
  }

  if (valueType === 'symbol') {
    return { type: 'symbol', description: value.description || value.toString() };
  }

  if (value && valueType === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return {
        type: 'object',
        summary: value.constructor?.name || 'Object',
        description: String(value),
      };
    }
  }

  return value;
}

/**
 * Serialize an Error into a plain object for transport.
 *
 * @param {Error|any} error - Error instance or arbitrary value
 * @returns {object|null} Serialized error representation
 */
function serializeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  if (typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch {
      return {
        message: error.message || String(error),
        type: error.constructor?.name || 'Object',
      };
    }
  }

  return {
    message: String(error),
    type: typeof error,
  };
}

/**
 * Emit telemetry event to background context.
 *
 * @param {'warn'|'error'} level
 * @param {string} context
 * @param {object} payload
 */
function emit(level, context, payload) {
  sendToRuntime({
    action: 'telemetry_event',
    level,
    context,
    payload,
    timestamp: Date.now(),
  });
}

export const telemetryEmitter = {
  /**
   * Emit warning telemetry.
   *
    * @param {string} context - Logical component (e.g. 'VAD', 'Passive')
    * @param {Array<any>} args - Additional log arguments
   */
  warn(context, args = []) {
    emit('warn', context, {
      args: Array.isArray(args) ? args.map(toSerializable) : [toSerializable(args)],
    });
  },

  /**
   * Emit error telemetry.
   *
   * @param {string} context - Logical component name
   * @param {Error|any} error - Error instance or error-like object
   * @param {Array<any>} args - Additional context arguments
   */
  error(context, error, args = []) {
    emit('error', context, {
      error: serializeError(error),
      args: Array.isArray(args) ? args.map(toSerializable) : [toSerializable(args)],
    });
  },
};

