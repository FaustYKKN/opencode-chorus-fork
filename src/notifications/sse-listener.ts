export type SseNotificationEvent = {
  type: string
  notificationUuid?: string
  /** Present on the connection_registered handshake event. */
  connectionUuid?: string
  /** Directed-delivery transport fields (stamped per-event by the server). */
  targetConnectionUuid?: string | null
  suppressWake?: boolean
}
export type SseListenerStatus = "connected" | "disconnected" | "reconnecting"

type ChorusSseListenerOptions = {
  onConnect?: () => Promise<void>
  onReconnect?: () => Promise<void>
  onStatusChange?: (status: SseListenerStatus, error?: string) => Promise<void> | void
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export type ParsedSseNotificationChunk = {
  events: SseNotificationEvent[]
  buffer: string
}

export function parseSseNotificationChunk(buffer: string, chunk: string): ParsedSseNotificationChunk {
  let nextBuffer = (buffer + chunk).replace(/\r\n/g, "\n")
  const events: SseNotificationEvent[] = []
  let boundary = nextBuffer.indexOf("\n\n")

  while (boundary !== -1) {
    const raw = nextBuffer.slice(0, boundary)
    nextBuffer = nextBuffer.slice(boundary + 2)
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")

    if (data) {
      const event = parseNotificationEvent(data)
      if (event) events.push(event)
    }

    boundary = nextBuffer.indexOf("\n\n")
  }

  return { events, buffer: nextBuffer }
}

export class ChorusSseListener {
  private abortController: AbortController | null = null
  private statusValue: SseListenerStatus = "disconnected"
  private connectPromise: Promise<void> | null = null
  private reconnectDelayTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayResolve: (() => void) | null = null
  private stopped = false
  private ownConnectionUuid: string | null = null

  constructor(
    private readonly chorusUrl: string,
    private readonly apiKey: string,
    private readonly onEvent: (event: SseNotificationEvent) => void,
    private readonly options: ChorusSseListenerOptions = {},
  ) {}

  get status(): SseListenerStatus {
    return this.statusValue
  }

  /** This listener's AgentInstance uuid, learned from the connection_registered handshake. */
  get connectionUuid(): string | null {
    return this.ownConnectionUuid
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.stopped = false
    const promise = this.run()
    this.connectPromise = promise
    try {
      await promise
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null
    }
  }

  disconnect(): void {
    this.stopped = true
    this.abortController?.abort()
    this.abortController = null
    this.cancelReconnectDelay()
    void this.updateStatus("disconnected")
  }

  private async run(): Promise<void> {
    const initialDelay = this.options.initialReconnectDelayMs ?? 1_000
    const maxDelay = this.options.maxReconnectDelayMs ?? 30_000
    let reconnectDelay = initialDelay
    let connectedOnce = false

    while (!this.stopped) {
      this.abortController = new AbortController()

      try {
        const response = await fetch(`${this.chorusUrl.replace(/\/$/, "")}/api/events/notifications`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "text/event-stream",
          },
          signal: this.abortController.signal,
        })

        if (!response.ok) throw new Error(`Chorus notification SSE request failed with status ${response.status}`)

        const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined
        if (!reader) throw new Error("Chorus notification SSE response body is missing")
        const wasReconnect = connectedOnce
        await this.updateStatus("connected")
        reconnectDelay = initialDelay
        connectedOnce = true
        if (wasReconnect) await this.options.onReconnect?.()
        else await this.options.onConnect?.()
        await this.consume(reader)

        if (this.stopped) break
        await this.updateStatus("reconnecting", "Chorus notification SSE stream ended")
      } catch (error) {
        if (this.stopped || this.abortController?.signal.aborted) break
        const message = error instanceof Error ? error.message : String(error)
        await this.updateStatus("reconnecting", message)
      } finally {
        this.abortController = null
      }

      if (this.stopped) break
      await this.waitForReconnectDelay(reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay)
    }

    await this.updateStatus("disconnected")
  }

  private async consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read()
        if (done) break
        const parsed = parseSseNotificationChunk(buffer, decoder.decode(value, { stream: true }))
        buffer = parsed.buffer
        for (const event of parsed.events) {
          if (event.type === "connection_registered" && typeof event.connectionUuid === "string") {
            this.ownConnectionUuid = event.connectionUuid
          }
          this.onEvent(event)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async updateStatus(status: SseListenerStatus, error?: string): Promise<void> {
    this.statusValue = status
    await this.options.onStatusChange?.(status, error)
  }

  private waitForReconnectDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve()
        return
      }

      this.reconnectDelayResolve = () => {
        this.reconnectDelayResolve = null
        if (this.reconnectDelayTimer) clearTimeout(this.reconnectDelayTimer)
        this.reconnectDelayTimer = null
        resolve()
      }

      this.reconnectDelayTimer = setTimeout(() => {
        this.reconnectDelayResolve?.()
      }, ms)
    })
  }

  private cancelReconnectDelay(): void {
    this.reconnectDelayResolve?.()
  }
}

function parseNotificationEvent(data: string): SseNotificationEvent | null {
  try {
    const parsed = JSON.parse(data)
    return isSseNotificationEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isSseNotificationEvent(value: unknown): value is SseNotificationEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string"
  )
}
