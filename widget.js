const NOTION_API_KEY = "secret_pNLmc1M6IlbkoiwoUrKnE2mzJlJGYZ61eppTt5tRZuR";
const DATABASE_ID = "468bf987e6cd4372abf96a8f30f165b1";
const CALENDAR_DB_ID = "ddfee91eec854db08c445b0fa1abd347";
const DDAY_DB_ID = "3ca479d92a3340b7813608b6dd7f4eac";
const CORS_PROXY = "https://corsproxy.io/?";

let viewMode = 'timeline';
let currentData = null;
let calendarData = null;
let ddayData = null;
let bookNames = {};
let currentDate = new Date();
currentDate.setHours(0, 0, 0, 0); // 초기화 시 시간을 00:00:00으로 설정
let calendarViewMode = false;
let calendarStartDate = new Date();
let calendarEndDate = new Date();
let lastSyncedItems = []; // 마지막 동기화로 생성된 항목 ID들
let dDayDate = localStorage.getItem('dDayDate') || null; // D-Day 날짜
let dDayTitle = localStorage.getItem('dDayTitle') || null; // D-Day 제목
let refreshTimer = null; // 디바운스용 타이머
let renderTimer = null; // 렌더링 디바운스용 타이머
let renderDataTimer = null; // 플래너 렌더링 디바운스용 타이머
let undoStack = []; // 실행 취소 스택
let redoStack = []; // 다시 실행 스택
const MAX_HISTORY = 50; // 최대 히스토리 개수
let loadingLogs = []; // 로딩 로그 {message: string, status: 'loading'|'completed'}
let loadingCount = 0; // 진행중인 작업 수

// 로딩 로그 관리
function startLoading(message) {
  loadingCount++;
  loadingLogs.push({ message, status: 'loading' });
  updateLoadingIndicator();
}

function completeLoading(message) {
  loadingCount = Math.max(0, loadingCount - 1);

  // 마지막으로 등장한 해당 메시지를 찾아서 완료로 변경
  for (let i = loadingLogs.length - 1; i >= 0; i--) {
    if (loadingLogs[i].message === message && loadingLogs[i].status === 'loading') {
      loadingLogs[i].status = 'completed';
      break;
    }
  }

  // 최대 20개까지만 유지
  if (loadingLogs.length > 20) {
    loadingLogs = loadingLogs.slice(-20);
  }

  updateLoadingIndicator();
}

function updateLoadingIndicator() {
  const loading = document.getElementById('loading');
  if (!loading) return;

  const logText = loadingLogs.length > 0
    ? loadingLogs.slice(-10).map(log =>
        log.status === 'loading' ? log.message : `${log.message} ✓`
      ).join('\n')
    : '작업 로그가 없습니다';

  if (loadingCount > 0) {
    loading.textContent = '⏳';
  } else {
    loading.textContent = '';
  }

  loading.title = logText;
}

// 히스토리에 작업 추가
function addToHistory(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_HISTORY) {
    undoStack.shift(); // 오래된 항목 제거
  }
  redoStack = []; // 새 작업이 추가되면 redo 스택 초기화
}

// 실행 취소
async function undo() {
  if (undoStack.length === 0) return;

  const action = undoStack.pop();

  startLoading('실행 취소');

  try {
    if (action.type === 'UPDATE') {
      // 이전 상태로 복원
      await updateNotionPage(action.itemId, action.before);
      redoStack.push(action);
    } else if (action.type === 'DELETE') {
      // 삭제된 항목 다시 생성
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent('https://api.notion.com/v1/pages')}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: action.databaseId },
          properties: action.before
        })
      });
      if (response.ok) {
        const result = await response.json();
        redoStack.push({...action, itemId: result.id}); // 새로운 ID로 저장
      }
    } else if (action.type === 'CREATE') {
      // 생성된 항목 삭제
      await fetch(`${CORS_PROXY}${encodeURIComponent(`https://api.notion.com/v1/pages/${action.itemId}`)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ archived: true })
      });
      redoStack.push(action);
    }

    await fetchAllData();
    if (calendarViewMode) {
      renderCalendarView();
    }
    completeLoading('실행 취소');
  } catch (error) {
    console.error('Undo failed:', error);
    completeLoading('실행 취소 실패');
  }
}

// 다시 실행
async function redo() {
  if (redoStack.length === 0) return;

  const action = redoStack.pop();

  startLoading('다시 실행');

  try {
    if (action.type === 'UPDATE') {
      // 이후 상태로 복원
      await updateNotionPage(action.itemId, action.after);
      undoStack.push(action);
    } else if (action.type === 'DELETE') {
      // 다시 삭제
      await fetch(`${CORS_PROXY}${encodeURIComponent(`https://api.notion.com/v1/pages/${action.itemId}`)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ archived: true })
      });
      undoStack.push(action);
    } else if (action.type === 'CREATE') {
      // 다시 생성
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent('https://api.notion.com/v1/pages')}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: action.databaseId },
          properties: action.after
        })
      });
      if (response.ok) {
        const result = await response.json();
        undoStack.push({...action, itemId: result.id});
      }
    }

    await fetchAllData();
    if (calendarViewMode) {
      renderCalendarView();
    }
    completeLoading('다시 실행');
  } catch (error) {
    console.error('Redo failed:', error);
    completeLoading('다시 실행 실패');
  }
}

// 디바운스된 새로고침 함수
function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    fetchAllData();
    refreshTimer = null;
  }, 2000); // 2초 후 새로고침
}

function scheduleRender() {
  if (renderTimer) {
    clearTimeout(renderTimer);
  }
  renderTimer = setTimeout(() => {
    renderCalendarView();
    renderTimer = null;
  }, 500); // 0.5초 후 렌더링
}

function scheduleRenderData() {
  if (renderDataTimer) {
    clearTimeout(renderDataTimer);
  }
  renderDataTimer = setTimeout(() => {
    renderData();
    renderDataTimer = null;
  }, 300); // 0.3초 후 렌더링
}

// 전역 함수 등록
window.changeDate = function(days) {
  currentDate.setDate(currentDate.getDate() + days);
  renderData();
};

window.goToday = function() {
  currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0); // 시간을 명시적으로 00:00:00으로 설정
  renderData();
};

