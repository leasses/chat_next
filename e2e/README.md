# 端到端测试

用 Playwright 驱动真实浏览器，验证多端同步、增量上传、清空重建等流程。

## 前置

1. PocketBase 已启动并完成 `init.sh` 初始化
2. 前端已构建（`npm run build && npm run deploy:copy`）或处于 `npm run dev`
3. 安装浏览器：`npx playwright install chromium`

## 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `PB_URL` | 站点地址 | `http://127.0.0.1:8090` |
| `PB_ADMIN_EMAIL` | 超管账号 | `admin@example.com` |
| `PB_ADMIN_PASSWORD` | 超管密码 | 无（必填） |

```bash
export PB_ADMIN_PASSWORD='你的超管密码'
npm run test:e2e     # 双端实时同步
npm run test:wipe    # 清空加密数据重建
```

## 说明

- 每个用例自建账号（通过 `verifications` 集合直接插入验证码），互不影响
- 会向数据库写入测试数据，请勿在正式环境运行
- `realtime.mjs` 会模拟 `api.deepseek.com` 的响应，不产生真实 API 调用
