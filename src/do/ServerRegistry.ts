// ServerRegistry: 服务端级房间数限制（简化版）
//
// 设计说明：
// - 单例 DO（id 固定为 "registry"），记录全服活跃房间
// - 每次建会话时 touch：惰性清理 30 分钟无活动的房间（与房间过期时间对齐），
//   若为新房间且已达上限则拒绝
// - 不需要 RoomSession 回调通知，惰性清理足以满足防刷需求
// - 精度说明：以"最近 30 分钟内有人建会话"作为活跃判定，
//   长时间无人新加入但仍有人的房间可能被提前释放名额（良性，名额会自愈）

interface RegistryState {
  // roomName -> 最后活跃时间戳 (ms)
  rooms: Record<string, number>
}

// 与 RoomSession 的房间过期时间对齐（roomExpiry.ts: EMPTY_ROOM_TIMEOUT_MS）
const INACTIVE_TIMEOUT_MS = 30 * 60 * 1000

const STATE_KEY = "registry"

export class ServerRegistry {
  private ctx: DurableObjectState

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx
  }

  private async loadState(): Promise<RegistryState> {
    const stored = await this.ctx.storage.get<RegistryState>(STATE_KEY)
    return stored ?? { rooms: {} }
  }

  private async saveState(state: RegistryState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
  }

  /** 移除超过 30 分钟无活动的房间条目（不落盘，只过滤） */
  private prune(state: RegistryState, now: number): { room: string; lastActiveAt: number }[] {
    return Object.entries(state.rooms)
      .filter(([, lastActive]) => now - lastActive <= INACTIVE_TIMEOUT_MS)
      .map(([room, lastActiveAt]) => ({ room, lastActiveAt }))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // 建会话前检查：POST /check { room, maxRooms }
    if (url.pathname === "/check" && request.method === "POST") {
      let body: { room?: unknown; maxRooms?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 })
      }
      const room = typeof body.room === "string" ? body.room : ""
      const maxRooms =
        typeof body.maxRooms === "number" && body.maxRooms > 0
          ? Math.floor(body.maxRooms)
          : 0
      if (!room) {
        return Response.json({ error: "invalid_room" }, { status: 400 })
      }
      if (maxRooms <= 0) {
        // maxRooms <= 0 表示不限制
        return Response.json({ allowed: true, activeRooms: -1 })
      }

      const now = Date.now()
      const state = await this.loadState()

      // 惰性清理：移除超过 30 分钟无活动的房间
      const active = this.prune(state, now)
      state.rooms = Object.fromEntries(
        active.map(({ room, lastActiveAt }) => [room, lastActiveAt])
      )

      const isNewRoom = !(room in state.rooms)
      const activeCount = Object.keys(state.rooms).length

      if (isNewRoom && activeCount >= maxRooms) {
        await this.saveState(state)
        return Response.json(
          { allowed: false, error: "room_limit_reached", max: maxRooms },
          { status: 429 }
        )
      }

      state.rooms[room] = now
      await this.saveState(state)
      return Response.json({
        allowed: true,
        activeRooms: Object.keys(state.rooms).length,
      })
    }

    // 房间列表（大厅）：GET /list → { rooms: [{ room, lastActiveAt }] }
    // 只读接口，不落盘清理（/check 写时会清理）；客户端拿房间名后需再查各房实时人数
    if (url.pathname === "/list" && request.method === "GET") {
      const state = await this.loadState()
      const rooms = this.prune(state, Date.now())
      return Response.json({ rooms })
    }

    return Response.json({ error: "not_found" }, { status: 404 })
  }
}
