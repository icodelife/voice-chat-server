# voice-chat-server 客户端对接文档

本文档面向需要从零开发客户端（Web / iOS / Android / 桌面）的开发者或 AI Agent。
按此文档实现，可连接任何部署了 `voice-chat-server` 的服务端。

## 1. 概述

### 架构

```
客户端 ←→ Worker (HTTPS API) ←→ Cloudflare Realtime SFU (WebRTC 媒体)
              ↓
       Durable Object (房间状态)
```

### 核心概念

| 概念 | 说明 |
|------|------|
| `room` | 房间 ID，任意字符串（如 `test123`）。每个 ID 对应一个独立房间，房间间完全隔离 |
| `participantId` | 参与者 ID，服务端分配的 UUID，进房后获得 |
| `participantToken` | 参与者凭证，UUID，必须妥善保管，后续鉴权用 |
| `sessionId` | Cloudflare SFU 会话 ID，用于媒体发布/订阅 |
| 无需账号 | 无登录体系，知道房间号就能进（密码房除外） |

### 服务端地址

- 官方服务器：`https://vc.risenav.com`
- 自部署：`https://voice-chat-server.<你的子域>.workers.dev`
- 健康检查：`GET /health` → `{"ok":true,"service":"voice-chat-server","version":"1.0.0"}`

### 联邦模式

服务端默认放开 Origin 限制（`DISABLE_ORIGIN_CHECK=true`），任何客户端可连接任何服务端。
浏览器 Web 客户端无跨域问题（服务端已返回 CORS 头）。

---

## 2. 进房流程（完整步骤）

### Step 1: 创建会话

```http
POST {BASE_URL}/api/sfu/session
Content-Type: application/json

{
  "room": "test123",
  "name": "张三",
  "password": "123456",    // 可选，4-64 位
  "title": "深夜树洞"      // 可选，最多 30 字；房间显示名，仅建房时有效
}
```

**成功响应 (200)：**
```json
{
  "participantId": "a1b2c3d4-...",
  "participantToken": "e5f6g7h8-...",
  "sessionId": "cf-sfu-session-xxx",
  "expiresAt": 4102444800000
}
```

**失败响应：**

| 状态码 | error | 含义 | 客户端处理建议 |
|--------|-------|------|---------------|
| 400 | `invalid_room` / `invalid_name` / `invalid_password` | 参数不合法 | 提示用户检查输入 |
| 403 | `password_required` | 房间有密码但未提供 | 弹出密码输入框 |
| 403 | `password_incorrect` | 密码错误 | 提示重新输入 |
| 403 | `password_not_allowed` | 该服务器禁用密码房 | 提示用户换服务器或不设密码 |
| 429 | `room_full` | 房间满员（最多 10 人） | 提示房间已满 |
| 429 | `room_limit_reached` | 服务端活跃房间数达上限（默认 5） | 提示服务器繁忙，请稍后再试 |
| 502 | `sfu_session_failed` | SFU 会话创建失败 | 提示服务端异常，稍后重试 |

**密码房规则：**
- 建房时传 `password` 即创建密码房（密码以 SHA-256 哈希存储）
- 房间已存在且有密码：进房必须传正确密码
- 房间已存在但无密码：传密码会被忽略（防止恶意抢房设密码）
- 密码只能在建房时设置，之后不可更改

### Step 2: 建立 WebSocket 信令通道

```http
GET {BASE_URL}/api/sfu/ws?room=test123&participantId={participantId}&token={participantToken}
Upgrade: websocket
```

**注意：**
- `BASE_URL` 的 `https://` 换成 `wss://`（`http://` 换成 `ws://`）
- 此通道用于：接收房间事件 + 收发文字消息
- 断线后应重连（建议指数退避，最多 5 次）
- 重连时不需要重新创建会话，用原来的 `participantId` + `token` 即可

### Step 3: 发布本地音频（语音聊天）

```
1. 获取麦克风：navigator.mediaDevices.getUserMedia({ audio: true })
2. 创建 RTCPeerConnection
3. 添加音频 track（sendonly transceiver）
4. createOffer → setLocalDescription(offer)
5. POST /api/sfu/tracks（也支持 PUT）：
   {
     "room": "test123",
     "participantId": "a1b2c3d4-...",
     "token": "e5f6g7h8-...",
     "sessionId": "自己的sessionId",
     "tracks": [{
       "location": "local",
       "trackName": "audio",
       "kind": "audio",      // 必须带 kind
       "mid": "0"            // offer 中的 mid
     }]
   }
   → 响应包含 SFU 的 answer SDP
   缺 room / participantId / token / sessionId 会返回 400 missing_session
6. setRemoteDescription(answer)
7. POST /api/sfu/publish-confirm：
   {
     "room": "test123",
     "participantId": "a1b2c3d4-...",
     "token": "e5f6g7h8-...",
     "sessionId": "...",
     "trackName": "audio",
     "kind": "audio"         // "audio" 或 "video"
   }
   缺任一字段会返回 400 missing_publication
```

