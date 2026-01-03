from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
import sqlite3
import os
import shutil
from datetime import datetime

app = Flask(__name__, static_folder='.', static_url_path='')
# 允许所有来源的跨域请求（用于 Cloudflare Pages 部署）
CORS(app, resources={r"/api/*": {"origins": "*"}})

DB_PATH = 'house_data.db'
BACKUP_DIR = 'db_backups'  # 备份目录

def get_db_connection():
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # 返回字典格式
    # 初始化标注表、举报表和埋点事件表
    init_annotations_table(conn)
    init_reports_table(conn)
    init_event_tracking_table(conn)
    
    # 自动备份：每次连接时检查是否需要备份（每天备份一次）
    auto_backup_database()
    
    return conn

def auto_backup_database():
    """自动备份数据库（每天备份一次）"""
    try:
        # 确保备份目录存在
        if not os.path.exists(BACKUP_DIR):
            os.makedirs(BACKUP_DIR)
        
        # 检查今天是否已经备份过
        today = datetime.now().strftime('%Y%m%d')
        
        # 列出今天的备份文件
        today_backups = [f for f in os.listdir(BACKUP_DIR) if f.startswith(f'house_data_backup_{today}_')]
        
        # 如果今天还没有备份，则创建备份
        if not today_backups:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_filename = f'house_data_backup_{timestamp}.db'
            backup_path = os.path.join(BACKUP_DIR, backup_filename)
            shutil.copy2(DB_PATH, backup_path)
            print(f'自动备份数据库成功: {backup_path}')
    except Exception as e:
        # 自动备份失败不影响主功能，只记录错误
        print(f'自动备份数据库失败: {e}')

