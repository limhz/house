// API 服务器配置
// 本地开发时使用 localhost，直接访问 IP 时使用 HTTP，域名访问时使用 HTTPS
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    // 本地开发
    window.API_BASE = 'http://localhost:5000/api';
} else if (window.location.hostname === '106.52.218.173' || /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)) {
    // 直接访问 IP 地址，使用 HTTP
    window.API_BASE = window.location.protocol + '//' + window.location.hostname + '/api';
} else {
    // 生产环境：使用域名，根据当前协议决定 HTTP/HTTPS
    window.API_BASE = window.location.protocol + '//' + window.location.hostname + '/api';
}

