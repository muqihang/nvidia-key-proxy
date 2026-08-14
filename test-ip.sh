#!/bin/bash
# IP测试脚本 - 多次调用Worker收集IP数据
# 用法: ./test-ip.sh <worker-url>

WORKER_URL="$1"
ITERATIONS=10

if [ -z "$WORKER_URL" ]; then
  echo "用法: ./test-ip.sh <worker-url>"
  echo "示例: ./test-ip.sh https://ip-test-account1.你的subdomain.workers.dev"
  exit 1
fi

echo "=========================================="
echo "开始测试Worker出站IP"
echo "Worker URL: $WORKER_URL"
echo "测试次数: $ITERATIONS"
echo "=========================================="
echo ""

IPS_FILE="/tmp/cf-worker-ips-$$.txt"
> "$IPS_FILE"

for i in $(seq 1 $ITERATIONS); do
  echo "[$i/$ITERATIONS] 请求中..."
  
  RESPONSE=$(curl -s "$WORKER_URL")
  
  if [ $? -ne 0 ]; then
    echo "  ❌ 请求失败"
    continue
  fi
  
  ACCOUNT=$(echo "$RESPONSE" | jq -r '.account')
  DATACENTER=$(echo "$RESPONSE" | jq -r '.cf_datacenter')
  IPS=$(echo "$RESPONSE" | jq -r '.unique_ips[]')
  
  echo "  账号: $ACCOUNT"
  echo "  数据中心: $DATACENTER"
  echo "  检测到的IP:"
  echo "$IPS" | while read ip; do
    echo "    - $ip"
    echo "$ip" >> "$IPS_FILE"
  done
  echo ""
  
  sleep 2
done

echo "=========================================="
echo "测试完成！汇总统计："
echo "=========================================="

UNIQUE_IPS=$(sort "$IPS_FILE" | uniq)
UNIQUE_COUNT=$(echo "$UNIQUE_IPS" | wc -l | xargs)

echo "总请求次数: $ITERATIONS"
echo "检测到的唯一IP数量: $UNIQUE_COUNT"
echo ""
echo "唯一IP列表:"
echo "$UNIQUE_IPS" | while read ip; do
  COUNT=$(grep -c "^$ip$" "$IPS_FILE")
  echo "  $ip (出现 $COUNT 次)"
done

rm "$IPS_FILE"

echo ""
echo "=========================================="
echo "下一步："
echo "1. 在另一个CF账号部署相同的Worker"
echo "2. 运行相同的测试脚本"
echo "3. 对比两个账号的IP列表，计算重叠率"
echo "=========================================="
