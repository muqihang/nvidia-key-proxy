#!/bin/bash

# Test race condition fix: 10 concurrent requests should increment count by exactly 10

API_URL="https://ds-api-gateway.jerrylopez3364.workers.dev/v1/chat/completions"
CUSTOMER_KEY="sk-cc0e564e47f78b2606546e0a968fe6b57bb277f0a070946a"
ADMIN_TOKEN="TestAdmin123456789012345678901234"

echo "=== Testing Race Condition Fix ==="
echo "Sending 10 concurrent requests..."

# Send 10 requests in parallel
for i in {1..10}; do
  (
    curl -s -X POST "$API_URL" \
      -H "Authorization: Bearer $CUSTOMER_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "Say OK"}],
        "stream": false
      }' > /dev/null 2>&1
    echo "Request $i completed"
  ) &
done

# Wait for all requests to complete
wait

echo ""
echo "All requests completed. Checking usage count..."
sleep 2

# Check usage count
curl -s -X GET "https://ds-api-gateway.jerrylopez3364.workers.dev/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" | \
  jq -r '.[] | select(.customer_key | startswith("sk-cc0e564e")) | "Count: \(.request_count)/\(.max_requests)"'

echo ""
echo "✅ If count shows exactly 10, race condition is fixed!"
