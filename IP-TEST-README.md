# CF Worker 出站IP测试指南

## 目标
验证不同CF账号的Worker是否使用不同的出站IP，评估多账号分散方案的可行性。

---

## 准备工作

### 1. 注册2个CF账号

用不同邮箱注册（可以用Gmail的+技巧）：
- `yourname+cf1@gmail.com` → 账号A
- `yourname+cf2@gmail.com` → 账号B

### 2. 获取API Token和Account ID

**每个账号分别操作：**

1. 登录 https://dash.cloudflare.com
2. 右上角头像 → "My Profile" → "API Tokens"
3. 点击 "Create Token"
4. 选择模板：**"Edit Cloudflare Workers"**
5. 点击 "Continue to summary" → "Create Token"
6. **复制Token**（只显示一次！）

7. 回到Dashboard首页，复制 **Account ID**

**记录下来：**
```
账号A:
  API Token: aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AbCdEf
  Account ID: 73920d17c04ed970281acfa38397f338

账号B:
  API Token: xYzAbC123...
  Account ID: 12345678...
```

---

## 部署测试

### 账号A - 部署Worker

```bash
cd /Users/muqihang/chelingxi_workspace/nvidia-key-proxy

# 1. 修改测试Worker的账号标识
sed -i '' "s/ACCOUNT_1/ACCOUNT_A/" test-ip-worker.js

# 2. 使用账号A的Token部署
export CLOUDFLARE_API_TOKEN="账号A的Token"
export CLOUDFLARE_ACCOUNT_ID="账号A的Account-ID"

npx wrangler deploy test-ip-worker.js --name ip-test-a

# 记录输出的Worker URL，类似：
# https://ip-test-a.你的subdomain.workers.dev
```

### 账号B - 部署Worker

```bash
# 1. 恢复文件并修改为账号B
git checkout test-ip-worker.js
sed -i '' "s/ACCOUNT_1/ACCOUNT_B/" test-ip-worker.js

# 2. 使用账号B的Token部署
export CLOUDFLARE_API_TOKEN="账号B的Token"
export CLOUDFLARE_ACCOUNT_ID="账号B的Account-ID"

npx wrangler deploy test-ip-worker.js --name ip-test-b

# 记录输出的Worker URL
```

---

## 运行测试

### 测试账号A

```bash
./test-ip.sh https://ip-test-a.你的subdomain.workers.dev
```

**示例输出：**
```
==========================================
测试完成！汇总统计：
==========================================
总请求次数: 10
检测到的唯一IP数量: 3

唯一IP列表:
  162.158.10.5 (出现 4 次)
  172.64.20.10 (出现 5 次)
  104.16.30.15 (出现 1 次)
```

### 测试账号B

```bash
./test-ip.sh https://ip-test-b.你的subdomain.workers.dev
```

---

## 分析结果

### 手动对比

```bash
# 账号A的IP
162.158.10.5
172.64.20.10
104.16.30.15

# 账号B的IP
162.158.12.8
172.64.22.12
104.16.32.20

# 重叠：0个
# 重叠率：0%
```

### 判断标准

| 重叠率 | 结论 | 行动 |
|--------|------|------|
| **<30%** | ✅ 多账号方案可行 | 继续实施多账号部署 |
| **30-50%** | ⚠️ 有一定效果 | 可以尝试，但风险仍存在 |
| **50-70%** | ⚠️ 效果有限 | 需要配合其他方案（限流+错峰） |
| **>70%** | ❌ 多账号方案无效 | 放弃，改用VPS代理池 |

---

## 下一步

### 如果IP确实不同（重叠<30%）

1. ✅ 实现时间卡/次数卡功能
2. ✅ 写自动化部署脚本
3. ✅ 注册10个CF账号
4. ✅ 批量部署，生成卡密

### 如果IP重叠严重（>70%）

1. ❌ 放弃多账号方案
2. ✅ 改用VPS代理池方案（$50/月）
3. ✅ 购买10-20个小VPS（不同地区、不同厂商）
4. ✅ 配置HTTP代理，Worker通过代理调用NVIDIA

---

## 快速测试（单次）

如果你只想快速看一下IP，不需要跑10次：

```bash
# 账号A
curl https://ip-test-a.你的subdomain.workers.dev | jq '.unique_ips'

# 账号B
curl https://ip-test-b.你的subdomain.workers.dev | jq '.unique_ips'
```

---

## 注意事项

1. **Workers.dev subdomain**：每个账号只能设置一次，设置后无法更改
2. **测试时间**：建议在不同时段测试（早中晚），IP可能会变化
3. **数据中心**：同一地理位置的用户会路由到相同数据中心，IP重叠概率更高
4. **Token安全**：测试完成后，可以删除或禁用测试用的API Token

---

## 测试完成后清理

```bash
# 删除测试Worker
export CLOUDFLARE_API_TOKEN="账号A的Token"
npx wrangler delete ip-test-a

export CLOUDFLARE_API_TOKEN="账号B的Token"
npx wrangler delete ip-test-b
```
