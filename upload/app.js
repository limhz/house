// API基础URL
// 优先使用 config.js 中定义的 API_BASE，如果没有则使用默认值
const API_BASE =
    (typeof window !== 'undefined' && window.API_BASE) ||
    (typeof window !== 'undefined' && window.location && window.location.hostname !== 'localhost'
        ? 'https://shanyuewan.site/api'
        : 'http://localhost:5000/api');

// 全局状态
let currentPage = 1;
let currentFilters = {};
let filterOptions = {};
let housesData = [];
let weights = {
    orientation: 5,
    price: 5,
    noise: 5,
    view: 5,
    floor: 5,
    roomType: 5,
    building: 3  // 新增楼栋维度，默认权重3
};

// 价格期望值（元/㎡）
let expectedPrice = null;

// 总楼层数
const TOTAL_FLOORS = 38;

// 可配置参数（衰减系数、最优楼层区间等）
const SCORE_CONFIG = {
    orientationDecay: 0.95,  // 朝向衰减系数
    viewDecay: 0.9,           // 景观衰减系数
    roomTypeDecay: 0.92,      // 房型衰减系数
    buildingDecay: 0.93,      // 楼栋衰减系数
    optimalFloorRange: [15, 25]  // 最优楼层区间
};

// 楼栋基础分数映射
const BUILDING_SCORE_MAP = {
    '1A': 60,   // 减分项
    '1B': 85,
    '1F': 80,
    '2A': 90,
    '2B': 88,
    '2F': 82,
    '其他': 75
};

// 楼栋修正系数映射
const BUILDING_CORRECTION_MAP = {
    '1A': 0.85,   // 核心减分项
    '1B': 1.0,
    '1F': 1.0,
    '2A': 1.05,   // 轻微加分
    '2B': 1.02,   // 轻微加分
    '2F': 1.0,
    '其他': 1.0    // 基准
};

// 全局排序配置
let sortConfig = {
    orientation: ['东南向', '西南向', '西北向', '东北向', '南向', '北向', '东向', '西向', '其他'],
    view: ['海景', '山景', '楼景', '没有景观'],
    roomType: ['三房', '两房', '四房', '一房', '其他'],  // 新增房型排序
    building: ['2A', '2B', '1B', '2F', '1F', '1A', '其他']  // 新增楼栋排序
};

// 梯度表配置（tier: 1=满意100分, 2=比较满意60分, 3=一般20分）
let gradientConfig = {
    orientation: {
        1: ['东南向', '西南向', '西北向'],  // 满意
        2: ['东北向', '南向'],  // 比较满意
        3: ['北向', '东向', '西向']  // 一般（移除"其他"）
    },
    view: {
        1: [],  // 满意（可添加房号）
        2: ['海景', '山景'],  // 比较满意
        3: ['楼景', '没有景观']  // 一般
    },
    viewRooms: []  // 第一梯队的房号列表（如['1C06']）
};

// 心理预期楼层
let preferredFloor = null;

// 初始化
let mapInitialized = false;

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    // 初始进入即加载俯视图，避免首次点击按钮无反应
    initMap();
    initFilters();
    loadFilterOptions();
    loadWeights();
    initExpectationPage();
    initModal();
    loadHouses();
    
    // 延迟初始化添加房号功能（确保DOM完全加载）
    setTimeout(() => {
        const viewWeight = document.getElementById('weight-view');
        if (viewWeight) {
            const weight = parseInt(viewWeight.value);
            if (weight > 0) {
                initViewRoomAdd();
            }
        }
    }, 1000);
});

// Tab切换
function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const pages = document.querySelectorAll('.page');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetPage = btn.dataset.page;
            
            // 更新tab状态
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // 更新页面显示
            pages.forEach(p => p.classList.remove('active'));
            document.getElementById(`${targetPage}-page`).classList.add('active');
            
            // 页面特定初始化
            if (targetPage === 'home') {
                initMap();
            } else if (targetPage === 'price') {
                loadHouses();
                // 检查是否需要显示新手引导
                checkAndShowGuide();
            }
        });
    });
}

// 初始化地图
// 标注数据存储
let annotationData = {};
let annotationMode = false;
const GRID_SIZE = 1000; // 1000x1000的网格

// 初始化地图
function initMap() {
    if (mapInitialized) return;
    mapInitialized = true;
    const mapImage = document.getElementById('map-image');
    const mapCanvas = document.getElementById('map-canvas');
    const mapContainer = document.querySelector('.map-container');
    
    if (!mapImage || !mapCanvas || !mapContainer) return;
    
    const ctx = mapCanvas.getContext('2d');
    
    // 更新canvas尺寸的函数
    const updateCanvasSize = () => {
        const containerRect = mapContainer.getBoundingClientRect();
        mapCanvas.width = containerRect.width;
        mapCanvas.height = containerRect.height;
    };
    
    // 加载标注数据（异步）
    loadAnnotationData().then(() => {
        console.log('标注数据加载完成，数据量:', Object.keys(annotationData).length);
        // 数据加载完成后，如果不是标注模式，绘制售出状态圆点
        if (!annotationMode) {
            // 延迟一下确保图片已加载
            setTimeout(() => {
                renderSoldStatusDots();
            }, 100);
        }
    });
    
    // 初始化标注模式切换按钮
    const toggleBtn = document.getElementById('toggle-annotation');
    const clearBtn = document.getElementById('clear-annotations');
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            annotationMode = !annotationMode;
            toggleAnnotationMode();
        });
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (confirm('确定要清除所有标注吗？')) {
                annotationData = {};
                await saveAnnotationData();
                toggleAnnotationMode();
                toggleAnnotationMode(); // 重新开启以刷新显示
            }
        });
    }
    
    mapImage.onload = () => {
        updateCanvasSize();
        
        // 监听窗口大小变化，更新canvas尺寸
        window.addEventListener('resize', () => {
            updateCanvasSize();
            if (annotationMode) {
                renderAnnotationGrid();
            } else {
                renderSoldStatusDots();
            }
        });
        
        // 如果不是标注模式，绘制售出状态圆点
        if (!annotationMode) {
            renderSoldStatusDots();
        }
        
        // 加载楼栋数据并绘制可点击区域
        loadBuildings().then(buildings => {
            // 这里可以根据实际图片坐标绘制可点击区域
            // 暂时使用简单的点击检测
            if (!annotationMode) {
                mapCanvas.style.pointerEvents = 'auto';
            mapCanvas.addEventListener('click', (e) => {
                const rect = mapCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                handleMapClick(x, y);
            });
            }
        });
    };
}

// 切换标注模式
function toggleAnnotationMode() {
    const overlay = document.getElementById('annotation-overlay');
    const toggleBtn = document.getElementById('toggle-annotation');
    const clearBtn = document.getElementById('clear-annotations');
    const mapCanvas = document.getElementById('map-canvas');
    
    if (!overlay || !toggleBtn || !mapCanvas) return;
    
    if (annotationMode) {
        overlay.style.display = 'block';
        toggleBtn.textContent = '关闭标注模式';
        if (clearBtn) clearBtn.style.display = 'block';
        mapCanvas.style.pointerEvents = 'none';
        renderAnnotationGrid();
    } else {
        overlay.style.display = 'none';
        toggleBtn.textContent = '开启标注模式';
        if (clearBtn) clearBtn.style.display = 'none';
        mapCanvas.style.pointerEvents = 'auto';
        renderSoldStatusDots();
    }
}

// 渲染标注网格（Canvas版，避免创建海量DOM节点）
function renderAnnotationGrid() {
    const overlay = document.getElementById('annotation-overlay');
    const mapImage = document.getElementById('map-image');
    const mapContainer = document.querySelector('.map-container');
    
    if (!overlay || !mapImage || !mapContainer) return;
    
    // 清空覆盖层
    overlay.innerHTML = '';
    
    // 获取图片实际显示尺寸
    const containerRect = mapContainer.getBoundingClientRect();
    const imageRect = mapImage.getBoundingClientRect();
    
    // 计算网格大小（每个小方块的大小）
    const cellWidth = imageRect.width / GRID_SIZE;
    const cellHeight = imageRect.height / GRID_SIZE;
    
    // 计算图片在容器中的偏移（居中显示时的偏移）
    const offsetX = (containerRect.width - imageRect.width) / 2;
    const offsetY = (containerRect.height - imageRect.height) / 2;
    
    // 创建单一 canvas 绘制网格
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = containerRect.width;
    gridCanvas.height = containerRect.height;
    gridCanvas.style.position = 'absolute';
    gridCanvas.style.top = '0';
    gridCanvas.style.left = '0';
    gridCanvas.style.pointerEvents = 'auto';
    
    const ctx = gridCanvas.getContext('2d');
    
    // 绘制稀疏网格线（每10个格子画一条线，避免性能问题）
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.1)';
    ctx.lineWidth = 0.5;
    const gridStep = 10; // 每10个格子画一条线
    
    // 垂直线（稀疏）
    for (let col = 0; col <= GRID_SIZE; col += gridStep) {
        const x = offsetX + col * cellWidth;
        ctx.beginPath();
        ctx.moveTo(x, offsetY);
        ctx.lineTo(x, offsetY + imageRect.height);
        ctx.stroke();
    }
    
    // 水平线（稀疏）
    for (let row = 0; row <= GRID_SIZE; row += gridStep) {
        const y = offsetY + row * cellHeight;
        ctx.beginPath();
        ctx.moveTo(offsetX, y);
        ctx.lineTo(offsetX + imageRect.width, y);
        ctx.stroke();
    }
    
    // 绘制已有标注（绿色半透明块）
    ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
    Object.keys(annotationData).forEach(key => {
        const [row, col] = key.split('_').map(Number);
        if (Number.isNaN(row) || Number.isNaN(col)) return;
        const x = offsetX + col * cellWidth;
        const y = offsetY + row * cellHeight;
        ctx.fillRect(x, y, cellWidth, cellHeight);
    });
    
    // 点击命中测试
    gridCanvas.addEventListener('click', (e) => {
        const rect = gridCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // 限制在图片区域内
        if (x < offsetX || x > offsetX + imageRect.width || y < offsetY || y > offsetY + imageRect.height) {
            return;
        }
        
        const col = Math.floor((x - offsetX) / cellWidth);
        const row = Math.floor((y - offsetY) / cellHeight);
        showAnnotationInput(row, col);
    });
    
    overlay.appendChild(gridCanvas);
}