### Step 4: 订阅远端音频

当收到 `trackPublished` 事件（见第 3 节）得知有人发布音频后：

```
POST /api/sfu/tracks
{
  "room": "test123",
  "participantId": "a1b2c3d4-...",
  "token": "e5f6g7h8-...",
  "sessionId": "自己的sessionId",
  "tracks": [{
    "location": "remote",
    "sessionId": "对方的sessionId",  // 从 trackPublished 事件的 participant.sessionId 获取
    "trackName": "audio",            // 从 trackPublished 事件的 participant.track.trackName 获取
    "kind": "audio"
  }]
}
→ 响应包含 SFU 的 answer SDP
→ setRemoteDescription 后即可听到对方声音
```

### Step 5: 离开房间

```
PUT /api/sfu/tracks/close
{
  "room": "test123",
  "participantId": "a1b2c3d4-...",
  "token": "e5f6g7h8-...",
  "sessionId": "...",
  "tracks": [{ "mid": "0" }]   // 数组每个元素必须带 mid（SFU 分配的媒体标识）
}
```
注意：这里必须是 **PUT** 方法，用 POST 会返回 405 method_not_allowed。
然后关闭 WebSocket 即可。服务端会在最后一人离开 30 分钟后自动清理房间数据。

---

## 3. WebSocket 消息格式

### 3.1 发送文字消息

```json
{
  "type": "chat",
  "text": "大家好"
}
```
- 服务端收到后会自己生成消息 id 并广播，客户端无需传 id

### 3.2 接收事件

所有接收的消息都是 JSON，`type` 字段区分类型。共三种：`message`（文字消息）、`trackPublished`（有人发布音频）、`state`（房间成员/状态变化）。

**文字消息**
```json
{
  "type": "message",
  "message": {
    "id": "服务端生成的uuid",
    "peerId": "a1b2c3d4-...",
    "name": "张三",
    "kind": "human",
    "type": "text",
    "text": "大家好",
    "createdAt": 1728900000000,
    "sequence": 42
  }
}
```
注意：接收是 `{type:"message", message:{...}}` 信封格式，时间字段叫 `createdAt`。
不要和发送的 `{type:"chat", text}` 混淆。

**有人发布音频**
```json
{
  "type": "trackPublished",
  "participant": {
    "id": "a1b2c3d4-...",
    "name": "李四",
    "kind": "human",
    "sessionId": "对方的sfu-session-id",
    "track": {
      "trackName": "audio",
      "mid": "1"
    }
  }
}
```
注意：事件名是 camelCase 的 `trackPublished`。收到后按 Step 4 订阅即可听到对方声音。

**房间状态变化（成员加入/离开、静音变化）**
```json
{
  "type": "state",
  "state": {
    "participants": [
      {
        "id": "a1b2c3d4-...",
        "name": "张三",
        "kind": "human",
        "connected": true,
        "media": {
          "sessionId": "xxx",
          "muted": false,
          "tracks": []
        }
      }
    ]
  }
}
```
- 服务端**不会**广播独立的 `join` / `leave` / `mute` 事件。成员变化靠 diff `state.participants` 列表自行推导。
- 静音状态在 `participants[].media.muted` 里读取。

---

## 4. 房间列表（大厅）

```http
GET {BASE_URL}/api/rooms
```

**成功响应 (200)：**
```json
{
  "rooms": [
    {
      "room": "test123",
      "participants": 3,
      "hasPassword": false,
      "title": "深夜树洞",
      "lastActiveAt": 1728900000000
    }
  ]
}
```

- 只返回当前有人在线的房间，按人数倒序排列
- `participants` 是实时在线人数（只给数量，不暴露成员昵称/ID）
- `hasPassword: true` 的房间，进房前需让用户输入密码（见 Step 1 密码房规则）
- `title` 是建房时设置的显示名，未设置时为 null，列表页显示 `title || room`
- 联邦模式下小程序/App 无需 Origin 头可直接调用
- 建议列表页每 10-30 秒刷新一次，不要高频轮询

