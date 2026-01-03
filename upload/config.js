// API 服务器配置
// 本地开发时使用 localhost，部署到 Cloudflare Pages 时使用 API 子域名
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    // 本地开发
    window.API_BASE = 'http://localhost:5000/api';
} else {
    // 生产环境：使用新域名
    window.API_BASE = 'https://shanyuewan.site/api';
}

