#!/bin/bash
# 部署脚本 - 用于服务器端执行

echo "🚀 开始部署..."

# 1. 检查Python环境
echo "📦 检查Python环境..."
python3 --version || { echo "❌ Python3未安装"; exit 1; }

# 2. 安装/更新依赖
echo "📦 安装Python依赖..."
pip3 install -r requirements.txt || { echo "❌ 依赖安装失败"; exit 1; }

# 3. 检查数据库文件
echo "🗄️  检查数据库文件..."
if [ ! -f "house_data.db" ]; then
    echo "⚠️  警告：house_data.db 不存在，请确保已上传"
else
    echo "✅ 数据库文件存在"
    chmod 644 house_data.db
fi

# 4. 创建备份目录
echo "📁 创建备份目录..."
mkdir -p db_backups
chmod 755 db_backups

# 5. 检查图片目录
echo "🖼️  检查图片目录..."
if [ ! -d "image" ]; then
    echo "⚠️  警告：image 目录不存在，请确保已上传"
else
    echo "✅ 图片目录存在"
    chmod -R 755 image
fi

# 6. 检查服务是否运行
echo "🔍 检查服务状态..."
if systemctl is-active --quiet house-app.service; then
    echo "🔄 重启服务..."
    sudo systemctl restart house-app.service
else
    echo "⚠️  服务未运行，请手动启动："
    echo "   sudo systemctl start house-app.service"
fi

# 7. 检查服务状态
sleep 2
if systemctl is-active --quiet house-app.service; then
    echo "✅ 服务运行正常"
    systemctl status house-app.service --no-pager
else
    echo "❌ 服务启动失败，请检查日志："
    echo "   sudo journalctl -u house-app.service -n 50"
fi

echo "✨ 部署完成！"

