#!/bin/bash
set -e

API_URL="https://ds-api-gateway.jerrylopez3364.workers.dev"
ADMIN_TOKEN="TestAdmin123456789012345678901234"

echo "====== 测试时间卡 ======"

echo -e "\n1️⃣ 创建1天卡"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-1day-1", "nvapi-test-key-1day-2"],
    "note": "1天体验卡",
    "days": 1
  }' | jq '.'

echo -e "\n2️⃣ 创建7天卡"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-7day-1", "nvapi-test-key-7day-2"],
    "note": "7天标准卡",
    "days": 7
  }' | jq '.'

echo -e "\n3️⃣ 创建15天卡"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-15day-1", "nvapi-test-key-15day-2"],
    "note": "15天进阶卡",
    "days": 15
  }' | jq '.'

echo -e "\n4️⃣ 创建30天卡"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-30day-1", "nvapi-test-key-30day-2"],
    "note": "30天月卡",
    "days": 30
  }' | jq '.'

echo -e "\n====== 测试次数卡 ======"

echo -e "\n5️⃣ 创建2000次卡"
RESPONSE_2000=$(curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-2000req-1", "nvapi-test-key-2000req-2"],
    "note": "2000次基础卡",
    "max_requests": 2000
  }')
echo "$RESPONSE_2000" | jq '.'
KEY_2000=$(echo "$RESPONSE_2000" | jq -r '.customer_key')

echo -e "\n6️⃣ 创建5000次卡"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-5000req-1", "nvapi-test-key-5000req-2"],
    "note": "5000次高级卡",
    "max_requests": 5000
  }' | jq '.'

echo -e "\n====== 测试组合卡 ======"

echo -e "\n7️⃣ 创建组合卡（7天+2000次）"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-combo-1", "nvapi-test-key-combo-2"],
    "note": "7天内2000次",
    "days": 7,
    "max_requests": 2000
  }' | jq '.'

echo -e "\n====== 测试无效参数 ======"

echo -e "\n8️⃣ 测试无效days（应该失败）"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-invalid-1", "nvapi-test-key-invalid-2"],
    "note": "无效的10天卡",
    "days": 10
  }' | jq '.'

echo -e "\n9️⃣ 测试无效max_requests（应该失败）"
curl -s -X POST "$API_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-test-key-invalid-1", "nvapi-test-key-invalid-2"],
    "note": "无效的3000次卡",
    "max_requests": 3000
  }' | jq '.'

echo -e "\n====== 测试次数卡拦截（需要真实NVIDIA key才能完整测试） ======"
echo "⚠️  次数限制测试需要真实的NVIDIA API key，跳过实际请求测试"
echo "✅ 创建的2000次卡customer_key: $KEY_2000"

echo -e "\n====== 所有测试完成 ======"