window.toggleDDaySelector = async function() {
  const content = document.getElementById('content');

  // 이미 열려있으면 닫기
  if (ddaySelectorOpen) {
    ddaySelectorOpen = false;
    renderData();
    return;
  }

  ddaySelectorOpen = true;

  // D-Day 데이터 가져오기
  await fetchDDayData();

  if (!ddayData || !ddayData.results) {
    content.innerHTML = '<div class="empty-message">D-Day 항목을 불러올 수 없습니다.</div>';
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // API에서 이미 필터링된 데이터
  const ddayItems = ddayData.results;

  if (ddayItems.length === 0) {
    content.innerHTML = '<div class="empty-message">디데이 표시된 미래 항목이 없습니다.</div>';
    return;
  }

  // 날짜순 정렬
  ddayItems.sort((a, b) => {
    const dateA = new Date(a.properties?.['date']?.date?.start);
    const dateB = new Date(b.properties?.['date']?.date?.start);
    return dateA - dateB;
  });

  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h3 style="margin: 0; font-size: 14px; font-weight: 600;">D-Day 선택</h3>
      <button onclick="renderData()" style="font-size: 12px; padding: 4px 8px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">닫기</button>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px;">
  `;

  ddayItems.forEach(item => {
    const title = item.properties?.['이름']?.title?.[0]?.plain_text || '제목 없음';
    const dateStr = item.properties?.['date']?.date?.start || '';
    const isSelected = dDayDate === dateStr;

    // D-Day 계산
    const itemDate = new Date(dateStr);
    itemDate.setHours(0, 0, 0, 0);
    const diffTime = itemDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    let dDayText = '';
    if (diffDays === 0) {
      dDayText = 'D-Day';
    } else if (diffDays > 0) {
      dDayText = `D-${diffDays}`;
    }

    html += `
      <button onclick="selectDDay('${dateStr}', '${title.replace(/'/g, "\\'")}', '${item.id}')"
        style="padding: 12px; background: ${isSelected ? '#999' : '#f5f5f7'}; color: ${isSelected ? 'white' : '#333'};
        border: 1px solid ${isSelected ? '#999' : '#e5e5e7'}; border-radius: 8px; cursor: pointer; text-align: left; font-size: 13px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 500;">${title}</span>
        <span style="font-weight: 600; font-size: 14px; opacity: ${isSelected ? '1' : '0.7'};">${dDayText}</span>
      </button>
    `;
  });

  html += `
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px;">
      <button onclick="addDDay()" style="padding: 8px; background: #34C759; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">추가</button>
      <button onclick="clearDDay()" style="padding: 8px; background: #FF3B30; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">D-Day 제거</button>
    </div>
  `;

  content.innerHTML = html;
};

window.selectDDay = function(date, title, itemId) {
  dDayDate = date;
  dDayTitle = title;
  localStorage.setItem('dDayDate', date);
  localStorage.setItem('dDayTitle', title);
  ddaySelectorOpen = false;
  updateDDayButton();
  renderData();
};

window.clearDDay = function() {
  dDayDate = null;
  dDayTitle = null;
  localStorage.removeItem('dDayDate');
  localStorage.removeItem('dDayTitle');
  ddaySelectorOpen = false;
  updateDDayButton();
  renderData();
};

window.addDDay = function() {
  const content = document.getElementById('content');

  content.innerHTML = `
    <div style="padding: 20px;">
      <h3 style="margin-bottom: 16px; font-size: 14px; font-weight: 600;">D-Day 추가</h3>

      <div style="margin-bottom: 12px;">
        <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">이름</label>
        <input type="text" id="new-dday-title" placeholder="이벤트 이름"
          style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px;">
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">속성</label>
        <input type="text" id="new-dday-property" placeholder="속성"
          style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px;">
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display: block; font-size: 11px; color: #86868b; margin-bottom: 4px;">날짜</label>
        <input type="date" id="new-dday-date"
          style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px;">
      </div>

      <div style="display: flex; gap: 8px;">
        <button onclick="confirmAddDDay()" style="flex: 1; padding: 8px; background: #34C759; color: white; border: none; border-radius: 4px; cursor: pointer;">추가</button>
        <button onclick="cancelAddDDay()" style="flex: 1; padding: 8px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">취소</button>
      </div>
    </div>
  `;

  setTimeout(() => {
    document.getElementById('new-dday-title').focus();
  }, 100);
};

window.confirmAddDDay = async function() {
  const titleInput = document.getElementById('new-dday-title');
  const propertyInput = document.getElementById('new-dday-property');
  const dateInput = document.getElementById('new-dday-date');

  const title = titleInput.value.trim();
  const property = propertyInput.value.trim();
  const date = dateInput.value;

  if (!title || !date) {
    return;
  }

  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    const properties = {
      '이름': {
        title: [{ text: { content: title } }]
      },
      'date': {
        date: { start: date }
      },
      '디데이 표시': {
        checkbox: true
      }
    };

    if (property) {
      properties['속성'] = {
        rich_text: [{ text: { content: property } }]
      };
    }

    const notionUrl = 'https://api.notion.com/v1/pages';
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DDAY_DB_ID },
        properties: properties
      })
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message || '추가 실패');
    }

    await fetchDDayData();
    await toggleDDaySelector();
  } catch (error) {
    console.error('D-Day 추가 오류:', error);
  } finally {
    loading.textContent = '';
  }
};

window.cancelAddDDay = function() {
  toggleDDaySelector();
};

function autoSelectClosestDDay() {
  if (!ddayData || !ddayData.results) {
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // API에서 이미 필터링되고 정렬된 데이터
  if (ddayData.results.length === 0) {
    return;
  }

  // 가장 가까운 D-Day 선택 (이미 날짜순 정렬됨)
  const closestDDay = ddayData.results[0];
  const title = closestDDay.properties?.['이름']?.title?.[0]?.plain_text || '제목 없음';
  const date = closestDDay.properties?.['date']?.date?.start || '';

  dDayDate = date;
  dDayTitle = title;
  localStorage.setItem('dDayDate', date);
  localStorage.setItem('dDayTitle', title);
  updateDDayButton();
}

let plannerCalendarViewMode = false;
let calendarViewYear = new Date().getFullYear();
let calendarViewMonth = new Date().getMonth();
let ddaySelectorOpen = false;

window.togglePlannerCalendar = function() {
  plannerCalendarViewMode = !plannerCalendarViewMode;
  renderCalendarView();
};

window.changeCalendarMonth = function(delta) {
  calendarViewMonth += delta;
  if (calendarViewMonth > 11) {
    calendarViewMonth = 0;
    calendarViewYear++;
  } else if (calendarViewMonth < 0) {
    calendarViewMonth = 11;
    calendarViewYear--;
  }
  renderCalendarView();
};

window.goToCurrentMonth = function() {
  const now = new Date();
  calendarViewYear = now.getFullYear();
  calendarViewMonth = now.getMonth();
  renderCalendarView();
};

function renderPlannerCalendarHTML() {
  if (!currentData || !currentData.results) return '';

  // 날짜별로 그룹화
  const tasksByDate = {};
  currentData.results.forEach(item => {
    const dateStart = item.properties?.['날짜']?.date?.start;
    if (dateStart) {
      if (!tasksByDate[dateStart]) {
        tasksByDate[dateStart] = [];
      }
      tasksByDate[dateStart].push(item);
    }
  });

  // 현재 월의 첫날과 마지막날 계산
  const today = new Date();
  const year = calendarViewYear;
  const month = calendarViewMonth;

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // 달력 시작일 (첫주 일요일)
  const calendarStart = new Date(firstDay);
  calendarStart.setDate(calendarStart.getDate() - calendarStart.getDay());

  // 달력 끝일 (마지막주 토요일)
  const calendarEnd = new Date(lastDay);
  calendarEnd.setDate(calendarEnd.getDate() + (6 - calendarEnd.getDay()));

  let html = `
    <div style="padding: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <button onclick="changeCalendarMonth(-1)" style="font-size: 16px; padding: 4px 8px; background: none; border: none; cursor: pointer; color: #999;">◀</button>
        <h3 onclick="goToCurrentMonth()" style="margin: 0; font-size: 16px; font-weight: 600; cursor: pointer;">${year}년 ${month + 1}월</h3>
        <button onclick="changeCalendarMonth(1)" style="font-size: 16px; padding: 4px 8px; background: none; border: none; cursor: pointer; color: #999;">▶</button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 4px;">
        <div style="text-align: center; font-size: 11px; color: #FF3B30; font-weight: 600; padding: 4px;">일</div>
        <div style="text-align: center; font-size: 11px; color: #666; font-weight: 600; padding: 4px;">월</div>
        <div style="text-align: center; font-size: 11px; color: #666; font-weight: 600; padding: 4px;">화</div>
        <div style="text-align: center; font-size: 11px; color: #666; font-weight: 600; padding: 4px;">수</div>
        <div style="text-align: center; font-size: 11px; color: #666; font-weight: 600; padding: 4px;">목</div>
        <div style="text-align: center; font-size: 11px; color: #666; font-weight: 600; padding: 4px;">금</div>
        <div style="text-align: center; font-size: 11px; color: #007AFF; font-weight: 600; padding: 4px;">토</div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;">
  `;

  const currentLoop = new Date(calendarStart);
  const todayStr = formatDateToLocalString(today);

  while (currentLoop <= calendarEnd) {
    const dateStr = formatDateToLocalString(currentLoop);
    const date = currentLoop.getDate();
    const isCurrentMonth = currentLoop.getMonth() === month;
    const isToday = dateStr === todayStr;
    const tasks = tasksByDate[dateStr] || [];

    // 시간 통계 계산
    let totalTarget = 0;
    let totalActual = 0;

    tasks.forEach(task => {
      const targetTime = task.properties?.['목표 시간']?.number || 0;
      totalTarget += targetTime;

      const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text || '';
      if (end) {
        const actualProp = task.properties?.['실제 시간'];
        if (actualProp?.type === 'formula') {
          if (actualProp.formula?.type === 'number') {
            totalActual += actualProp.formula.number || 0;
          } else if (actualProp.formula?.type === 'string') {
            const str = actualProp.formula.string || '';
            const hourMatch = str.match(/(\d+)시간/);
            const minMatch = str.match(/(\d+)분/);
            const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
            const mins = minMatch ? parseInt(minMatch[1]) : 0;
            totalActual += hours * 60 + mins;
          }
        }
      }
    });

    const totalDiff = totalActual - totalTarget;
    const diffColor = totalDiff > 0 ? '#FF3B30' : totalDiff < 0 ? '#34C759' : '#86868b';

    const dayOfWeek = currentLoop.getDay();
    const dayColor = dayOfWeek === 0 ? '#FF3B30' : dayOfWeek === 6 ? '#007AFF' : '#333';

    html += `
      <div onclick="goToDate('${dateStr}')" style="
        background: ${isToday ? '#d0d0d0' : '#f5f5f7'};
        border: 1px solid ${isToday ? '#c0c0c0' : '#e5e5e7'};
        border-radius: 8px;
        padding: 6px;
        min-height: 70px;
        cursor: pointer;
        opacity: ${isCurrentMonth ? '1' : '0.3'};
      ">
        <div style="font-size: 12px; font-weight: 600; color: ${isToday ? '#333' : dayColor}; margin-bottom: 4px;">${date}</div>
        <div style="font-size: 9px; color: #86868b; line-height: 1.4; text-align: right;">
          <div>${formatMinutesToClock(totalTarget)}</div>
          <div style="font-weight: 700; color: #333;">${formatMinutesToClock(totalActual)}</div>
        </div>
      </div>
    `;

    currentLoop.setDate(currentLoop.getDate() + 1);
  }

  html += `
      </div>
    </div>
  `;

  return html;
}

window.goToDate = function(dateStr) {
  // YYYY-MM-DD 형식을 로컬 날짜로 변환
  const [year, month, day] = dateStr.split('-').map(Number);
  currentDate = new Date(year, month - 1, day);
  currentDate.setHours(0, 0, 0, 0); // 시간을 명시적으로 00:00:00으로 설정
  calendarViewMode = false;
  plannerCalendarViewMode = false;
  const viewToggle = document.getElementById('view-toggle');
  viewToggle.textContent = viewMode === 'timeline' ? 'TIME TABLE' : 'TASK';
  renderData();
};

function getDDayString() {
  if (!dDayDate) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(dDayDate);
  targetDate.setHours(0, 0, 0, 0);

  const diffTime = targetDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return ' D-Day';
  if (diffDays > 0) return ` D-${diffDays}`;
  return ` D+${Math.abs(diffDays)}`;
}

window.toggleCalendarView = async function(targetDate = null) {
  const viewToggle = document.getElementById('view-toggle');

  // targetDate가 있으면 날짜를 설정하고 캘린더 뷰에서 나가기
  if (targetDate) {
    // YYYY-MM-DD 형식을 로컬 날짜로 변환
    const [year, month, day] = targetDate.split('-').map(Number);
    currentDate = new Date(year, month - 1, day);
    currentDate.setHours(0, 0, 0, 0); // 시간을 명시적으로 00:00:00으로 설정
    calendarViewMode = false;
    plannerCalendarViewMode = false;
    viewToggle.textContent = viewMode === 'timeline' ? 'TIME TABLE' : 'TASK';
    renderData();
    return;
  }

  // targetDate가 없으면 일반 토글
  calendarViewMode = !calendarViewMode;

  if (calendarViewMode) {
    // 프리플랜으로 진입
    plannerCalendarViewMode = false;
    viewToggle.textContent = 'LIST';

    // 전날부터 2주 보기
    calendarStartDate = new Date();
    calendarStartDate.setHours(0, 0, 0, 0);
    calendarStartDate.setDate(calendarStartDate.getDate() - 1); // 전날부터 시작
    calendarEndDate = new Date(calendarStartDate);
    calendarEndDate.setDate(calendarEndDate.getDate() + 14);
    renderCalendarView();
  } else {
    // 프리플랜에서 나가기
    plannerCalendarViewMode = false;
    viewToggle.textContent = viewMode === 'timeline' ? 'TIME TABLE' : 'TASK';
    renderData();
  }
};

window.editTask = async function(taskId) {
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;
  
  const title = task.properties?.['범위']?.title?.[0]?.plain_text || '';
  const bookRelation = task.properties?.['책']?.relation?.[0];
  const bookId = bookRelation?.id || '';
  const targetTime = task.properties?.['목표 시간']?.number || '';
  const dateStart = task.properties?.['날짜']?.date?.start || '';
  const start = task.properties?.['시작']?.rich_text?.[0]?.plain_text || '';
  const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text || '';
  const rating = task.properties?.['(੭•̀ᴗ•̀)੭']?.select?.name || '';
  
  const bookList = Object.entries(bookNames).map(([id, name]) => 
    `<option value="${id}" ${id === bookId ? 'selected' : ''}>${name}</option>`
  ).join('');
  
  const content = document.getElementById('content');
  
  content.innerHTML = `
    <div style="padding: 20px;">
      <h3 style="margin-bottom: 12px;">할 일 수정</h3>
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">범위</label>
      <input type="text" id="edit-task-title" value="${title}" placeholder="할 일 제목" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">책</label>
      <select id="edit-task-book" style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
        <option value="">선택 안 함</option>
        ${bookList}
      </select>
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">목표 시간 (분)</label>
      <input type="number" id="edit-task-time" value="${targetTime}" placeholder="60" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">날짜</label>
      <input type="date" id="edit-task-date" value="${dateStart}" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">시작 시간</label>
      <input type="text" id="edit-task-start" value="${start}" placeholder="09:00" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">끝 시간</label>
      <input type="text" id="edit-task-end" value="${end}" placeholder="10:00" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">집중도</label>
      <select id="edit-task-rating" style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
        <option value="" ${!rating ? 'selected' : ''}>선택 안 함</option>
        <option value="..." ${rating === '...' ? 'selected' : ''}>...</option>
        <option value="⭐️" ${rating === '⭐️' ? 'selected' : ''}>⭐️</option>
        <option value="⭐️⭐️" ${rating === '⭐️⭐️' ? 'selected' : ''}>⭐️⭐️</option>
        <option value="⭐️⭐️⭐️" ${rating === '⭐️⭐️⭐️' ? 'selected' : ''}>⭐️⭐️⭐️</option>
        <option value="🌟 🌟 🌟" ${rating === '🌟 🌟 🌟' ? 'selected' : ''}>🌟 🌟 🌟</option>
      </select>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
        <button onclick="cancelEdit()" style="padding: 8px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">취소</button>
        <button onclick="confirmEditTask('${taskId}')" style="padding: 8px; background: #007AFF; color: white; border: none; border-radius: 4px; cursor: pointer;">저장</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <button onclick="duplicateTask('${taskId}')" style="padding: 8px; background: #34C759; color: white; border: none; border-radius: 4px; cursor: pointer;">복제</button>
        <button onclick="deleteTask('${taskId}')" style="padding: 8px; background: #FF3B30; color: white; border: none; border-radius: 4px; cursor: pointer;">삭제</button>
      </div>
    </div>
  `;
};

window.duplicateTask = async function(taskId) {
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;

  const originalTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '';

  startLoading(`${originalTitle} 복제`);

  try {
    
    // (숫자) 찾아서 증가
    const numberMatch = originalTitle.match(/\((\d+)\)$/);
    let newTitle;
    if (numberMatch) {
      const num = parseInt(numberMatch[1]);
      newTitle = originalTitle.replace(/\(\d+\)$/, `(${num + 1})`);
    } else {
      newTitle = originalTitle + ' (2)';
    }
    
    const bookRelation = task.properties?.['책']?.relation?.[0];
    const targetTime = task.properties?.['목표 시간']?.number;
    const dateStart = task.properties?.['날짜']?.date?.start;
    const plannerRelation = task.properties?.['PLANNER']?.relation;
    // 시작/끝 시간은 복제하지 않음

    const properties = {
      '범위': {
        title: [{ text: { content: newTitle } }]
      },
      '완료': { checkbox: false }
    };

    if (bookRelation) {
      properties['책'] = { relation: [{ id: bookRelation.id }] };
    }

    if (targetTime) {
      properties['목표 시간'] = { number: targetTime };
    }

    if (dateStart) {
      properties['날짜'] = { date: { start: dateStart } };
    }

    // 우선순위 복사
    const priority = task.properties?.['우선순위']?.select?.name;
    if (priority) {
      properties['우선순위'] = { select: { name: priority } };
    }

    // PLANNER 관계형 복사
    if (plannerRelation && plannerRelation.length > 0) {
      properties['PLANNER'] = { relation: plannerRelation.map(r => ({ id: r.id })) };
    }
    
    const notionUrl = 'https://api.notion.com/v1/pages';
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: properties
      })
    });

    if (!response.ok) throw new Error('복제 실패');

    // 원본 항목을 완료 처리
    const updateUrl = `https://api.notion.com/v1/pages/${taskId}`;
    await fetch(`${CORS_PROXY}${encodeURIComponent(updateUrl)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          '완료': { checkbox: true }
        }
      })
    });

    // 즉시 UI 업데이트
    await fetchAllData();
    completeLoading(`${originalTitle} 복제`);
  } catch (error) {
    console.error('복제 실패:', error);
    completeLoading(`${originalTitle} 복제 실패`);
  }
};

window.confirmEditTask = async function(taskId) {
  const titleInput = document.getElementById('edit-task-title');
  const bookSelect = document.getElementById('edit-task-book');
  const timeInput = document.getElementById('edit-task-time');
  const dateInput = document.getElementById('edit-task-date');
  const startInput = document.getElementById('edit-task-start');
  const endInput = document.getElementById('edit-task-end');
  const ratingSelect = document.getElementById('edit-task-rating');

  const title = titleInput.value.trim();

  if (!title) {
    return;
  }

  // 바로 창 닫기
  renderData();

  startLoading(`${title} 수정`);

  // 백그라운드에서 업데이트
  (async () => {
    try {
      const properties = {
        '범위': {
          title: [{ text: { content: title } }]
        }
      };

      if (bookSelect.value) {
        properties['책'] = { relation: [{ id: bookSelect.value }] };
      } else {
        properties['책'] = { relation: [] };
      }

      if (timeInput.value) {
        properties['목표 시간'] = { number: parseInt(timeInput.value) };
      }

      if (dateInput.value) {
        properties['날짜'] = { date: { start: dateInput.value } };
      }

      // 시작 시간 (빈 값도 업데이트)
      if (startInput.value) {
        const formattedStart = formatTimeInput(startInput.value);
        properties['시작'] = { rich_text: [{ type: 'text', text: { content: formattedStart } }] };
      } else {
        properties['시작'] = { rich_text: [] };
      }

      // 끝 시간 (빈 값도 업데이트)
      if (endInput.value) {
        const formattedEnd = formatTimeInput(endInput.value);
        properties['끝'] = { rich_text: [{ type: 'text', text: { content: formattedEnd } }] };
      } else {
        properties['끝'] = { rich_text: [] };
      }

      if (ratingSelect.value) {
        properties['(੭•̀ᴗ•̀)੭'] = { select: { name: ratingSelect.value } };
      } else {
        properties['(੭•̀ᴗ•̀)੭'] = { select: null };
      }

      await updateNotionPage(taskId, properties);
      await fetchAllData();
      completeLoading(`${title} 수정`);
    } catch (error) {
      console.error('수정 실패:', error);
      completeLoading(`${title} 수정 실패`);
    }
  })();
};

window.deleteTask = async function(taskId) {
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;

  const taskTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '항목';

  startLoading(`${taskTitle} 삭제`);

  // 히스토리에 추가 (삭제 전 상태 저장)
  addToHistory({
    type: 'DELETE',
    itemId: taskId,
    databaseId: DATABASE_ID,
    before: task.properties
  });

  // 바로 창 닫기
  renderData();

  // 백그라운드에서 삭제
  (async () => {
    try {
      const notionUrl = `https://api.notion.com/v1/pages/${taskId}`;
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          archived: true
        })
      });

      if (!response.ok) throw new Error('삭제 실패');

      await fetchAllData();
      completeLoading(`${taskTitle} 삭제`);
    } catch (error) {
      console.error('삭제 실패:', error);
      completeLoading(`${taskTitle} 삭제 실패`);
    }
  })();
};

