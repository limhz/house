// API基础URL
// 优先使用 config.js 中定义的 API_BASE，如果没有则使用默认值
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) || 
    (typeof window !== 'undefined' && window.location 
        ? (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? 'http://localhost:5000/api'
            : window.location.protocol + '//' + window.location.hostname + '/api')
        : 'http://localhost:5000/api');

// 全局状态
let currentPage = 1;
let currentFilters = {};
let filterOptions = {};
let housesData = [];
// 缓存所有房源的原始分数（key: house.id, value: rawScore）
let allHousesScoresCache = {};
// 缓存映射到展示区间后的分数（60-99，用于展示和排序）
let allHousesDisplayScores = {};
let isCalculatingAllScores = false; // 标记是否正在后台计算所有分数
// 分数排序相关
let sortedAllHouses = []; // 保存排序后的所有房源（用于分页）
let isScoreSortingActive = false; // 标记是否正在使用分数排序
// 记录圆点位置和房号的映射（用于点击检测）
let roomDotPositions = {}; // { "1A01": {x, y, radius} }

// 规范化房型显示：优先使用房子类型（如 70B'、90A''），否则用户型+面积推断
function getDisplayRoomType(house) {
    const type = (house.房子类型 || '').trim(); // 可能是 70C' 或 B户型
    const layout = (house.户型 || '').trim();   // 可能是 B户型
    const areaRaw = (house.房子面积 || '').toString().trim(); // 可能是 70、90、70㎡、约70等

    // 1) 如果房子类型已经是目标格式（带数字+字母），直接返回
    if (type && /^\d+[A-Z]/i.test(type)) {
        return type;
    }

    // 2) 尝试从房子类型或户型中提取字母（如 B户型）
    const sourceForLetter = type || layout;
    const letterMatch = sourceForLetter.match(/([A-Z])户型/i);
    if (letterMatch) {
        const letter = letterMatch[1].toUpperCase();
        // 尝试从面积中提取 70 或 90（支持“70㎡”、“约70”、“70-90”等）
        const areaMatch = areaRaw.match(/(70|90)/);
        const areaPrefix = areaMatch ? areaMatch[1] : '';
        if (areaPrefix && letter) {
            return `${areaPrefix}${letter}`;
        }
        return sourceForLetter || '-';
    }

    // 3) 回退
    return type || layout || '-';
}
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
    initDisclaimerModal();
    
    // 检查并显示新手引导（关于圆点颜色的说明）
    checkAndShowDotColorGuide();
    
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

