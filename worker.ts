import { handleSfuRequest } from "./src/sfu/server"
import { handleRoomRequest, isRoomRequestPath } from "./src/room/server"
import { isAllowedOrigin } from "./src/common/origin"

export { RoomSession } from "./src/do/RoomSession"
export { ServerRegistry } from "./src/do/ServerRegistry"

// 房间列表（大厅）：从注册表拿房间名，并发查询各房实时人数
// 只返回有人在的房间，按人数倒序。注册表不可用时降级返回空列表。
async function handleRoomList(env: any): Promise<Response> {
  try {
    const registry = env.SERVER_REGISTRY.get(
      env.SERVER_REGISTRY.idFromName("registry")
    )
    const listResp = await registry.fetch(new Request("https://registry/list"))
    if (!listResp.ok) return Response.json({ rooms: [] })
    const { rooms } = (await listResp.json()) as {
      rooms: { room: string; lastActiveAt: number }[]
    }
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return Response.json({ rooms: [] })
    }

    const infos = await Promise.all(
      rooms.map(async ({ room, lastActiveAt }) => {
        try {
          const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(room))
          const infoResp = await stub.fetch(
            new Request("https://room/control", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "room-info" }),
            })
          )
          if (!infoResp.ok) return null
          const info = (await infoResp.json()) as {
            exists?: boolean
            participants?: unknown[]
            hasPassword?: boolean
            title?: string | null
          }
          const count = Array.isArray(info.participants)
            ? info.participants.length
            : 0
          // 不存在的房间或没人的房间不上榜
          if (!info.exists || count === 0) return null
          return {
            room,
            participants: count,
            hasPassword: !!info.hasPassword,
            title: typeof info.title === "string" ? info.title : null,
            lastActiveAt,
          }
        } catch {
          return null
        }
      })
    )

    const list = infos
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort(
        (a, b) => b.participants - a.participants || b.lastActiveAt - a.lastActiveAt
      )
    return Response.json({ rooms: list })
  } catch {
    return Response.json({ rooms: [] })
  }
}

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
    // 房间列表（大厅）：GET /api/rooms
    else if (pathname === "/api/rooms" && request.method === "GET") {
      // 联邦模式下允许无 Origin 的原生客户端（小程序/App）
      if (
        !isAllowedOrigin(
          origin,
          (env as any)?.ALLOWED_ORIGINS,
          (env as any)?.DISABLE_ORIGIN_CHECK
        )
      ) {
        response = Response.json({ error: "forbidden_origin" }, { status: 403 })
      } else {
        response = await handleRoomList(env)
      }
    }
    // 健康检查（含服务端能力声明，供客户端决定展示哪些功能）
    else if (pathname === "/" || pathname === "/health") {
      const e = env as any
      const maxRoomsRaw = parseInt(e?.MAX_ROOMS_PER_SERVER ?? "5", 10)
      response = Response.json({
        ok: true,
        service: "voice-chat-server",
        version: "1.0.0",
        capabilities: {
          // 是否允许创建密码房（ALLOW_PASSWORD_ROOMS=false 时为 false）
          passwordRooms: e?.ALLOW_PASSWORD_ROOMS !== "false",
          // 每服务端最大活跃房间数（0 表示不限制）
          maxRoomsPerServer: Number.isNaN(maxRoomsRaw) ? 5 : maxRoomsRaw,
          // 每房间最大在线人数（与 server.ts 的 MAX_PARTICIPANTS_PER_ROOM 一致）
          maxParticipantsPerRoom: 10,
        },
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