window.cancelEdit = function() {
  renderData();
};

window.addNewTask = async function() {
  const bookList = Object.entries(bookNames).map(([id, name]) => 
    `<option value="${id}">${name}</option>`
  ).join('');
  
  const content = document.getElementById('content');
  
  content.innerHTML = `
    <div style="padding: 20px;">
      <h3 style="margin-bottom: 12px;">새 할 일 추가</h3>
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">범위</label>
      <input type="text" id="new-task-title" placeholder="할 일 제목" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">책</label>
      <select id="new-task-book" style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
        <option value="">선택 안 함</option>
        ${bookList}
      </select>
      
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: #666;">목표 시간 (분)</label>
      <input type="number" id="new-task-time" placeholder="60" 
        style="width: 100%; padding: 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 13px; margin-bottom: 12px;">
      
      <div style="display: flex; gap: 8px;">
        <button onclick="confirmAddTask()" style="flex: 1; padding: 8px; background: #007AFF; color: white; border: none; border-radius: 4px; cursor: pointer;">추가</button>
        <button onclick="cancelAddTask()" style="flex: 1; padding: 8px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">취소</button>
      </div>
    </div>
  `;
  
  setTimeout(() => {
    document.getElementById('new-task-title').focus();
  }, 100);
};

window.confirmAddTask = async function() {
  const titleInput = document.getElementById('new-task-title');
  const bookSelect = document.getElementById('new-task-book');
  const timeInput = document.getElementById('new-task-time');
  
  const title = titleInput.value.trim();

  if (!title) {
    return;
  }

  startLoading(`${title} 추가`);

  try {
    const todayDate = currentDate.toISOString().split('T')[0];
    
    const properties = {
      '범위': {
        title: [{ text: { content: title } }]
      },
      '날짜': {
        date: { start: todayDate }
      },
      '완료': { checkbox: false }
    };
    
    if (bookSelect.value) {
      properties['책'] = {
        relation: [{ id: bookSelect.value }]
      };
    }
    
    if (timeInput.value) {
      properties['목표 시간'] = {
        number: parseInt(timeInput.value)
      };
    }
    
    const existingPriorities = currentData.results
      .map(t => t.properties?.['우선순위']?.select?.name)
      .filter(Boolean)
      .map(p => parseInt(p.replace(/\D/g, '')));
    
    const nextPriority = existingPriorities.length > 0 
      ? Math.max(...existingPriorities) + 1 
      : 1;
    
    if (nextPriority <= 20) {
      const priorityOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];
      properties['우선순위'] = {
        select: { name: priorityOrder[nextPriority - 1] }
      };
    }
    
    const notionUrl = 'https://api.notion.com/v1/pages';
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: properties
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || '추가 실패');
    }

    await fetchAllData();
    completeLoading(`${title} 추가`);
  } catch (error) {
    console.error('할 일 추가 오류:', error);
    completeLoading(`${title} 추가 실패`);
  }
};

window.cancelAddTask = function() {
  renderData();
};

window.toggleComplete = async function(taskId, completed) {
  // 백업
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;
  const originalCompleted = task.properties['완료'].checkbox;

  const taskTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '항목';
  const action = completed ? '완료 처리' : '미완료 처리';

  startLoading(`${taskTitle} ${action}`);

  // 히스토리에 추가
  addToHistory({
    type: 'UPDATE',
    itemId: taskId,
    before: { '완료': { checkbox: originalCompleted } },
    after: { '완료': { checkbox: completed } }
  });

  // UI 업데이트
  task.properties['완료'].checkbox = completed;

  // 백그라운드에서 API 호출
  try {
    await updateNotionPage(taskId, {
      '완료': { checkbox: completed }
    });
    completeLoading(`${taskTitle} ${action}`);
    scheduleRenderData();
  } catch (error) {
    console.error('업데이트 실패:', error);
    completeLoading(`${taskTitle} ${action} 실패`);
    // 실패시 롤백
    task.properties['완료'].checkbox = originalCompleted;
    scheduleRenderData();
  }
};

window.formatTimeInput = function(value) {
  // 빈 값이면 그대로 반환
  if (!value || !value.trim()) return value;

  // 이미 콜론이 있으면 그대로 반환
  if (value.includes(':')) return value;

  // 숫자만 추출
  const numbers = value.replace(/\D/g, '');

  // 숫자가 없으면 빈 문자열
  if (!numbers) return '';

  // 길이에 따라 포맷팅
  if (numbers.length <= 2) {
    // 1자리나 2자리: 시간만 (예: 9 -> 09:00, 11 -> 11:00)
    return numbers.padStart(2, '0') + ':00';
  } else if (numbers.length === 3) {
    // 3자리: 첫 자리는 시간, 나머지는 분 (예: 930 -> 09:30)
    return '0' + numbers[0] + ':' + numbers.slice(1);
  } else {
    // 4자리 이상: 앞 2자리 시간, 다음 2자리 분 (예: 1130 -> 11:30)
    return numbers.slice(0, 2) + ':' + numbers.slice(2, 4);
  }
};

window.updateTime = async function(taskId, field, value, inputElement) {
  // 시간 포맷 자동 변환
  const formattedValue = formatTimeInput(value);

  // 입력 필드 업데이트
  if (inputElement) {
    inputElement.value = formattedValue;
  }

  // 백업
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;
  const originalValue = task.properties[field]?.rich_text?.[0]?.plain_text || '';

  const taskTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '항목';
  const fieldName = field === '시작' ? '시작 시간' : '끝 시간';

  // UI 즉시 업데이트 (빈 값이든 아니든)
  if (!task.properties[field]) {
    task.properties[field] = { rich_text: [] };
  }

  if (formattedValue.trim()) {
    task.properties[field].rich_text = [{ type: 'text', text: { content: formattedValue }, plain_text: formattedValue }];
  } else {
    task.properties[field].rich_text = [];
  }

  startLoading(`${taskTitle} ${fieldName} 수정`);

  // 백그라운드에서 API 호출 (빈 값이어도 서버에 업데이트)
  try {
    if (formattedValue.trim()) {
      await updateNotionPage(taskId, {
        [field]: {
          rich_text: [{ type: 'text', text: { content: formattedValue } }]
        }
      });
    } else {
      // 빈 값으로 업데이트 (서버에서도 지움)
      await updateNotionPage(taskId, {
        [field]: {
          rich_text: []
        }
      });
    }
    completeLoading(`${taskTitle} ${fieldName} 수정`);
    scheduleRenderData();
  } catch (error) {
    console.error('시간 업데이트 실패:', error);
    completeLoading(`${taskTitle} ${fieldName} 수정 실패`);
    // 실패시 롤백
    if (originalValue) {
      task.properties[field].rich_text = [{ type: 'text', text: { content: originalValue }, plain_text: originalValue }];
    } else {
      task.properties[field].rich_text = [];
    }
    scheduleRenderData();
  }
};

window.updateDate = async function(taskId, newDate) {
  if (!newDate) return;

  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;

  const originalDate = task.properties?.['날짜']?.date?.start;

  // 날짜가 실제로 바뀌었는지 확인
  if (originalDate === newDate) return;

  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  // 복제 + 제목에 ' 추가
  const originalTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '';
  const newTitle = originalTitle + "'";

  const bookRelation = task.properties?.['책']?.relation?.[0];
  const targetTime = task.properties?.['목표 시간']?.number;
  const start = task.properties?.['시작']?.rich_text?.[0]?.plain_text;
  const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text;
  const rating = task.properties?.['(੭•̀ᴗ•̀)੭']?.select?.name;
  const priority = task.properties?.['우선순위']?.select?.name;

  // 임시 ID로 새 항목 생성
  const tempId = 'temp-' + Date.now();
  const tempTask = {
    id: tempId,
    created_time: new Date().toISOString(),
    properties: {
      '범위': { title: [{ plain_text: newTitle, text: { content: newTitle } }] },
      '날짜': { date: { start: newDate } },
      '완료': { checkbox: false },
      '목표 시간': { number: targetTime || null },
      '시작': { rich_text: start ? [{ plain_text: start, text: { content: start } }] : [] },
      '끝': { rich_text: end ? [{ plain_text: end, text: { content: end } }] : [] },
      '(੭•̀ᴗ•̀)੭': rating ? { select: { name: rating } } : { select: null },
      '우선순위': priority ? { select: { name: priority } } : { select: null },
      '책': { relation: bookRelation ? [bookRelation] : [] }
    }
  };

  // UI 즉시 업데이트
  currentData.results.unshift(tempTask);
  renderData();

  // 백그라운드에서 API 호출
  try {
    const properties = {
      '범위': {
        title: [{ text: { content: newTitle } }]
      },
      '날짜': {
        date: { start: newDate }
      },
      '완료': { checkbox: false }
    };

    if (bookRelation) {
      properties['책'] = { relation: [{ id: bookRelation.id }] };
    }

    if (targetTime) {
      properties['목표 시간'] = { number: targetTime };
    }

    if (start) {
      properties['시작'] = { rich_text: [{ type: 'text', text: { content: start } }] };
    }

    if (end) {
      properties['끝'] = { rich_text: [{ type: 'text', text: { content: end } }] };
    }

    if (rating) {
      properties['(੭•̀ᴗ•̀)੭'] = { select: { name: rating } };
    }

    if (priority) {
      properties['우선순위'] = { select: { name: priority } };
    }

    const notionUrl = 'https://api.notion.com/v1/pages';
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: properties
      })
    });

    if (!response.ok) throw new Error('복제 실패');

    await fetchAllData();
  } catch (error) {
    console.error('날짜 변경 실패:', error);
    // 실패시 임시 항목 제거
    currentData.results = currentData.results.filter(t => t.id !== tempId);
    renderData();
    loading.textContent = '';
  }
};

