type ChorusRemoteMcpConfig = {
  type: "remote"
  url: string
  headers: Record<string, string>
  oauth: false
  enabled: true
}

function normalizeChorusBaseUrl(chorusUrl: string): URL {
  return new URL(chorusUrl.endsWith("/") ? chorusUrl : `${chorusUrl}/`)
}

export function resolveChorusMcpUrl(chorusUrl: string): string {
  return new URL("api/mcp", normalizeChorusBaseUrl(chorusUrl)).toString()
}

export type ChorusMcpScope = {
  projectUuid?: string
  projectGroupUuid?: string
}

export function createChorusMcpHeaders(
  apiKey: string,
  scope?: ChorusMcpScope,
  instanceUuid?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }

  // Instance identity for pinned-task affinity: lets the server reject claims
  // on tasks pinned to a different machine+directory instance.
  if (instanceUuid) headers["X-Chorus-Instance"] = instanceUuid

  if (scope?.projectGroupUuid) headers["X-Chorus-Project-Group"] = scope.projectGroupUuid
  else if (scope?.projectUuid) headers["X-Chorus-Project"] = scope.projectUuid

  return headers
}

export function createChorusRemoteMcpConfig(chorusUrl: string, apiKey: string): ChorusRemoteMcpConfig {
  return {
    type: "remote",
    url: resolveChorusMcpUrl(chorusUrl),
    headers: createChorusMcpHeaders(apiKey),
    oauth: false,
    enabled: true,
  }
}