// 五期需求：初始化免责与隐私声明弹窗
function initDisclaimerModal() {
    const overlay = document.getElementById('disclaimer-overlay');
    if (!overlay) return;
    
    const btnAgree = document.getElementById('btn-agree');
    const btnReport = document.getElementById('btn-report');
    const waitSpan = document.getElementById('disclaimer-wait');
    const reportView = document.getElementById('disclaimer-report');
    const contentView = document.getElementById('disclaimer-content');
    const actionsBar = document.getElementById('disclaimer-actions');
    const reportContact = document.getElementById('report-contact');
    const reportContent = document.getElementById('report-content');
    const reportSubmit = document.getElementById('report-submit');
    const reportCancel = document.getElementById('report-cancel');
    
    // 每次进入网站都显示弹窗
    overlay.style.display = 'flex';
    
    // 初始禁用“同意”按钮，3秒后可点
    if (btnAgree) {
        btnAgree.disabled = true;
        let countdown = 5;
        if (waitSpan) {
            waitSpan.textContent = `请先阅读声明（${countdown}秒后可点击同意）`;
        }
        const timer = setInterval(() => {
            countdown -= 1;
            if (countdown <= 0) {
                clearInterval(timer);
                btnAgree.disabled = false;
                if (waitSpan) {
                    waitSpan.textContent = '';
                }
            } else if (waitSpan) {
                waitSpan.textContent = `请先阅读声明（${countdown}秒后可点击同意）`;
            }
        }, 1000);
        
        btnAgree.addEventListener('click', () => {
            overlay.style.display = 'none';
        });
    }
    
    // 举报按钮：切换到举报视图
    if (btnReport && reportView && contentView && actionsBar) {
        btnReport.addEventListener('click', () => {
            contentView.style.display = 'none';
            reportView.style.display = 'flex';
            actionsBar.style.display = 'none';
        });
    }
    
    // 举报取消：返回声明视图
    if (reportCancel && reportView && contentView && actionsBar) {
        reportCancel.addEventListener('click', () => {
            reportView.style.display = 'none';
            contentView.style.display = 'block';
            actionsBar.style.display = 'flex';
        });
    }
    
    // 提交举报
    if (reportSubmit && reportContact && reportContent) {
        reportSubmit.addEventListener('click', async () => {
            const contact = reportContact.value.trim();
            const content = reportContent.value.trim();
            if (!contact) {
                showToast('请输入联系方式', 'error');
                return;
            }
            if (!content) {
                showToast('请输入举报内容', 'error');
                return;
            }
            
            try {
                const resp = await fetch(`${API_BASE}/report`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contact,
                        content
                    })
                });
                
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}`);
                }
                
                const data = await resp.json();
                if (data && data.success) {
                    showToast('举报已提交，感谢反馈', 'success');
                    // 清空表单并返回声明视图
                    reportContact.value = '';
                    reportContent.value = '';
                    if (reportView && contentView && actionsBar) {
                        reportView.style.display = 'none';
                        contentView.style.display = 'block';
                        actionsBar.style.display = 'flex';
                    }
                } else {
                    showToast('举报提交失败，请稍后重试', 'error');
                }
            } catch (err) {
                console.error('提交举报失败:', err);
                showToast('举报提交失败，请检查网络后重试', 'error');
            }
        });
    }
}

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

// 固定参考尺寸（1200*790，标记点准确的比例）
const REFERENCE_WIDTH = 1200;
const REFERENCE_HEIGHT = 790;

// 获取图片的原始尺寸（从图片元素获取）
function getImageNaturalSize() {
    const mapImage = document.getElementById('map-image');
    if (!mapImage) return { width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT };
    return {
        width: mapImage.naturalWidth || REFERENCE_WIDTH,
        height: mapImage.naturalHeight || REFERENCE_HEIGHT
    };
}

// 基于固定比例计算位置（修复标记点偏移问题）
// 六期需求：图片不再拉伸，只居中显示
function calculatePosition(row, col, imageRect, containerRect) {
    // 获取图片的自然尺寸
    const naturalSize = getImageNaturalSize();
    
    // 计算缩放比例
    const scale = imageRect.width / naturalSize.width;
    
    // 计算图片相对于容器的偏移（使用实际位置差，而非假设居中）
    const offsetX = imageRect.left - containerRect.left;
    const offsetY = imageRect.top - containerRect.top;
    
    
    // 基于图片自然尺寸和网格计算位置
    const cellWidth = naturalSize.width / GRID_SIZE;
    const cellHeight = naturalSize.height / GRID_SIZE;
    
    // 最终位置 = 图片偏移 + 网格位置 * 缩放
    const x = offsetX + (col * cellWidth * scale);
    const y = offsetY + (row * cellHeight * scale);
    
    return { x, y, cellWidth: cellWidth * scale, cellHeight: cellHeight * scale };
}

// 从屏幕坐标转换为网格坐标（基于固定比例）
// 六期需求：图片不再拉伸，只居中显示
function screenToGrid(x, y, imageRect, containerRect) {
    const naturalSize = getImageNaturalSize();
    
    const scale = imageRect.width / naturalSize.width;
    
    // 计算图片相对于容器的偏移（使用实际位置差）
    const offsetX = imageRect.left - containerRect.left;
    const offsetY = imageRect.top - containerRect.top;
    
    // 基于图片自然尺寸计算单元格大小
    const cellWidth = (naturalSize.width / GRID_SIZE) * scale;
    const cellHeight = (naturalSize.height / GRID_SIZE) * scale;
    
    const col = Math.floor((x - offsetX) / cellWidth);
    const row = Math.floor((y - offsetY) / cellHeight);
    
    return { row, col };
}

// 房号对齐规则配置
const ALIGNMENT_RULES = {
    // 1A、2A、2D、2F、2G：1~4和9~12为竖线，5~8为横线
    '1A': { vertical: [[1, 2, 3, 4], [9, 10, 11, 12]], horizontal: [[5, 6, 7, 8]] },
    '2A': { vertical: [[1, 2, 3, 4], [9, 10, 11, 12]], horizontal: [[5, 6, 7, 8]] },
    '2D': { vertical: [[1, 2, 3, 4], [9, 10, 11, 12]], horizontal: [[5, 6, 7, 8]] },
    '2F': { vertical: [[1, 2, 3, 4], [9, 10, 11, 12]], horizontal: [[5, 6, 7, 8]] },
    '2G': { vertical: [[1, 2, 3, 4], [9, 10, 11, 12]], horizontal: [[5, 6, 7, 8]] },
    // 1E：1~7为竖线，8~14为竖线
    '1E': { vertical: [[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14]], horizontal: [] },
    // 2E：1~3为竖线，4~7为横线，8~10为竖线
    '2E': { vertical: [[1, 2, 3], [8, 9, 10]], horizontal: [[4, 5, 6, 7]] },
    // 1C、1D、2B、2C：1~4、5~8为竖线
    '1C': { vertical: [[1, 2, 3, 4], [5, 6, 7, 8]], horizontal: [] },
    '1D': { vertical: [[1, 2, 3, 4], [5, 6, 7, 8]], horizontal: [] },
    '2B': { vertical: [[1, 2, 3, 4], [5, 6, 7, 8]], horizontal: [] },
    '2C': { vertical: [[1, 2, 3, 4], [5, 6, 7, 8]], horizontal: [] },
    // 1B、1F：1~6、7~12为竖线
    '1B': { vertical: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]], horizontal: [] },
    '1F': { vertical: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]], horizontal: [] }
};

// 获取房号所属的对齐组
function getAlignmentGroup(roomNumber) {
    const match = roomNumber.match(/^(\d+[A-Z])(\d+)$/);
    if (!match) return null;
    
    const buildingName = match[1];
    const roomNum = parseInt(match[2]);
    const rules = ALIGNMENT_RULES[buildingName];
    
    if (!rules) return null;
    
    // 检查竖线
    for (const group of rules.vertical) {
        if (group.includes(roomNum)) {
            return {
                type: 'vertical',
                building: buildingName,
                rooms: group.map(n => `${buildingName}${String(n).padStart(2, '0')}`)
            };
        }
    }
    
    // 检查横线
    for (const group of rules.horizontal) {
        if (group.includes(roomNum)) {
            return {
                type: 'horizontal',
                building: buildingName,
                rooms: group.map(n => `${buildingName}${String(n).padStart(2, '0')}`)
            };
        }
    }
    
    return null;
}

// 对齐房号点（将同一组的点对齐到一条线，并等距分布）
function alignRoomPoints(annotationData) {
    const alignedData = { ...annotationData };
    const roomGroups = {}; // { "1A01": { row, col, group } }
    
    // 收集所有房号点
    Object.keys(annotationData).forEach(key => {
        const value = annotationData[key].toUpperCase();
        if (/^\d+[A-Z]\d+$/.test(value)) {
            const [row, col] = key.split('_').map(Number);
            const group = getAlignmentGroup(value);
            if (group) {
                if (!roomGroups[value]) {
                    roomGroups[value] = { row, col, group };
                }
            }
        }
    });
    
    // 按组对齐
    const processedGroups = new Set();
    Object.keys(roomGroups).forEach(roomNumber => {
        const roomInfo = roomGroups[roomNumber];
        const groupKey = `${roomInfo.group.building}_${roomInfo.group.type}_${roomInfo.group.rooms.join(',')}`;
        
        if (processedGroups.has(groupKey)) return;
        processedGroups.add(groupKey);
        
        // 获取组内所有房号的当前位置
        const groupRooms = roomInfo.group.rooms.map(rn => {
            const key = Object.keys(annotationData).find(k => 
                annotationData[k].toUpperCase() === rn
            );
            if (key) {
                const [row, col] = key.split('_').map(Number);
                return { roomNumber: rn, key, row, col };
            }
            return null;
        }).filter(r => r !== null);
        
        if (groupRooms.length === 0) return;
        
        // 对齐：竖线对齐列并等距分布，横线对齐行并等距分布
        if (roomInfo.group.type === 'vertical') {
            // 竖线：所有点使用相同的列，行等距分布
            const avgCol = Math.round(groupRooms.reduce((sum, r) => sum + r.col, 0) / groupRooms.length);
            
            // 按行排序
            groupRooms.sort((a, b) => a.row - b.row);
            
            // 计算等距分布
            if (groupRooms.length > 1) {
                const minRow = Math.min(...groupRooms.map(r => r.row));
                const maxRow = Math.max(...groupRooms.map(r => r.row));
                const rowSpan = maxRow - minRow;
                const rowStep = rowSpan / (groupRooms.length - 1);
                
                groupRooms.forEach((room, index) => {
                    const newRow = Math.round(minRow + index * rowStep);
                    const newKey = `${newRow}_${avgCol}`;
                    if (newKey !== room.key) {
                        alignedData[newKey] = alignedData[room.key];
                        delete alignedData[room.key];
                    }
                });
            } else {
                // 只有一个点，只对齐列
                const room = groupRooms[0];
                const newKey = `${room.row}_${avgCol}`;
                if (newKey !== room.key) {
                    alignedData[newKey] = alignedData[room.key];
                    delete alignedData[room.key];
                }
            }
        } else if (roomInfo.group.type === 'horizontal') {
            // 横线：所有点使用相同的行，列等距分布
            const avgRow = Math.round(groupRooms.reduce((sum, r) => sum + r.row, 0) / groupRooms.length);
            
            // 按列排序
            groupRooms.sort((a, b) => a.col - b.col);
            
            // 计算等距分布
            if (groupRooms.length > 1) {
                const minCol = Math.min(...groupRooms.map(r => r.col));
                const maxCol = Math.max(...groupRooms.map(r => r.col));
                const colSpan = maxCol - minCol;
                const colStep = colSpan / (groupRooms.length - 1);
                
                groupRooms.forEach((room, index) => {
                    const newCol = Math.round(minCol + index * colStep);
                    const newKey = `${avgRow}_${newCol}`;
                    if (newKey !== room.key) {
                        alignedData[newKey] = alignedData[room.key];
                        delete alignedData[room.key];
                    }
                });
            } else {
                // 只有一个点，只对齐行
                const room = groupRooms[0];
                const newKey = `${avgRow}_${room.col}`;
                if (newKey !== room.key) {
                    alignedData[newKey] = alignedData[room.key];
                    delete alignedData[room.key];
                }
            }
        }
    });
    
    return alignedData;
}

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
        if (mapCanvas.width !== Math.floor(containerRect.width) || 
            mapCanvas.height !== Math.floor(containerRect.height)) {
            mapCanvas.width = containerRect.width;
            mapCanvas.height = containerRect.height;
        }
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
    const saveBtn = document.getElementById('save-annotations');
    
    // 三期需求：隐藏标注模式按钮，改为左上角20*20px点击区域，6次点击+密码验证
    let clickCount = 0;
    let clickTimer = null;
    const ANNOTATION_PASSWORD = '159357';
    const CLICK_TIMEOUT = 2000; // 2秒
    
    const triggerArea = document.getElementById('annotation-trigger-area');
    if (triggerArea) {
        triggerArea.addEventListener('click', () => {
            clickCount++;
            
            // 清除之前的定时器
            if (clickTimer) {
                clearTimeout(clickTimer);
            }
            
            // 如果达到6次点击，弹出密码输入框
            if (clickCount >= 6) {
                clickCount = 0;
                const password = prompt('请输入密码以开启标注模式：');
                if (password === ANNOTATION_PASSWORD) {
                    annotationMode = true;
                    toggleAnnotationMode();
                } else if (password !== null) {
                    alert('密码错误！');
                }
            } else {
                // 设置定时器，2秒内没有继续点击则重置计数
                clickTimer = setTimeout(() => {
                    clickCount = 0;
                }, CLICK_TIMEOUT);
            }
        });
    }
    
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
    
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            await saveAnnotationPositions();
        });
    }
    
    const initMapCanvas = () => {
        updateCanvasSize();
        
        // 如果不是标注模式，绘制售出状态圆点
        if (!annotationMode) {
            renderSoldStatusDots();
        }
        
        // 加载楼栋数据并绘制可点击区域
        loadBuildings().then(buildings => {
            if (!annotationMode) {
                mapCanvas.style.pointerEvents = 'auto';
                
                // 点击事件
                mapCanvas.addEventListener('click', (e) => {
                    const rect = mapCanvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    handleMapClick(x, y);
                });
                
                // 鼠标移动事件：检测是否在圆点上，改变cursor
                mapCanvas.addEventListener('mousemove', (e) => {
                    const rect = mapCanvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    
                    // 检测是否在某个圆点上
                    let isOnDot = false;
                    for (const [roomKey, dot] of Object.entries(roomDotPositions)) {
                        const distance = Math.sqrt(Math.pow(x - dot.x, 2) + Math.pow(y - dot.y, 2));
                        if (distance <= dot.radius) {
                            isOnDot = true;
                            break;
                        }
                    }
                    
                    // 改变cursor样式
                    mapCanvas.style.cursor = isOnDot ? 'pointer' : 'default';
                });
            }
        });
    };
    
    // 监听窗口大小变化，延迟更新避免拖影
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        // 立即清空canvas，隐藏所有圆点
        const ctx = mapCanvas.getContext('2d');
        ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        
        // 清除之前的定时器
        if (resizeTimer) {
            clearTimeout(resizeTimer);
        }
        
        // 延迟1秒后更新尺寸和重绘
        resizeTimer = setTimeout(() => {
            updateCanvasSize();
            if (annotationMode) {
                renderAnnotationGrid();
            } else {
                renderSoldStatusDots();
            }
        }, 1000);
    });
    
    // 图片加载完成或已缓存时初始化
    if (mapImage.complete && mapImage.naturalWidth > 0) {
        initMapCanvas();
    } else {
        mapImage.onload = initMapCanvas;
    }
}

// 切换标注模式
async function toggleAnnotationMode() {
    const overlay = document.getElementById('annotation-overlay');
    const toggleBtn = document.getElementById('toggle-annotation');
    const clearBtn = document.getElementById('clear-annotations');
    const saveBtn = document.getElementById('save-annotations');
    const mapCanvas = document.getElementById('map-canvas');
    
    if (!overlay || !toggleBtn || !mapCanvas) return;
    
    if (annotationMode) {
        // 关闭标注模式：对齐并保存数据
        annotationData = alignRoomPoints(annotationData);
        await saveAnnotationData();
        
        overlay.style.display = 'block';
        toggleBtn.textContent = '关闭标注模式';
        if (clearBtn) clearBtn.style.display = 'block';
        if (saveBtn) saveBtn.style.display = 'block';
        mapCanvas.style.pointerEvents = 'none';
        renderAnnotationGrid();
    } else {
        // 开启标注模式：保存当前数据
        annotationData = alignRoomPoints(annotationData);
        await saveAnnotationData();
        
        overlay.style.display = 'none';
        toggleBtn.textContent = '开启标注模式';
        if (clearBtn) clearBtn.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'none';
        mapCanvas.style.pointerEvents = 'auto';
        renderSoldStatusDots();
    }
}

// 保存标注位置
async function saveAnnotationPositions() {
    try {
        // 对齐并保存
        annotationData = alignRoomPoints(annotationData);
        await saveAnnotationData();
        showToast('位置已保存', 'success');
    } catch (error) {
        console.error('保存位置失败:', error);
        showToast('保存失败', 'error');
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
    
    // 使用新的计算方式（基于固定比例）
    const refScaleX = imageRect.width / REFERENCE_WIDTH;
    const refScaleY = imageRect.height / REFERENCE_HEIGHT;
    const cellWidth = (REFERENCE_WIDTH / GRID_SIZE) * refScaleX;
    const cellHeight = (REFERENCE_HEIGHT / GRID_SIZE) * refScaleY;
    
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
    
    // 先对齐房号点
    const alignedData = alignRoomPoints(annotationData);
    
    // 绘制已有标注（绿色半透明块）
    ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
    Object.keys(alignedData).forEach(key => {
        const [row, col] = key.split('_').map(Number);
        if (Number.isNaN(row) || Number.isNaN(col)) return;
        const pos = calculatePosition(row, col, imageRect, containerRect);
        ctx.fillRect(pos.x, pos.y, pos.cellWidth, pos.cellHeight);
    });
    
    // 绘制房号点（蓝色圆点，可拖动）
    const roomPoints = []; // 存储可拖动的点信息
    Object.keys(alignedData).forEach(key => {
        const value = alignedData[key].toUpperCase();
        if (/^\d+[A-Z]\d+$/.test(value)) {
            const [row, col] = key.split('_').map(Number);
            if (Number.isNaN(row) || Number.isNaN(col)) return;
            const pos = calculatePosition(row, col, imageRect, containerRect);
            
            // 绘制蓝色圆点
            ctx.fillStyle = 'rgba(24, 144, 255, 0.7)';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
            
            roomPoints.push({ key, value, row, col, x: pos.x, y: pos.y });
        }
    });
    
    // 拖动功能
    let dragging = false;
    let dragStart = null;
    let draggedPoint = null;
    let draggedGroup = null;
    
    gridCanvas.addEventListener('mousedown', (e) => {
        const rect = gridCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // 检查是否点击在房号点上
        for (const point of roomPoints) {
            const dist = Math.sqrt(Math.pow(x - point.x, 2) + Math.pow(y - point.y, 2));
            if (dist <= 10) { // 点击范围10px
                dragging = true;
                dragStart = { x, y };
                draggedPoint = point;
                
                // 获取同组的点（从 annotationData 中查找，而不是 alignedData）
                const group = getAlignmentGroup(point.value);
                if (group) {
                    draggedGroup = group.rooms.map(rn => {
                        // 从 annotationData 中查找对应的 key
                        const key = Object.keys(annotationData).find(k => 
                            annotationData[k].toUpperCase() === rn
                        );
                        if (key) {
                            const [row, col] = key.split('_').map(Number);
                            return { roomNumber: rn, key, row, col };
                        }
                        return null;
                    }).filter(r => r !== null);
                } else {
                    // 单个点，从 annotationData 中查找对应的 key
                    const key = Object.keys(annotationData).find(k => 
                        annotationData[k].toUpperCase() === point.value
                    );
                    if (key) {
                        const [row, col] = key.split('_').map(Number);
                        draggedGroup = [{ roomNumber: point.value, key, row, col }];
                    } else {
                        draggedGroup = [];
                    }
                }
                
                // 重置原始位置记录
                dragOriginalPositions = [];
                
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }
        
        // 如果没有点击在点上，执行原有的点击逻辑
        if (!dragging) {
            // 限制在图片区域内
            if (x < offsetX || x > offsetX + imageRect.width || y < offsetY || y > offsetY + imageRect.height) {
                return;
            }
            
            const gridPos = screenToGrid(x, y, imageRect, containerRect);
            showAnnotationInput(gridPos.row, gridPos.col);
        }
    });
    
    // 存储拖动前的原始位置（用于计算偏移）
    let dragOriginalPositions = [];
    
    gridCanvas.addEventListener('mousemove', (e) => {
        if (!dragging || !draggedPoint || !draggedGroup) return;
        
        const rect = gridCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const dx = x - dragStart.x;
        const dy = y - dragStart.y;
        
        // 重新获取图片和容器的尺寸（可能已经改变）
        const currentContainerRect = mapContainer.getBoundingClientRect();
        const currentImageRect = mapImage.getBoundingClientRect();
        
        // 重新计算 cellWidth 和 cellHeight（基于图片自然尺寸）
        const naturalSize = getImageNaturalSize();
        const currentScaleX = currentImageRect.width / naturalSize.width;
        const currentScaleY = currentImageRect.height / naturalSize.height;
        const currentScale = Math.min(currentScaleX, currentScaleY);
        const currentCellWidth = (naturalSize.width / GRID_SIZE) * currentScale;
        const currentCellHeight = (naturalSize.height / GRID_SIZE) * currentScale;
        
        // 使用像素偏移，转换为网格坐标偏移（保持精度）
        const dCol = dx / currentCellWidth;
        const dRow = dy / currentCellHeight;
        
        // 获取原始位置（只在第一次移动时保存）
        if (dragOriginalPositions.length === 0) {
            dragOriginalPositions = draggedGroup.map(i => ({ row: i.row, col: i.col }));
        }
        
        // 更新同组所有点的位置（直接更新 annotationData）
        draggedGroup.forEach((item, index) => {
            const originalPos = dragOriginalPositions[index];
            const newRow = Math.round(originalPos.row + dRow);
            const newCol = Math.round(originalPos.col + dCol);
            const newKey = `${newRow}_${newCol}`;
            
            // 如果位置改变了，更新数据
            if (newKey !== item.key) {
                // 如果新位置已经有数据，先删除旧数据
                if (annotationData[item.key]) {
                    const value = annotationData[item.key];
                    delete annotationData[item.key];
                    annotationData[newKey] = value;
                    item.key = newKey;
                    item.row = newRow;
                    item.col = newCol;
                }
            }
        });
        
        // 直接更新 canvas 上的点位置，而不是重新渲染整个网格
        // 这样可以避免重新创建事件监听器导致拖动状态丢失
        const ctx = gridCanvas.getContext('2d');
        
        // 重新绘制被拖动的点（使用更新后的位置）
        draggedGroup.forEach(item => {
            const pos = calculatePosition(item.row, item.col, currentImageRect, currentContainerRect);
            
            // 清除旧位置（绘制背景色覆盖）
            ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
            ctx.fillRect(pos.x - 3, pos.y - 3, 16, 16);
            
            // 绘制蓝色圆点
            ctx.fillStyle = 'rgba(24, 144, 255, 0.7)';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        });
    });
    
    gridCanvas.addEventListener('mouseup', (e) => {
        if (dragging) {
            dragging = false;
            dragStart = null;
            draggedPoint = null;
            draggedGroup = null;
            dragOriginalPositions = [];
            
            // 拖动结束后，重新渲染一次确保位置正确
            renderAnnotationGrid();
        }
    });
    
    gridCanvas.addEventListener('mouseleave', (e) => {
        if (dragging) {
            dragging = false;
            dragStart = null;
            draggedPoint = null;
            draggedGroup = null;
            dragOriginalPositions = [];
            
            // 拖动结束后，重新渲染一次确保位置正确
            renderAnnotationGrid();
        }
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
        
        // 使用新的计算方式（基于图片自然尺寸）
        const naturalSize = getImageNaturalSize();
        const scale = imageRect.width / naturalSize.width;
        const cellWidth = (naturalSize.width / GRID_SIZE) * scale;
        const cellHeight = (naturalSize.height / GRID_SIZE) * scale;
        
        // 计算图片相对于容器的偏移（使用实际位置差）
        const offsetX = imageRect.left - containerRect.left;
        const offsetY = imageRect.top - containerRect.top;
        
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
        
        // 为所有楼栋计算中心位置并绘制淡红色圆点
        // 从数据库获取所有楼栋
        let allBuildings = [];
        try {
            const buildingsResponse = await fetch(`${API_BASE}/buildings`);
            const buildingsData = await buildingsResponse.json();
            allBuildings = buildingsData.data || [];
        } catch (error) {
            console.error('获取楼栋列表失败:', error);
            // 如果获取失败，使用 buildingGroups 中的楼栋
            allBuildings = Object.keys(buildingGroups);
        }
        
        // 三期需求：移除楼栋红点渲染
        
        // 六期需求：统计每个房号（一列）的未售出数量
        const roomUnsoldCounts = {}; // { "1A01": unsoldCount }
        houses.forEach(house => {
            // 从楼栋名提取简短格式：1栋A座 -> 1A
            const buildingMatch = (house.楼栋名 || '').match(/(\d+)栋([A-Z])座/);
            if (!buildingMatch) return;
            const buildingShort = `${buildingMatch[1]}${buildingMatch[2]}`;
            // 房号取最后两位：301 -> 01
            const roomNo = (house.房号 || '').toString().slice(-2);
            const roomKey = `${buildingShort}${roomNo}`;
            
            if (!roomUnsoldCounts[roomKey]) {
                roomUnsoldCounts[roomKey] = 0;
            }
            if (house.售出情况 !== '已售出') {
                roomUnsoldCounts[roomKey]++;
            }
        });
        
        // 清空圆点位置记录
        roomDotPositions = {};
        
        // 绘制所有标注的房号位置点（六期需求：改为显示剩余数量的圆点）
        Object.keys(annotationData).forEach(key => {
            const value = annotationData[key].toUpperCase();
            const [row, col] = key.split('_').map(Number);
            
            // 只绘制房号格式的标注（如 1A01, 2A02）
            if (/^\d+[A-Z]\d+$/.test(value)) {
                // 使用新的计算方式
                const pos = calculatePosition(row, col, imageRect, containerRect);
                
                // 获取该房号的未售出数量
                const unsoldCount = roomUnsoldCounts[value] || 0;
                
                // 六期需求：根据剩余数量设置颜色
                let bgColor, textColor;
                if (unsoldCount <= 10) {
                    bgColor = 'rgba(255, 77, 79, 0.8)';  // 淡红色
                    textColor = '#fff';
                } else if (unsoldCount <= 20) {
                    bgColor = 'rgba(250, 173, 20, 0.8)'; // 淡黄色
                    textColor = '#333';
                } else {
                    bgColor = 'rgba(82, 196, 26, 0.8)';  // 淡绿色
                    textColor = '#fff';
                }
                
                // 绘制较大的圆点（半径10px）
                const radius = 10;
                ctx.fillStyle = bgColor;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
                ctx.fill();
                
                // 添加白色边框
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                
                // 在圆点上显示剩余数量
                ctx.fillStyle = textColor;
                ctx.font = 'bold 9px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(unsoldCount.toString(), pos.x, pos.y);
                
                // 记录圆点位置（用于点击检测）
                roomDotPositions[value] = {
                    x: pos.x,
                    y: pos.y,
                    radius: radius + 5 // 增加5px的点击区域，便于点击
                };
            }
        });
        
    } catch (error) {
        console.error('渲染售出状态圆点失败:', error);
    }
}

// 处理地图点击
async function handleMapClick(x, y) {
    // 检测点击是否在某个圆点上
    let clickedRoom = null;
    for (const [roomKey, dot] of Object.entries(roomDotPositions)) {
        const distance = Math.sqrt(Math.pow(x - dot.x, 2) + Math.pow(y - dot.y, 2));
        if (distance <= dot.radius) {
            clickedRoom = roomKey;
            break;
        }
    }
    
    // 如果点击在圆点上，显示该房号对应的所有楼层房源
    if (clickedRoom) {
        await showRoomColumnModal(clickedRoom);
    }
    // 如果点击在背景图上，不做任何操作（背景图不可点击）
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

// 显示房号列的所有楼层房源（点击圆点时调用）
let currentRoomHouses = []; // 存储当前房号的所有房源数据

async function showRoomColumnModal(roomKey) {
    // roomKey格式：1A01，需要解析为楼栋名和房号
    const buildingMatch = roomKey.match(/^(\d+)([A-Z])(\d+)$/);
    if (!buildingMatch) {
        showToast('房号格式错误', 'error');
        return;
    }
    
    const buildingNum = buildingMatch[1];
    const buildingLetter = buildingMatch[2];
    const roomNo = buildingMatch[3];
    const buildingName = `${buildingNum}栋${buildingLetter}座`;
    
    const modal = document.getElementById('building-modal');
    const modalTitle = document.getElementById('modal-building-name');
    const modalList = document.getElementById('modal-houses-list');
    const showUnsoldOnlyCheckbox = document.getElementById('modal-show-unsold-only');
    
    modalTitle.textContent = `${buildingName} ${roomNo}号（所有楼层）`;
    modalList.innerHTML = '<div class="loading">加载中...</div>';
    modal.style.display = 'block';
    
    try {
        // 获取该楼栋的所有房源
        const response = await fetch(`${API_BASE}/houses/building/${encodeURIComponent(buildingName)}`);
        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
            // 筛选出该房号的所有楼层（房号最后两位匹配）
            currentRoomHouses = data.data.filter(house => {
                const houseRoomNo = (house.房号 || '').toString().slice(-2);
                return houseRoomNo === roomNo;
            });
            
            // 按楼层排序（从低到高）
            currentRoomHouses.sort((a, b) => (a.房子楼层 || 0) - (b.房子楼层 || 0));
            
            // 渲染房源列表（根据开关状态过滤）
            renderModalHousesList();
            
            // 监听开关变化
            showUnsoldOnlyCheckbox.onchange = () => {
                renderModalHousesList();
            };
        } else {
            modalList.innerHTML = '<div class="loading">暂无数据</div>';
        }
    } catch (error) {
        console.error('加载房源失败:', error);
        modalList.innerHTML = '<div class="loading">加载失败，请重试</div>';
    }
}

// 检查并显示新手引导（圆点颜色说明）
function checkAndShowDotColorGuide() {
    // 检查是否已显示过引导
    const hasShownGuide = localStorage.getItem('dotColorGuideShown');
    if (hasShownGuide === 'true') {
        return;
    }
    
    // 延迟显示，确保页面已加载
    setTimeout(() => {
        const guideOverlay = document.getElementById('dot-color-guide-overlay');
        const guideCloseBtn = document.getElementById('guide-close-btn');
        
        if (guideOverlay && guideCloseBtn) {
            guideOverlay.style.display = 'flex';
            
            // 点击"我知道了"按钮
            guideCloseBtn.addEventListener('click', () => {
                guideOverlay.style.display = 'none';
                localStorage.setItem('dotColorGuideShown', 'true');
            });
            
            // 点击背景关闭（可选）
            guideOverlay.addEventListener('click', (e) => {
                if (e.target === guideOverlay) {
                    guideOverlay.style.display = 'none';
                    localStorage.setItem('dotColorGuideShown', 'true');
                }
            });
        }
    }, 1500); // 延迟1.5秒显示，避免与免责声明冲突
}

// 渲染弹窗中的房源列表
function renderModalHousesList() {
    const modalList = document.getElementById('modal-houses-list');
    const showUnsoldOnlyCheckbox = document.getElementById('modal-show-unsold-only');
    
    if (!modalList || !showUnsoldOnlyCheckbox) return;
    
    // 根据开关状态过滤房源
    let filteredHouses = currentRoomHouses;
    if (showUnsoldOnlyCheckbox.checked) {
        filteredHouses = currentRoomHouses.filter(house => house.售出情况 !== '已售出');
    }
    
    if (filteredHouses.length > 0) {
        modalList.innerHTML = filteredHouses.map(house => `
            <div class="modal-house-card">
                <h4>${house.楼栋名} ${house.房号}号</h4>
                <div class="house-info">
                    <div class="house-info-item">
                        <span class="house-info-label">房型:</span>
                        <span class="house-info-value">${getDisplayRoomType(house)}</span>
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
            </div>
        `).join('');
    } else {
        modalList.innerHTML = '<div class="loading">暂无未售出房源</div>';
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
                            <span class="house-info-label">房型:</span>
                            <span class="house-info-value">${getDisplayRoomType(house)}</span>
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
    document.getElementById('btn-search').addEventListener('click', async () => {
        // 检查分数排序是否已选中
        const scoreFilter = document.getElementById('filter-score-sort');
        if (scoreFilter && !scoreFilter.disabled && scoreFilter.value) {
            // 如果分数排序已选中，重新获取所有筛选后的房源并重新排序
            await performScoreSorting();
        } else {
            // 如果分数排序未选中，清除排序状态，正常加载数据
            isScoreSortingActive = false;
            sortedAllHouses = [];
            currentPage = 1;
            loadHouses();
        }
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

// 执行分数排序（获取所有筛选后的房源，排序后保存到 sortedAllHouses）
async function performScoreSorting() {
    const scoreFilter = document.getElementById('filter-score-sort');
    if (!scoreFilter || scoreFilter.disabled || !scoreFilter.value) {
        return false;
    }
    
    const sortValue = scoreFilter.value;
    
    // 检查是否已有缓存的分数
    const hasCachedScores = Object.keys(allHousesScoresCache).length > 0;
    
    if (!hasCachedScores) {
        // 如果没有缓存，先计算当前页的分数
        await calculateScores();
        // 等待一下让后台计算开始
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 获取当前筛选条件，并应用到 /houses/all 请求中，保证排序基于当前筛选
    const rawRoomTypeSort = document.getElementById('filter-room-type').value;
    let roomTypeParamSort = '';
    if (rawRoomTypeSort) {
        if (ROOM_TYPE_GROUPS[rawRoomTypeSort]) {
            roomTypeParamSort = ROOM_TYPE_GROUPS[rawRoomTypeSort].join(',');
        } else {
            roomTypeParamSort = rawRoomTypeSort;
        }
    }
    const filtersForSort = new URLSearchParams();
    const buildingSort = document.getElementById('filter-building').value;
    const areaSort = document.getElementById('filter-area').value;
    const orientationSort = getCustomMultiselectValues('filter-orientation').join(',');
    const floorMinSort = document.getElementById('filter-floor-min').value;
    const floorMaxSort = document.getElementById('filter-floor-max').value;
    const soldSort = document.getElementById('filter-sold-status').value;
    const priceMinSort = document.getElementById('filter-price-min').value;
    const priceMaxSort = document.getElementById('filter-price-max').value;
    if (buildingSort) filtersForSort.append('楼栋', buildingSort);
    if (roomTypeParamSort) filtersForSort.append('房型', roomTypeParamSort);
    if (areaSort) filtersForSort.append('房子面积', areaSort);
    if (orientationSort) filtersForSort.append('房子朝向', orientationSort);
    if (floorMinSort) filtersForSort.append('楼层最低', floorMinSort);
    if (floorMaxSort) filtersForSort.append('楼层最高', floorMaxSort);
    if (soldSort) filtersForSort.append('售出情况', soldSort);
    if (priceMinSort) {
        const v = parseFloat(priceMinSort);
        if (!isNaN(v)) filtersForSort.append('价格最低', (v * 10000).toString());
    }
    if (priceMaxSort) {
        const v = parseFloat(priceMaxSort);
        if (!isNaN(v)) filtersForSort.append('价格最高', (v * 10000).toString());
    }

    // 获取所有房源数据用于排序（带当前筛选条件）
    const response = await fetch(`${API_BASE}/houses/all?${filtersForSort.toString()}`);
    if (!response.ok) {
        showToast('获取房源数据失败', 'error');
        return false;
    }
    
    const allHouses = await response.json();
    
    // 调试：检查第一个房源的数据完整性
    if (allHouses.length > 0) {
        const firstHouse = allHouses[0];
        console.log('获取到的房源数据示例（第一个）:', {
            id: firstHouse.id,
            楼栋名: firstHouse.楼栋名,
            房号: firstHouse.房号,
            朝向: firstHouse.朝向,
            噪音: firstHouse.噪音,
            景观: firstHouse.景观,
            价格: firstHouse.价格,
            房子楼层: firstHouse.房子楼层
        });
    }
    
    // 为所有房源添加缓存的展示分数（注意：只添加score属性，不修改其他字段）
    allHouses.forEach(house => {
        if (house.id && allHousesDisplayScores[house.id] !== undefined) {
            house.score = allHousesDisplayScores[house.id];
        } else if (house.id && allHousesScoresCache[house.id] !== undefined) {
            // 兜底：如果还没有生成映射分数，则先用原始分数
            house.score = allHousesScoresCache[house.id];
        } else if (!house.score) {
            // 如果缓存中没有，使用0
            house.score = 0;
        }
    });
    
    // 根据选择排序
    if (sortValue === 'desc') {
        allHouses.sort((a, b) => {
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
        allHouses.sort((a, b) => {
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
    
    // 将排序后的所有数据保存到全局变量（用于分页）
    sortedAllHouses = allHouses;
    isScoreSortingActive = true;
    currentPage = 1;
    
    // 重新渲染当前页（显示第一页）
    const pageSize = 20;
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageData = sortedAllHouses.slice(startIndex, endIndex);
    
    renderHousesList(pageData);
    
    // 更新分页信息
    const totalPages = Math.ceil(sortedAllHouses.length / pageSize);
    renderPagination({
        total: sortedAllHouses.length,
        total_pages: totalPages,
        page: currentPage,
        per_page: pageSize
    });
    
    return true;
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
            await performScoreSorting();
        } else {
            // 如果不排序，清除排序状态，重新加载数据（按数据库id排序）
            isScoreSortingActive = false;
            sortedAllHouses = [];
            currentPage = 1;
            loadHouses();
        }
    });
    
    // 去掉提示逻辑，不再显示引导弹窗
}

// 房型选项（具体户型）
const ROOM_TYPE_OPTIONS = [
    '70A', `70A'`, `70A''`,
    '70B', `70B'`,
    '70C', `70C'`,
    '90A', `90A'`,
    '90B', '90C'
];

