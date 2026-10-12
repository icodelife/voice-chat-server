# 服务端 API 文档

`voice-chat-server` 的接口说明，供客户端开发参考。

## 基础信息

- 纯后端服务，无前端页面
- 房间标识：`room` 参数，如 `test123`
- 每个房间对应一个独立的 Durable Object 实例，房间之间完全隔离
- 无需账号，无需登录
- 健康检查：`GET /health` 返回 `{"ok":true}`

## 语音流程（SFU）

### 1. 创建会话

```
POST /api/sfu/session
Content-Type: application/json

Body:
{
  "room": "test123",
  "name": "张三",
  "password": "123456"  # 可选，4-64 位；建房时设置，已有房间则验证
}

Response 200:
{
  "participantId": "uuid",
  "participantToken": "uuid",
  "sessionId": "cloudflare-sfu-session-id",
  "expiresAt": 4102444800000
}

Response 429:
{ "error": "room_full", "max": 10 }  # 房间满员（每房间最多 10 人）

Response 429:
{ "error": "room_limit_reached", "max": 5 }  # 服务端活跃房间数达上限（默认每服 5 房）

Response 403:
{ "error": "password_required" }    # 房间有密码但未提供
{ "error": "password_incorrect" }   # 密码错误
{ "error": "password_not_allowed" } # 服务器禁用了密码房
```

### 2. 获取房间列表（大厅）

```
GET /api/rooms

Response 200:
{
  "rooms": [
    { "room": "test123", "participants": 3, "hasPassword": false, "lastActiveAt": 1728900000000 }
  ]
}
```

- 只返回当前有人的房间，按人数倒序排列
- `participants` 为实时在线人数（只返回数量，不暴露成员信息）
- `hasPassword` 为 true 时，进房需先让用户输入密码
- 联邦模式下无 Origin 的原生客户端可直接调用

### 3. 建立 WebSocket 信令通道

```
GET /api/sfu/ws?room=test123&participantId=xxx&token=yyy
Upgrade: websocket
```

用于接收房间事件（成员加入/离开、静音状态、文字消息等）。

### 3. 发布本地音频

1. 创建 `RTCPeerConnection`，添加本地音频 track（`sendonly` transceiver）
2. `createOffer` → `setLocalDescription`
3. 调用：
   ```
   POST /api/sfu/tracks
   Body: {
     "room": "...",
     "participantId": "...",
     "token": "...",
     "sessionId": "...",
     "tracks": [{
       "location": "local",
       "trackName": "audio",
       "kind": "audio",
       "mid": "0"
     }]
   }
   ```
   缺 room / participantId / token / sessionId 会返回 400 `missing_session`
4. 收到 SFU 的 answer 后 `setRemoteDescription`
5. 确认发布：
   ```
   POST /api/sfu/publish-confirm
   Body: { "room": "...", "participantId": "...", "token": "...", "sessionId": "...", "trackName": "audio", "kind": "audio" }
   ```
   缺任一字段会返回 400 `missing_publication`

### 4. 订阅远端音频

```
POST /api/sfu/tracks
Body: {
  "room": "...",
  "participantId": "...",
  "token": "...",
  "sessionId": "...",
  "tracks": [{
    "location": "remote",
    "sessionId": "<对方的sessionId>",
    "trackName": "audio",
    "kind": "audio"
  }]
}
```

### 5. 关闭

```
PUT /api/sfu/tracks/close
Body: { "room": "...", "participantId": "...", "token": "...", "sessionId": "...", "tracks": [{ "mid": "..." }] }
```
（必须是 PUT；tracks 数组每个元素必须带 `mid`）

## 文字聊天

通过 WebSocket（`/api/sfu/ws`）收发。

### 发送

```json
{ "type": "chat", "text": "大家好" }
```
（服务端会自己生成消息 id 并广播，客户端无需传 id）

### 接收

- `message`：文字消息，信封格式 `{type:"message", message:{id, peerId, name, kind, type:"text", text, createdAt, sequence}}`
- `trackPublished`：有人发布音频，`{type:"trackPublished", participant:{id, name, kind, sessionId, track:{trackName, mid}}}`
- `state`：房间状态变化，`{type:"state", state:{participants:[...]}}`——成员加入/离开靠 diff participants 列表推导，静音状态在 `participants[].media.muted`（服务端不广播独立的 join / leave / mute 事件）

## 环境变量

| 名称 | 类型 | 说明 |
|------|------|------|
| `SFU_APP_ID` | var | Cloudflare Realtime App ID |
| `SFU_APP_SECRET` | secret | Cloudflare Realtime App Secret |
| `DISABLE_ORIGIN_CHECK` | var | 设为 `true` 放开 Origin 限制（默认） |
| `ALLOWED_ORIGINS` | var（可选） | 逗号分隔的白名单域名 |
| `MAX_ROOMS_PER_SERVER` | var（可选） | 每服务端最大活跃房间数，默认 `5`；设为 `0` 不限制 |

## 注意事项

1. **联邦模式**：默认放开 Origin 限制，任何客户端可连接
2. **房间限流**：每服务端最多 5 个活跃房间（30 分钟无新加入视为不活跃并释放名额），每房间最多 10 人
3. **房间自动清理**：最后一人离开 30 分钟后清除数据