// 显示标注输入框
function showAnnotationInput(row, col) {
    const key = `${row}_${col}`;
    const currentValue = annotationData[key] || '';
    
    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'annotation-input-modal';
    modal.innerHTML = `
        <h3>标注位置 (${row}, ${col})</h3>
        <input type="text" id="annotation-input" placeholder="输入房号（如：1A01）或楼栋名（如：1A）" value="${currentValue}">
        <div class="btn-group">
            <button class="btn-cancel">取消</button>
            <button class="btn-save">保存</button>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const input = modal.querySelector('#annotation-input');
    input.focus();
    input.select();
    
    // 保存按钮
    modal.querySelector('.btn-save').addEventListener('click', async () => {
        const value = input.value.trim();
        if (value) {
            annotationData[key] = value;
            await saveAnnotationData();
            modal.remove();
            // 重新绘制网格以展示标注状态
            renderAnnotationGrid();
            showToast(`已保存标注: ${value}`, 'success');
        } else {
            // 如果输入为空，删除标注
            if (annotationData[key]) {
                delete annotationData[key];
                await saveAnnotationData();
                modal.remove();
                renderAnnotationGrid();
                showToast('已删除标注', 'success');
            } else {
                modal.remove();
            }
        }
    });
    
    // 取消按钮
    modal.querySelector('.btn-cancel').addEventListener('click', () => {
        modal.remove();
    });
    
    // 按Enter保存
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            modal.querySelector('.btn-save').click();
        }
    });
    
    // 点击外部关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// 保存标注数据到数据库
async function saveAnnotationData() {
    try {
        // 批量保存所有标注
        const response = await fetch(`${API_BASE}/annotations/batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ annotations: annotationData })
        });
        
        if (!response.ok) {
            throw new Error('保存失败');
        }
        
        const result = await response.json();
        console.log('标注已保存到数据库:', result);
    } catch (error) {
        console.error('保存标注数据失败:', error);
        // 如果API失败，回退到localStorage
        localStorage.setItem('mapAnnotations', JSON.stringify(annotationData));
        showToast('保存失败，已保存到本地缓存', 'error');
    }
}

// 从数据库加载标注数据
async function loadAnnotationData() {
    try {
        const response = await fetch(`${API_BASE}/annotations`);
        if (response.ok) {
            annotationData = await response.json();
            console.log('从数据库加载标注数据:', Object.keys(annotationData).length, '条');
        } else {
            throw new Error('加载失败');
        }
    } catch (error) {
        console.error('从数据库加载标注数据失败:', error);
        // 如果API失败，尝试从localStorage加载（兼容旧数据）
        const saved = localStorage.getItem('mapAnnotations');
        if (saved) {
            try {
                annotationData = JSON.parse(saved);
                console.log('从本地缓存加载标注数据:', Object.keys(annotationData).length, '条');
                // 如果localStorage有数据，尝试迁移到数据库
                if (Object.keys(annotationData).length > 0) {
                    await saveAnnotationData();
                }
            } catch (e) {
                console.error('加载本地缓存失败:', e);
                annotationData = {};
            }
        } else {
            annotationData = {};
        }
    }
}