**小程序大厅流程：**
```
1. GET /api/rooms 拿列表 → 渲染房间卡片（房号、人数、🔒标识）
2. 用户点某房间 → POST /api/sfu/session { room, name, password? }（有🔒先弹密码框）
3. 后续走标准进房流程（Step 2 WebSocket → Step 3 发布音频 → Step 4 订阅）
```

## 5. 其他接口

### 静音 / 取消静音

通过 WebSocket 发送：
```json
{ "type": "mute", "muted": true }
```
静音状态变化从 `state` 广播的 `participants[].media.muted` 读取（服务端不广播独立的 mute 事件）。

### 健康检查 / 服务端能力

```http
GET {BASE_URL}/health
```

```json
{
  "ok": true,
  "service": "voice-chat-server",
  "version": "1.0.0",
  "capabilities": {
    "passwordRooms": true,
    "maxRoomsPerServer": 5,
    "maxParticipantsPerRoom": 10
  }
}
```

- `capabilities.passwordRooms`：是否允许**创建**密码房。客户端应据此决定是否展示"开设密码房"入口；为 false 时隐藏，但已有密码房仍可输入密码加入
- `maxRoomsPerServer`：每服务端最大活跃房间数（0 表示不限制）
- `maxParticipantsPerRoom`：每房间最大在线人数
- 建议客户端启动时拉取一次并缓存

---

## 6. 服务端配置（部署者参考）

| 变量 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `SFU_APP_ID` | var | — | Cloudflare Realtime App ID（必需） |
| `SFU_APP_SECRET` | secret | — | Cloudflare Realtime App Secret（必需） |
| `ALLOW_PASSWORD_ROOMS` | var | `true` | 设为 `false` 禁用密码房 |
| `MAX_ROOMS_PER_SERVER` | var | `5` | 每服务端最大活跃房间数；设为 `0` 不限制 |
| `DISABLE_ORIGIN_CHECK` | var | `true` | 设为 `true` 放开 Origin 限制（联邦模式） |
| `ALLOWED_ORIGINS` | var | — | 逗号分隔的白名单域名（收紧 Origin 时用） |

---

## 7. 客户端实现检查清单

- [ ] Step 1: `POST /api/sfu/session` 创建会话，处理所有错误码
- [ ] Step 2: 建立 WebSocket，处理断线重连（指数退避）
- [ ] Step 3: WebRTC 发布本地音频（getUserMedia → offer → tracks → answer → publish-confirm）
- [ ] Step 4: 监听 `trackPublished` 事件，订阅远端音频
- [ ] 文字聊天：发送 `{type:"chat", text}`；接收 `{type:"message", message:{...}}` 信封格式
- [ ] 成员/静音状态：通过 `state` 广播 diff `participants` 列表维护，静音读 `participants[].media.muted`
- [ ] 密码房：密码输入 UI，处理 `password_required` / `password_incorrect`
- [ ] 离开房间：`PUT /api/sfu/tracks/close` + 关闭 WebSocket
- [ ] 房间列表页：`GET /api/rooms` 渲染大厅（房号、人数、🔒标识），有🔒的房间先进密码框再调 session 接口
- [ ] 房间人数显示：通过 `state` 广播的 participants 列表维护（上限 10 人）

---

## 8. 常见问题

**Q: 官方服务器和自部署服务器的协议有区别吗？**
A: 没有。协议完全一致，唯一区别是自部署服务器可通过环境变量调整策略（如关闭密码房、收紧 Origin）。

**Q: 房间数据会持久化吗？**
A: 最后一人离开 30 分钟后自动清除。同名房间之后再进是全新的空房间。

**Q: 需要处理 Turnstile 验证吗？**
A: 不需要。模板默认不启用 Turnstile。

**Q: iOS / Android / 小程序等原生客户端能用吗？**
A: 可以。API 都是标准 HTTPS + WebSocket + WebRTC，无浏览器特有依赖。联邦模式（`DISABLE_ORIGIN_CHECK=true`，默认开启）下，不带 Origin 头的原生请求（小程序 `wx.request` / `wx.connectSocket`、App、curl）可直接调用所有接口，无需伪造 Origin。只有在关闭联邦模式（严格白名单）时，原生客户端才需要联系服务端部署者加白名单。

**Q: 密码是明文传输的吗？**
A: 密码通过 HTTPS POST 传输（TLS 加密），服务端只存 SHA-256 哈希。但请勿使用重要密码，房间密码仅为轻量防打扰机制。
