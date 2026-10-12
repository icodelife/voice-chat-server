// 联邦模式：默认允许所有来源（任何人部署服务端，任何客户端都能连）
// 如需收紧，设置环境变量 ALLOWED_ORIGINS（逗号分隔的域名列表）
// 或设置 DISABLE_ORIGIN_CHECK=false 恢复白名单模式

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://free4.chat",
  "https://www.free4.chat",
  "http://localhost:3000",
])

export function isAllowedOrigin(
  origin: string | null,
  allowedOriginsEnv?: string,
  disableCheck?: string
): boolean {
  // 显式禁用检查 → 全部放行（联邦模式默认）
  if (disableCheck === "true") return true
  // 未配置 ALLOWED_ORIGINS 时，联邦模式默认放行所有 https 来源
  if (!allowedOriginsEnv) {
    if (origin === null) return false
    try {
      const url = new URL(origin)
      // 允许所有 https 来源（联邦模式）
      return url.protocol === "https:" || url.protocol === "http:"
    } catch {
      return false
    }
  }
  // 配置了 ALLOWED_ORIGINS → 严格白名单模式
  const allowed = new Set(allowedOriginsEnv.split(",").map((s) => s.trim()))
  return origin !== null && allowed.has(origin)
}

// 兼容旧调用（不传 env 时走默认逻辑）
export function isAllowedOriginLegacy(origin: string | null): boolean {
  if (origin === null) return false
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    if (url.protocol === "https:" && url.hostname.endsWith(".workers.dev")) {
      return true
    }
  } catch {
    // ignore
  }
  return false
}
