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
  "name": "张三"
}

Response 200:
{
  "participantId": "uuid",
  "participantToken": "uuid",
  "sessionId": "cloudflare-sfu-session-id",
  "expiresAt": 4102444800000
}

Response 429:
{ "error": "room_full", "max": 10 }  # 房间满员
```

### 2. 建立 WebSocket 信令通道

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
     "sessionId": "...",
     "tracks": [{
       "location": "local",
       "trackName": "audio",
       "kind": "audio",
       "mid": "0"
     }]
   }
   ```
4. 收到 SFU 的 answer 后 `setRemoteDescription`
5. 确认发布：
   ```
   POST /api/sfu/publish-confirm
   Body: { "sessionId": "...", "trackName": "audio" }
   ```

### 4. 订阅远端音频

```
POST /api/sfu/tracks
Body: {
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
POST /api/sfu/tracks/close
Body: { "sessionId": "...", "tracks": [...] }
```

## 文字聊天

通过 WebSocket（`/api/sfu/ws`）收发。

### 发送

```json
{ "type": "chat", "text": "大家好", "id": "client-msg-uuid" }
```

### 接收

- `chat`：文字消息
- `join`：有人加入
- `leave`：有人离开
- `mute`：静音状态变化
- `track-published`：有人发布音频

## 环境变量

| 名称 | 类型 | 说明 |
|------|------|------|
| `SFU_APP_ID` | var | Cloudflare Realtime App ID |
| `SFU_APP_SECRET` | secret | Cloudflare Realtime App Secret |
| `DISABLE_ORIGIN_CHECK` | var | 设为 `true` 放开 Origin 限制（默认） |
| `ALLOWED_ORIGINS` | var（可选） | 逗号分隔的白名单域名 |

## 注意事项

1. **联邦模式**：默认放开 Origin 限制，任何客户端可连接
2. **房间限流**：每房间最多 10 人
3. **房间自动清理**：最后一人离开 30 分钟后清除数据
