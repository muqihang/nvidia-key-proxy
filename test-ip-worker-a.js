/**
 * IP测试Worker - 用于验证不同CF账号的出站IP是否不同
 * 
 * 部署方法：
 * 1. wrangler deploy test-ip-worker.js --name ip-test-account1
 * 2. 访问 https://ip-test-account1.你的subdomain.workers.dev
 * 3. 记录返回的IP列表
 * 4. 在另一个CF账号重复上述步骤
 * 5. 对比两个账号的IP是否不同
 */

export default {
  async fetch(request) {
    const accountName = 'ACCOUNT_A'; // 部署到不同账号时修改这里：ACCOUNT_1, ACCOUNT_2, ...
    
    // 调用多个IP检测服务，收集出站IP
    const services = [
      { name: 'ipify', url: 'https://api.ipify.org?format=json' },
      { name: 'httpbin', url: 'https://httpbin.org/ip' },
      { name: 'ifconfig.me', url: 'https://ifconfig.me/ip' },
      { name: 'icanhazip', url: 'https://icanhazip.com' },
      { name: 'ipinfo', url: 'https://ipinfo.io/ip' },
    ];
    
    const results = [];
    
    for (const service of services) {
      try {
        const response = await fetch(service.url, {
          headers: { 'User-Agent': 'CF-Worker-IP-Test/1.0' }
        });
        
        if (!response.ok) {
          results.push({
            service: service.name,
            error: `HTTP ${response.status}`
          });
          continue;
        }
        
        const text = await response.text();
        let ip;
        
        // 尝试解析JSON或纯文本
        try {
          const json = JSON.parse(text);
          ip = json.ip || json.origin || text.trim();
        } catch {
          ip = text.trim();
        }
        
        results.push({
          service: service.name,
          ip: ip
        });
      } catch (error) {
        results.push({
          service: service.name,
          error: error.message
        });
      }
    }
    
    // 统计不同的IP
    const uniqueIPs = [...new Set(results.filter(r => r.ip).map(r => r.ip))];
    
    const response = {
      account: accountName,
      timestamp: new Date().toISOString(),
      cf_datacenter: request.cf?.colo || 'unknown', // CF数据中心代码
      unique_ips: uniqueIPs,
      ip_count: uniqueIPs.length,
      results: results
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