// 渲染售出状态圆点（根据标注数据）
async function renderSoldStatusDots() {
    const mapCanvas = document.getElementById('map-canvas');
    const mapImage = document.getElementById('map-image');
    const mapContainer = document.querySelector('.map-container');
    
    if (!mapCanvas || !mapImage || !mapContainer) return;
    
    const ctx = mapCanvas.getContext('2d');
    const containerRect = mapContainer.getBoundingClientRect();
    const imageRect = mapImage.getBoundingClientRect();
    
    // 确保canvas尺寸正确
    if (mapCanvas.width !== containerRect.width || mapCanvas.height !== containerRect.height) {
        mapCanvas.width = containerRect.width;
        mapCanvas.height = containerRect.height;
    }
    
    // 清空canvas
    ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    
    console.log('Canvas尺寸:', mapCanvas.width, 'x', mapCanvas.height);
    
    // 获取所有房源数据
    try {
        const response = await fetch(`${API_BASE}/houses/all`);
        const houses = await response.json();
        
        // 计算图片偏移
        const offsetX = (containerRect.width - imageRect.width) / 2;
        const offsetY = (containerRect.height - imageRect.height) / 2;
        const cellWidth = imageRect.width / GRID_SIZE;
        const cellHeight = imageRect.height / GRID_SIZE;
        
        // 处理标注数据，找到房号对应的位置
        const roomPositions = {}; // { "1A01": {row, col, building} }
        const buildingPositions = {}; // { "1A": [{row, col}] }
        
        // 遍历所有标注
        Object.keys(annotationData).forEach(key => {
            const value = annotationData[key];
            const [row, col] = key.split('_').map(Number);
            
            // 判断是房号还是楼栋名
            if (/^\d+[A-Z]\d+$/.test(value)) {
                // 房号格式：1A01
                roomPositions[value] = { row, col };
            } else if (/^\d+[A-Z]$/.test(value)) {
                // 楼栋名格式：1A
                if (!buildingPositions[value]) {
                    buildingPositions[value] = [];
                }
                buildingPositions[value].push({ row, col });
            }
        });
        
        // 为每个房号找到最近的楼栋位置
        Object.keys(roomPositions).forEach(roomNumber => {
            const roomPos = roomPositions[roomNumber];
            const buildingName = roomNumber.match(/^(\d+[A-Z])/)?.[1];
            
            if (buildingName && buildingPositions[buildingName]) {
                // 找到最近的楼栋位置
                let minDist = Infinity;
                let nearestBuildingPos = null;
                
                buildingPositions[buildingName].forEach(buildingPos => {
                    const dist = Math.sqrt(
                        Math.pow(roomPos.row - buildingPos.row, 2) + 
                        Math.pow(roomPos.col - buildingPos.col, 2)
                    );
                    if (dist < minDist) {
                        minDist = dist;
                        nearestBuildingPos = buildingPos;
                    }
                });
                
                if (nearestBuildingPos) {
                    roomPos.buildingRow = nearestBuildingPos.row;
                    roomPos.buildingCol = nearestBuildingPos.col;
                }
            }
        });
        
        // 统计每个房号的售出数量
        const soldCounts = {};
        houses.forEach(house => {
            const roomKey = `${house.楼栋名}${house.房号}`;
            if (!soldCounts[roomKey]) {
                soldCounts[roomKey] = { total: 0, sold: 0 };
            }
            soldCounts[roomKey].total++;
            if (house.售出情况 === '已售出') {
                soldCounts[roomKey].sold++;
            }
        });
        
        // 绘制楼栋位置圆点（淡红色）
        const buildingGroups = {}; // { "1A": [{row, col, value}] }
        console.log('标注数据总数:', Object.keys(annotationData).length);
        
        Object.keys(annotationData).forEach(key => {
            const value = annotationData[key].toUpperCase();
            const [row, col] = key.split('_').map(Number);
            
            // 提取楼栋名（如 1A01 -> 1A, 2A02 -> 2A）
            const buildingMatch = value.match(/^(\d+[A-Z])/);
            if (buildingMatch) {
                const buildingName = buildingMatch[1];
                if (!buildingGroups[buildingName]) {
                    buildingGroups[buildingName] = [];
                }
                buildingGroups[buildingName].push({ row, col, value });
            }
        });
        
        console.log('楼栋分组:', buildingGroups);
        console.log('图片尺寸:', imageRect.width, 'x', imageRect.height);
        console.log('容器尺寸:', containerRect.width, 'x', containerRect.height);
        console.log('偏移量:', offsetX, offsetY);
        console.log('单元格尺寸:', cellWidth, 'x', cellHeight);
        
        // 为每个楼栋计算中心位置并绘制淡红色圆点
        const targetBuildings = ['1A', '2A', '2D']; // 用户指定的三栋
        targetBuildings.forEach(buildingName => {
            const positions = buildingGroups[buildingName];
            if (positions && positions.length > 0) {
                // 计算中心位置（所有房号位置的平均值）
                const avgRow = positions.reduce((sum, p) => sum + p.row, 0) / positions.length;
                const avgCol = positions.reduce((sum, p) => sum + p.col, 0) / positions.length;
                
                // 绘制淡红色圆点
                const x = offsetX + avgCol * cellWidth;
                const y = offsetY + avgRow * cellHeight;
                
                console.log(`楼栋 ${buildingName}: 中心位置 (${avgRow}, ${avgCol}), 绘制位置 (${x}, ${y}), 房号数量: ${positions.length}`);
                
                // 验证坐标是否在canvas范围内
                if (x < 0 || x > mapCanvas.width || y < 0 || y > mapCanvas.height) {
                    console.warn(`楼栋 ${buildingName} 的坐标超出canvas范围: (${x}, ${y})`);
                }
                
                // 绘制圆点（更明显的红色）
                ctx.fillStyle = '#ff0000'; // 纯红色，不透明
                ctx.beginPath();
                ctx.arc(x, y, 15, 0, Math.PI * 2); // 半径15px，更大更明显
                ctx.fill();
                
                // 添加白色边框
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 3;
                ctx.stroke();
                
                // 添加楼栋名标签（白色背景，红色文字）
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(x - 20, y - 35, 40, 20);
                ctx.fillStyle = '#ff0000';
                ctx.font = 'bold 16px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(buildingName, x, y - 25);
                
                console.log(`已绘制楼栋 ${buildingName} 圆点`);
            } else {
                console.log(`楼栋 ${buildingName} 没有找到位置数据`);
            }
        });
        
        // 绘制所有标注的房号位置点（小圆点）
        Object.keys(annotationData).forEach(key => {
            const value = annotationData[key].toUpperCase();
            const [row, col] = key.split('_').map(Number);
            
            // 只绘制房号格式的标注（如 1A01, 2A02）
            if (/^\d+[A-Z]\d+$/.test(value)) {
                const x = offsetX + col * cellWidth;
                const y = offsetY + row * cellHeight;
                
                // 绘制小圆点（蓝色，表示房号位置）
                ctx.fillStyle = 'rgba(24, 144, 255, 0.7)'; // 蓝色半透明
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2); // 半径5px
                ctx.fill();
                
                // 添加白色边框
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        });
        
        // 绘制房号售出状态圆点（原有逻辑，如果有售出数据）
        Object.keys(roomPositions).forEach(roomNumber => {
            const pos = roomPositions[roomNumber];
            const soldInfo = soldCounts[roomNumber];
            
            if (soldInfo) {
                const soldCount = soldInfo.sold;
                let color = '#52c41a'; // 绿色
                if (soldCount >= 20) {
                    color = '#ff4d4f'; // 红色
                } else if (soldCount >= 8) {
                    color = '#faad14'; // 黄色
                }
                
                // 计算圆点位置（根据楼栋和房号位置确定左右下）
                const x = offsetX + pos.col * cellWidth;
                const y = offsetY + pos.row * cellHeight;
                
                // 这里需要根据楼栋规则确定圆点位置
                // 暂时在房号位置右侧显示
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(x + cellWidth, y + cellHeight / 2, 6, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        
    } catch (error) {
        console.error('渲染售出状态圆点失败:', error);
    }
}

// 处理地图点击
async function handleMapClick(x, y) {
    // 这里需要根据实际图片坐标映射到楼栋
    // 暂时使用一个简单的映射逻辑
    // 实际应该根据图片中楼栋的实际位置来设置坐标范围
    
    // 获取所有楼栋
    const buildings = await fetch(`${API_BASE}/buildings`).then(r => r.json());
    
    // 简单的示例：根据点击位置选择楼栋（需要根据实际图片调整）
    // 这里假设点击图片的某个区域对应某个楼栋
    // 实际应该根据图片中楼栋的实际坐标来映射
    
    // 暂时显示第一个楼栋作为示例
    if (buildings.data && buildings.data.length > 0) {
        // 可以根据x,y坐标判断点击的是哪个楼栋
        // 这里简化处理，实际需要根据图片坐标映射
        showBuildingModal(buildings.data[0]);
    }
}

// 加载楼栋列表
async function loadBuildings() {
    try {
        const response = await fetch(`${API_BASE}/buildings`);
        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('加载楼栋失败:', error);
        return [];
    }
}

// 显示楼栋弹窗
async function showBuildingModal(buildingName) {
    const modal = document.getElementById('building-modal');
    const modalTitle = document.getElementById('modal-building-name');
    const modalList = document.getElementById('modal-houses-list');
    
    modalTitle.textContent = buildingName;
    modalList.innerHTML = '<div class="loading">加载中...</div>';
    modal.style.display = 'block';
    
    try {
        const response = await fetch(`${API_BASE}/houses/building/${encodeURIComponent(buildingName)}`);
        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
            modalList.innerHTML = data.data.map(house => `
                <div class="modal-house-card">
                    <h4>${house.楼栋名} ${house.房号}号</h4>
                    <div class="house-info">
                        <div class="house-info-item">
                            <span class="house-info-label">户型:</span>
                            <span class="house-info-value">${house.户型 || '-'}</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">面积:</span>
                            <span class="house-info-value">${house.房子面积 || '-'}㎡</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">类型:</span>
                            <span class="house-info-value">${house.房子类型 || '-'}</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">楼层:</span>
                            <span class="house-info-value">${house.房子楼层 || '-'}楼</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">价格:</span>
                            <span class="house-info-value">${house.价格 ? formatPrice(house.价格) : '已售出'}</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">朝向:</span>
                            <span class="house-info-value">${house.朝向 || '-'}</span>
                        </div>
                        <div class="house-info-item">
                            <span class="house-info-label">售出情况:</span>
                            <span class="house-info-value">${house.售出情况 || '-'}</span>
                        </div>
                    </div>
                </div>
            `).join('');
        } else {
            modalList.innerHTML = '<div class="empty-state">暂无房源数据</div>';
        }
    } catch (error) {
        console.error('加载楼栋房源失败:', error);
        modalList.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
}

// 初始化弹窗
function initModal() {
    const modal = document.getElementById('building-modal');
    const closeBtn = document.querySelector('.modal-close');
    
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}

// 初始化筛选器
function initFilters() {
    // 搜索按钮
    document.getElementById('btn-search').addEventListener('click', () => {
        currentPage = 1;
        loadHouses();
    });
    
    // 计算分数按钮
    document.getElementById('btn-calculate-score').addEventListener('click', async () => {
        await calculateScores();
    });
    
    // 初始化分数筛选器
    initScoreFilter();
}

// 更新分数筛选器状态（全局函数）
function updateScoreFilterState() {
    const scoreFilter = document.getElementById('filter-score-sort');
    if (!scoreFilter) return;
    
    // 检查是否已设置期望值
    const saved = localStorage.getItem('houseWeights');
    let hasWeights = false;
    if (saved) {
        const savedWeights = JSON.parse(saved);
        // 检查是否有权重大于0（0表示无所谓）
        hasWeights = Object.values(savedWeights).some(w => w > 0);
    }
    // 检查是否有价格期望值
    const savedPrice = localStorage.getItem('houseExpectedPrice');
    const hasPriceExpectation = savedPrice && parseFloat(savedPrice) > 0;
    
    // 同时检查当前weights变量（可能刚保存但还没写入localStorage）
    const currentHasWeights = Object.values(weights).some(w => w > 0);
    const currentHasPrice = expectedPrice && expectedPrice > 0;
    
    if (hasWeights || hasPriceExpectation || currentHasWeights || currentHasPrice) {
        scoreFilter.disabled = false;
        scoreFilter.classList.remove('disabled');
        scoreFilter.title = '';
    } else {
        scoreFilter.disabled = true;
        scoreFilter.classList.add('disabled');
        scoreFilter.value = '';
        scoreFilter.title = '请先设置期望值权重';
    }
}

// 初始化分数筛选器
function initScoreFilter() {
    const scoreFilter = document.getElementById('filter-score-sort');
    if (!scoreFilter) return;
    
    // 初始状态
    updateScoreFilterState();
    
    // 监听权重保存事件（通过监听期望值页面的保存按钮）
    const saveBtn = document.getElementById('btn-save-weights');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            setTimeout(updateScoreFilterState, 200); // 延迟更新，确保localStorage已保存
        });
    }
    
        // 分数筛选器变化事件
    scoreFilter.addEventListener('change', async () => {
        if (scoreFilter.disabled) {
            return;
        }
        
        const sortValue = scoreFilter.value;
        if (sortValue) {
            // 先计算所有房源的分数
            await calculateScores();
            
            // 根据选择排序（对所有房源排序）
            if (sortValue === 'desc') {
                housesData.sort((a, b) => {
                    const scoreA = a.score || 0;
                    const scoreB = b.score || 0;
                    if (scoreB !== scoreA) {
                        return scoreB - scoreA;
                    }
                    // 分数相同，按价格从低到高
                    const priceA = a.价格 || Infinity;
                    const priceB = b.价格 || Infinity;
                    if (priceA !== priceB) {
                        return priceA - priceB;
                    }
                    // 价格相同，按楼层从高到低
                    const floorA = a.房子楼层 || 0;
                    const floorB = b.房子楼层 || 0;
                    return floorB - floorA;
                });
            } else if (sortValue === 'asc') {
                housesData.sort((a, b) => {
                    const scoreA = a.score || 0;
                    const scoreB = b.score || 0;
                    if (scoreA !== scoreB) {
                        return scoreA - scoreB;
                    }
                    // 分数相同，按价格从低到高
                    const priceA = a.价格 || Infinity;
                    const priceB = b.价格 || Infinity;
                    if (priceA !== priceB) {
                        return priceA - priceB;
                    }
                    // 价格相同，按楼层从高到低
                    const floorA = a.房子楼层 || 0;
                    const floorB = b.房子楼层 || 0;
                    return floorB - floorA;
                });
            }
            
            // 重新加载当前页数据（应用筛选和分页）
            currentPage = 1;
            loadHouses();
        } else {
            // 如果不排序，重新加载数据（按数据库id排序）
            currentPage = 1;
            loadHouses();
        }
    });
    
    // 去掉提示逻辑，不再显示引导弹窗
}

// 加载筛选器选项
async function loadFilterOptions() {
    try {
        const response = await fetch(`${API_BASE}/filters/options`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        filterOptions = await response.json();
        
        // 填充筛选器选项
        populateSelect('filter-building', filterOptions.楼栋);
        populateSelect('filter-room-type', filterOptions.房型);
        populateSelect('filter-area', filterOptions.房子面积);
        populateCustomMultiselect('filter-orientation', filterOptions.房子朝向);
        populateSelect('filter-floor', filterOptions.房子楼层);
        populateSelect('filter-sold-status', filterOptions.售出情况);
        
    } catch (error) {
        console.error('加载筛选选项失败:', error);
    }
}

// 自定义多选组件数据
let customMultiselectData = {
    'filter-orientation': {
        selected: [],
        options: []
    }
};

// 初始化自定义多选组件
function populateCustomMultiselect(wrapperId, options) {
    const wrapper = document.getElementById(`${wrapperId}-wrapper`);
    const display = document.getElementById(`${wrapperId}-display`);
    const dropdown = document.getElementById(`${wrapperId}-dropdown`);
    const optionsContainer = document.getElementById(`${wrapperId}-options`);
    
    if (!wrapper || !display || !dropdown || !optionsContainer) return;
    
    // 保存选项数据
    customMultiselectData[wrapperId] = {
        selected: [],
        options: options || []
    };
    
    // 清空选项容器
    optionsContainer.innerHTML = '';
    
    // 创建选项
    options.forEach(option => {
        const optionEl = document.createElement('div');
        optionEl.className = 'multiselect-option';
        optionEl.dataset.value = option;
        optionEl.textContent = option;
        optionEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCustomMultiselectOption(wrapperId, option);
        });
        optionsContainer.appendChild(optionEl);
    });
    
    // 点击显示区域，切换下拉框
    display.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        dropdown.style.display = isOpen ? 'none' : 'block';
    });
    
    // 点击外部关闭下拉框
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
    
    // 更新显示
    updateCustomMultiselectDisplay(wrapperId);
}

