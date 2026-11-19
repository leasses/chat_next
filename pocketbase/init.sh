#!/usr/bin/env bash
# PocketBase 初始化（Ubuntu/Linux）：建超管、建集合、给 users 加 crypto_salt。
# 幂等，可重复执行。用法：./init.sh <PB_URL> <ADMIN_EMAIL> <ADMIN_PASSWORD>
set -euo pipefail

PB_URL="${1:-http://127.0.0.1:8090}"
ADMIN_EMAIL="${2:-admin@example.com}"
ADMIN_PASS="${3:-}"

if [ -z "$ADMIN_PASS" ]; then
  echo "用法: $0 <PB_URL> <ADMIN_EMAIL> <ADMIN_PASSWORD>" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PB_BIN="$DIR/pocketbase"

# 1. 超管（已存在会报错，忽略）
"$PB_BIN" admin create "$ADMIN_EMAIL" "$ADMIN_PASS" --dir "$DIR/pb_data" 2>/dev/null \
  || echo "· 超管已存在，跳过"

# 2. 登录取 token
TOKEN=$(curl -sf -X POST "$PB_URL/api/admins/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "超管登录失败，服务是否已启动？($PB_URL)" >&2
  exit 1
fi

api() { curl -s -H "Authorization: $TOKEN" -H 'Content-Type: application/json' "$@"; }

# 3. 建集合（存在则跳过）
make_collection() {
  local name=$1 json=$2
  if api -o /dev/null -w '%{http_code}' "$PB_URL/api/collections/$name" | grep -q '^200$'; then
    echo "· $name 已存在"
  else
    api -X POST "$PB_URL/api/collections" -d "$json" >/dev/null
    echo "✓ $name 已创建"
  fi
}

REL='{"collectionId":"_pb_users_auth_","cascadeDelete":true,"minSelect":null,"maxSelect":1,"displayFields":null}'
RULE='user = @request.auth.id'

make_collection conversations "{
  \"name\":\"conversations\",\"type\":\"base\",\"system\":false,
  \"schema\":[
    {\"name\":\"user\",\"type\":\"relation\",\"required\":true,\"options\":$REL},
    {\"name\":\"conversation_id\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":64}},
    {\"name\":\"rev\",\"type\":\"number\",\"required\":true,\"options\":{\"min\":0,\"max\":9999999999999}},
    {\"name\":\"cipher\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":1000000}}
  ],
  \"indexes\":[
    \"CREATE INDEX idx_conv_user_rev ON conversations (user, rev)\",
    \"CREATE UNIQUE INDEX idx_conv_user_cid ON conversations (user, conversation_id)\"
  ],
  \"listRule\":\"$RULE\",\"viewRule\":\"$RULE\",\"createRule\":\"$RULE\",\"updateRule\":\"$RULE\",\"deleteRule\":\"$RULE\"
}"

make_collection secrets "{
  \"name\":\"secrets\",\"type\":\"base\",\"system\":false,
  \"schema\":[
    {\"name\":\"user\",\"type\":\"relation\",\"required\":true,\"options\":$REL},
    {\"name\":\"cipher\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":10000}}
  ],
  \"indexes\":[\"CREATE UNIQUE INDEX idx_secrets_user ON secrets (user)\"],
  \"listRule\":\"$RULE\",\"viewRule\":\"$RULE\",\"createRule\":\"$RULE\",\"updateRule\":\"$RULE\",\"deleteRule\":\"$RULE\"
}"

make_collection diffs "{
  \"name\":\"diffs\",\"type\":\"base\",\"system\":false,
  \"schema\":[
    {\"name\":\"user\",\"type\":\"relation\",\"required\":true,\"options\":$REL},
    {\"name\":\"cid\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":64}},
    {\"name\":\"ts\",\"type\":\"number\",\"required\":true,\"options\":{\"min\":0,\"max\":9999999999999}},
    {\"name\":\"off\",\"type\":\"number\",\"required\":true,\"options\":{\"min\":0,\"max\":999999999}},
    {\"name\":\"diff\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":5000000}},
    {\"name\":\"crc\",\"type\":\"number\",\"required\":true,\"options\":{\"min\":0,\"max\":4294967295}},
    {\"name\":\"len\",\"type\":\"number\",\"required\":true,\"options\":{\"min\":0,\"max\":999999999}}
  ],
  \"indexes\":[
    \"CREATE INDEX idx_diffs_user_ts ON diffs (user, ts)\",
    \"CREATE INDEX idx_diffs_user_cid_ts ON diffs (user, cid, ts)\"
  ],
  \"listRule\":\"$RULE\",\"viewRule\":\"$RULE\",\"createRule\":\"$RULE\",\"updateRule\":\"$RULE\",\"deleteRule\":\"$RULE\"
}"

make_collection verifications "{
  \"name\":\"verifications\",\"type\":\"base\",\"system\":false,
  \"schema\":[
    {\"name\":\"email\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":255}},
    {\"name\":\"code_hash\",\"type\":\"text\",\"required\":true,\"options\":{\"min\":0,\"max\":128}},
    {\"name\":\"expires\",\"type\":\"date\",\"required\":true,\"options\":{\"min\":\"\",\"max\":\"\"}},
    {\"name\":\"used\",\"type\":\"bool\",\"required\":false,\"options\":{}},
    {\"name\":\"ip\",\"type\":\"text\",\"required\":false,\"options\":{\"min\":0,\"max\":64}}
  ],
  \"indexes\":[
    \"CREATE INDEX idx_verifications_email ON verifications (email, created)\",
    \"CREATE INDEX idx_verifications_ip ON verifications (ip, created)\"
  ],
  \"listRule\":null,\"viewRule\":null,\"createRule\":null,\"updateRule\":null,\"deleteRule\":null
}"

# 4. users：加 crypto_salt + 改为只允许邮箱登录
USERS=$(api "$PB_URL/api/collections/users")
if echo "$USERS" | grep -q '"crypto_salt"'; then
  echo "· users.crypto_salt 已存在"
else
  echo "$USERS" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const c=JSON.parse(s);
      const schema=(c.schema||[]).filter(f=>f.name!=="crypto_salt");
      schema.push({name:"crypto_salt",type:"text",required:false,presentable:false,system:false,
        options:{min:0,max:64,pattern:"^[0-9a-f]{64}$"}});
      process.stdout.write(JSON.stringify({schema}));
    })' > /tmp/pb_users.json
  api -X PATCH "$PB_URL/api/collections/users" -d "@/tmp/pb_users.json" >/dev/null
  echo "✓ users.crypto_salt 已添加"
fi

# 只允许邮箱登录（username 是 PB 内置字段，格式受限，不参与登录）
api -X PATCH "$PB_URL/api/collections/users" \
  -d '{"options":{"allowEmailAuth":true,"allowUsernameAuth":false,"requireEmail":true,"onlyVerified":false,"minPasswordLength":8}}' >/dev/null
echo "✓ users 已设为仅邮箱登录"

rm -f /tmp/pb_users.json
echo
echo "初始化完成：$PB_URL"