// 房型分组（A/B/C户型→具体户型映射）
const ROOM_TYPE_GROUPS = {
    'A户型': ['70A', `70A'`, `70A''`, '90A', `90A'`],
    'B户型': ['70B', `70B'`, '90B'],
    'C户型': ['70C', `70C'`, '90C']
};

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
        
        // 房型筛选器：使用固定列表 + 分组选项，覆盖后端原有 A户型/B户型/C户型
        const roomTypeOptions = [...ROOM_TYPE_OPTIONS, ...Object.keys(ROOM_TYPE_GROUPS)];
        filterOptions.房型 = roomTypeOptions;
        populateSelect('filter-room-type', filterOptions.房型);
        populateSelect('filter-area', filterOptions.房子面积);
        populateCustomMultiselect('filter-orientation', filterOptions.房子朝向);
        // 楼层改为区间输入，不再使用下拉选项
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
    
    // 如果分数排序已激活，从已排序的完整列表中取对应页的数据
    const scoreFilter = document.getElementById('filter-score-sort');
    if (isScoreSortingActive && scoreFilter && !scoreFilter.disabled && scoreFilter.value && sortedAllHouses.length > 0) {
        const pageSize = 20;
        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const pageData = sortedAllHouses.slice(startIndex, endIndex);
        
        housesData = pageData;
        
        if (housesData.length > 0) {
            renderHousesList(housesData);
            
            // 更新分页信息
            const totalPages = Math.ceil(sortedAllHouses.length / pageSize);
            renderPagination({
                total: sortedAllHouses.length,
                total_pages: totalPages,
                page: currentPage,
                per_page: pageSize
            });
        } else {
            listContainer.innerHTML = '<div class="empty-state">暂无房源数据</div>';
            const totalPages = Math.ceil(sortedAllHouses.length / pageSize);
            renderPagination({
                total: sortedAllHouses.length,
                total_pages: totalPages,
                page: currentPage,
                per_page: pageSize
            });
        }
        return;
    }
    
    // 否则，正常从后端获取数据
    // 获取筛选条件
    const rawRoomType = document.getElementById('filter-room-type').value;
    let roomTypeParam = '';
    if (rawRoomType) {
        if (ROOM_TYPE_GROUPS[rawRoomType]) {
            // 分组：A户型/B户型/C户型 → 多个具体房型，用逗号分隔传给后端
            roomTypeParam = ROOM_TYPE_GROUPS[rawRoomType].join(',');
        } else {
            roomTypeParam = rawRoomType;
        }
    }

    const filters = {
        '楼栋': document.getElementById('filter-building').value,
        '房型': roomTypeParam,
        '房子面积': document.getElementById('filter-area').value,
        '房子朝向': getCustomMultiselectValues('filter-orientation').join(','),  // 多选，用逗号分隔
        '楼层最低': document.getElementById('filter-floor-min').value,
        '楼层最高': document.getElementById('filter-floor-max').value,
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
        
        // 如果缓存中有分数，应用到当前页的房源（优先使用映射后的展示分数）
        housesData.forEach(house => {
            if (house.id && allHousesDisplayScores[house.id] !== undefined) {
                house.score = allHousesDisplayScores[house.id];
            } else if (house.id && allHousesScoresCache[house.id] !== undefined) {
                // 兜底：如果还没有生成映射分数，则先用原始分数
                house.score = allHousesScoresCache[house.id];
            }
        });
        
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
        
        // 三期需求：添加"参考房型"按钮和合并房型显示
        const displayRoomType = getDisplayRoomType(house);
        const referenceButton = (displayRoomType && /^\d+[A-Z]/.test(displayRoomType)) ? 
            `<button class="btn-reference" data-image="image/${encodeURIComponent(displayRoomType)}.jpg" onclick="showRoomTypeImage('image/${encodeURIComponent(displayRoomType)}.jpg')">参考房型</button>` : '';
        
        return `
            <div class="house-card">
                <h3>${house.楼栋名} ${house.房号}号</h3>
                ${referenceButton}
                <div class="house-info">
                    <div class="house-info-item">
                        <span class="house-info-label">房型:</span>
                        <span class="house-info-value">${displayRoomType}</span>
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
    
    // 首页按钮
    html += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(1)" class="page-btn">首页</button>`;
    
    // 上一页
    html += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})" class="page-btn">上一页</button>`;
    
    // 计算页码范围（当前页前后5页）
    const pageRange = 5;
    let startPage, endPage;
    
    if (totalPages <= pageRange * 2 + 1) {
        // 如果总页数较少，显示所有页码
        startPage = 1;
        endPage = totalPages;
    } else {
        // 计算页码范围
        startPage = Math.max(1, currentPage - pageRange);
        endPage = Math.min(totalPages, currentPage + pageRange);
        
        // 如果当前页靠近首页，确保显示足够的页码
        if (currentPage <= pageRange) {
            endPage = Math.min(totalPages, pageRange * 2 + 1);
        }
        
        // 如果当前页靠近尾页，确保显示足够的页码
        if (currentPage > totalPages - pageRange) {
            startPage = Math.max(1, totalPages - pageRange * 2);
        }
    }
    
    // 如果开始页码不是1，显示首页和省略号
    if (startPage > 1) {
        html += `<button onclick="goToPage(1)" class="page-btn">1</button>`;
        if (startPage > 2) {
            html += `<span class="page-ellipsis">...</span>`;
        }
    }
    
    // 显示页码范围
    for (let i = startPage; i <= endPage; i++) {
        if (i === currentPage) {
            html += `<button class="page-btn page-btn-active" disabled>${i}</button>`;
        } else {
            html += `<button onclick="goToPage(${i})" class="page-btn">${i}</button>`;
        }
    }
    
    // 如果结束页码不是总页数，显示省略号和尾页
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            html += `<span class="page-ellipsis">...</span>`;
        }
        html += `<button onclick="goToPage(${totalPages})" class="page-btn">${totalPages}</button>`;
    }
    
    // 下一页
    html += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})" class="page-btn">下一页</button>`;
    
    // 尾页按钮
    html += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${totalPages})" class="page-btn">尾页</button>`;
    
    // 页码信息
    html += `<span class="page-info">第 ${currentPage} / ${totalPages} 页 (共 ${total} 条)</span>`;
    
    pagination.innerHTML = html;
}