window.updateTargetTimeInTask = async function(taskId, newTime) {
  if (newTime === '' || newTime === null) return;

  const timeValue = parseInt(newTime);
  if (isNaN(timeValue)) return;

  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;

  const originalTime = task.properties?.['목표 시간']?.number;
  if (originalTime === timeValue) return;

  const taskTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '항목';

  // UI 업데이트
  task.properties['목표 시간'].number = timeValue;

  startLoading(`${taskTitle} 목표 시간 수정`);

  // 백그라운드에서 API 호출
  try {
    await updateNotionPage(taskId, {
      '목표 시간': { number: timeValue }
    });

    completeLoading(`${taskTitle} 목표 시간 수정`);
    scheduleRenderData();
  } catch (error) {
    console.error('목표 시간 업데이트 실패:', error);
    completeLoading(`${taskTitle} 목표 시간 수정 실패`);
    // 실패시 롤백
    task.properties['목표 시간'].number = originalTime;
    scheduleRenderData();
  }
};

window.updateDateInTask = async function(taskId, newDate) {
  if (!newDate) return;

  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;

  const originalDate = task.properties?.['날짜']?.date?.start;

  if (originalDate === newDate) return;

  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  const originalTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '';
  const newTitle = originalTitle + "'";

  const bookRelation = task.properties?.['책']?.relation?.[0];
  const targetTime = task.properties?.['목표 시간']?.number;
  const start = task.properties?.['시작']?.rich_text?.[0]?.plain_text;
  const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text;
  const rating = task.properties?.['(੭•̀ᴗ•̀)੭']?.select?.name;
  const priority = task.properties?.['우선순위']?.select?.name;

  // 임시 ID로 새 항목 생성
  const tempId = 'temp-' + Date.now();
  const tempTask = {
    id: tempId,
    created_time: new Date().toISOString(),
    properties: {
      '범위': { title: [{ plain_text: newTitle, text: { content: newTitle } }] },
      '날짜': { date: { start: newDate } },
      '완료': { checkbox: false },
      '목표 시간': { number: targetTime || null },
      '시작': { rich_text: start ? [{ plain_text: start, text: { content: start } }] : [] },
      '끝': { rich_text: end ? [{ plain_text: end, text: { content: end } }] : [] },
      '(੭•̀ᴗ•̀)੭': rating ? { select: { name: rating } } : { select: null },
      '우선순위': priority ? { select: { name: priority } } : { select: null },
      '책': { relation: bookRelation ? [bookRelation] : [] }
    }
  };

  // UI 즉시 업데이트
  currentData.results.unshift(tempTask);
  renderData();

  // 백그라운드에서 API 호출
  try {
    const properties = {
      '범위': {
        title: [{ text: { content: newTitle } }]
      },
      '날짜': {
        date: { start: newDate }
      },
      '완료': { checkbox: false }
    };

    if (bookRelation) {
      properties['책'] = { relation: [{ id: bookRelation.id }] };
    }

    if (targetTime) {
      properties['목표 시간'] = { number: targetTime };
    }

    if (start) {
      properties['시작'] = { rich_text: [{ type: 'text', text: { content: start } }] };
    }

    if (end) {
      properties['끝'] = { rich_text: [{ type: 'text', text: { content: end } }] };
    }

    if (rating) {
      properties['(੭•̀ᴗ•̀)੭'] = { select: { name: rating } };
    }

    if (priority) {
      properties['우선순위'] = { select: { name: priority } };
    }

    const notionUrl = 'https://api.notion.com/v1/pages';
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: properties
      })
    });

    if (!response.ok) throw new Error('복제 실패');

    await fetchAllData();
  } catch (error) {
    console.error('날짜 변경 실패:', error);
    // 실패시 임시 항목 제거
    currentData.results = currentData.results.filter(t => t.id !== tempId);
    renderData();
    loading.textContent = '';
  }
};

window.updateRating = async function(taskId, value) {
  // 백업
  const task = currentData.results.find(t => t.id === taskId);
  if (!task) return;
  const originalRating = task.properties['(੭•̀ᴗ•̀)੭']?.select?.name || null;

  const taskTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '항목';

  // UI 업데이트
  task.properties['(੭•̀ᴗ•̀)੭'] = value ? { select: { name: value } } : { select: null };

  startLoading(`${taskTitle} 집중도 수정`);

  // 백그라운드에서 API 호출
  try {
    await updateNotionPage(taskId, {
      '(੭•̀ᴗ•̀)੭': value ? { select: { name: value } } : { select: null }
    });
    completeLoading(`${taskTitle} 집중도 수정`);
    scheduleRenderData();
  } catch (error) {
    console.error('집중도 업데이트 실패:', error);
    completeLoading(`${taskTitle} 집중도 수정 실패`);
    // 실패시 롤백
    task.properties['(੭•̀ᴗ•̀)੭'] = originalRating ? { select: { name: originalRating } } : { select: null };
    scheduleRenderData();
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();

  // 메인 플래너 데이터 일부만 먼저 로드해서 빠르게 표시 (오늘 ±7~30일)
  await fetchData();

  // 전체 플래너 데이터 백그라운드에서 로드
  fetchAllData().catch(err => {
    console.error('전체 데이터 로드 실패:', err);
  });

  // D-Day 데이터는 백그라운드에서 로드
  fetchDDayData().then(() => {
    autoSelectClosestDDay();
    renderData(); // D-Day 로드 후 화면 업데이트
  }).catch(err => {
    console.error('D-Day loading failed:', err);
  });

  // 캘린더 데이터도 백그라운드에서 로드 (조용히)
  fetchCalendarData(true).catch(err => {
    console.error('Calendar loading failed:', err);
  });

  setInterval(fetchAllData, 300000);

  setInterval(() => {
    // keepalive
  }, 60000);
});

function setupEventListeners() {
  // 로딩 인디케이터 초기화
  const loading = document.getElementById('loading');
  const tooltip = document.getElementById('loading-tooltip');
  if (loading) {
    loading.title = '작업 로그';
  }
  if (tooltip) {
    tooltip.textContent = '작업 로그가 없습니다';
  }

  const viewToggle = document.getElementById('view-toggle');
  viewToggle.addEventListener('click', () => {
    if (calendarViewMode) {
      // 프리플랜 화면에서는 LIST/CALENDAR 토글
      plannerCalendarViewMode = !plannerCalendarViewMode;
      viewToggle.textContent = plannerCalendarViewMode ? 'CALENDAR' : 'LIST';
      renderCalendarView();
    } else {
      // 플래너 화면에서는 TIME TABLE / TASK 전환
      viewMode = viewMode === 'timeline' ? 'task' : 'timeline';
      viewToggle.textContent = viewMode === 'timeline' ? 'TIME TABLE' : 'TASK';
      renderData();
    }
  });

  // 키보드 단축키: Ctrl+Z (undo), Ctrl+Shift+Z (redo)
  document.addEventListener('keydown', (e) => {
    // 입력 필드에서는 단축키 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      undo();
    }
  });
}

async function fetchData(retryCount = 0) {
  startLoading('플래너 데이터 로드');

  try {
    // 오늘 기준 앞뒤 날짜 계산 (빠른 초기 로드용)
    const today = new Date();
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - 7); // 7일 전
    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + 30); // 30일 후

    // 로컬 날짜를 YYYY-MM-DD 형식으로 변환
    const pastDateStr = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`;
    const futureDateStr = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`;

    const notionUrl = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_size: 100,
        filter: {
          and: [
            {
              property: '날짜',
              date: {
                on_or_after: pastDateStr
              }
            },
            {
              property: '날짜',
              date: {
                on_or_before: futureDateStr
              }
            }
          ]
        },
        sorts: [{ property: "날짜", direction: "descending" }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error ${response.status}: ${errorData.message || response.statusText}`);
    }

    currentData = await response.json();

    // 책 이름 불러오기
    await fetchBookNames();

    // 렌더링
    renderData();
    updateLastUpdateTime();
    completeLoading('플래너 데이터 로드');
  } catch (error) {
    console.error('Error:', error);

    // Determine error type and provide specific message
    let errorMessage = '';
    if (error.message.includes('Failed to fetch')) {
      errorMessage = `네트워크 연결을 확인해주세요.\n\n가능한 원인:\n• 인터넷 연결 끊김\n• CORS 문제 (브라우저에서 직접 실행 시)\n• API 키 만료\n\n해결 방법:\n• 인터넷 연결 확인\n• 로컬 서버에서 실행 (예: Live Server)\n• API 키 갱신`;
    } else if (error.message.includes('401')) {
      errorMessage = 'API 키가 유효하지 않습니다. Notion API 키를 확인해주세요.';
    } else if (error.message.includes('404')) {
      errorMessage = '데이터베이스를 찾을 수 없습니다. DATABASE_ID를 확인해주세요.';
    } else if (error.message.includes('429')) {
      errorMessage = 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
    } else {
      errorMessage = error.message;
    }

    // Retry logic for network errors
    if (error.message.includes('Failed to fetch') && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s
      document.getElementById('content').innerHTML =
        `<div class="empty-message">⚠️ 연결 중... (${retryCount + 1}/3)<br><br>${errorMessage}</div>`;
      setTimeout(() => fetchData(retryCount + 1), delay);
      return;
    }

    document.getElementById('content').innerHTML =
      `<div class="empty-message" style="white-space: pre-line;">❌ 오류\n\n${errorMessage}</div>`;
    completeLoading('플래너 데이터 로드 실패');
  }
}

async function fetchAllData() {
  try {
    const notionUrl = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_size: 100,
        sorts: [{ property: "날짜", direction: "descending" }]
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    currentData = await response.json();

    // 책 이름 불러오기
    await fetchBookNames();

    // 재렌더링 - 현재 뷰 모드에 맞게 렌더링
    if (calendarViewMode) {
      renderCalendarView();
    } else {
      renderData();
    }
  } catch (error) {
    console.error('전체 데이터 로드 실패:', error);
  }
}

async function fetchBookNames() {
  const bookIds = new Set();

  // planner 데이터베이스의 책 ID 수집
  currentData.results.forEach(task => {
    const bookRelations = task.properties?.['책']?.relation || [];
    bookRelations.forEach(rel => bookIds.add(rel.id));
  });


  // 모든 책 데이터를 병렬로 가져오기
  const fetchPromises = Array.from(bookIds)
    .filter(bookId => !bookNames[bookId])
    .map(async (bookId) => {
      try {
        const notionUrl = `https://api.notion.com/v1/pages/${bookId}`;
        const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
          headers: {
            'Authorization': `Bearer ${NOTION_API_KEY}`,
            'Notion-Version': '2022-06-28'
          }
        });

        if (response.ok) {
          const bookData = await response.json();
          for (const [key, value] of Object.entries(bookData.properties)) {
            if (value.type === 'title' && value.title && value.title.length > 0) {
              bookNames[bookId] = value.title[0].plain_text;
              break;
            }
          }
          if (!bookNames[bookId]) bookNames[bookId] = '책';
        } else {
          console.warn(`Failed to fetch book ${bookId}: ${response.status}`);
          bookNames[bookId] = '책';
        }
      } catch (error) {
        console.warn(`Error fetching book ${bookId}:`, error);
        bookNames[bookId] = '책';
      }
    });

  await Promise.all(fetchPromises);
}

function getTaskTitle(task) {
  const scope = task.properties?.['범위']?.title?.[0]?.plain_text || '제목 없음';
  const bookRelation = task.properties?.['책']?.relation?.[0];

  if (bookRelation && bookNames[bookRelation.id]) {
    return `[${bookNames[bookRelation.id]}] ${scope}`;
  }
  return scope;
}

