// ServerRegistry: 服务端房间目录（简化版）
//
// 设计说明：
// - 单例 DO（id 固定为 "registry"），记录全服房间名录
// - Worker 建会话时调 /touch 上报房间活跃；GET /list 供房间列表和限流查询
// - "活跃房间"统一定义为"当前有连接中的参与者"，由 Worker 查各房 room-info
//   实时判定（见 server.ts）；注册表只存名录 + 最后活跃时间，不做限流判定
// - 30 分钟无新会话的条目在读取时过滤（安全网），真正的活跃判定以实时人数为准

interface RegistryState {
  // roomName -> 最后活跃时间戳 (ms)
  rooms: Record<string, number>
}

// 名录保留窗口：超过此时长无新会话的房间不再列入名录
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

    // 上报房间活跃：POST /touch { room }
    // 只记录名录，不做限流判定（限流由 Worker 按实时人数判定）
    if (url.pathname === "/touch" && request.method === "POST") {
      let body: { room?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 })
      }
      const room = typeof body.room === "string" ? body.room : ""
      if (!room) {
        return Response.json({ error: "invalid_room" }, { status: 400 })
      }

      const now = Date.now()
      const state = await this.loadState()

      // 惰性清理：移除超过 30 分钟无活动的房间
      const active = this.prune(state, now)
      state.rooms = Object.fromEntries(
        active.map(({ room, lastActiveAt }) => [room, lastActiveAt])
      )

      state.rooms[room] = now
      await this.saveState(state)
      return Response.json({
        ok: true,
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