// 跳转页面（全局函数，供HTML调用）
window.goToPage = function(page) {
    currentPage = page;
    loadHouses();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// 计算单个房源的分数
function calculateSingleHouseScore(house, averages) {
    // 确保权重和期望值已加载（防止计算时未加载）
    if (typeof weights === 'undefined' || !weights) {
        loadWeights();
    }
    
    const dimensionScores = {
        orientation: calculateOrientationScore(house, averages.orientation),
        price: calculatePriceScore(house, averages.price),
        noise: calculateNoiseScore(house, averages.noise),
        view: calculateViewScore(house, averages.view),
        floor: calculateFloorScore(house, averages.floor),
        roomType: calculateRoomTypeScore(house, averages.roomType),
        building: calculateBuildingScore(house, averages.building)
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
    
    // 楼栋修正
    const buildingCorrection = getBuildingCorrection(house.楼栋名 || '');
    const correctedBaseScore = baseScore * buildingCorrection;
    
    // 最终原始分数（0-100 区间附近，可能略大于100或小于0）
    let finalScore = correctedBaseScore;
    // 限制在 0-100 区间，便于后续全局线性映射
    finalScore = Math.max(0, Math.min(100, finalScore));
    return Math.round(finalScore * 100) / 100; // 保留两位小数（原始分）
}

// 显示/隐藏计算loading
function showCalculatingLoading(show, progress = 0) {
    let loadingEl = document.getElementById('calculating-loading');
    if (show) {
        if (!loadingEl) {
            loadingEl = document.createElement('div');
            loadingEl.id = 'calculating-loading';
            loadingEl.className = 'calculating-loading';
            loadingEl.innerHTML = `
                <div class="calculating-loading-content">
                    <div class="calculating-spinner"></div>
                    <div class="calculating-text">正在计算分数...</div>
                    <div class="calculating-progress">
                        <div class="calculating-progress-bar" id="calculating-progress-bar"></div>
                    </div>
                    <div class="calculating-percent" id="calculating-percent">0%</div>
                </div>
            `;
            document.body.appendChild(loadingEl);
        }
        loadingEl.style.display = 'flex';
        const progressBar = document.getElementById('calculating-progress-bar');
        const percentText = document.getElementById('calculating-percent');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
        if (percentText) {
            percentText.textContent = `${Math.round(progress)}%`;
        }
    } else {
        if (loadingEl) {
            loadingEl.style.display = 'none';
        }
    }
}

// 计算分数（优化版：快速计算，5秒内完成）
async function calculateScores() {
    try {
        // 如果正在计算，提示用户
        if (isCalculatingAllScores) {
            showToast('正在计算分数，请稍候...', 'info');
            return;
        }
        
        // 获取当前页的房源数据
        const currentHouses = [...housesData];
        
        if (currentHouses.length === 0) {
            alert('当前没有房源数据，请先搜索');
            return;
        }
        
        // 显示loading
        showCalculatingLoading(true, 0);
        
        // 获取当前筛选条件，并应用到 /houses/all 请求中，保证计算和排序都基于当前筛选
        const rawRoomType = document.getElementById('filter-room-type').value;
        let roomTypeParam = '';
        if (rawRoomType) {
            if (ROOM_TYPE_GROUPS[rawRoomType]) {
                roomTypeParam = ROOM_TYPE_GROUPS[rawRoomType].join(',');
            } else {
                roomTypeParam = rawRoomType;
            }
        }
        const filtersForAll = new URLSearchParams();
        const buildingVal = document.getElementById('filter-building').value;
        const areaVal = document.getElementById('filter-area').value;
        const orientationVals = getCustomMultiselectValues('filter-orientation').join(',');
        const floorMinVal = document.getElementById('filter-floor-min').value;
        const floorMaxVal = document.getElementById('filter-floor-max').value;
        const soldVal = document.getElementById('filter-sold-status').value;
        const priceMinInput = document.getElementById('filter-price-min').value;
        const priceMaxInput = document.getElementById('filter-price-max').value;
        if (buildingVal) filtersForAll.append('楼栋', buildingVal);
        if (roomTypeParam) filtersForAll.append('房型', roomTypeParam);
        if (areaVal) filtersForAll.append('房子面积', areaVal);
        if (orientationVals) filtersForAll.append('房子朝向', orientationVals);
        if (floorMinVal) filtersForAll.append('楼层最低', floorMinVal);
        if (floorMaxVal) filtersForAll.append('楼层最高', floorMaxVal);
        if (soldVal) filtersForAll.append('售出情况', soldVal);
        if (priceMinInput) {
            const v = parseFloat(priceMinInput);
            if (!isNaN(v)) filtersForAll.append('价格最低', (v * 10000).toString());
        }
        if (priceMaxInput) {
            const v = parseFloat(priceMaxInput);
            if (!isNaN(v)) filtersForAll.append('价格最高', (v * 10000).toString());
        }

        // 获取所有房源数据（用于计算平均值），带上当前筛选条件
        const response = await fetch(`${API_BASE}/houses/all?${filtersForAll.toString()}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const allHouses = await response.json();
        if (!allHouses || allHouses.length === 0) {
            alert('暂无房源数据');
            showCalculatingLoading(false);
            return;
        }
        
        // 计算所有房源的平均分（用于"无所谓"的情况）
        const averages = calculateAverages(allHouses);
        
        // 标记开始计算
        isCalculatingAllScores = true;
        const startTime = Date.now();
        const totalHouses = allHouses.length;
        
        // 优化：动态调整批次大小，目标5秒内完成
        // 估算：假设每个房源计算需要0.5ms，1000个房源需要500ms，加上UI更新，目标在2-3秒内完成
        const targetTime = 5000; // 5秒目标
        const estimatedTimePerHouse = 0.5; // 每个房源估算0.5ms
        const estimatedTotalTime = totalHouses * estimatedTimePerHouse;
        
        // 如果估算时间超过目标，使用更大的批次
        let batchSize = 200; // 默认每批200个
        if (estimatedTotalTime > targetTime) {
            // 需要加快速度，增加批次大小
            const batchesNeeded = Math.ceil(targetTime / 16); // requestAnimationFrame约16ms一次
            batchSize = Math.ceil(totalHouses / batchesNeeded);
        }
        
        let currentIndex = 0;
        let lastUpdateTime = startTime;
        
        const calculateBatch = () => {
            const endIndex = Math.min(currentIndex + batchSize, totalHouses);
            
            // 批量计算
            for (let i = currentIndex; i < endIndex; i++) {
                const house = allHouses[i];
                if (!allHousesScoresCache[house.id]) {
                    const score = calculateSingleHouseScore(house, averages);
                    allHousesScoresCache[house.id] = score;
                    house.score = score;
                } else {
                    house.score = allHousesScoresCache[house.id];
                }
            }
            
            currentIndex = endIndex;
            const progress = (currentIndex / totalHouses) * 100;
            
            // 更新进度（每50ms更新一次UI，避免过于频繁）
            const now = Date.now();
            if (now - lastUpdateTime >= 50 || currentIndex >= totalHouses) {
                showCalculatingLoading(true, progress);
                lastUpdateTime = now;
            }
            
            // 检查是否超时，如果接近5秒，加快速度
            const elapsed = Date.now() - startTime;
            if (elapsed > 4000 && currentIndex < totalHouses) {
                // 接近5秒，加快速度：直接计算剩余所有
                for (let i = currentIndex; i < totalHouses; i++) {
                    const house = allHouses[i];
                    if (!allHousesScoresCache[house.id]) {
                        const score = calculateSingleHouseScore(house, averages);
                        allHousesScoresCache[house.id] = score;
                        house.score = score;
                    } else {
                        house.score = allHousesScoresCache[house.id];
                    }
                }
                currentIndex = totalHouses;
                showCalculatingLoading(true, 100);
            }
            
            if (currentIndex < totalHouses) {
                // 使用 requestAnimationFrame 继续下一批（性能更好）
                requestAnimationFrame(calculateBatch);
            } else {
                finishCalculation();
            }
        };
        
        const finishCalculation = () => {
            // 计算全局原始分数的最小值和最大值
            const rawScores = Object.values(allHousesScoresCache);
            if (rawScores.length === 0) {
                isCalculatingAllScores = false;
                showCalculatingLoading(false);
                showToast('未计算到任何分数', 'error');
                return;
            }
            
            let minRaw = Math.min(...rawScores);
            let maxRaw = Math.max(...rawScores);
            
            // 避免所有分数相同导致除以0
            if (maxRaw === minRaw) {
                maxRaw = minRaw + 1;
            }
            
            const TARGET_MIN = 60;
            const TARGET_MAX = 99;
            const scale = (TARGET_MAX - TARGET_MIN) / (maxRaw - minRaw);
            
            // 生成映射后的展示分数缓存
            allHousesDisplayScores = {};
            Object.entries(allHousesScoresCache).forEach(([id, raw]) => {
                const mapped = TARGET_MIN + (raw - minRaw) * scale;
                const clamped = Math.max(TARGET_MIN, Math.min(TARGET_MAX, mapped));
                allHousesDisplayScores[id] = Math.round(clamped * 100) / 100;
            });
            
            isCalculatingAllScores = false;
            showCalculatingLoading(false);
            
            // 更新当前页显示（使用映射后的分数）
            currentHouses.forEach(house => {
                if (house.id && allHousesDisplayScores[house.id] !== undefined) {
                    house.score = allHousesDisplayScores[house.id];
                }
            });
            renderHousesList(currentHouses);
            
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            showToast(`分数计算完成（耗时 ${elapsed} 秒）`, 'success');
        };
        
        // 开始计算（使用 requestAnimationFrame 优化）
        requestAnimationFrame(calculateBatch);
        
    } catch (error) {
        console.error('计算分数失败:', error);
        alert('计算分数失败，请重试');
        isCalculatingAllScores = false;
        showCalculatingLoading(false);
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
    let icon, iconColor;
    if (type === 'success') {
        icon = '✓';
        iconColor = '#52c41a';
    } else if (type === 'error') {
        icon = '✗';
        iconColor = '#ff4d4f';
    } else if (type === 'info') {
        icon = 'ℹ';
        iconColor = '#1890ff';
    } else {
        icon = '✓';
        iconColor = '#52c41a';
    }
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
    
    if (!house.价格) {
        return 0;
    }
    
    // 如果没有设置期望价格，但权重不为0，使用默认逻辑（价格越低分数越高）
    if (!expectedPrice || expectedPrice <= 0) {
        // 使用所有房源的平均价格作为参考
        // 这里需要从外部传入平均价格，如果没有，使用当前房源价格的80%作为参考
        const referencePrice = averageScore > 0 ? (house.价格 * 100 / averageScore) : house.价格 * 0.8;
        const diffPercent = ((house.价格 - referencePrice) / referencePrice) * 100;
        
        // 价格低于参考价越多，分数越高
        if (diffPercent <= -20) return 100;
        if (diffPercent <= -10) return 90;
        if (diffPercent <= 0) return 75;
        if (diffPercent <= 10) return 50;
        if (diffPercent <= 20) return 30;
        return 10;
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
    // 标准化房号：将 "1栋B座" + "302" 转为 "1B02" 形式，便于与用户输入的房号匹配
    const fullBuilding = house.楼栋名 || '';
    const rawRoomNo = (house.房号 || '').toString().trim();
    let normalizedRoomNumber = fullBuilding + rawRoomNo;
    const buildingMatch = fullBuilding.match(/(\d+)栋([A-Z])座/);
    if (buildingMatch && rawRoomNo) {
        const buildingShort = `${buildingMatch[1]}${buildingMatch[2]}`;
        const unit = rawRoomNo.slice(-2); // 后两位作为房号
        normalizedRoomNumber = `${buildingShort}${unit}`;
    }
    
    // 使用梯度表计算分数
    const gradient = gradientConfig.view || { 1: [], 2: [], 3: [] };
    const viewRooms = gradientConfig.viewRooms || [];
    
    // 首先检查房号是否在第一梯队
    if (viewRooms.includes(normalizedRoomNumber)) {
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
    // 清空分数缓存
    allHousesScoresCache = {};
    allHousesDisplayScores = {};
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
    // 清空分数缓存，确保下次计算使用新配置
    allHousesScoresCache = {};
    allHousesDisplayScores = {};
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
    // 清空分数缓存
    allHousesScoresCache = {};
    allHousesDisplayScores = {};
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
    // 清空分数缓存，确保下次计算使用新权重
    allHousesScoresCache = {};
    allHousesDisplayScores = {};
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

// 三期需求：显示房型图片浮窗
function showRoomTypeImage(imagePath) {
    // 移除已存在的浮窗
    const existingModal = document.getElementById('room-type-modal');
    if (existingModal) {
        existingModal.remove();
    }
    
    // 创建浮窗
    const modal = document.createElement('div');
    modal.id = 'room-type-modal';
    modal.className = 'room-type-modal';
    modal.innerHTML = `
        <div class="room-type-modal-content">
            <span class="room-type-modal-close">&times;</span>
            <img src="${imagePath}" alt="房型图" class="room-type-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
            <div class="room-type-error" style="display: none; padding: 20px; text-align: center; color: #999;">
                图片加载失败
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 点击关闭按钮或背景关闭浮窗
    const closeBtn = modal.querySelector('.room-type-modal-close');
    const closeModal = () => {
        modal.remove();
    };
    
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
    
    // ESC键关闭
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}


