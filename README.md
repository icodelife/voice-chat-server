# voice-chat-server

基于 Cloudflare 免费资源构建的语音+文字聊天室**纯后端**服务。

## 特性

- 🎙️ **语音聊天**：基于 Cloudflare Realtime SFU，WebRTC 低延迟
- 💬 **文字聊天**：WebSocket 实时消息
- 🔒 **密码房**：建房时可设密码（默认开启，可通过 `ALLOW_PASSWORD_ROOMS=false` 关闭）
- 🌐 **联邦模式**：默认放开 Origin 限制，任何客户端可连接
- 🚦 **房间限流**：每房间最多 10 人
- 📦 **纯后端**：无前端，轻量部署

## 架构

```
客户端 ←→ Worker (API) ←→ Cloudflare Realtime SFU
              ↓
       Durable Object (RoomSession)
```

**Cloudflare 资源**（免费额度内）：
- Worker：`/api/sfu/*` + 房间接口
- Durable Object：`RoomSession`
- Realtime SFU App：语音媒体

## 一键部署

### 使用模板（推荐）

1. 点击本仓库的 **Use this template** 创建你自己的仓库
2. 在 Settings → Secrets → Actions 添加：
   - `CLOUDFLARE_API_TOKEN`：Cloudflare API Token（权限：Workers Scripts → Edit，Calls → Edit）
   - `CLOUDFLARE_ACCOUNT_ID`：可选，不填则从 token 自动获取
3. Actions → Cloudflare Deploy → Run workflow → `fresh_install=true`
4. 跑完后把日志里的 `SFU_APP_ID` 加到 Secrets

完成！你的服务端地址是 `https://voice-chat-server.<你的子域>.workers.dev`

### 可选配置

| 变量 | 位置 | 说明 |
|------|------|------|
| `ALLOW_PASSWORD_ROOMS` | Variables | 设为 `false` 可关闭密码房功能。默认不设置即为开启 |

### API 接口

| 接口 | 说明 |
|------|------|
| `POST /api/sfu/session` | 创建会话 |
| `GET /api/sfu/ws` | WebSocket 信令 |
| `POST /api/sfu/tracks` | 发布/订阅 track |
| `GET /health` | 健康检查 |

详见 [SERVER_API.md](./SERVER_API.md)。

## 鸣谢

本项目来源于 [free4chat](https://github.com/xwfounder/free4chat)，感谢原作者的开源贡献。

## License

MIT
