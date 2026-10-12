import { handleSfuRequest } from "./src/sfu/server"
import { handleRoomRequest, isRoomRequestPath } from "./src/room/server"

export { RoomSession } from "./src/do/RoomSession"

// CORS 头：允许任意来源（联邦模式）
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers)
  const cors = corsHeaders(origin)
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname
    const origin = request.headers.get("Origin")

    // 预检请求直接返回
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    let response: Response

    // SFU API
    if (pathname.startsWith("/api/sfu/")) {
      response = await handleSfuRequest(request, env)
    }
    // Room API
    else if (isRoomRequestPath(pathname)) {
      response = await handleRoomRequest(request, env)
    }
    // 健康检查
    else if (pathname === "/" || pathname === "/health") {
      response = Response.json({
        ok: true,
        service: "voice-chat-server",
        version: "1.0.0",
      })
    } else {
      response = Response.json({ error: "not_found" }, { status: 404 })
    }

    // WebSocket 握手响应不能包装，直接返回
    if (response.status === 101) {
      return response
    }

    return withCors(response, origin)
  },
}