def init_annotations_table(conn):
    """初始化标注表"""
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS map_annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            annotation_value TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(row_index, col_index)
        )
    ''')
    conn.commit()


def init_reports_table(conn):
    """初始化举报表"""
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS violation_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact TEXT NOT NULL,
            content TEXT NOT NULL,
            ip TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()

def init_event_tracking_table(conn):
    """初始化埋点事件表"""
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS event_tracking (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            event_name TEXT NOT NULL,
            event_params TEXT,
            page_path TEXT,
            user_agent TEXT,
            ip_address TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()

@app.route('/api/houses', methods=['GET'])
def get_houses():
    """获取房源列表，支持筛选和分页"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 获取筛选参数
    building = request.args.get('楼栋', '')
    room_type = request.args.get('房型', '')
    area = request.args.get('房子面积', '')
    orientation = request.args.get('房子朝向', '')
    price_min = request.args.get('价格最低', '')
    price_max = request.args.get('价格最高', '')
    floor = request.args.get('房子楼层', '')
    floor_min = request.args.get('楼层最低', '')
    floor_max = request.args.get('楼层最高', '')
    sold_status = request.args.get('售出情况', '')
    
    # 分页参数
    page = int(request.args.get('page', 1))
    per_page = int(request.args.get('per_page', 20))
    offset = (page - 1) * per_page
    
    # 构建查询
    query = "SELECT * FROM house_info WHERE 1=1"
    params = []
    
    if building:
        query += " AND 楼栋名 LIKE ?"
        params.append(f"%{building}%")
    
    if room_type:
        # 支持多房型筛选：逗号分隔表示 IN 查询，例如 70A,70A',70A''
        if ',' in room_type:
            types = [t.strip() for t in room_type.split(',') if t.strip()]
            if types:
                placeholders = ','.join(['?' for _ in types])
                query += f" AND 房子类型 IN ({placeholders})"
                params.extend(types)
        else:
            query += " AND 房子类型 = ?"
            params.append(room_type)
    
    if area:
        query += " AND 房子面积 = ?"
        params.append(area)
    
    if orientation:
        # 支持多选（用逗号分隔）
        orientations = [o.strip() for o in orientation.split(',') if o.strip()]
        if orientations:
            placeholders = ','.join(['?' for _ in orientations])
            query += f" AND 朝向 IN ({placeholders})"
            params.extend(orientations)
    
    if price_min:
        query += " AND 价格 >= ?"
        params.append(float(price_min))
    
    if price_max:
        query += " AND 价格 <= ?"
        params.append(float(price_max))
    
    if floor:
        query += " AND 房子楼层 = ?"
        params.append(int(floor))
    
    # 楼层区间筛选（支持独立或与单一楼层同时使用）
    if floor_min:
        query += " AND 房子楼层 >= ?"
        params.append(int(floor_min))
    if floor_max:
        query += " AND 房子楼层 <= ?"
        params.append(int(floor_max))
    
    if sold_status:
        query += " AND 售出情况 = ?"
        params.append(sold_status)
    
    # 获取总数
    count_query = f"SELECT COUNT(*) as total FROM ({query})"
    cursor.execute(count_query, params)
    total = cursor.fetchone()['total']
    
    # 获取分页数据
    query += " ORDER BY id LIMIT ? OFFSET ?"
    params.extend([per_page, offset])
    cursor.execute(query, params)
    
    houses = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    return jsonify({
        'data': houses,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page
    })

@app.route('/api/houses/all', methods=['GET'])
def get_all_houses():
    """获取所有房源（不分页），用于计算分数"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 获取筛选参数（可选）
    building = request.args.get('楼栋', '')
    room_type = request.args.get('房型', '')
    area = request.args.get('房子面积', '')
    orientation = request.args.get('房子朝向', '')
    price_min = request.args.get('价格最低', '')
    price_max = request.args.get('价格最高', '')
    floor = request.args.get('房子楼层', '')
    floor_min = request.args.get('楼层最低', '')
    floor_max = request.args.get('楼层最高', '')
    sold_status = request.args.get('售出情况', '')
    
    # 构建查询
    query = "SELECT * FROM house_info WHERE 1=1"
    params = []
    
    if building:
        query += " AND 楼栋名 LIKE ?"
        params.append(f"%{building}%")
    
    if room_type:
        # 支持多房型筛选：逗号分隔表示 IN 查询
        if ',' in room_type:
            types = [t.strip() for t in room_type.split(',') if t.strip()]
            if types:
                placeholders = ','.join(['?' for _ in types])
                query += f" AND 房子类型 IN ({placeholders})"
                params.extend(types)
        else:
            query += " AND 房子类型 = ?"
            params.append(room_type)
    
    if area:
        query += " AND 房子面积 = ?"
        params.append(area)
    
    if orientation:
        # 支持多选（用逗号分隔）
        orientations = [o.strip() for o in orientation.split(',') if o.strip()]
        if orientations:
            placeholders = ','.join(['?' for _ in orientations])
            query += f" AND 朝向 IN ({placeholders})"
            params.extend(orientations)
    
    if price_min:
        query += " AND 价格 >= ?"
        params.append(float(price_min))
    
    if price_max:
        query += " AND 价格 <= ?"
        params.append(float(price_max))
    
    if floor:
        query += " AND 房子楼层 = ?"
        params.append(int(floor))
    
    # 楼层区间筛选
    if floor_min:
        query += " AND 房子楼层 >= ?"
        params.append(int(floor_min))
    if floor_max:
        query += " AND 房子楼层 <= ?"
        params.append(int(floor_max))
    
    if sold_status:
        query += " AND 售出情况 = ?"
        params.append(sold_status)
    
    # 按id排序
    query += " ORDER BY id"
    cursor.execute(query, params)
    
    houses = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    return jsonify(houses)

@app.route('/api/houses/building/<building_name>', methods=['GET'])
def get_houses_by_building(building_name):
    """根据楼栋名获取所有房源"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM house_info WHERE 楼栋名 = ? ORDER BY CAST(房号 AS INTEGER)", (building_name,))
    houses = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    return jsonify({
        'data': houses,
        'total': len(houses)
    })

@app.route('/api/houses/<int:house_id>', methods=['GET'])
def get_house_by_id(house_id):
    """根据ID获取单个房源信息"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM house_info WHERE id = ?", (house_id,))
    house = cursor.fetchone()
    
    conn.close()
    
    if house:
        return jsonify(dict(house))
    else:
        return jsonify({'error': '房源不存在'}), 404

@app.route('/api/filters/options', methods=['GET'])
def get_filter_options():
    """获取筛选器的选项数据"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 获取所有楼栋
    cursor.execute("SELECT DISTINCT 楼栋名 FROM house_info ORDER BY 楼栋名")
    buildings = [row['楼栋名'] for row in cursor.fetchall()]
    
    # 获取所有房型
    cursor.execute("SELECT DISTINCT 房子类型 FROM house_info WHERE 房子类型 IS NOT NULL ORDER BY 房子类型")
    room_types = [row['房子类型'] for row in cursor.fetchall()]
    
    # 获取所有面积
    cursor.execute("SELECT DISTINCT 房子面积 FROM house_info WHERE 房子面积 IS NOT NULL ORDER BY CAST(房子面积 AS INTEGER)")
    areas = [row['房子面积'] for row in cursor.fetchall()]
    
    # 获取所有朝向
    cursor.execute("SELECT DISTINCT 朝向 FROM house_info WHERE 朝向 IS NOT NULL ORDER BY 朝向")
    orientations = [row['朝向'] for row in cursor.fetchall()]
    
    # 获取所有楼层
    cursor.execute("SELECT DISTINCT 房子楼层 FROM house_info WHERE 房子楼层 IS NOT NULL ORDER BY 房子楼层")
    floors = [row['房子楼层'] for row in cursor.fetchall()]
    
    # 获取售出情况
    cursor.execute("SELECT DISTINCT 售出情况 FROM house_info ORDER BY 售出情况")
    sold_statuses = [row['售出情况'] for row in cursor.fetchall()]
    
    # 获取价格范围
    cursor.execute("SELECT MIN(价格) as min_price, MAX(价格) as max_price FROM house_info WHERE 价格 IS NOT NULL")
    price_range = cursor.fetchone()
    
    conn.close()
    
    return jsonify({
        '楼栋': buildings,
        '房型': room_types,
        '房子面积': areas,
        '房子朝向': orientations,
        '房子楼层': floors,
        '售出情况': sold_statuses,
        '价格范围': {
            'min': price_range['min_price'],
            'max': price_range['max_price']
        }
    })

@app.route('/api/buildings', methods=['GET'])
def get_buildings():
    """获取所有楼栋列表"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT DISTINCT 楼栋名 FROM house_info ORDER BY 楼栋名")
    buildings = [row['楼栋名'] for row in cursor.fetchall()]
    
    conn.close()
    
    return jsonify({
        'data': buildings
    })

@app.route('/api/annotations', methods=['GET'])
def get_annotations():
    """获取所有标注数据"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT row_index, col_index, annotation_value FROM map_annotations")
    annotations = {}
    for row in cursor.fetchall():
        key = f"{row['row_index']}_{row['col_index']}"
        annotations[key] = row['annotation_value']
    
    conn.close()
    
    return jsonify(annotations)

@app.route('/api/annotations', methods=['POST'])
def save_annotation():
    """保存单个标注"""
    data = request.get_json()
    row_index = data.get('row_index')
    col_index = data.get('col_index')
    annotation_value = data.get('annotation_value', '').strip()
    
    if row_index is None or col_index is None:
        return jsonify({'error': '缺少必要参数'}), 400
    
     # 安全限制：单个标注内容长度限制，防止被刷超长数据
    if len(annotation_value) > 200:
        return jsonify({'error': '标注内容过长，单条最多200个字符'}), 400
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    if annotation_value:
        # 保存或更新标注
        cursor.execute('''
            INSERT OR REPLACE INTO map_annotations (row_index, col_index, annotation_value, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ''', (row_index, col_index, annotation_value))
    else:
        # 删除标注
        cursor.execute('DELETE FROM map_annotations WHERE row_index = ? AND col_index = ?', 
                      (row_index, col_index))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/annotations/batch', methods=['POST'])
def save_annotations_batch():
    """批量保存标注数据"""
    data = request.get_json()
    annotations = data.get('annotations', {})
    
    # 安全限制：一次批量保存的标注数量限制，防止被刷爆
    MAX_BATCH_ANNOTATIONS = 2000
    MAX_VALUE_LENGTH = 200
    if not isinstance(annotations, dict):
        return jsonify({'error': '参数格式错误，应为字典'}), 400
    if len(annotations) > MAX_BATCH_ANNOTATIONS:
        return jsonify({'error': f'单次最多只能保存 {MAX_BATCH_ANNOTATIONS} 条标注'}), 400
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 先清空所有标注
    cursor.execute('DELETE FROM map_annotations')
    
    # 批量插入新标注
    saved_count = 0
    for key, value in annotations.items():
        if not value:
            continue
        v = value.strip()
        if not v:
            continue  # 跳过空值
        if len(v) > MAX_VALUE_LENGTH:
            # 对于过长的内容可以选择截断或直接跳过，这里选择截断
            v = v[:MAX_VALUE_LENGTH]
        try:
            row_index, col_index = key.split('_')
            cursor.execute('''
                INSERT INTO map_annotations (row_index, col_index, annotation_value)
                VALUES (?, ?, ?)
            ''', (int(row_index), int(col_index), v))
            saved_count += 1
        except (ValueError, IndexError):
            continue  # 跳过格式错误的键
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'count': saved_count})


@app.route('/api/report', methods=['POST'])
def submit_report():
    """提交违规举报"""
    data = request.get_json() or {}
    contact = (data.get('contact') or '').strip()
    content = (data.get('content') or '').strip()
    
    # 基本必填校验
    if not contact or not content:
        return jsonify({'success': False, 'error': '联系方式和举报内容均为必填'}), 400
    
    # 安全限制：长度限制，防止被刷超长垃圾
    MAX_CONTACT_LEN = 200
    MAX_CONTENT_LEN = 2000
    if len(contact) > MAX_CONTACT_LEN:
        return jsonify({'success': False, 'error': f'联系方式过长，最多{MAX_CONTACT_LEN}个字符'}), 400
    if len(content) > MAX_CONTENT_LEN:
        # 可以截断或直接拒绝，这里选择直接拒绝，提示用户缩短
        return jsonify({'success': False, 'error': f'举报内容过长，最多{MAX_CONTENT_LEN}个字符'}), 400
    
    # 获取IP，优先使用 X-Forwarded-For
    ip = request.headers.get('X-Forwarded-For', '').split(',')[0].strip() or request.remote_addr
    
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO violation_reports (contact, content, ip)
        VALUES (?, ?, ?)
    ''', (contact, content, ip))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/events/track', methods=['POST'])