function getCalendarItemTitle(item) {
  // 여러 가능한 속성 이름 시도
  let title = null;

  // 먼저 '범위' 속성 시도
  if (item.properties?.['범위']?.title?.[0]?.plain_text) {
    title = item.properties['범위'].title[0].plain_text;
  }

  // 'pre-plan' 속성 시도
  if (!title && item.properties?.['pre-plan']?.title?.[0]?.plain_text) {
    title = item.properties['pre-plan'].title[0].plain_text;
  }

  // 모든 title 타입 속성 찾기
  if (!title) {
    for (const [key, value] of Object.entries(item.properties || {})) {
      if (value.type === 'title' && value.title && value.title.length > 0) {
        title = value.title[0].plain_text;
        break;
      }
    }
  }

  return title || '제목 없음';
}

function renderData() {
  if (!currentData || !currentData.results) return;

  // D-Day 버튼 업데이트
  updateDDayButton();

  if (viewMode === 'timeline') {
    renderTimelineView();
  } else {
    renderTaskView();
  }
}

function updateDDayButton() {
  const ddayButton = document.getElementById('dday-button');
  if (ddayButton) {
    if (dDayDate && dDayTitle) {
      const dDayStr = getDDayString();
      ddayButton.textContent = `${dDayTitle}${dDayStr}`;
    } else {
      ddayButton.textContent = 'D-Day';
    }
    ddayButton.style.background = dDayDate ? '#999' : '#999';
  }
}

