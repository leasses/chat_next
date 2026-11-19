# Ubuntu 部署（PocketBase + Nginx）

单端口方案：PocketBase 同时托管前端静态文件与 `/api`，Nginx 只做 HTTPS 反代。服务器只存密文。

## 1. 上传文件

本地先构建，把产物和二进制一起传上去：

```bash
# 本地（Windows PowerShell / Git Bash）
npm run build
npm run deploy:copy          # dist → pocketbase/pb_public

# 上传整个 pocketbase 目录（不含 pb_data，服务器会自己生成）
scp -r pocketbase/ user@server:/opt/chat-demo/
```

服务器上需要：

```
/opt/chat-demo/pocketbase/
├── pocketbase          # Linux amd64 二进制
├── pb_public/          # 前端产物
├── init.sh             # 初始化脚本
└── pb_data/            # 首次启动自动创建（SQLite）
```

下载 Linux 版二进制（本地下载再上传也行）：

```bash
cd /opt/chat-demo/pocketbase
curl -L -o pb.zip https://github.com/pocketbase/pocketbase/releases/download/v0.22.10/pocketbase_0.22.10_linux_amd64.zip
unzip pb.zip pocketbase && rm pb.zip && chmod +x pocketbase
```

## 2. systemd 服务

`/etc/systemd/system/chat-demo.service`：

```ini
[Unit]
Description=Chat Demo (PocketBase)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/chat-demo/pocketbase
ExecStart=/opt/chat-demo/pocketbase/pocketbase serve --http=127.0.0.1:8090 --dir=/opt/chat-demo/pocketbase/pb_data --publicDir=/opt/chat-demo/pocketbase/pb_public --hooksDir=/opt/chat-demo/pocketbase/pb_hooks
Restart=always
RestartSec=3
# 日志不进文件，走 journald
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
chown -R www-data:www-data /opt/chat-demo/pocketbase
systemctl daemon-reload
systemctl enable --now chat-demo
```

## 3. 初始化（只需一次）

```bash
cd /opt/chat-demo/pocketbase
chmod +x init.sh
./init.sh http://127.0.0.1:8090 admin@你的域名 '超管强密码'
```

输出 `初始化完成` 即可。脚本幂等，重复跑无副作用。

## 4. Nginx

`/etc/nginx/sites-available/chat-demo`：

```nginx
# 登录限流
limit_req_zone $binary_remote_addr zone=chat_auth:10m rate=10r/m;

server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 20m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 登录 / 注册限流
    location ~ ^/api/collections/users/(auth-with-password|records)$ {
        limit_req zone=chat_auth burst=5 nodelay;
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/chat-demo /etc/nginx/sites-enabled/
certbot --nginx -d chat.example.com
nginx -t && systemctl reload nginx
```

## 5. 验证

```bash
curl -s https://chat.example.com/api/health          # {"message":"API is healthy"...}
curl -sI https://chat.example.com/ | head -1        # 200
```

浏览器打开站点 → 注册 → 解锁 → 设置里填 API Key → 聊天。

## 5.5 邮件服务（注册验证码必需）

注册必须收验证码。两种做法：用第三方 SMTP（推荐），或自建邮件服务器。

### 方式 A：第三方 SMTP（推荐，5 分钟）

在 PocketBase 后台 `/_/` → Settings → Mail settings 填：

| 字段 | 示例（Gmail） | 示例（Resend） | 示例（阿里云） |
|---|---|---|---|
| Sender name | Chat Demo | Chat Demo | Chat Demo |
| Sender address | you@gmail.com | noreply@yourdomain.com | noreply@yourdomain.com |
| SMTP host | smtp.gmail.com | smtp.resend.com | smtpdm.aliyun.com |
| Port | 587 (STARTTLS) | 465 (SSL) | 465 (SSL) |
| Username | you@gmail.com | resend | 你的账号 |
| Password | Gmail 应用专用密码 | `re_xxx` API key | SMTP 密码 |

填完点 **Send test email** 验证。

> Gmail 要开两步验证并用「应用专用密码」；自建域名邮箱建议配 SPF/DKIM，否则进垃圾箱。
> 也可以用 `/api/settings` PATCH 关掉「需验证邮箱」：本应用注册即校验验证码，不需要 PB 自己的 `onlyVerified`。

**邮件配置不走代码**，存在 `pb_data` 里，备份即包含。

### 方式 B：自建邮件服务器（Postfix + DKIM）

如果不想依赖第三方：