def track_event():
    """记录埋点事件"""
    try:
        data = request.get_json() or {}
        event_type = data.get('event_type', '')
        event_name = data.get('event_name', '')
        event_params = data.get('event_params', {})
        page_path = data.get('page_path', '')
        
        # 基本校验
        if not event_type or not event_name:
            return jsonify({'success': False, 'error': '事件类型和事件名称不能为空'}), 400
        
        # 获取IP和User-Agent
        ip = request.headers.get('X-Forwarded-For', '').split(',')[0].strip() or request.remote_addr
        user_agent = request.headers.get('User-Agent', '')
        
        # 将event_params转换为JSON字符串
        import json
        event_params_str = json.dumps(event_params, ensure_ascii=False) if event_params else None
        
        # 保存到数据库
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO event_tracking (event_type, event_name, event_params, page_path, user_agent, ip_address)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (event_type, event_name, event_params_str, page_path, user_agent, ip))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        print(f'埋点事件保存失败: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/')
def index():
    """返回首页"""
    return send_file('index.html')

@app.route('/<path:path>')
def serve_static(path):
    """提供静态文件服务"""
    if path.startswith('api/'):
        # API路由不在这里处理
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory('.', path)

if __name__ == '__main__':
    # 检查数据库是否存在
    if not os.path.exists(DB_PATH):
        print(f"错误: 数据库文件 {DB_PATH} 不存在")
        exit(1)
    
    print("启动Flask服务器...")
    print("API地址: http://localhost:5000")
    app.run(debug=True, host='0.0.0.0', port=5000)