function renderTimelineView() {
  const targetDateStr = formatDateToLocalString(currentDate);

  const dayTasks = currentData.results.filter(item => {
    const dateStart = item.properties?.['날짜']?.date?.start;
    return dateStart && dateStart === targetDateStr;
  });

  // 오늘 날짜 구하기
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = formatDateToLocalString(today);

  // 오늘 또는 미래 날짜인 경우에만 완료/미완료 분리
  const isPastDate = targetDateStr < todayStr;

  // 완료/미완료 분리 (버튼 표시용)
  const incompleteTasks = dayTasks.filter(t => !t.properties?.['완료']?.checkbox);
  const completedTasks = dayTasks.filter(t => t.properties?.['완료']?.checkbox);

  const sortTasks = (tasks) => {
    return tasks.sort((a, b) => {
      const aStart = a.properties?.['시작']?.rich_text?.[0]?.plain_text || '';
      const bStart = b.properties?.['시작']?.rich_text?.[0]?.plain_text || '';

      if (aStart && bStart) {
        // 06:00를 하루의 시작으로 간주 (00:00~05:59는 뒤로 보냄)
        const adjustTime = (timeStr) => {
          const hour = parseInt(timeStr.split(':')[0]);
          if (hour < 6) {
            // 00:00~05:59 → 24:00~29:59로 변환
            return String(hour + 24).padStart(2, '0') + timeStr.substring(2);
          }
          return timeStr;
        };

        const aAdjusted = adjustTime(aStart);
        const bAdjusted = adjustTime(bStart);
        return aAdjusted.localeCompare(bAdjusted);
      }
      if (aStart) return -1;
      if (bStart) return 1;

      const priorityOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];
      const aPriority = a.properties?.['우선순위']?.select?.name || '20th';
      const bPriority = b.properties?.['우선순위']?.select?.name || '20th';
      const priorityCompare = priorityOrder.indexOf(aPriority) - priorityOrder.indexOf(bPriority);

      if (priorityCompare !== 0) return priorityCompare;

      const aTitle = getTaskTitle(a);
      const bTitle = getTaskTitle(b);
      return aTitle.localeCompare(bTitle);
    });
  };

  let sortedTasks;
  if (isPastDate) {
    // 과거 날짜: 완료/미완료 구분 없이 그냥 정렬
    sortedTasks = sortTasks(dayTasks);
  } else {
    // 오늘/미래: 완료 안 한 일 먼저, 그 다음 완료한 일
    sortedTasks = [...sortTasks(incompleteTasks), ...sortTasks(completedTasks)];
  }

  // 완료 개수 계산
  const completedCount = sortedTasks.filter(t => t.properties?.['완료']?.checkbox).length;
  const totalCount = sortedTasks.length;

  // 시간 통계 계산
  let totalTarget = 0;
  let totalActual = 0;
  sortedTasks.forEach(task => {
    const targetTime = task.properties?.['목표 시간']?.number || 0;
    totalTarget += targetTime;

    const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text || '';
    if (end) {
      const actualProp = task.properties?.['실제 시간'];
      if (actualProp?.type === 'formula') {
        if (actualProp.formula?.type === 'number') {
          totalActual += actualProp.formula.number || 0;
        } else if (actualProp.formula?.type === 'string') {
          const str = actualProp.formula.string || '';
        
          // 1️⃣ 부호 먼저 확인
          const sign = str.trim().startsWith('-') ? -1 : 1;
        
          // 2️⃣ 시간 / 분 파싱
          const hourMatch = str.match(/(\d+)시간/);
          const minMatch = str.match(/(\d+)분/);
          const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
          const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
        
          // 3️⃣ 부호 적용
          totalActual += sign * (hours * 60 + mins);
        }

      }
    }
  });

  const totalDiff = totalActual - totalTarget;
  const diffSign = totalDiff === 0 ? '±' : (totalDiff > 0 ? '+' : '-');
  const diffAbs = Math.abs(totalDiff);

  const content = document.getElementById('content');
  const dateLabel = formatDateLabelShort(targetDateStr);

  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <button onclick="changeDate(-1)" style="font-size: 16px; padding: 4px 12px; color: #999;">◀</button>
      <h3 class="section-title" style="margin: 0; cursor: pointer;" onclick="goToday()">${dateLabel} (${completedCount}개/${totalCount}개)</h3>
      <button onclick="changeDate(1)" style="font-size: 16px; padding: 4px 12px; color: #999;">▶</button>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="flex: 1;"></div>
      <div style="font-size: 11px; color: #86868b; text-align: center;">
        목표 ${formatMinutesToTime(totalTarget)} / 실제 ${formatMinutesToTime(totalActual)} <span style="color: ${totalDiff > 0 ? '#FF3B30' : totalDiff < 0 ? '#34C759' : '#666'};">(${diffSign}${formatMinutesToTime(diffAbs)})</span>
      </div>
      <div style="flex: 1; display: flex; justify-content: flex-end;">
        ${incompleteTasks.length > 0 ? `<button onclick="duplicateAllIncompleteTasks()" style="font-size: 16px; padding: 4px 8px; background: none; border: none; cursor: pointer; color: #999;">→</button>` : ''}
      </div>
    </div>
    <div class="task-list">
  `;
  
  if (sortedTasks.length === 0) {
    html += '<div class="empty-message">일정이 없습니다.</div>';
  } else {
    sortedTasks.forEach(task => {
      const title = getTaskTitle(task);
      const start = task.properties?.['시작']?.rich_text?.[0]?.plain_text || '';
      const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text || '';
      const completed = task.properties?.['완료']?.checkbox;
      const rating = task.properties?.['(੭•̀ᴗ•̀)੭']?.select?.name || '';
      const targetTime = task.properties?.['목표 시간']?.number || 0;
      
      // 끝시간 없으면 실제 0분
      let actualTime = 0;
      let diffStr = '';
      
      if (end) {
        const actualProp = task.properties?.['실제 시간'];
        
        if (actualProp?.type === 'formula') {
          if (actualProp.formula?.type === 'number') {
            actualTime = actualProp.formula.number || 0;
          } else if (actualProp.formula?.type === 'string') {
            const str = actualProp.formula.string || '';
            const hourMatch = str.match(/(\d+)시간/);
            const minMatch = str.match(/(\d+)분/);
            const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
            const mins = minMatch ? parseInt(minMatch[1]) : 0;
            actualTime = hours * 60 + mins;
          }
        }
        
        const diff = actualTime - targetTime;
        diffStr = diff === 0 ? '' : `${diff > 0 ? '+' : ''}${diff}`;
      }
      
      const dateStart = task.properties?.['날짜']?.date?.start || '';

      html += `
        <div class="task-item ${completed ? 'completed' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <div class="task-title ${completed ? 'completed' : ''}" style="flex: 1; cursor: pointer;" onclick="editTask('${task.id}')">${title}</div>
            <div class="checkbox ${completed ? 'checked' : ''}" onclick="toggleComplete('${task.id}', ${!completed})" 
              style="margin-left: 12px; flex-shrink: 0;">
              ${completed ? '✓' : ''}
            </div>
          </div>
          
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
            <input type="text" value="${start}" placeholder="시작"
              onblur="updateTime('${task.id}', '시작', this.value, this)"
              style="width: 50px; padding: 4px; border: 1px solid #e5e5e7; border-radius: 4px; text-align: center; font-size: 11px;">
            <span style="font-size: 11px; color: #86868b;">-</span>
            <input type="text" value="${end}" placeholder="끝"
              onblur="updateTime('${task.id}', '끝', this.value, this)"
              style="width: 50px; padding: 4px; border: 1px solid #e5e5e7; border-radius: 4px; text-align: center; font-size: 11px;">
            
            <select onchange="updateRating('${task.id}', this.value)" 
              style="margin-left: 8px; padding: 4px 8px; border: 1px solid #e5e5e7; border-radius: 4px; font-size: 11px; cursor: pointer; background: #f5f5f7; color: ${rating ? '#333' : '#999'};">
              <option value="" ${!rating ? 'selected' : ''}></option>
              <option value="..." ${rating === '...' ? 'selected' : ''}>...</option>
              <option value="⭐️" ${rating === '⭐️' ? 'selected' : ''}>⭐️</option>
              <option value="⭐️⭐️" ${rating === '⭐️⭐️' ? 'selected' : ''}>⭐️⭐️</option>
              <option value="⭐️⭐️⭐️" ${rating === '⭐️⭐️⭐️' ? 'selected' : ''}>⭐️⭐️⭐️</option>
              <option value="🌟 🌟 🌟" ${rating === '🌟 🌟 🌟' ? 'selected' : ''}>🌟 🌟 🌟</option>
            </select>
          </div>
          
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: #86868b;">
              목표 ${formatMinutesToTime(targetTime)} / 실제 ${formatMinutesToTime(actualTime)}${end ? (() => {
                const diff = actualTime - targetTime;
                if (diff === 0) return '';
                const sign = diff > 0 ? '+' : '-';
                return ` (${sign}${formatMinutesToTime(Math.abs(diff))})`;
              })() : ''}
            </div>
            ${!completed ? `
              <div style="display: flex; gap: 16px; align-items: center;">
                ${start && end ? `
                  <button onclick="duplicateTask('${task.id}')" style="font-size: 18px; padding: 0px 4px; background: none; color: inherit; border: none; cursor: pointer; flex-shrink: 0; display: inline-block; min-width: 20px; height: 20px; line-height: 1;">+</button>
                ` : ''}
                <span style="cursor: pointer; font-size: 16px; position: relative; display: inline-block; width: 20px; height: 20px; flex-shrink: 0;">
                  →
                  <input type="date" value="${dateStart}"
                    onchange="updateDate('${task.id}', this.value)"
                    style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;">
                </span>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    });
  }
  
  html += '</div>';
  content.innerHTML = html;
}

function renderTaskView() {
  const targetDateStr = formatDateToLocalString(currentDate);

  // 날짜 필터
  const dayTasks = currentData.results.filter(item => {
    const dateStart = item.properties?.['날짜']?.date?.start;
    return dateStart && dateStart === targetDateStr;
  });

  // 오늘 날짜 구하기
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = formatDateToLocalString(today);

  // 오늘 또는 미래 날짜인 경우에만 완료/미완료 분리
  const isPastDate = targetDateStr < todayStr;

  const priorityOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];

  const sortByPriority = (tasks) => {
    return tasks.sort((a, b) => {
      const aPriority = a.properties?.['우선순위']?.select?.name || '10th';
      const bPriority = b.properties?.['우선순위']?.select?.name || '10th';
      return priorityOrder.indexOf(aPriority) - priorityOrder.indexOf(bPriority);
    });
  };

  let allTasks;
  if (isPastDate) {
    // 과거 날짜: 완료/미완료 구분 없이 그냥 정렬
    allTasks = sortByPriority(dayTasks);
  } else {
    // 오늘/미래: 완료 안 한 일 먼저
    const incompleteTasks = dayTasks.filter(t => !t.properties?.['완료']?.checkbox);
    const completedTasks = dayTasks.filter(t => t.properties?.['완료']?.checkbox);
    allTasks = [...sortByPriority(incompleteTasks), ...sortByPriority(completedTasks)];
  }

  // 시간 통계 계산
  let totalTarget = 0;
  let totalActual = 0;
  allTasks.forEach(task => {
    const targetTime = task.properties?.['목표 시간']?.number || 0;
    totalTarget += targetTime;

    const end = task.properties?.['끝']?.rich_text?.[0]?.plain_text || '';
    if (end) {
      const actualProp = task.properties?.['실제 시간'];
      if (actualProp?.type === 'formula') {
        if (actualProp.formula?.type === 'number') {
          totalActual += actualProp.formula.number || 0;
        } else if (actualProp.formula?.type === 'string') {
          const str = actualProp.formula.string || '';
        
          // 1️⃣ 부호 먼저 확인
          const sign = str.trim().startsWith('-') ? -1 : 1;
        
          // 2️⃣ 시간 / 분 파싱
          const hourMatch = str.match(/(\d+)시간/);
          const minMatch = str.match(/(\d+)분/);
          const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
          const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
        
          // 3️⃣ 부호 적용
          totalActual += sign * (hours * 60 + mins);
        }
      }
    }
  });

  const totalDiff = totalActual - totalTarget;
  const diffSign = totalDiff === 0 ? '±' : (totalDiff > 0 ? '+' : '-');
  const diffAbs = Math.abs(totalDiff);

  const content = document.getElementById('content');
  const dateLabel = formatDateLabelShort(targetDateStr);

  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <button onclick="changeDate(-1)" style="font-size: 16px; padding: 4px 12px; color: #999;">◀</button>
      <h3 class="section-title" style="margin: 0; cursor: pointer;" onclick="goToday()">${dateLabel}</h3>
      <button onclick="changeDate(1)" style="font-size: 16px; padding: 4px 12px; color: #999;">▶</button>
    </div>
    <div style="font-size: 11px; color: #86868b; margin-bottom: 12px; text-align: center;">
      목표 ${formatMinutesToTime(totalTarget)} / 실제 ${formatMinutesToTime(totalActual)} <span style="color: ${totalDiff > 0 ? '#FF3B30' : totalDiff < 0 ? '#34C759' : '#666'};">(${diffSign}${formatMinutesToTime(diffAbs)})</span>
    </div>
    <button onclick="addNewTask()" style="width: 100%; margin-bottom: 12px; padding: 8px; background: #999; color: white; border-radius: 8px; cursor: pointer; border: none; font-size: 13px;">+ 추가</button>
    <div class="task-list" id="task-sortable">
  `;
  
  allTasks.forEach(task => {
    const title = getTaskTitle(task);
    const priority = task.properties?.['우선순위']?.select?.name;
    const targetTime = task.properties?.['목표 시간']?.number;
    const dateStart = task.properties?.['날짜']?.date?.start || '';
    const completed = task.properties?.['완료']?.checkbox;

    html += `
      <div class="task-item ${completed ? 'completed' : ''}" data-id="${task.id}" style="border-left: 3px solid #999; position: relative; padding: 12px;">
        <div class="drag-handle" style="position: absolute; left: 0; top: 0; bottom: 0; width: 40px; cursor: move; opacity: 0; user-select: none; -webkit-user-select: none; touch-action: none;"></div>
        <div class="task-header" style="flex: 1;">
          <div class="task-content" style="flex: 1;">
            <div class="task-title ${completed ? 'completed' : ''}" style="cursor: pointer;" onclick="editTask('${task.id}')">${title}</div>
            <div style="font-size: 11px; color: #86868b; margin-top: 6px; display: flex; gap: 8px; align-items: center;">
              ${priority ? `<span style="background: #999; color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px;">${priority}</span>` : ''}
              <span style="display: flex; align-items: center; gap: 4px;">
                <input type="number" value="${targetTime || 0}"
                  onblur="updateTargetTimeInTask('${task.id}', this.value)"
                  style="width: 45px; padding: 4px; border: 1px solid #e5e5e7; border-radius: 4px; text-align: center; font-size: 11px;">
                <span style="font-size: 11px;">분</span>
              </span>
              ${dateStart ? `<span style="font-size: 10px;">${formatDateShort(dateStart)}</span>` : ''}
              <span style="cursor: pointer; font-size: 14px; position: relative; display: inline-block; width: 18px; height: 18px;">
                →
                <input type="date" value="${dateStart}"
                  onchange="updateDateInTask('${task.id}', this.value)"
                  style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;">
              </span>
            </div>
          </div>
          <div class="checkbox ${completed ? 'checked' : ''}" onclick="toggleComplete('${task.id}', ${!completed})"
            style="margin-left: 12px; flex-shrink: 0;">
            ${completed ? '✓' : ''}
          </div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  content.innerHTML = html;
  
  initSortable();
}

function initSortable() {
  const container = document.getElementById('task-sortable');
  if (!container) return;

  let draggedItem = null;
  let dragStartIndex = -1;
  let touchStartY = 0;
  let touchCurrentY = 0;

  // 각 아이템에 드래그 핸들 설정
  container.querySelectorAll('.task-item').forEach(item => {
    const handle = item.querySelector('.drag-handle');
    if (!handle) return;

    handle.setAttribute('draggable', 'true');

    // 마우스 드래그 (데스크톱)
    handle.addEventListener('dragstart', (e) => {
      draggedItem = item;
      dragStartIndex = Array.from(container.children).indexOf(draggedItem);
      item.style.opacity = '0.5';
    });

    handle.addEventListener('dragend', async (e) => {
      item.style.opacity = '1';

      const dragEndIndex = Array.from(container.children).indexOf(draggedItem);

      if (dragStartIndex !== dragEndIndex) {
        await updateTaskOrder();
      }
    });

    // 마우스 드래그 (아이패드 마우스 포함)
    let isMouseDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isMouseDragging = true;
      draggedItem = item;
      dragStartIndex = Array.from(container.children).indexOf(draggedItem);
      item.style.opacity = '0.5';
      item.style.position = 'relative';
      item.style.zIndex = '1000';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isMouseDragging || !draggedItem) return;
      const afterElement = getDragAfterElement(container, e.clientY);

      if (afterElement == null) {
        container.appendChild(draggedItem);
      } else {
        container.insertBefore(draggedItem, afterElement);
      }
    });

    document.addEventListener('mouseup', async (e) => {
      if (!isMouseDragging) return;
      isMouseDragging = false;

      if (draggedItem) {
        item.style.opacity = '1';
        item.style.position = '';
        item.style.zIndex = '';

        const dragEndIndex = Array.from(container.children).indexOf(draggedItem);

        if (dragStartIndex !== dragEndIndex) {
          await updateTaskOrder();
        }

        draggedItem = null;
      }
    });

    // 터치 드래그 (모바일)
    handle.addEventListener('touchstart', (e) => {
      draggedItem = item;
      dragStartIndex = Array.from(container.children).indexOf(draggedItem);
      touchStartY = e.touches[0].clientY;
      item.style.opacity = '0.5';
      item.style.position = 'relative';
      item.style.zIndex = '1000';
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      e.preventDefault();
      touchCurrentY = e.touches[0].clientY;
      const afterElement = getDragAfterElement(container, touchCurrentY);

      if (afterElement == null) {
        container.appendChild(draggedItem);
      } else {
        container.insertBefore(draggedItem, afterElement);
      }
    }, { passive: false });

    handle.addEventListener('touchend', async (e) => {
      item.style.opacity = '1';
      item.style.position = '';
      item.style.zIndex = '';

      const dragEndIndex = Array.from(container.children).indexOf(draggedItem);

      if (dragStartIndex !== dragEndIndex) {
        await updateTaskOrder();
      }

      draggedItem = null;
    });
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const afterElement = getDragAfterElement(container, e.clientY);
    if (afterElement == null && draggedItem) {
      container.appendChild(draggedItem);
    } else if (draggedItem) {
      container.insertBefore(draggedItem, afterElement);
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-item:not([style*="opacity: 0.5"])')];
  
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

async function updateTaskOrder() {
  const container = document.getElementById('task-sortable');
  const items = container.querySelectorAll('.task-item');
  const priorityOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th'];
  
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';
  
  const updates = [];
  for (let i = 0; i < items.length && i < 10; i++) {
    const taskId = items[i].getAttribute('data-id');
    const newPriority = priorityOrder[i];
    
    updates.push(
      updateNotionPage(taskId, {
        '우선순위': { select: { name: newPriority } }
      })
    );
  }
  
  await Promise.all(updates);

  // 즉시 UI 업데이트 (호출하는 곳에서 scheduleRefresh를 호출하므로 여기서는 렌더링만)
  await fetchAllData();
}

async function updateNotionPage(pageId, properties) {
  const notionUrl = `https://api.notion.com/v1/pages/${pageId}`;
  const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Update failed: ${response.status}`);
  }

  return await response.json();
}

function formatDateLabel(dateString) {
  const date = new Date(dateString);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dayOfWeek = days[date.getDay()];
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 (${dayOfWeek})`;
}

function formatDateLabelShort(dateString) {
  const date = new Date(dateString);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dayOfWeek = days[date.getDay()];
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${dayOfWeek})`;
}

function formatDateShort(dateString) {
  const date = new Date(dateString);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateToLocalString(date) {
  // 로컬 날짜를 YYYY-MM-DD 형식으로 변환 (UTC 변환 없이)
  // 시간을 0으로 설정하여 시간대 문제 방지
  const localDate = new Date(date);
  localDate.setHours(0, 0, 0, 0);
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, '0');
  const day = String(localDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMinutesToTime(minutes) {
  if (minutes === 0) return '0분';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}분`;
  if (mins === 0) return `${hours}시간`;
  return `${hours}시간 ${mins}분`;
}

function formatMinutesToClock(minutes) {
  const hours = Math.floor(Math.abs(minutes) / 60);
  const mins = Math.abs(minutes) % 60;
  const sign = minutes < 0 ? '-' : '';
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function updateLastUpdateTime() {
  const now = new Date();
  document.getElementById('last-update').textContent =
    now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

// 프리플랜과 플래너 항목들을 연결하는 헬퍼 함수 (UI 없이)
async function linkPrePlanToPlannerSilent() {
  if (!currentData) {
    return 0;
  }

  let linkCount = 0;

  // 프리플랜 항목들을 순회
  for (const prePlanItem of currentData.results) {
    const prePlanTitle = getCalendarItemTitle(prePlanItem);
    const prePlanBookId = prePlanItem.properties?.['책']?.relation?.[0]?.id;

    // 책이 없으면 스킵
    if (!prePlanBookId) {
      continue;
    }

    // 같은 책을 가진 플래너 항목들 중에서 제목이 같은 항목 찾기
    const matchingPlannerItem = currentData.results.find(plannerItem => {
      const plannerScope = plannerItem.properties?.['범위']?.title?.[0]?.plain_text || '제목 없음';
      const plannerBookId = plannerItem.properties?.['책']?.relation?.[0]?.id;
      return plannerScope === prePlanTitle && plannerBookId === prePlanBookId;
    });

    if (matchingPlannerItem) {
      // 이미 연결되어 있는지 확인
      const existingPlannerRelation = prePlanItem.properties?.['PLANNER']?.relation || [];
      const alreadyLinked = existingPlannerRelation.some(rel => rel.id === matchingPlannerItem.id);

      // 이미 연결되어 있으면 스킵
      if (alreadyLinked) {
        continue;
      }

      // 프리플랜의 PLANNER 속성에 플래너 항목 연결
      const prePlanUpdateUrl = `https://api.notion.com/v1/pages/${prePlanItem.id}`;
      await fetch(`${CORS_PROXY}${encodeURIComponent(prePlanUpdateUrl)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            'PLANNER': {
              relation: [{ id: matchingPlannerItem.id }]
            }
          }
        })
      });

      // 플래너의 PRE-PLAN 속성에 프리플랜 항목 연결 (속성이 없을 수 있으므로 에러 무시)
      try {
        const plannerUpdateUrl = `https://api.notion.com/v1/pages/${matchingPlannerItem.id}`;
        await fetch(`${CORS_PROXY}${encodeURIComponent(plannerUpdateUrl)}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${NOTION_API_KEY}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              'PRE-PLAN': {
                relation: [{ id: prePlanItem.id }]
              }
            }
          })
        });
      } catch (e) {
        // PRE-PLAN 속성이 없는 경우 무시
      }

      linkCount++;
    }
  }

  return linkCount;
}

window.linkPrePlanToPlanner = async function() {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    if (!currentData) {
      alert('데이터가 로드되지 않았습니다.');
      loading.textContent = '';
      return;
    }

    const linkCount = await linkPrePlanToPlannerSilent();
    alert(`${linkCount}개 항목 연결 완료`);

    // 데이터 새로고침
    await fetchAllData();
    renderCalendarView();
  } catch (error) {
    alert(`연결 실패: ${error.message}`);
  } finally {
    loading.textContent = '';
  }
};

window.duplicateAllIncompleteTasks = async function() {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    const targetDateStr = formatDateToLocalString(currentDate);

    // 완료되지 않은 할일만 필터
    const incompleteTasks = currentData.results.filter(item => {
      const dateStart = item.properties?.['날짜']?.date?.start;
      const completed = item.properties?.['완료']?.checkbox;
      return dateStart === targetDateStr && !completed;
    });

    if (incompleteTasks.length === 0) {
      loading.textContent = '';
      return;
    }

    // 모든 할일을 복제 (원본 완료 처리 없이)
    for (const task of incompleteTasks) {
      const originalTitle = task.properties?.['범위']?.title?.[0]?.plain_text || '';

      // ' 붙이기
      const newTitle = originalTitle + "'";

      const bookRelation = task.properties?.['책']?.relation?.[0];
      const targetTime = task.properties?.['목표 시간']?.number;
      const dateStart = task.properties?.['날짜']?.date?.start;
      const plannerRelation = task.properties?.['PLANNER']?.relation;

      // 다음날로 날짜 설정
      let nextDayStr = dateStart;
      if (dateStart) {
        const currentTaskDate = new Date(dateStart);
        currentTaskDate.setDate(currentTaskDate.getDate() + 1);
        nextDayStr = formatDateToLocalString(currentTaskDate);
      }

      const properties = {
        '범위': {
          title: [{ text: { content: newTitle } }]
        },
        '완료': { checkbox: false }
      };

      if (bookRelation) {
        properties['책'] = { relation: [{ id: bookRelation.id }] };
      }

      if (targetTime) {
        properties['목표 시간'] = { number: targetTime };
      }

      if (nextDayStr) {
        properties['날짜'] = { date: { start: nextDayStr } };
      }

      // 우선순위 복사
      const priority = task.properties?.['우선순위']?.select?.name;
      if (priority) {
        properties['우선순위'] = { select: { name: priority } };
      }

      // PLANNER 관계형 복사
      if (plannerRelation && plannerRelation.length > 0) {
        properties['PLANNER'] = { relation: plannerRelation.map(r => ({ id: r.id })) };
      }

      // 복제 생성
      const notionUrl = 'https://api.notion.com/v1/pages';
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: properties
        })
      });

      if (!response.ok) continue;
    }

    // 즉시 UI 업데이트
    await fetchAllData();
  } catch (error) {
    console.error('전체 복제 실패:', error);
    loading.textContent = '';
  }
};

async function fetchCalendarData(silent = false) {
  const loading = document.getElementById('loading');
  if (!silent) {
    loading.textContent = '⏳';
  }

  try {
    const notionUrl = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_size: 100,
        sorts: [{ property: "날짜", direction: "descending" }]
      })
    });

    if (!response.ok) {
      throw new Error(`Calendar API Error: ${response.status}`);
    }

    calendarData = await response.json();
    await fetchBookNames();
  } catch (error) {
    console.error('Calendar fetch error:', error);
  } finally {
    if (!silent) {
      loading.textContent = '';
    }
  }
}

async function fetchDDayData() {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    // 로컬 날짜를 YYYY-MM-DD 형식으로 변환
    const todayDate = new Date();
    const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

    const notionUrl = `https://api.notion.com/v1/databases/${DDAY_DB_ID}/query`;
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_size: 100,
        filter: {
          and: [
            {
              property: 'date',
              date: {
                on_or_after: today
              }
            },
            {
              property: '디데이 표시',
              checkbox: {
                equals: true
              }
            }
          ]
        },
        sorts: [
          {
            property: 'date',
            direction: 'ascending'
          }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('D-Day API Error:', errorData);
      throw new Error(`D-Day API Error: ${response.status}`);
    }

    ddayData = await response.json();
  } catch (error) {
    console.error('D-Day fetch error:', error);
  } finally {
    loading.textContent = '';
  }
}

window.updateCalendarItemDate = async function(itemId, newDate) {
  const item = currentData.results.find(t => t.id === itemId);
  if (item && item.properties?.['날짜']) {
    const oldDate = item.properties['날짜'].date?.start;

    const itemTitle = item.properties?.['범위']?.title?.[0]?.plain_text || '항목';

    // 히스토리에 추가
    addToHistory({
      type: 'UPDATE',
      itemId: itemId,
      before: { '날짜': { date: { start: oldDate } } },
      after: { '날짜': { date: { start: newDate } } }
    });

    item.properties['날짜'].date = { start: newDate };

    startLoading(`${itemTitle} 날짜 변경`);

    // 노션에 실제로 날짜 업데이트
    try {
      const notionUrl = `https://api.notion.com/v1/pages/${itemId}`;
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            '날짜': { date: { start: newDate } }
          }
        })
      });

      if (!response.ok) {
        throw new Error('날짜 업데이트 실패');
      }

      completeLoading(`${itemTitle} 날짜 변경`);

      // UI 업데이트
      scheduleRender();
    } catch (error) {
      console.error('Error updating date:', error);
      completeLoading(`${itemTitle} 날짜 변경 실패`);
    }
  }
};

window.loadPrevCalendar = function() {
  const content = document.getElementById('content');
  const oldScrollHeight = content.scrollHeight;
  const oldScrollTop = content.scrollTop;

  calendarStartDate.setDate(calendarStartDate.getDate() - 14);
  renderCalendarView();

  // 새로 추가된 콘텐츠 높이만큼 스크롤 조정
  requestAnimationFrame(() => {
    const newScrollHeight = content.scrollHeight;
    const heightDiff = newScrollHeight - oldScrollHeight;
    content.scrollTop = oldScrollTop + heightDiff;
  });
};

window.loadNextCalendar = function() {
  const content = document.getElementById('content');
  const oldScrollTop = content.scrollTop;

  calendarEndDate.setDate(calendarEndDate.getDate() + 14);
  renderCalendarView();

  // 스크롤 위치 유지
  requestAnimationFrame(() => {
    content.scrollTop = oldScrollTop;
  });
};

window.saveToPlanner = async function(dateStr) {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    const itemsOnDate = currentData.results.filter(item => {
      const itemDate = item.properties?.['날짜']?.date?.start;
      return itemDate === dateStr;
    });

    let addedCount = 0;
    let skippedCount = 0;

    for (const item of itemsOnDate) {
      const title = getCalendarItemTitle(item);
      const bookRelation = item.properties?.['책']?.relation?.[0];

      // 플래너에 이미 같은 제목과 날짜의 항목이 있는지 확인
      const isDuplicate = currentData.results.some(plannerItem => {
        const plannerTitle = plannerItem.properties?.['범위']?.title?.[0]?.plain_text || '';
        const plannerDate = plannerItem.properties?.['날짜']?.date?.start || '';
        return plannerTitle === title && plannerDate === dateStr;
      });

      if (isDuplicate) {
        skippedCount++;
        continue;
      }

      const properties = {
        '범위': {
          title: [{ text: { content: title } }]
        },
        '날짜': {
          date: { start: dateStr }
        },
        '완료': { checkbox: false }
      };

      if (bookRelation) {
        properties['책'] = { relation: [{ id: bookRelation.id }] };
      }

      const notionUrl = 'https://api.notion.com/v1/pages';
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: properties
        })
      });

      if (!response.ok) {
        throw new Error('플래너에 저장 실패');
      }
      addedCount++;
    }

    // alert 없이 바로 새로고침
    await fetchAllData();
    // 프리플랜-플래너 자동 연결
    await linkPrePlanToPlannerSilent();
  } catch (error) {
    console.error('Save error:', error);
  } finally {
    loading.textContent = '';
  }
};