function toggleCustomMultiselectOption(wrapperId, value) {
    const data = customMultiselectData[wrapperId];
    if (!data) return;
    
    const index = data.selected.indexOf(value);
    if (index > -1) {
        // 取消选择
        data.selected.splice(index, 1);
    } else {
        // 选择
        data.selected.push(value);
    }
    
    updateCustomMultiselectDisplay(wrapperId);
    updateCustomMultiselectOptions(wrapperId);
}

function updateCustomMultiselectDisplay(wrapperId) {
    const display = document.getElementById(`${wrapperId}-display`);
    const data = customMultiselectData[wrapperId];
    
    if (!display || !data) return;
    
    // 清空显示区域
    display.innerHTML = '';
    
    if (data.selected.length === 0) {
        // 显示占位符
        const placeholder = document.createElement('span');
        placeholder.className = 'placeholder';
        placeholder.textContent = '请选择朝向';
        display.appendChild(placeholder);
    } else {
        // 显示选中的标签
        data.selected.forEach(value => {
            const tag = document.createElement('span');
            tag.className = 'selected-tag';
            tag.innerHTML = `
                ${value}
                <span class="remove" data-value="${value}">×</span>
            `;
            
            // 添加删除按钮事件
            const removeBtn = tag.querySelector('.remove');
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleCustomMultiselectOption(wrapperId, value);
            });
            
            display.appendChild(tag);
        });
    }
    
    // 添加下拉箭头（使用CSS伪元素，这里不需要）
}

function updateCustomMultiselectOptions(wrapperId) {
    const optionsContainer = document.getElementById(`${wrapperId}-options`);
    const data = customMultiselectData[wrapperId];
    
    if (!optionsContainer || !data) return;
    
    // 更新选项的选中状态
    const options = optionsContainer.querySelectorAll('.multiselect-option');
    options.forEach(optionEl => {
        const value = optionEl.dataset.value;
        if (data.selected.includes(value)) {
            optionEl.classList.add('selected');
        } else {
            optionEl.classList.remove('selected');
        }
    });
}

function getCustomMultiselectValues(wrapperId) {
    const data = customMultiselectData[wrapperId];
    return data ? data.selected.filter(v => v && v !== '') : [];
}

// 填充下拉框
function populateSelect(selectId, options) {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    // 如果是多选下拉框（朝向），不添加"全部"选项
    const isMultiple = select.multiple;
    
    // 清空现有选项（除了"全部"选项，如果是单选）
    if (!isMultiple) {
        // 保留"全部"选项
        const existingOptions = Array.from(select.options).map(opt => opt.value);
    options.forEach(option => {
            if (!existingOptions.includes(option)) {
                const optionEl = document.createElement('option');
                optionEl.value = option;
                optionEl.textContent = option;
                select.appendChild(optionEl);
            }
        });
    } else {
        // 多选下拉框，清空所有选项后添加
        select.innerHTML = '';
        options.forEach(option => {
        const optionEl = document.createElement('option');
        optionEl.value = option;
        optionEl.textContent = option;
        select.appendChild(optionEl);
    });
    }
}