```bash
# 1. 只发不收的 Postfix（25 端口出站，不开放入站）
apt install postfix mailutils opendkim opendkim-tools
# 选择 "Internet Site"，系统邮件名填你的域名

# 2. 配 DKIM（必须，否则 Gmail/QQ 直接拒收）
mkdir -p /etc/opendkim/keys/yourdomain.com
opendkim-genkey -b 2048 -d yourdomain.com -s mail -D /etc/opendkim/keys/yourdomain.com
chown -R opendkim:opendkim /etc/opendkim/keys

cat >> /etc/opendkim.conf <<'EOF'
Domain                  yourdomain.com
KeyTable                /etc/opendkim/key.table
SigningTable            refile:/etc/opendkim/signing.table
ExternalIgnoreList      /etc/opendkim/trusted.hosts
InternalHosts           /etc/opendkim/trusted.hosts
EOF

echo "mail._domainkey.yourdomain.com yourdomain.com:mail:/etc/opendkim/keys/yourdomain.com/mail.private" > /etc/opendkim/key.table
echo "*@yourdomain.com mail._domainkey.yourdomain.com" > /etc/opendkim/signing.table
echo "127.0.0.1" > /etc/opendkim/trusted.hosts
systemctl restart opendkim postfix

# 3. 把公钥加到 DNS（TXT 记录 mail._domainkey）
cat /etc/opendkim/keys/yourdomain.com/mail.txt
```

DNS 追加三条 TXT，否则大概率进垃圾箱：

```
v=spf1 a mx ip4:<服务器IP> ~all          # SPF（@）
mail._domainkey                           # DKIM（opendkim 生成的内容）
v=DMARC1; p=none; rua=mailto:admin@yourdomain.com   # DMARC（_dmarc）
```

然后 PocketBase 后台 SMTP 填 `127.0.0.1`、端口 `25`、关闭认证（TLS 关），发送地址用 `noreply@yourdomain.com`。

> ⚠️ 自建邮箱的**送达率**远不如第三方：阿里云、腾讯云等厂商默认封禁 25 端口，需单独申请解封；IP 信誉也要慢慢养。**建议先用第三方 SMTP 跑起来，有需要再迁移。**

### 验证码机制

- 6 位数字，10 分钟过期，一次性使用
- 同邮箱 60 秒内不可重发，每日上限 10 次
- 同 IP 每小时上限 20 次
- 验证码只存 `sha256(email:code:appName)`，库泄露也无法还原
- 实现：`pb_hooks/main.pb.js`（PocketBase 的 JS hook 自动加载，无需编译）

## 5.6 第三方网关转发（可选）

自定义模型通道走 `POST /api/llm/forward`，由服务端代为请求上游。

**为什么需要**：智谱等网关的 OPTIONS 预检被 WAF 拦截、不返回 CORS 头，
浏览器直连必然失败；同源转发可绕开跨域限制。

**安全边界**：

- 使用该通道时 **API Key 会经过服务器内存**（界面已明确提示）
- 不落库、不写日志、不缓存，请求结束即丢弃
- 只接受 `https://` 且路径以 `/messages` 或 `/chat/completions` 结尾的目标
- 需要登录态，匿名不可调用

若部署要求 Key 绝不离开浏览器，只用 DeepSeek 官方通道即可。

## 6. 日常运维

```bash
systemctl status chat-demo
journalctl -u chat-demo -f                          # 看日志（只有 URL 与状态码，无明文）
systemctl restart chat-demo

# 备份：只需备份 pb_data（内容全是密文）
tar czf ~/chat-demo-$(date +%F).tar.gz -C /opt/chat-demo pocketbase/pb_data
```

前端更新：

```bash
# 本地
npm run build && npm run deploy:copy
scp -r pocketbase/pb_public/* user@server:/opt/chat-demo/pocketbase/pb_public/
```

无需重启，静态文件即时生效。

## 注意事项

- **超管账号只在 `/_/` 后台用**，前端用户走 `users` 集合，两者独立。
- **忘记密码无解**：数据用用户密码派生密钥加密，服务端无法解密。用户只能点「清空加密数据并重建」，历史永久丢失。这是设计使然，界面已明示。
- **限流**：PocketBase 自带基础限流；上面 Nginx 的 `limit_req` 是第二层。
- **2C1G 够用**：PocketBase 常驻约 30–50MB，数百用户规模压力主要来自轮询（前台每 5 秒一次增量拉取）。