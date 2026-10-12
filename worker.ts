import { handleSfuRequest } from "./src/sfu/server"
import { handleRoomRequest, isRoomRequestPath } from "./src/room/server"

export { RoomSession } from "./src/do/RoomSession"

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const pathname = new URL(request.url).pathname

    // SFU API
    if (pathname.startsWith("/api/sfu/")) {
      return handleSfuRequest(request, env)
    }

    // Room API
    if (isRoomRequestPath(pathname)) {
      return handleRoomRequest(request, env)
    }

    // 健康检查
    if (pathname === "/" || pathname === "/health") {
      return Response.json({
        ok: true,
        service: "voice-chat-server",
        version: "1.0.0",
      })
    }

    return Response.json({ error: "not_found" }, { status: 404 })
  },
}
