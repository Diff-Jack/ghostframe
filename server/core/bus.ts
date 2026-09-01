import { EventEmitter } from 'node:events'
import type { StreamMessage } from '../../shared/types.js'

/**
 * Fan-out for server-sent events. The UI holds one EventSource and re-renders
 * as runs and events arrive, so recording feels live without polling.
 */
class Bus extends EventEmitter {
  publish(message: StreamMessage): void {
    this.emit('message', message)
  }

  subscribe(listener: (message: StreamMessage) => void): () => void {
    this.on('message', listener)
    return () => this.off('message', listener)
  }
}

export const bus = new Bus()
bus.setMaxListeners(64)

/**
 * Open SSE responses.
 *
 * An event stream never completes on its own, so `fastify.close()` would wait
 * on it forever and the process would ignore Ctrl-C. Shutdown ends these
 * explicitly first.
 */
const openStreams = new Set<{ end: () => void }>()

export function trackStream(stream: { end: () => void }): () => void {
  openStreams.add(stream)
  return () => openStreams.delete(stream)
}

export function closeAllStreams(): void {
  for (const stream of openStreams) {
    try {
      stream.end()
    } catch {
      // Already torn down by the client.
    }
  }
  openStreams.clear()
}
