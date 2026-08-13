import type { NextConfig } from "next";

// Note: the MCP endpoint lives at /api/mcp. That "/api" prefix comes from the
// route file location (app/api/[transport]/route.ts) combined with the
// `basePath: "/api"` option passed to mcp-handler's createMcpHandler — NOT from
// Next.js's own `basePath`. Do not set a Next.js basePath here or the endpoint
// would move to /api/api/mcp and silently break the connector.
const nextConfig: NextConfig = {};

export default nextConfig;
