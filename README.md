# ChatNext

自托管的多端同步 AI 对话前端。聊天记录与 API Key 在浏览器内加密后同步，服务器只保存密文。

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造，保留原有的流式对话、Markdown 渲染、分支对话、附件等能力，替换了存储层并加入了账号体系。

## 特性

- **客户端加密**：PBKDF2-SHA256（10 万次迭代，每用户独立 salt）派生密钥，AES-256-GCM 加密
- **流式增量同步**：只上传变化的字节，追加一轮对话约 **2%** 的全量大小
- **实时多端**：PocketBase Realtime 推送，实测跨设备 **150ms** 到达
- **只同步激活会话**：导入的历史包永久留在本地，只有聊过的会话才上云
- **邮箱验证码注册**：一次性码 + 多维度限流，防批量注册
- **模型通道**：DeepSeek 官方（浏览器直连）/ 第三方网关（支持 Anthropic 与 OpenAI 两种协议）

## 架构

```
浏览器                          服务器
┌──────────────────┐           ┌──────────────────┐
│ IndexedDB 明文    │           │ PocketBase       │
│   ↓ 加密          │  同步     │  conversations   │
│ 流式增量密文      │ ────────► │  diffs   （增量） │
│   ↑ 实时推送      │ ◄──────── │  secrets （配置） │
└──────────────────┘           │  users           │
                               └──────────────────┘
```

服务器数据：`user` 关系、会话 UUID、时间戳、`cipher` 密文。**无正文、无 Key、无明文**。

## 快速开始

### 1. 后端

```bash
mkdir -p pocketbase && cd pocketbase
curl -L -o pb.zip https://github.com/pocketbase/pocketbase/releases/download/v0.22.10/pocketbase_0.22.10_linux_amd64.zip
unzip pb.zip pocketbase && rm pb.zip && chmod +x pocketbase
cd ..
```

> Windows 开发：把 `pocketbase.exe` 放到 `pocketbase/` 目录，双击根目录 `start.bat`。

```bash
cd pocketbase
./pocketbase serve --http=127.0.0.1:8090 \
  --dir=./pb_data --publicDir=./pb_public --hooksDir=./pb_hooks
```

### 2. 初始化

```bash
cd pocketbase
chmod +x init.sh
./init.sh http://127.0.0.1:8090 admin@example.com '你的强密码'
```

创建超管、集合（`conversations` / `diffs` / `secrets` / `verifications`）、
给 `users` 加 `crypto_salt` 并设为仅邮箱登录。幂等，可重复执行。

### 3. 前端

```bash
npm install
npm run build && npm run deploy:copy   # 产物复制到 pocketbase/pb_public
```

浏览器打开 `http://127.0.0.1:8090`，注册 → 解锁 → 在设置里填 API Key。

开发模式：`npm run dev`（8090，`/api` 已代理到 PocketBase）。

## 加密与同步

### 密钥派生

```
AES-256 密钥 = PBKDF2-SHA256(密码, per-user salt, 100000 次)
密钥流 = HMAC-SHA256(会话密钥, blockIndex)   # 32 字节/块
密文[i] = 明文[i] XOR 密钥流[i]
```

同一会话、同一 offset 的密文恒等，因此**尾部追加不改变前缀**，可以只传增量。
密钥为 `extractable: false`，锁定/退出即丢弃引用。

> 没有用 `key[i % len]` 的循环 XOR：等长循环密钥对已知明文攻击零防护，
> 而对话 JSON 结构完全可预测，攻击者拿到任意明文片段即可还原密钥流。

### 增量上传

字段顺序决定 diff 大小，序列化时按「稳定 → 易变」排列：

```
id / createdAt / rootMessageId  →  messages  →  title / updatedAt
```

实测（100 条消息 / 46.3KB）：

| 操作 | 上传量 | 占全量 |
|---|---|---|
| 追加一轮对话 | 0.97 KB | **2.1%** |
| 改标题 | 46 字节 | 0.1% |
| 只更新时间戳 | 6 字节 | 0.01% |

### 冲突处理

本地密文 = `baseline[0, off) + diff`，之后校验总长度与 CRC32。
任一不符即丢弃该 diff，向服务器请求全量重建基线。

## 模型通道

| 通道 | 连接方式 | Key 位置 |
|---|---|---|
| DeepSeek 官方 | 浏览器直连 `api.deepseek.com` | 只在本机 |
| 第三方网关 | 经本站 `/api/llm/forward` 转发 | **经过服务器内存** |

第三方网关支持 **Anthropic Messages** 与 **OpenAI Chat Completions** 两种协议。

之所以需要服务端转发：多数网关的 `OPTIONS` 预检被 WAF 拦截、不返回 CORS 头，
浏览器直连必然失败。转发时 Key 只在内存中流转，不落库、不写日志；
界面在切换时明确提示这一点。

## 安全边界

| 位置 | 内容 |
| --- | --- |
| 浏览器内存 | 密钥、聊天明文、API Key |
| localStorage | 鉴权 token、主题偏好、同步游标（**无**密码、密钥、Key） |
| IndexedDB | 聊天明文（本地优先） |
| 服务器 | 仅密文 + 索引字段 |

- 全站 HTTPS（`crypto.subtle` 要求安全上下文）
- 日志写入前统一脱敏：Bearer token、`sk-`、长十六进制串都会替换为 `[redacted]`
- 锁定/退出清空内存中的密钥与 Key
- **忘记密码无法恢复**：服务器无法解密，只能在登录页「清空加密数据并重建」

## 项目结构

```
src/
├── lib/
│   ├── crypto.ts        PBKDF2 + AES-GCM
│   ├── streamcipher.ts  流式密钥流、CRC32、增量友好序列化
│   ├── syncEngine.ts    推送/拉取/实时订阅/冲突处理
│   ├── secretSync.ts    Key 与通道配置的密文同步
│   ├── logger.ts        环形日志缓冲（带脱敏）
│   ├── gateway.ts       第三方网关转发客户端
│   └── pb.ts            PocketBase 客户端
├── services/
│   ├── chat/            会话状态、IndexedDB、导入导出
│   ├── api/             DeepSeek Anthropic 兼容接口
│   └── provider.ts      通道配置
├── components/          UI（沿用原版结构）
└── i18n/                中英文
pocketbase/
├── pb_hooks/main.pb.js  邮箱验证码 + 网关转发
├── init.sh              集合初始化
├── DEPLOY.md            Ubuntu + Nginx 部署
└── README.md            后端说明
```

## 部署

见 [pocketbase/DEPLOY.md](pocketbase/DEPLOY.md)：systemd 服务、Nginx 反代、HTTPS、邮件配置。

## 测试

```bash
npm run test:e2e    # 双端实时同步
npm run test:wipe   # 清空重建
```

需要本地 PocketBase 与前端已启动。

## 许可

MIT，见 [LICENSE](LICENSE)。
