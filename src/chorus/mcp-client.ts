import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PACKAGE_VERSION } from "../package-info"
import { createChorusMcpHeaders, resolveChorusMcpUrl, type ChorusMcpScope } from "./mcp-config"
import type { ChorusToolTextContent, McpClientStatus } from "./types"

export type ChorusMcpClientOptions = {
  chorusUrl: string
  apiKey: string
  instanceUuid?: string
}

type McpToolResult = Awaited<ReturnType<Client["callTool"]>>

export type ChorusMcpToolDefinition = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export function parseToolResult(content: ChorusToolTextContent[]): unknown {
  const text = content.find((item) => item.type === "text" && item.text !== undefined)?.text
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function isRetryableMcpSessionError(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404
}

export class ChorusMcpClient {
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null
  private connectPromise: Promise<void> | null = null
  private connectionGeneration = 0
  private statusValue: McpClientStatus = "disconnected"

  constructor(private readonly options: ChorusMcpClientOptions) {}

  get status(): McpClientStatus {
    return this.statusValue
  }

  async connect(): Promise<void> {
    if (this.statusValue === "connected") return
    if (this.connectPromise) return this.connectPromise

    const promise = this.openConnection(this.connectionGeneration)
    this.connectPromise = promise
    try {
      await promise
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null
    }
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration++
    this.connectPromise = null
    const client = this.client
    const transport = this.transport

    try {
      if (client) {
        await client.close()
      } else {
        await transport?.close()
      }
    } catch (error) {
      await transport?.close().catch(() => {})
      throw error
    } finally {
      this.statusValue = "disconnected"
      this.client = null
      this.transport = null
    }
  }

  async callTool<T>(name: string, args: Record<string, unknown> = {}, scope?: ChorusMcpScope): Promise<T> {
    if (scope) return this.callScopedTool<T>(name, args, scope)

    try {
      return await this.callConnectedTool<T>(name, args)
    } catch (error) {
      if (!isRetryableMcpSessionError(error)) throw error

      this.connectionGeneration++
      this.statusValue = "reconnecting"
      await this.client?.close()
      this.client = null
      this.transport = null
      return this.callConnectedTool<T>(name, args)
    }
  }

  async listTools(): Promise<ChorusMcpToolDefinition[]> {
    await this.connect()
    if (!this.client) throw new Error("Chorus MCP client is not connected")

    const tools: ChorusMcpToolDefinition[] = []
    let cursor: string | undefined
    do {
      const result = await this.client.listTools({ cursor })
      tools.push(
        ...result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
      )
      cursor = result.nextCursor
    } while (cursor)

    return tools
  }

  private async openConnection(generation: number): Promise<void> {
    this.statusValue = this.statusValue === "reconnecting" ? "reconnecting" : "connecting"

    const { client, transport } = this.createClientAndTransport()

    try {
      await client.connect(transport)
      if (generation !== this.connectionGeneration) {
        await client.close().catch(() => transport.close())
        return
      }

      this.client = client
      this.transport = transport
      this.statusValue = "connected"
    } catch (error) {
      if (generation === this.connectionGeneration) this.statusValue = "disconnected"
      await transport.close().catch(() => {})
      throw error
    }
  }

  private async callConnectedTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect()
    if (!this.client) throw new Error("Chorus MCP client is not connected")

    const result = await this.client.callTool({ name, arguments: args })
    if ("isError" in result && result.isError) {
      throw new Error(this.formatToolError(result))
    }

    if ("content" in result) return parseToolResult(result.content as ChorusToolTextContent[]) as T
    return result.toolResult as T
  }

  private async callScopedTool<T>(name: string, args: Record<string, unknown>, scope: ChorusMcpScope): Promise<T> {
    const { client, transport } = this.createClientAndTransport(scope)
    try {
      await client.connect(transport)
      const result = await client.callTool({ name, arguments: args })
      if ("isError" in result && result.isError) throw new Error(this.formatToolError(result))
      if ("content" in result) return parseToolResult(result.content as ChorusToolTextContent[]) as T
      return result.toolResult as T
    } finally {
      await client.close().catch(() => transport.close())
    }
  }

  private createClientAndTransport(scope?: ChorusMcpScope): { client: Client; transport: StreamableHTTPClientTransport } {
    const client = new Client({ name: "opencode-chorus", version: PACKAGE_VERSION })
    const transport = new StreamableHTTPClientTransport(new URL(resolveChorusMcpUrl(this.options.chorusUrl)), {
      requestInit: {
        headers: createChorusMcpHeaders(this.options.apiKey, scope, this.options.instanceUuid),
      },
    })
    return { client, transport }
  }

  private formatToolError(result: McpToolResult): string {
    if ("content" in result) {
      const parsed = parseToolResult(result.content as ChorusToolTextContent[])
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed)
    }

    return JSON.stringify(result.toolResult)
  }
}
