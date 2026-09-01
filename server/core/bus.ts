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