// 加载房源列表
async function loadHouses() {
    const listContainer = document.getElementById('houses-list');
    listContainer.innerHTML = '<div class="loading">加载中...</div>';
    
    // 获取筛选条件
    const filters = {
        '楼栋': document.getElementById('filter-building').value,
        '房型': document.getElementById('filter-room-type').value,
        '房子面积': document.getElementById('filter-area').value,
        '房子朝向': getCustomMultiselectValues('filter-orientation').join(','),  // 多选，用逗号分隔
        '房子楼层': document.getElementById('filter-floor').value,
        '售出情况': document.getElementById('filter-sold-status').value,
        '价格最低': document.getElementById('filter-price-min').value ? 
            (parseFloat(document.getElementById('filter-price-min').value) * 10000).toString() : '',
        '价格最高': document.getElementById('filter-price-max').value ? 
            (parseFloat(document.getElementById('filter-price-max').value) * 10000).toString() : '',
    };
    
    // 构建查询参数
    const params = new URLSearchParams();
    Object.keys(filters).forEach(key => {
        if (filters[key]) {
            params.append(key, filters[key]);
        }
    });
    params.append('page', currentPage);
    params.append('per_page', 20);
    
    try {
        const response = await fetch(`${API_BASE}/houses?${params.toString()}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        housesData = data.data || [];
        
        // 如果housesData中有分数属性（已计算过），直接使用，不重新计算
        // 分数排序在分数筛选器change事件中处理
        
        if (housesData.length > 0) {
            renderHousesList(housesData);
            renderPagination(data);
        } else {
            listContainer.innerHTML = '<div class="empty-state">暂无房源数据</div>';
            renderPagination(data);  // 即使无数据也要显示分页信息
        }
    } catch (error) {
        console.error('加载房源失败:', error);
        listContainer.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
}

// 渲染房源列表
function renderHousesList(houses) {
    const listContainer = document.getElementById('houses-list');
    
    listContainer.innerHTML = houses.map(house => {
        const score = house.score ? `<div class="house-score">综合分数: ${house.score.toFixed(2)}</div>` : '';
        
        return `
            <div class="house-card">
                <h3>${house.楼栋名} ${house.房号}号</h3>
                <div class="house-info">
                    <div class="house-info-item">
                        <span class="house-info-label">户型:</span>
                        <span class="house-info-value">${house.户型 || '-'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">面积:</span>
                        <span class="house-info-value">${house.房子面积 || '-'}㎡</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">类型:</span>
                        <span class="house-info-value">${house.房子类型 || '-'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">楼层:</span>
                        <span class="house-info-value">${house.房子楼层 || '-'}楼</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">价格:</span>
                        <span class="house-info-value">${house.价格 ? formatPrice(house.价格) : '已售出'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">朝向:</span>
                        <span class="house-info-value">${house.朝向 || '-'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">售出情况:</span>
                        <span class="house-info-value">${house.售出情况 || '-'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">噪音:</span>
                        <span class="house-info-value">${house.噪音 !== null && house.噪音 !== undefined ? house.噪音 : '-'}</span>
                    </div>
                    <div class="house-info-item">
                        <span class="house-info-label">景观:</span>
                        <span class="house-info-value">${house.景观 !== null && house.景观 !== undefined ? house.景观 : '-'}</span>
                    </div>
                </div>
                ${score}
            </div>
        `;
    }).join('');
}

// 渲染分页
function renderPagination(data) {
    const pagination = document.getElementById('pagination');
    const total = data.total || 0;
    const totalPages = data.total_pages || 1;
    
    // 修复：即使没有数据也要显示分页信息
    let html = '';
    
    // 上一页
    html += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">上一页</button>`;
    
    // 页码（修复：无结果时显示第1/1页，共0条）
    html += `<span class="page-info">第 ${currentPage} / ${totalPages} 页 (共 ${total} 条)</span>`;
    
    // 下一页
    html += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">下一页</button>`;
    
    pagination.innerHTML = html;
}

// 跳转页面（全局函数，供HTML调用）
window.goToPage = function(page) {
    currentPage = page;
    loadHouses();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// 计算分数（从后端获取所有房源，不自动排序）
async function calculateScores() {
    try {
        // 从后端获取所有房源（不分页）
        const response = await fetch(`${API_BASE}/houses/all`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const allHouses = await response.json();
        
        if (!allHouses || allHouses.length === 0) {
            alert('暂无房源数据');
        return;
    }
    
        // 计算所有房源的平均分（用于"无所谓"的情况）
        const averages = calculateAverages(allHouses);
        
        // 计算每个房源的分数（不排序，只添加分数属性）
        allHouses.forEach(house => {
            const dimensionScores = {
                orientation: calculateOrientationScore(house, averages.orientation),
                price: calculatePriceScore(house, averages.price),
                noise: calculateNoiseScore(house, averages.noise),
                view: calculateViewScore(house, averages.view),
                floor: calculateFloorScore(house, averages.floor),
                roomType: calculateRoomTypeScore(house, averages.roomType),
                building: calculateBuildingScore(house, averages.building)  // 新增楼栋分数
            };
            
            // 计算基础分：加权平均
            let totalWeight = 0;
            let weightedSum = 0;
            
            Object.keys(dimensionScores).forEach(key => {
                const weight = weights[key] || 0;
                if (weight > 0) {
                    totalWeight += weight;
                    weightedSum += dimensionScores[key] * weight;
                }
            });
            
            // 如果所有维度都是"无所谓"（总权重为0），使用平均分
            let baseScore = 0;
            if (totalWeight > 0) {
                baseScore = weightedSum / totalWeight;
            } else {
                // 所有维度都无所谓，使用所有维度的平均分
                const allAvg = Object.values(averages).reduce((sum, val) => sum + val, 0) / Object.keys(averages).length;
                baseScore = allAvg;
            }
            
            // 步骤4：楼栋修正（核心差异化增强）
            const buildingCorrection = getBuildingCorrection(house.楼栋名 || '');
            const correctedBaseScore = baseScore * buildingCorrection;
            
            // 步骤5：最终分数映射（保留原有区间）
            let finalScore = 60 + (correctedBaseScore / 100) * 38;
            // 限制在60-98分区间
            finalScore = Math.max(60, Math.min(98, finalScore));
            house.score = Math.round(finalScore * 100) / 100; // 保留两位小数
        });
        
        // 将计算后的所有房源数据保存到全局变量
        housesData = allHouses;
        
        // 不自动排序，保持当前列表顺序（按数据库id排序）
        // 只有选择分数排序时才排序
    renderHousesList(housesData);
        
        // 显示toast提示
        showToast('分数计算完成');
    } catch (error) {
        console.error('计算分数失败:', error);
        alert('计算分数失败，请重试');
    }
}

// 显示Toast提示（通用函数）
function showToast(message, type = 'success') {
    const existingToast = document.getElementById('toast-message');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.id = 'toast-message';
    toast.className = 'toast-message';
    const icon = type === 'success' ? '✓' : '✗';
    const iconColor = type === 'success' ? '#52c41a' : '#ff4d4f';
    toast.innerHTML = `
        <span style="color: ${iconColor}; margin-right: 8px;">${icon}</span>
        <span>${message}</span>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

// 计算所有房源的平均分
function calculateAverages(houses) {
    const validHouses = houses.filter(h => h.价格 && h.房子面积);
    
    let orientationSum = 0, orientationCount = 0;
    let priceSum = 0, priceCount = 0;
    let noiseSum = 0, noiseCount = 0;
    let viewSum = 0, viewCount = 0;
    let floorSum = 0, floorCount = 0;
    let roomTypeSum = 0, roomTypeCount = 0;
    let buildingSum = 0, buildingCount = 0;  // 新增楼栋平均分
    
    validHouses.forEach(house => {
        // 朝向平均分
        const orientationScore = calculateOrientationScore(house, 0, false);
        if (orientationScore > 0) {
            orientationSum += orientationScore;
            orientationCount++;
        }
        
        // 价格平均分（如果有期望值，按期望值计算；否则按实际价格计算）
        const priceScore = calculatePriceScore(house, 0, false);
        if (priceScore > 0) {
            priceSum += priceScore;
            priceCount++;
        }
        
        // 噪音平均分
        const noiseScore = calculateNoiseScore(house, 0, false);
        if (noiseScore > 0) {
            noiseSum += noiseScore;
            noiseCount++;
        }
        
        // 景观平均分
        const viewScore = calculateViewScore(house, 0, false);
        if (viewScore > 0) {
            viewSum += viewScore;
            viewCount++;
        }
        
        // 楼层平均分
        const floorScore = calculateFloorScore(house, 0, false);
        if (floorScore > 0) {
            floorSum += floorScore;
            floorCount++;
        }
        
        // 房型平均分
        const roomTypeScore = calculateRoomTypeScore(house, 0, false);
        if (roomTypeScore > 0) {
            roomTypeSum += roomTypeScore;
            roomTypeCount++;
        }
        
        // 楼栋平均分（新增）
        const buildingScore = calculateBuildingScore(house, 0, false);
        if (buildingScore > 0) {
            buildingSum += buildingScore;
            buildingCount++;
        }
    });
    
    return {
        orientation: orientationCount > 0 ? orientationSum / orientationCount : 50,
        price: priceCount > 0 ? priceSum / priceCount : 50,
        noise: noiseCount > 0 ? noiseSum / noiseCount : 50,
        view: viewCount > 0 ? viewSum / viewCount : 50,
        floor: floorCount > 0 ? floorSum / floorCount : 50,
        roomType: roomTypeCount > 0 ? roomTypeSum / roomTypeCount : 50,
        building: buildingCount > 0 ? buildingSum / buildingCount : 50  // 新增楼栋平均分
    };
}

// 计算朝向分数（使用梯度表）
function calculateOrientationScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.orientation === 0 && useAverage) {
        return averageScore;
    }
    
    const orientation = house.朝向 || '';
    
    // 使用梯度表计算分数
    const gradient = gradientConfig.orientation || { 1: [], 2: [], 3: [] };
    
    // 创建朝向映射表（数据库中的值 -> 标准值）
    const orientationMap = {
        '东南向': '东南向', '东南': '东南向',
        '西南向': '西南向', '西南': '西南向', '西偏南': '西南向',
        '西北向': '西北向', '西北': '西北向',
        '东北向': '东北向', '东北': '东北向',
        '南向': '南向', '南': '南向',
        '北向': '北向', '北': '北向',
        '东向': '东向', '东': '东向',
        '西向': '西向', '西': '西向'
    };
    
    // 找到标准朝向值
    let standardOrientation = null;
    for (const [key, mapped] of Object.entries(orientationMap)) {
        if (orientation.includes(key) || key.includes(orientation)) {
            standardOrientation = mapped;
            break;
        }
    }
    if (!standardOrientation) {
        standardOrientation = orientation;
    }
    
    // 查找在哪个梯度
    if (gradient[1] && gradient[1].includes(standardOrientation)) {
        return 100;  // 满意
    } else if (gradient[2] && gradient[2].includes(standardOrientation)) {
        return 60;  // 比较满意
    } else if (gradient[3] && gradient[3].includes(standardOrientation)) {
        return 20;  // 一般
    }
    
    // 如果没匹配到，返回一般分数
    return 20;
}

// 计算价格分数
function calculatePriceScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.price === 0 && useAverage) {
        return averageScore;
    }
    
    // 如果没有设置期望价格，使用平均分
    if (!expectedPrice || expectedPrice <= 0) {
        return useAverage ? averageScore : 50;
    }
    
    if (!house.价格) {
        return 0;
    }
    
    // 计算总价差异百分比
    const diffPercent = ((house.价格 - expectedPrice) / expectedPrice) * 100;
    
    // 优化后：细化分数梯度，增强价格差异感知
    if (diffPercent <= -10) {
        // 低于期望值≥10%
        return 100;
    } else if (diffPercent > -10 && diffPercent <= -5) {
        // 低于期望值5%-10%
        return 90;
    } else if (diffPercent > -5 && diffPercent <= 5) {
        // 等于期望值（±5%内）
        return 75;
    } else if (diffPercent > 5 && diffPercent <= 10) {
        // 高于期望值5%-10%
        return 50;
    } else if (diffPercent > 10 && diffPercent <= 20) {
        // 高于期望值10%-20%
        return 30;
    } else {
        // 高于期望值>20%
        return 10;
    }
}

// 计算噪音分数
function calculateNoiseScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.noise === 0 && useAverage) {
        return averageScore;
    }
    
    const noise = house.噪音;
    // 优化后：拉大分数差，增强噪音维度权重
    if (noise === '好') return 100;
    if (noise === '中') return 50;  // 原60，调整为50
    if (noise === '差') return 10;  // 原30，调整为10
    
    return 0;
}

// 计算景观分数（使用梯度表）
function calculateViewScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.view === 0 && useAverage) {
        return averageScore;
    }
    
    const view = house.景观 || '';
    const roomNumber = `${house.楼栋名 || ''}${house.房号 || ''}`;
    
    // 使用梯度表计算分数
    const gradient = gradientConfig.view || { 1: [], 2: [], 3: [] };
    const viewRooms = gradientConfig.viewRooms || [];
    
    // 首先检查房号是否在第一梯队
    if (viewRooms.includes(roomNumber)) {
        return 100;  // 第一梯队最高分
    }
    
    // 查找景观类型在哪个梯度
    let matchedTier = null;
    for (let tier = 1; tier <= 3; tier++) {
        if (gradient[tier] && gradient[tier].some(v => view.includes(v) || v.includes(view))) {
            matchedTier = tier;
            break;
        }
    }
    
    if (matchedTier === 1) {
        // 第一梯队：同梯度下按海景>山景>楼景排序，但分差很小
        let baseScore = 100;
        if (view.includes('楼景')) {
            baseScore = 98;  // 楼景稍低
        } else if (view.includes('山景')) {
            baseScore = 99;  // 山景稍低
        } else if (view.includes('海景')) {
            baseScore = 100;  // 海景最高
        }
        return baseScore;
    } else if (matchedTier === 2) {
        // 第二梯队：比较满意，同梯度下按海景>山景>楼景排序，但分差很小
        let baseScore = 60;
        if (view.includes('楼景')) {
            baseScore = 58;
        } else if (view.includes('山景')) {
            baseScore = 59;
        } else if (view.includes('海景')) {
            baseScore = 60;
        }
        return baseScore;
    } else if (matchedTier === 3) {
        // 第三梯队：一般
        return 20;
    }
    
    // 如果没匹配到，返回一般分数
    return 20;
}

// 计算楼层高度分数
function calculateFloorScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.floor === 0 && useAverage) {
        return averageScore;
    }
    
    const floor = house.房子楼层;
    if (!floor || floor <= 0) {
        return 0;
    }
    
    // 如果设置了心理预期楼层，按距离递减
    if (preferredFloor && preferredFloor >= 1 && preferredFloor <= 38) {
        const distance = Math.abs(floor - preferredFloor);
        
        // 优化后：细化距离梯度，增强楼层差异
        if (distance === 0) {
            return 100;
        } else if (distance === 1) {
            return 95;
        } else if (distance === 2) {
            return 85;
        } else if (distance === 3) {
            return 70;
        } else if (distance === 4) {
            return 55;
        } else if (distance >= 5 && distance <= 10) {
            // 5层=40，10层=30
            return 40 - (distance - 5) * 2;
        } else {
            // 距离>10，最低20分
            return Math.max(20, 30 - (distance - 10) * 1);
        }
    }
    
    // 如果没有设置心理预期楼层，使用优化后的默认逻辑
    // 最优楼层区间 [15, 25]
    const [minOptimal, maxOptimal] = SCORE_CONFIG.optimalFloorRange;
    
    if (floor >= minOptimal && floor <= maxOptimal) {
        // 最优楼层区间 = 100分
        return 100;
    } else if ((floor >= 10 && floor < minOptimal) || (floor > maxOptimal && floor <= 30)) {
        // 10-14层或26-30层 = 80分
        return 80;
    } else if ((floor >= 5 && floor < 10) || (floor > 30 && floor <= 35)) {
        // 5-9层或31-35层 = 50分
        return 50;
    } else {
        // 1-4层或36-38层 = 20分
        return 20;
    }
}

// 计算房型分数
function calculateRoomTypeScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.roomType === 0 && useAverage) {
        return averageScore;
    }
    
    const roomType = house.房子类型 || '';
    const houseType = house.户型 || '';
    
    // 优化后：细化房型规则，支持自定义排序
    const order = sortConfig.roomType || [];
    
    // 如果用户自定义了排序，使用指数级梯度
    if (order.length > 0) {
        // 查找房型在排序中的位置
        let matchedIndex = -1;
        for (let i = 0; i < order.length; i++) {
            const key = order[i];
            if (roomType.includes(key) || houseType.includes(key) || 
                (key === '三房' && (roomType.includes('三房') || houseType.includes('90'))) ||
                (key === '两房' && (roomType.includes('两房') || houseType.includes('70')))) {
                matchedIndex = i;
                break;
            }
        }
        
        if (matchedIndex !== -1) {
            // 使用指数级梯度
            const score = 100 * Math.pow(SCORE_CONFIG.roomTypeDecay, matchedIndex);
            return Math.round(score * 100) / 100;
        }
    }
    
    // 默认映射表（如果没有自定义排序）
    const roomTypeMap = {
        '三房': 100,
        '两房': 80,
        '四房': 70,
        '一房': 50,
        '其他': 20
    };
    
    // 匹配房型
    if (roomType.includes('三房') || houseType.includes('90')) {
        return roomTypeMap['三房'];
    } else if (roomType.includes('两房') || houseType.includes('70')) {
        return roomTypeMap['两房'];
    } else if (roomType.includes('四房') || houseType.includes('四')) {
        return roomTypeMap['四房'];
    } else if (roomType.includes('一房') || houseType.includes('一')) {
        return roomTypeMap['一房'];
    }
    
    return roomTypeMap['其他'];
}

// 计算楼栋分数（新增）
function calculateBuildingScore(house, averageScore, useAverage = true) {
    // 如果权重为0（无所谓），使用平均分
    if (weights.building === 0 && useAverage) {
        return averageScore;
    }
    
    const buildingName = house.楼栋名 || '';
    
    // 使用用户自定义排序
    const order = sortConfig.building || [];
    
    // 如果用户自定义了排序，使用指数级梯度
    if (order.length > 0) {
        let matchedIndex = -1;
        for (let i = 0; i < order.length; i++) {
            const key = order[i];
            if (buildingName === key || buildingName.includes(key) || key.includes(buildingName)) {
                matchedIndex = i;
                break;
            }
        }
        
        if (matchedIndex !== -1) {
            // 使用指数级梯度
            const score = 100 * Math.pow(SCORE_CONFIG.buildingDecay, matchedIndex);
            return Math.round(score * 100) / 100;
        }
    }
    
    // 默认楼栋分数映射
    if (BUILDING_SCORE_MAP[buildingName]) {
        return BUILDING_SCORE_MAP[buildingName];
    }
    
    // 兜底：其他楼栋
    return BUILDING_SCORE_MAP['其他'];
}

// 获取楼栋修正系数
function getBuildingCorrection(buildingName) {
    if (BUILDING_CORRECTION_MAP[buildingName]) {
        return BUILDING_CORRECTION_MAP[buildingName];
    }
    return BUILDING_CORRECTION_MAP['其他'];
}

// 初始化期望值页面
function initExpectationPage() {
    // 加载保存的权重
    // 映射：weights对象的key -> HTML元素的ID
    const sliderMap = {
        'orientation': 'orientation',
        'price': 'price',
        'noise': 'noise',
        'view': 'view',
        'floor': 'floor',
        'roomType': 'room-type',  // weights使用roomType，HTML使用room-type
        'building': 'building'     // 如果HTML中没有，会被跳过
    };
    
    Object.keys(sliderMap).forEach(weightKey => {
        const htmlId = sliderMap[weightKey];
        const slider = document.getElementById(`weight-${htmlId}`);
        const valueDisplay = document.getElementById(`weight-${htmlId}-value`);
        
        // 检查元素是否存在
        if (!slider || !valueDisplay) {
            console.warn(`权重滑块或显示元素不存在: weight-${htmlId}`);
            return;
        }
        
        slider.value = weights[weightKey];
        valueDisplay.textContent = weights[weightKey];
        
        slider.addEventListener('input', (e) => {
            weights[weightKey] = parseInt(e.target.value);
            valueDisplay.textContent = weights[weightKey];
        });
    });
    
    // 加载排序配置和梯度配置
    loadSortConfig();
    loadGradientConfig();
    loadPreferredFloor();
    
    // 初始化朝向梯度表
    initGradientTable('orientation', [
        '东南向', '西南向', '西北向', '东北向', '南向', '北向', '东向', '西向'
    ]);
    
    // 初始化景观梯度表
    initGradientTable('view', [
        '海景', '山景', '楼景', '没有景观'
    ]);
    
    // 监听朝向权重变化，显示/隐藏梯度表
    const orientationWeight = document.getElementById('weight-orientation');
    if (orientationWeight) {
        orientationWeight.addEventListener('input', (e) => {
            const weight = parseInt(e.target.value);
            const container = document.getElementById('orientation-sort-container');
            if (container) {
                container.style.display = weight > 0 ? 'block' : 'none';
            }
        });
        // 初始状态
        const weight = parseInt(orientationWeight.value);
        const container = document.getElementById('orientation-sort-container');
        if (container) {
            container.style.display = weight > 0 ? 'block' : 'none';
        }
    }
    
    // 监听景观权重变化，显示/隐藏梯度表
    const viewWeight = document.getElementById('weight-view');
    if (viewWeight) {
        viewWeight.addEventListener('input', (e) => {
            const weight = parseInt(e.target.value);
            const container = document.getElementById('view-sort-container');
            if (container) {
                container.style.display = weight > 0 ? 'block' : 'none';
                // 当容器显示时，重新初始化添加房号功能
                if (weight > 0) {
                    setTimeout(() => {
                        initViewRoomAdd();
                    }, 100);
                }
            }
        });
        // 初始状态
        const weight = parseInt(viewWeight.value);
        const container = document.getElementById('view-sort-container');
        if (container) {
            container.style.display = weight > 0 ? 'block' : 'none';
            // 如果初始状态是显示的，初始化添加房号功能
            if (weight > 0) {
                setTimeout(() => {
                    initViewRoomAdd();
                }, 300);
            }
        }
    }
    
    // 监听楼层权重变化，显示/隐藏楼层选择
    const floorWeight = document.getElementById('weight-floor');
    if (floorWeight) {
        floorWeight.addEventListener('input', (e) => {
            const weight = parseInt(e.target.value);
            const container = document.getElementById('floor-preference-container');
            if (container) {
                container.style.display = weight > 0 ? 'flex' : 'none';
            }
        });
        // 初始状态
        const weight = parseInt(floorWeight.value);
        const container = document.getElementById('floor-preference-container');
        if (container) {
            container.style.display = weight > 0 ? 'flex' : 'none';
        }
    }
    
    // 初始化心理预期楼层输入框
    const preferredFloorInput = document.getElementById('preferred-floor');
    if (preferredFloorInput) {
        preferredFloorInput.value = preferredFloor || '';
        preferredFloorInput.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            preferredFloor = (value >= 1 && value <= 38) ? value : null;
            savePreferredFloor();
        });
    }
    
        // 初始化价格期望值输入框（单位：万元）
    const expectedPriceInput = document.getElementById('expected-price');
    if (expectedPriceInput) {
        loadExpectedPrice();
        // 显示时转换为万元
        expectedPriceInput.value = expectedPrice ? (expectedPrice / 10000).toFixed(2) : '';
        
        // 延迟加载价格参考，确保API可用
        setTimeout(() => {
            updatePriceReference();
        }, 500);
        
        // 实时保存价格期望值（存储为元，显示为万元）
        expectedPriceInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            expectedPrice = value > 0 ? value * 10000 : null;  // 转换为元存储
            saveExpectedPrice();
        });
    }
    
    // 初始化时显示/隐藏梯度表和楼层选择
    setTimeout(() => {
        const orientationWeight = document.getElementById('weight-orientation');
        if (orientationWeight) {
            const weight = parseInt(orientationWeight.value);
            const container = document.getElementById('orientation-sort-container');
            if (container) {
                container.style.display = weight > 0 ? 'block' : 'none';
            }
        }
        
        const viewWeight = document.getElementById('weight-view');
        if (viewWeight) {
            const weight = parseInt(viewWeight.value);
            const container = document.getElementById('view-sort-container');
            if (container) {
                container.style.display = weight > 0 ? 'block' : 'none';
            }
        }
        
        const floorWeight = document.getElementById('weight-floor');
        if (floorWeight) {
            const weight = parseInt(floorWeight.value);
            const container = document.getElementById('floor-preference-container');
            if (container) {
                container.style.display = weight > 0 ? 'flex' : 'none';
            }
        }
    }, 100);
    
    // 保存按钮
    const saveBtn = document.getElementById('btn-save-weights');
    if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // 先保存所有配置
        saveWeights();
            saveSortConfig();
            saveGradientConfig();
            saveExpectedPrice();
            savePreferredFloor();
            
            // 显示Toast提示
            console.log('准备显示Toast提示'); // 调试信息
            showSaveSuccessDialog();
            
            // 更新分数筛选器状态（延迟执行，确保localStorage已保存）
            setTimeout(() => {
                updateScoreFilterState();
            }, 300);
        });
    }
}

// 更新价格参考信息
async function updatePriceReference() {
    const referenceSpan = document.getElementById('price-reference');
    if (!referenceSpan) return;
    
    try {
        const response = await fetch(`${API_BASE}/houses?per_page=1000`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const houses = data.data || [];
        
        // 计算所有有价格房源的平均总价
        const validHouses = houses.filter(h => h.价格);
        if (validHouses.length > 0) {
            const totalPrice = validHouses.reduce((sum, h) => sum + h.价格, 0);
            const avgPrice = Math.round(totalPrice / validHouses.length);
            referenceSpan.textContent = `附近均价参考：${(avgPrice / 10000).toFixed(2)}万元`;
        }
    } catch (error) {
        console.error('获取价格参考失败:', error);
    }
}

// 保存价格期望值
function saveExpectedPrice() {
    if (expectedPrice) {
        localStorage.setItem('houseExpectedPrice', expectedPrice.toString());
    } else {
        localStorage.removeItem('houseExpectedPrice');
    }
}

// 加载价格期望值
function loadExpectedPrice() {
    const saved = localStorage.getItem('houseExpectedPrice');
    if (saved) {
        expectedPrice = parseFloat(saved);
    }
}

// 显示保存成功Toast提示
function showSaveSuccessDialog() {
    // 移除已存在的toast
    const existingToast = document.getElementById('save-success-toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 创建toast元素
    const toast = document.createElement('div');
    toast.id = 'save-success-toast';
    toast.className = 'toast-message';
    toast.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #fff; padding: 12px 20px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); z-index: 5000; display: flex; align-items: center; opacity: 0; transform: translateX(100%); transition: all 0.3s ease; font-size: 14px; color: #333; border-left: 4px solid #52c41a;';
    toast.innerHTML = `
        <span style="color: #52c41a; margin-right: 8px; font-size: 16px;">✓</span>
        <span>保存成功</span>
    `;
    
    document.body.appendChild(toast);
    
    // 强制重绘，然后显示动画
    toast.offsetHeight; // 触发重绘
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    }, 10);
    
    // 3秒后自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 300);
    }, 3000);
}

// 初始化排序滑块
function initSortSliders(type, currentOrder, defaultOrder) {
    const container = document.getElementById(`${type}-sort-sliders`);
    if (!container) return;
    
    // 确保currentOrder包含所有默认项
    const order = currentOrder && currentOrder.length > 0 ? currentOrder : defaultOrder;
    const allItems = [...new Set([...order, ...defaultOrder])];
    
    // 清空容器
    container.innerHTML = '';
    
    // 创建可拖动的滑块项
    allItems.forEach((item, index) => {
        const sliderItem = document.createElement('div');
        sliderItem.className = 'sort-slider-item';
        sliderItem.draggable = true;
        sliderItem.dataset.item = item;
        
        const score = allItems.length - index; // 左侧为最高分
        const maxScore = allItems.length;
        const normalizedScore = Math.round((score / maxScore) * 100);
        
        sliderItem.innerHTML = `
            <span class="sort-label">${item}</span>
            <span class="sort-score">${normalizedScore}分</span>
        `;
        
        // 拖动事件
        sliderItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', item);
            sliderItem.classList.add('dragging');
        });
        
        sliderItem.addEventListener('dragend', () => {
            sliderItem.classList.remove('dragging');
            updateSortScores(type);
        });
        
        sliderItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = container.querySelector('.dragging');
            if (dragging && dragging !== sliderItem) {
                const items = Array.from(container.children);
                const draggingIndex = items.indexOf(dragging);
                const currentIndex = items.indexOf(sliderItem);
                
                if (draggingIndex < currentIndex) {
                    container.insertBefore(dragging, sliderItem.nextSibling);
                } else {
                    container.insertBefore(dragging, sliderItem);
                }
            }
        });
        
        sliderItem.addEventListener('drop', (e) => {
            e.preventDefault();
            const draggedItem = e.dataTransfer.getData('text/plain');
            const draggedElement = container.querySelector(`[data-item="${draggedItem}"]`);
            if (draggedElement && draggedElement !== sliderItem) {
                const items = Array.from(container.children);
                const draggedIndex = items.indexOf(draggedElement);
                const currentIndex = items.indexOf(sliderItem);
                
                if (draggedIndex < currentIndex) {
                    container.insertBefore(draggedElement, sliderItem.nextSibling);
                } else {
                    container.insertBefore(draggedElement, sliderItem);
                }
                updateSortOrder(type);
            }
        });
        
        container.appendChild(sliderItem);
    });
    
    updateSortScores(type);
}

// 更新排序顺序
function updateSortOrder(type) {
    const container = document.getElementById(`${type}-sort-sliders`);
    if (!container) return;
    
    const items = Array.from(container.children);
    const order = items.map(item => item.dataset.item);
    sortConfig[type] = order;
    saveSortConfig();
}

// 更新排序分数显示
function updateSortScores(type) {
    const container = document.getElementById(`${type}-sort-sliders`);
    if (!container) return;
    
    const items = Array.from(container.children);
    const maxScore = items.length;
    
    items.forEach((item, index) => {
        const score = maxScore - index;
        const normalizedScore = Math.round((score / maxScore) * 100);
        const scoreSpan = item.querySelector('.sort-score');
        if (scoreSpan) {
            scoreSpan.textContent = `${normalizedScore}分`;
        }
    });
}

// 保存排序配置
function saveSortConfig() {
    localStorage.setItem('houseSortConfig', JSON.stringify(sortConfig));
}

// 加载排序配置
function loadSortConfig() {
    const saved = localStorage.getItem('houseSortConfig');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // 兼容旧格式
            if (parsed.orientation && Array.isArray(parsed.orientation)) {
                sortConfig.orientation = parsed.orientation;
            }
            if (parsed.view && Array.isArray(parsed.view)) {
                sortConfig.view = parsed.view;
            }
        } catch (e) {
            console.error('加载排序配置失败:', e);
        }
    }
}

// 保存梯度配置
function saveGradientConfig() {
    localStorage.setItem('houseGradientConfig', JSON.stringify(gradientConfig));
}

// 加载梯度配置
function loadGradientConfig() {
    const saved = localStorage.getItem('houseGradientConfig');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            
            // 清除orientation配置中的"其他"选项
            if (parsed.orientation && parsed.orientation[3]) {
                parsed.orientation[3] = parsed.orientation[3].filter(item => item !== '其他');
            }
            
            // 加载配置
            if (parsed.orientation) {
                gradientConfig.orientation = parsed.orientation;
            }
            if (parsed.view) {
                gradientConfig.view = parsed.view;
            }
            if (parsed.viewRooms) {
                gradientConfig.viewRooms = parsed.viewRooms;
            }
            
            // 保存清理后的配置
            localStorage.setItem('houseGradientConfig', JSON.stringify(parsed));
        } catch (e) {
            console.error('加载梯度配置失败:', e);
        }
    }
}

// 初始化梯度表
function initGradientTable(type, allItems) {
    let config = gradientConfig[type] || { 1: [], 2: [], 3: [] };
    
    // 如果配置为空，使用默认配置
    if (type === 'orientation' && (!config[1] || config[1].length === 0)) {
        config = {
            1: ['东南向', '西南向', '西北向'],
            2: ['东北向', '南向'],
            3: ['北向', '东向', '西向']
        };
        gradientConfig[type] = config;
        saveGradientConfig();
    }
    
    if (type === 'view' && (!config[1] || config[1].length === 0)) {
        config = {
            1: [],
            2: ['海景', '山景'],
            3: ['楼景', '没有景观']
        };
        gradientConfig[type] = config;
        saveGradientConfig();
    }
    
    // 渲染三个梯度
    for (let tier = 1; tier <= 3; tier++) {
        const tierContainer = document.getElementById(`${type}-tier-${tier}`);
        if (!tierContainer) {
            console.warn(`梯度表容器不存在: ${type}-tier-${tier}`);
            continue;
        }
        
        // 清空容器（保留输入框等）
        const existingCards = tierContainer.querySelectorAll('.gradient-card:not(.add-room-input)');
        existingCards.forEach(card => card.remove());
        
        const items = config[tier] || [];
        items.forEach(item => {
            if (item) {
                const card = createGradientCard(type, item, tier);
                tierContainer.appendChild(card);
            }
        });
        
        // 如果是景观第一梯队，需要单独渲染viewRooms中的房号（插入到输入框之前）
        if (type === 'view' && tier === 1 && gradientConfig.viewRooms && Array.isArray(gradientConfig.viewRooms)) {
            const addInput = tierContainer.querySelector('.add-room-input');
            gradientConfig.viewRooms.forEach(roomNumber => {
                // 确保房号不在config[1]中（避免重复）
                if (!items.includes(roomNumber)) {
                    const card = createGradientCard(type, roomNumber, tier);
                    if (addInput) {
                        tierContainer.insertBefore(card, addInput);
                    } else {
                        tierContainer.appendChild(card);
                    }
                }
            });
        }
    }
    
    // 如果是景观类型，初始化添加房号功能
    if (type === 'view') {
        initViewRoomAdd();
    }
    
    // 初始化拖拽功能（延迟执行，确保DOM已渲染）
    setTimeout(() => {
        initGradientDrag(type);
    }, 200);
}

// 创建梯度卡片
function createGradientCard(type, item, tier) {
    const card = document.createElement('div');
    card.className = 'gradient-card';
    card.draggable = true;
    card.dataset.item = item;
    card.dataset.tier = tier;
    
    // 只有viewRooms中的房号才显示删除按钮（不是景观类型如"山景"、"海景"等）
    const isViewRoom = type === 'view' && tier === 1 && 
                       gradientConfig.viewRooms && 
                       Array.isArray(gradientConfig.viewRooms) &&
                       gradientConfig.viewRooms.includes(item);
    
    card.innerHTML = `
        <span class="card-label">${item}</span>
        ${isViewRoom ? '<button class="card-remove" data-item="' + item + '">×</button>' : ''}
    `;
    
    // 如果是景观第一梯队的房号（不是景观类型），添加删除按钮事件
    if (isViewRoom) {
        const removeBtn = card.querySelector('.card-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeViewRoom(item);
            });
        }
    }
    
    return card;
}

// 初始化景观房号添加功能
function initViewRoomAdd() {
    const addBtn = document.getElementById('view-add-room-btn');
    const addInput = document.getElementById('view-add-room');
    
    if (!addBtn || !addInput) {
        // 如果元素不存在，可能是容器还没显示，延迟重试
        setTimeout(() => {
            initViewRoomAdd();
        }, 500);
        return;
    }
    
    // 确保viewRooms数组已初始化
    if (!gradientConfig.viewRooms) {
        gradientConfig.viewRooms = [];
    }
    
    // 移除可能存在的旧监听器（通过克隆节点）
    const newAddBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newAddBtn, addBtn);
    const newAddInput = addInput.cloneNode(true);
    addInput.parentNode.replaceChild(newAddInput, addInput);
    
    newAddBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const roomNumber = newAddInput.value.trim();
        console.log('点击添加按钮，房号:', roomNumber);
        
        if (!roomNumber) {
            showToast('请输入房号', 'error');
            return;
        }
        
        if (validateRoomNumber(roomNumber)) {
            addViewRoom(roomNumber);
            newAddInput.value = '';
        } else {
            console.log('房号格式验证失败:', roomNumber);
            showToast('房号格式不正确，格式应为：楼栋+房号（如1C06）', 'error');
        }
    });
    
    newAddInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            console.log('按Enter键，触发添加');
            newAddBtn.click();
        }
    });
    
    // 添加备用onclick属性
    newAddBtn.setAttribute('onclick', 'event.preventDefault(); event.stopPropagation(); const input = document.getElementById("view-add-room"); if (input) { const roomNumber = input.value.trim(); if (roomNumber && /^\\d{1,2}[A-Za-z]{1,2}\\d{1,3}$/.test(roomNumber)) { window.addViewRoomDirect(roomNumber); input.value = ""; } else { alert("房号格式不正确"); } }');
}

// 验证房号格式（如1C06）
function validateRoomNumber(roomNumber) {
    // 格式：1-2位数字 + 1-2位字母 + 1-3位数字
    const pattern = /^\d{1,2}[A-Za-z]{1,2}\d{1,3}$/;
    return pattern.test(roomNumber);
}

// 添加景观房号到第一梯队
function addViewRoom(roomNumber) {
    // 确保viewRooms数组已初始化
    if (!gradientConfig.viewRooms) {
        gradientConfig.viewRooms = [];
    }
    
    if (gradientConfig.viewRooms.includes(roomNumber)) {
        showToast('该房号已存在', 'error');
        return;
    }
    
    gradientConfig.viewRooms.push(roomNumber);
    
    const tier1Container = document.getElementById('view-tier-1');
    if (tier1Container) {
        const card = createGradientCard('view', roomNumber, 1);
        // 插入到输入框之前
        const addInput = tier1Container.querySelector('.add-room-input');
        if (addInput) {
            tier1Container.insertBefore(card, addInput);
        } else {
            tier1Container.appendChild(card);
        }
    }
    
    saveGradientConfig();
    showToast(`房号 ${roomNumber} 已添加到第一梯队`, 'success');
}

// 备用函数：直接从window调用
window.addViewRoomDirect = function(roomNumber) {
    addViewRoom(roomNumber);
};

// 移除景观房号
function removeViewRoom(roomNumber) {
    gradientConfig.viewRooms = gradientConfig.viewRooms.filter(r => r !== roomNumber);
    const card = document.querySelector(`.gradient-card[data-item="${roomNumber}"]`);
    if (card) {
        card.remove();
    }
    saveGradientConfig();
}

// 初始化梯度表拖拽功能
function initGradientDrag(type) {
    // 为所有梯度容器添加拖拽事件
    for (let tier = 1; tier <= 3; tier++) {
        const tierContainer = document.getElementById(`${type}-tier-${tier}`);
        if (!tierContainer) continue;
        
        // 移除旧的事件监听器（通过克隆节点）
        const newContainer = tierContainer.cloneNode(true);
        tierContainer.parentNode.replaceChild(newContainer, tierContainer);
        
        newContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const afterElement = getDragAfterElement(newContainer, e.clientY);
            const dragging = document.querySelector('.gradient-card.dragging');
            if (dragging && dragging.parentNode !== newContainer) {
                if (afterElement == null) {
                    newContainer.appendChild(dragging);
                } else {
                    newContainer.insertBefore(dragging, afterElement);
                }
            }
        });
        
        newContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.gradient-card.dragging');
            if (dragging) {
                dragging.classList.remove('dragging');
                dragging.dataset.tier = tier;
                updateGradientConfig(type);
            }
        });
    }
    
    // 为所有卡片添加拖拽事件
    setTimeout(() => {
        document.querySelectorAll(`#${type}-tier-1 .gradient-card, #${type}-tier-2 .gradient-card, #${type}-tier-3 .gradient-card`).forEach(card => {
            // 移除旧的监听器
            const newCard = card.cloneNode(true);
            card.parentNode.replaceChild(newCard, card);
            
            newCard.addEventListener('dragstart', (e) => {
                newCard.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            
            newCard.addEventListener('dragend', () => {
                newCard.classList.remove('dragging');
            });
        });
    }, 50);
}

// 获取拖拽后的元素位置
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.gradient-card:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// 更新梯度配置
function updateGradientConfig(type) {
    for (let tier = 1; tier <= 3; tier++) {
        const tierContainer = document.getElementById(`${type}-tier-${tier}`);
        if (tierContainer) {
            const cards = tierContainer.querySelectorAll('.gradient-card:not(.add-room-input)');
            gradientConfig[type][tier] = Array.from(cards).map(card => card.dataset.item);
        }
    }
    saveGradientConfig();
}

// 保存心理预期楼层
function savePreferredFloor() {
    if (preferredFloor) {
        localStorage.setItem('housePreferredFloor', preferredFloor.toString());
    } else {
        localStorage.removeItem('housePreferredFloor');
    }
}

// 加载心理预期楼层
function loadPreferredFloor() {
    const saved = localStorage.getItem('housePreferredFloor');
    if (saved) {
        preferredFloor = parseInt(saved);
    }
}

// 保存权重到localStorage
function saveWeights() {
    localStorage.setItem('houseWeights', JSON.stringify(weights));
}

// 从localStorage加载权重
function loadWeights() {
    const saved = localStorage.getItem('houseWeights');
    if (saved) {
        weights = { ...weights, ...JSON.parse(saved) };
    }
    // 加载价格期望值
    loadExpectedPrice();
    // 加载心理预期楼层
    loadPreferredFloor();
    // 加载权重后更新分数筛选器状态
    setTimeout(() => {
        const scoreFilter = document.getElementById('filter-score-sort');
        if (scoreFilter) {
            const hasWeights = Object.values(weights).some(w => w > 0);
            const hasPriceExpectation = expectedPrice && expectedPrice > 0;
            if (hasWeights || hasPriceExpectation) {
                scoreFilter.disabled = false;
                scoreFilter.classList.remove('disabled');
                scoreFilter.title = '';
            } else {
                scoreFilter.disabled = true;
                scoreFilter.classList.add('disabled');
                scoreFilter.title = '请先设置期望值权重';
            }
        }
    }, 100);
}

// 格式化价格
function formatPrice(price) {
    if (!price) return '-';
    return (price / 10000).toFixed(2) + '万';
}

// 检查并显示新手引导
function checkAndShowGuide() {
    // 检查是否已经显示过引导
    const hasShownGuide = localStorage.getItem('hasShownPriceGuide');
    if (hasShownGuide) {
        return;
    }
    
    // 检查是否已设置期望值
    const saved = localStorage.getItem('houseWeights');
    let hasWeights = false;
    if (saved) {
        const savedWeights = JSON.parse(saved);
        hasWeights = Object.values(savedWeights).some(w => w > 0);
    }
    const savedPrice = localStorage.getItem('houseExpectedPrice');
    const hasPriceExpectation = savedPrice && parseFloat(savedPrice) > 0;
    
    // 如果没有设置期望值，显示引导
    if (!hasWeights && !hasPriceExpectation) {
        setTimeout(() => {
            showNewUserGuide();
        }, 500);
    }
}

// 显示新手引导
function showNewUserGuide() {
    const guideDiv = document.createElement('div');
    guideDiv.id = 'new-user-guide';
    guideDiv.innerHTML = `
        <div class="guide-content">
            <h3>欢迎使用房源选择系统！</h3>
            <p>为了使用分数排序功能，请先前往"期望值"页面设置您的偏好权重。</p>
            <div class="guide-buttons">
                <button class="btn-primary" id="guide-go-to-expectation">前往设置</button>
                <button class="btn-secondary" id="guide-close">我知道了</button>
            </div>
        </div>
    `;
    document.body.appendChild(guideDiv);
    
    // 前往设置按钮
    document.getElementById('guide-go-to-expectation').addEventListener('click', () => {
        const expectationTab = document.querySelector('.tab-btn[data-page="expectation"]');
        if (expectationTab) {
            expectationTab.click();
        }
        closeGuide();
    });
    
    // 关闭按钮
    document.getElementById('guide-close').addEventListener('click', () => {
        closeGuide();
    });
}

// 关闭引导
function closeGuide() {
    const guideDiv = document.getElementById('new-user-guide');
    if (guideDiv) {
        guideDiv.remove();
        localStorage.setItem('hasShownPriceGuide', 'true');
    }
}

