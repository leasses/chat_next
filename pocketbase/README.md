# 自托管部署（PocketBase + 静态前端）

服务器只保存**密文**：聊天记录与 API Key 均由浏览器用用户密码派生密钥（PBKDF2-SHA256 10 万次 + per-user salt → AES-256-GCM）加密后上传。

## 目录

```
pocketbase/
  pocketbase(.exe)   后端二进制
  pb_data/           数据库（SQLite）与日志
  pb_public/         前端静态文件（npm run build 的 dist 产物）
  setup.sh           初始化：建超管、建集合、加 salt 字段（幂等）
  start.sh           启动（PB 同时托管前端与 API，单端口）
```

## 首次部署

```bash
# 1. 取二进制（linux amd64 示例）
curl -L -o pb.zip https://github.com/pocketbase/pocketbase/releases/download/v0.22.10/pocketbase_0.22.10_linux_amd64.zip
unzip pb.zip -d pocketbase && rm pb.zip

# 2. 构建前端并放到 pb_public
npm ci && npm run build          # 产出 dist/
mkdir -p pocketbase/pb_public && cp -r dist/* pocketbase/pb_public/

# 3. 起服务（先起，setup.sh 需要连上）
cd pocketbase && ./start.sh &    # 监听 0.0.0.0:8090

# 4. 初始化（改默认超管密码！）
./setup.sh http://127.0.0.1:8090 admin@your-domain.tld '<强密码>'
```

> 前端与 PB 同源时，「服务器地址」默认取当前站点 origin，无需手填。

## 必须做的安全项

- **HTTPS**：用 Nginx/Caddy 反代 8090 并终止 TLS（PocketBase 自身不做 TLS）。
- **改超管密码**：`setup.sh` 的第三个参数。
- **限流**：PB 自带 auth 接口限流；如需更严格，在反代上加 `limit_req`。
- **日志**：PB 访问日志只记录 URL 与状态码，不含请求体；请勿自行打印密码/密文解密结果。
- **备份**：备份 `pb_data/` 即可（其中只有密文，但丢失库里数据等于丢失历史）。

## Nginx 参考

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;
  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # 登录/注册接口限流
  location ~ ^/api/collections/users/auth-with-password {
    limit_req zone=auth burst=5 nodelay;
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
  }
}
```

## 集合结构

| 集合 | 字段 | 规则 |
| --- | --- | --- |
| `users` | 内置 + `crypto_salt`(64 位 hex) | 仅本人可读写 |
| `conversations` | `user`, `conversation_id`, `rev`, `cipher` | `user = @request.auth.id` |
| `secrets` | `user`, `cipher` | `user = @request.auth.id` |

`rev` 即客户端会话的 `updatedAt`（毫秒），用于增量拉取；PB 保留字 `updated` 不可作列名，故改名。

## 忘记密码

服务端无法解密任何数据。用户只能在登录界面使用「清空加密数据并重建」：删除全部密文、换新 salt，历史永久丢失。产品文案已明示。