window.saveAllToPlanner = async function() {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    let totalAdded = 0;
    let totalSkipped = 0;

    // 프리플랜의 모든 항목 순회
    for (const item of currentData.results) {
      const title = getCalendarItemTitle(item);
      const dateStart = item.properties?.['날짜']?.date?.start;
      const bookRelation = item.properties?.['책']?.relation?.[0];

      if (!dateStart) continue;

      // 플래너에 이미 같은 제목과 날짜의 항목이 있는지 확인
      const isDuplicate = currentData.results.some(plannerItem => {
        const plannerTitle = plannerItem.properties?.['범위']?.title?.[0]?.plain_text || '';
        const plannerDate = plannerItem.properties?.['날짜']?.date?.start || '';
        return plannerTitle === title && plannerDate === dateStart;
      });

      if (isDuplicate) {
        totalSkipped++;
        continue;
      }

      const properties = {
        '범위': {
          title: [{ text: { content: title } }]
        },
        '날짜': {
          date: { start: dateStart }
        },
        '완료': { checkbox: false }
      };

      if (bookRelation) {
        properties['책'] = { relation: [{ id: bookRelation.id }] };
      }

      const notionUrl = 'https://api.notion.com/v1/pages';
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: properties
        })
      });

      if (!response.ok) {
        console.error('플래너 저장 실패:', title);
        continue;
      }
      totalAdded++;
    }

    // alert 없이 바로 새로고침
    await fetchAllData();
    // 프리플랜-플래너 자동 연결
    await linkPrePlanToPlannerSilent();
  } catch (error) {
    console.error('Save all error:', error);
  } finally {
    loading.textContent = '';
  }
};

window.undoCalendarSync = async function() {
  if (lastSyncedItems.length === 0) {
    return;
  }

  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    // 마지막 동기화로 생성된 항목들을 삭제
    let deletedCount = 0;
    for (const itemId of lastSyncedItems) {
      const notionUrl = `https://api.notion.com/v1/pages/${itemId}`;
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          archived: true
        })
      });

      if (response.ok) {
        deletedCount++;
      } else {
        console.error('삭제 실패:', itemId, response.status);
      }
    }

    // 되돌리기 후 초기화
    lastSyncedItems = [];
    await fetchAllData();
    renderCalendarView();
  } catch (error) {
    console.error('Undo error:', error);
  } finally {
    loading.textContent = '';
  }
};

window.syncPlannerToCalendar = async function() {
  const loading = document.getElementById('loading');
  loading.textContent = '⏳';

  try {
    // 새 동기화 시작 시 이전 기록 초기화
    lastSyncedItems = [];

    // 플래너의 모든 항목 가져오기
    const plannerItems = currentData.results;

    // 날짜별로 그룹화
    const itemsByDate = {};
    plannerItems.forEach(item => {
      const dateStart = item.properties?.['날짜']?.date?.start;
      if (dateStart) {
        if (!itemsByDate[dateStart]) {
          itemsByDate[dateStart] = [];
        }
        itemsByDate[dateStart].push(item);
      }
    });

    // 각 날짜별로 원본만 필터링
    const originalItems = [];
    for (const [dateStr, items] of Object.entries(itemsByDate)) {
      // 책+제목 조합으로 그룹화
      const titleGroups = {};
      items.forEach(item => {
        const title = item.properties?.['범위']?.title?.[0]?.plain_text || '';
        const bookId = item.properties?.['책']?.relation?.[0]?.id || 'no-book';

        // 제목에서 ', (2), (3) 등 제거하여 base 제목 추출
        const baseTitle = title.replace(/['']/g, '').replace(/\s*\(\d+\)\s*$/, '').trim();
        const key = `${bookId}:${baseTitle}`;

        if (!titleGroups[key]) {
          titleGroups[key] = [];
        }
        titleGroups[key].push(item);
      });

      // 각 그룹에서 가장 먼저 생성된 항목만 선택
      for (const group of Object.values(titleGroups)) {
        group.sort((a, b) => {
          const timeA = new Date(a.created_time || 0);
          const timeB = new Date(b.created_time || 0);
          return timeA - timeB;
        });
        originalItems.push(group[0]); // 가장 오래된 것(원본)만 추가
      }
    }

    // 프리플랜에 이미 있는 항목 맵 (제목+책 → 항목)
    const existingCalendarItemsMap = new Map();
    currentData.results.forEach(item => {
      const title = getCalendarItemTitle(item);
      const bookId = item.properties?.['책']?.relation?.[0]?.id || 'no-book';
      const key = `${bookId}:${title}`;
      existingCalendarItemsMap.set(key, item);
    });

    // 프리플랜에 복사 또는 업데이트
    let syncCount = 0;
    let updateCount = 0;
    for (const item of originalItems) {
      const title = item.properties?.['범위']?.title?.[0]?.plain_text || '';
      const dateStart = item.properties?.['날짜']?.date?.start;
      const bookRelation = item.properties?.['책']?.relation?.[0];
      const bookId = bookRelation?.id || 'no-book';

      // 이미 존재하는지 확인
      const itemKey = `${bookId}:${title}`;
      const existingItem = existingCalendarItemsMap.get(itemKey);

      if (existingItem) {
        // 이미 있으면 날짜 확인
        const existingDate = existingItem.properties?.['날짜']?.date?.start;
        if (existingDate !== dateStart) {
          // 날짜가 다르면 업데이트
          const notionUrl = `https://api.notion.com/v1/pages/${existingItem.id}`;
          const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${NOTION_API_KEY}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              properties: {
                '날짜': { date: { start: dateStart } }
              }
            })
          });

          if (response.ok) {
            updateCount++;
          }
        }
        continue; // 이미 있으면 새로 생성은 하지 않음
      }

      // 프리플랜에 생성 (pre-plan 속성 사용)
      const properties = {
        '날짜': {
          date: { start: dateStart }
        }
      };

      // pre-plan 속성이 title 타입인지 확인 후 사용
      // 일단 기본 title 속성으로 시도
      for (const [key, value] of Object.entries(currentData.results[0]?.properties || {})) {
        if (value.type === 'title') {
          properties[key] = {
            title: [{ text: { content: title } }]
          };
          break;
        }
      }

      if (bookRelation) {
        properties['책'] = { relation: [{ id: bookRelation.id }] };
      }

      const notionUrl = 'https://api.notion.com/v1/pages';
      const response = await fetch(`${CORS_PROXY}${encodeURIComponent(notionUrl)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parent: { database_id: CALENDAR_DB_ID },
          properties: properties
        })
      });

      if (response.ok) {
        const result = await response.json();
        // 새로 생성된 항목 ID 저장
        lastSyncedItems.push(result.id);
        syncCount++;
      }
    }

    // alert 없이 바로 새로고침
    await fetchAllData();
    // 프리플랜-플래너 자동 연결
    await linkPrePlanToPlannerSilent();
    renderCalendarView();
  } catch (error) {
    console.error('Sync error:', error);
  } finally {
    loading.textContent = '';
  }
};

function renderCalendarView() {
  const content = document.getElementById('content');

  // CALENDAR 모드일 때는 플래너 통계만 표시
  if (plannerCalendarViewMode) {
    content.innerHTML = `
      ${renderPlannerCalendarHTML()}
    `;
    return;
  }

  // LIST 모드일 때는 프리플랜 리스트 표시
  if (!currentData || !currentData.results) return;

  // 날짜별로 그룹화
  const groupedByDate = {};
  currentData.results.forEach(item => {
    const dateStart = item.properties?.['날짜']?.date?.start;
    if (dateStart) {
      if (!groupedByDate[dateStart]) {
        groupedByDate[dateStart] = [];
      }
      groupedByDate[dateStart].push(item);
    }
  });

  // calendarStartDate부터 calendarEndDate까지 모든 날짜 생성
  const allDates = [];
  const currentLoopDate = new Date(calendarStartDate);
  while (currentLoopDate < calendarEndDate) {
    // 로컬 날짜를 YYYY-MM-DD 형식으로 변환
    const dateStr = `${currentLoopDate.getFullYear()}-${String(currentLoopDate.getMonth() + 1).padStart(2, '0')}-${String(currentLoopDate.getDate()).padStart(2, '0')}`;
    allDates.push(dateStr);
    currentLoopDate.setDate(currentLoopDate.getDate() + 1);
  }

  // 로컬 날짜를 YYYY-MM-DD 형식으로 변환
  const todayDate = new Date();
  const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

  let html = `
    <button onclick="loadPrevCalendar()" style="width: 100%; background: #e5e5e7; color: #333; border: none; border-radius: 4px; padding: 8px; font-size: 11px; cursor: pointer; margin-bottom: 12px;">더보기</button>
  `;

  allDates.forEach(dateStr => {
    const items = groupedByDate[dateStr] || [];
    const dateLabel = formatDateLabel(dateStr);
    const isToday = dateStr === today;
    const dateStyle = isToday ? 'font-size: 13px; font-weight: 700; color: #333; margin: 0;' : 'font-size: 13px; font-weight: 600; color: #666; margin: 0;';

    html += `
      <div style="margin-bottom: 20px;">
        <div style="display: flex; align-items: center; margin-bottom: 8px;">
          <h4 style="${dateStyle} cursor: pointer;" onclick="toggleCalendarView('${dateStr}')" title="플래너로 이동">${dateLabel}</h4>
        </div>
        <div class="calendar-date-group" data-date="${dateStr}">
    `;

    if (items.length === 0) {
      html += `<div style="font-size: 11px; color: #999; padding: 8px;">일정 없음</div>`;
    } else {
      // 책이름으로 먼저 정렬, 같은 책 안에서 제목으로 정렬 (숫자는 자연스럽게)
      const sortedItems = items.sort((a, b) => {
        const titleA = getCalendarItemTitle(a);
        const titleB = getCalendarItemTitle(b);
        const bookRelationA = a.properties?.['책']?.relation?.[0];
        const bookRelationB = b.properties?.['책']?.relation?.[0];
        const bookNameA = bookRelationA && bookNames[bookRelationA.id] ? bookNames[bookRelationA.id] : '';
        const bookNameB = bookRelationB && bookNames[bookRelationB.id] ? bookNames[bookRelationB.id] : '';

        // 1. 먼저 책 이름으로 정렬
        const bookCompare = bookNameA.localeCompare(bookNameB, 'ko', { numeric: true });
        if (bookCompare !== 0) return bookCompare;

        // 2. 같은 책이면 제목으로 정렬 (숫자 자연스럽게)
        return titleA.localeCompare(titleB, 'ko', { numeric: true });
      });

      sortedItems.forEach(item => {
        const title = getCalendarItemTitle(item);
        const bookRelation = item.properties?.['책']?.relation?.[0];
        const bookName = bookRelation && bookNames[bookRelation.id] ? bookNames[bookRelation.id] : '';
        const displayTitle = bookName ? `[${bookName}] ${title}` : title;

        // 플래너 데이터베이스의 완료 상태 직접 가져오기
        const completed = item.properties?.['완료']?.checkbox || false;

        html += `
          <div class="calendar-item" data-id="${item.id}" data-date="${dateStr}" style="position: relative; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;">
            <div class="drag-handle" style="position: absolute; left: 0; top: 0; bottom: 0; width: 80px; cursor: grab; opacity: 0; user-select: none; -webkit-user-select: none; touch-action: none;"></div>
            <div style="font-size: 12px; color: #333; flex: 1; cursor: pointer;" onclick="editTask('${item.id}')">${displayTitle}</div>
            <div class="checkbox ${completed ? 'checked' : ''}" style="pointer-events: none; margin-left: 8px;">
              ${completed ? '✓' : ''}
            </div>
          </div>
        `;
      });
    }

    html += `
        </div>
      </div>
    `;
  });

  html += `
    <button onclick="loadNextCalendar()" style="width: 100%; background: #e5e5e7; color: #333; border: none; border-radius: 4px; padding: 8px; font-size: 11px; cursor: pointer; margin-top: 4px;">더보기</button>
  `;

  content.innerHTML = html;
  initCalendarDragDrop();
}

function initCalendarDragDrop() {
  const items = document.querySelectorAll('.calendar-item');
  const groups = document.querySelectorAll('.calendar-date-group');

  let draggedItem = null;
  let touchStartY = 0;
  let touchCurrentY = 0;
  let isMouseDragging = false;

  // 마우스 이벤트는 document 레벨에서 한 번만 등록
  const handleMouseMove = (e) => {
    if (!isMouseDragging || !draggedItem) return;

    // 마우스 위치에 있는 그룹 찾기
    const touchedElement = document.elementFromPoint(e.clientX, e.clientY);
    const targetGroup = touchedElement?.closest('.calendar-date-group');

    // 모든 그룹 하이라이트 제거
    groups.forEach(g => g.style.background = 'transparent');

    // 현재 그룹 하이라이트
    if (targetGroup) {
      targetGroup.style.background = '#f0f0f0';
    }
  };

  const handleMouseUp = (e) => {
    if (!isMouseDragging) return;
    isMouseDragging = false;

    if (draggedItem) {
      draggedItem.style.opacity = '1';
      draggedItem.style.position = '';
      draggedItem.style.zIndex = '';

      const handle = draggedItem.querySelector('.drag-handle');
      if (handle) handle.style.cursor = 'grab';

      // 마우스 종료 위치의 그룹 찾기
      const touchedElement = document.elementFromPoint(e.clientX, e.clientY);
      const targetGroup = touchedElement?.closest('.calendar-date-group');

      if (targetGroup && draggedItem) {
        const newDate = targetGroup.getAttribute('data-date');
        const itemId = draggedItem.getAttribute('data-id');

        draggedItem.setAttribute('data-date', newDate);
        targetGroup.appendChild(draggedItem);

        updateCalendarItemDate(itemId, newDate);
      }

      // 모든 그룹 하이라이트 제거
      groups.forEach(g => g.style.background = 'transparent');

      draggedItem = null;
    }
  };

  // 기존 리스너 제거 후 새로 등록
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  items.forEach(item => {
    const handle = item.querySelector('.drag-handle');
    if (!handle) return;

    handle.setAttribute('draggable', 'true');

    // 데스크톱 드래그
    handle.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.style.opacity = '0.5';
    });

    handle.addEventListener('dragend', (e) => {
      item.style.opacity = '1';
    });

    // 마우스 드래그 (아이패드 마우스 포함)
    handle.addEventListener('mousedown', (e) => {
      isMouseDragging = true;
      draggedItem = item;
      item.style.opacity = '0.5';
      item.style.position = 'relative';
      item.style.zIndex = '1000';
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    // 모바일 터치 드래그
    handle.addEventListener('touchstart', (e) => {
      draggedItem = item;
      touchStartY = e.touches[0].clientY;
      item.style.opacity = '0.5';
      item.style.position = 'relative';
      item.style.zIndex = '1000';
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      e.preventDefault();
      touchCurrentY = e.touches[0].clientY;

      // 터치 위치에 있는 그룹 찾기
      const touchedElement = document.elementFromPoint(
        e.touches[0].clientX,
        e.touches[0].clientY
      );

      const targetGroup = touchedElement?.closest('.calendar-date-group');

      // 모든 그룹 하이라이트 제거
      groups.forEach(g => g.style.background = 'transparent');

      // 현재 그룹 하이라이트
      if (targetGroup) {
        targetGroup.style.background = '#f0f0f0';
      }
    }, { passive: false });

    handle.addEventListener('touchend', (e) => {
      item.style.opacity = '1';
      item.style.position = '';
      item.style.zIndex = '';

      // 터치 종료 위치의 그룹 찾기
      const touchedElement = document.elementFromPoint(
        e.changedTouches[0].clientX,
        e.changedTouches[0].clientY
      );

      const targetGroup = touchedElement?.closest('.calendar-date-group');

      if (targetGroup && draggedItem) {
        const newDate = targetGroup.getAttribute('data-date');
        const itemId = draggedItem.getAttribute('data-id');

        draggedItem.setAttribute('data-date', newDate);
        targetGroup.appendChild(draggedItem);

        updateCalendarItemDate(itemId, newDate);
      }

      // 모든 그룹 하이라이트 제거
      groups.forEach(g => g.style.background = 'transparent');

      draggedItem = null;
    });
  });

  groups.forEach(group => {
    group.addEventListener('dragover', (e) => {
      e.preventDefault();
      group.style.background = '#f0f0f0';
    });

    group.addEventListener('dragleave', (e) => {
      group.style.background = 'transparent';
    });

    group.addEventListener('drop', (e) => {
      e.preventDefault();
      group.style.background = 'transparent';

      if (draggedItem) {
        const newDate = group.getAttribute('data-date');
        const itemId = draggedItem.getAttribute('data-id');

        draggedItem.setAttribute('data-date', newDate);
        group.appendChild(draggedItem);

        updateCalendarItemDate(itemId, newDate);
      }
    });
  });
}
