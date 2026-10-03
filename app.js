/* ============================================================
   app.js - هسته اصلی برنامه (نسخه نهایی)
   ============================================================
   شامل:
   - State Management
   - احراز هویت + راه‌اندازی اولیه امن
   - مدیریت قراردادها (CRUD)
   - محاسبات (قسط، سود، جریمه)
   - Undo/Redo
   - اعتبارسنجی دقیق تاریخ
   - دسته‌بندی (Tag)
   - BroadcastChannel برای قفل همزمانی
   - سطل بازیابی (Trash)
   - Snapshots (20 نسخه)
   - محافظت از بازنویسی
   - آرشیو لاگ‌ها
   - UI Rendering + نمودارها + خروجی‌ها
============================================================ */

'use strict';

/* ==================== ثابت‌ها ==================== */
const APP_CONFIG = {
    VERSION: 18,
    NAME: 'دفترچه اقساط هوشمند',
    DATA_VERSION: 2,
    HISTORY_LIMIT: 30,
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 5 * 60 * 1000,
    CONTRACT_TAGS: ['عادی', 'مهم', 'دیرکرد سابق', 'معتبر', 'VIP', 'مشکل‌دار']
};

const DEFAULT_USERNAME = 'admin';
const LOG_KEY = 'moto_logs';
const LOCK_KEY = 'moto_lock';
const TAB_ID = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2);

/* ==================== State ==================== */
const State = {
    contracts: [],
    currentPassword: '',
    encryptionKey: null,
    isLoggedIn: false,
    loadError: false,
    editingId: null,
    payContext: null,
    currentPage: 1,
    totalPages: 1,
    filteredContracts: [],
    isLocked: false,
    tabId: TAB_ID,
    history: [],
    historyIndex: -1,
    broadcastChannel: null,
    selectedTag: 'all',
    dateFilter: { from: null, to: null },
    saveCounter: 0,
    checkContext: null,
    charts: {
        sales: null,
        status: null,
        bike: null,
        check: null
    }
};

/* ==================== قفل همزمانی با BroadcastChannel ==================== */
function initBroadcastChannel(){
    if(!('BroadcastChannel' in window)){
        console.warn('⚠️ BroadcastChannel پشتیبانی نمی‌شود');
        return;
    }
    
    State.broadcastChannel = new BroadcastChannel('moto_app_channel');
    
    State.broadcastChannel.onmessage = (event) => {
        const msg = event.data;
        
        if(msg.type === 'lock_acquired' && msg.tabId !== State.tabId){
            State.isLocked = true;
            showLockBanner(msg.tabId);
        }
        
        if(msg.type === 'lock_released' && msg.tabId !== State.tabId){
            State.isLocked = false;
            hideLockBanner();
        }
        
        if(msg.type === 'data_updated' && msg.tabId !== State.tabId){
            reloadFromStorage();
            showToast('🔄 داده‌ها از تب دیگر به‌روزرسانی شد', 'info');
        }
        
        if(msg.type === 'request_data' && msg.tabId !== State.tabId){
            broadcastDataUpdate();
        }
    };
    
    broadcast({ type: 'tab_opened', tabId: State.tabId });
    
    window.addEventListener('beforeunload', () => {
        broadcast({ type: 'lock_released', tabId: State.tabId });
        if(State.broadcastChannel) State.broadcastChannel.close();
    });
}

function broadcast(message){
    if(State.broadcastChannel){
        try{
            State.broadcastChannel.postMessage(message);
        }catch(e){}
    }
}

function broadcastLockAcquired(){
    broadcast({ type: 'lock_acquired', tabId: State.tabId });
}

function broadcastDataUpdate(){
    broadcast({ type: 'data_updated', tabId: State.tabId });
}

function showLockBanner(otherTab){
    const banner = document.getElementById('lockBanner');
    if(banner) banner.classList.add('active');
}

function hideLockBanner(){
    const banner = document.getElementById('lockBanner');
    if(banner) banner.classList.remove('active');
}

/* ==================== History (Undo/Redo) ==================== */
function pushHistory(action){
    if(State.historyIndex < State.history.length - 1){
        State.history = State.history.slice(0, State.historyIndex + 1);
    }
    
    State.history.push({
        action: action,
        contracts: JSON.parse(JSON.stringify(State.contracts)),
        timestamp: Date.now()
    });
    
    if(State.history.length > APP_CONFIG.HISTORY_LIMIT){
        State.history.shift();
    }
    
    State.historyIndex = State.history.length - 1;
    updateUndoRedoButtons();
}

function undo(){
    if(State.historyIndex <= 0){
        showToast('چیزی برای برگشت وجود ندارد', 'warning');
        return;
    }
    
    State.historyIndex--;
    State.contracts = JSON.parse(JSON.stringify(State.history[State.historyIndex].contracts));
    saveAllData();
    renderAll();
    updateUndoRedoButtons();
    
    const action = State.history[State.historyIndex + 1].action;
    showToast(`↩️ برگشت: ${action}`, 'success');
}

function redo(){
    if(State.historyIndex >= State.history.length - 1){
        showToast('چیزی برای ازنو وجود ندارد', 'warning');
        return;
    }
    
    State.historyIndex++;
    State.contracts = JSON.parse(JSON.stringify(State.history[State.historyIndex].contracts));
    saveAllData();
    renderAll();
    updateUndoRedoButtons();
    
    const action = State.history[State.historyIndex].action;
    showToast(`↪️ ازنو: ${action}`, 'success');
}

function updateUndoRedoButtons(){
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    
    if(undoBtn) undoBtn.disabled = State.historyIndex <= 0;
    if(redoBtn) redoBtn.disabled = State.historyIndex >= State.history.length - 1;
}

/* ==================== راه‌اندازی اولیه امن ==================== */
async function checkInitialSetup(){
    try{
        const auth = await CryptoLayer.initAuth();
        const setupBtn = document.getElementById('setupBtn');
        const loginHint = document.getElementById('loginHint');
        
        if(auth.isFirstRun){
            // اولین اجرا - نمایش دکمه راه‌اندازی
            if(setupBtn) setupBtn.style.display = 'block';
            if(loginHint) loginHint.innerHTML = '🔐 در اولین اجرا، رمز عبور امن خود را تعیین کنید.';
            
            // باز کردن خودکار مودال
            setTimeout(() => openFirstSetup(), 300);
        } else {
            if(setupBtn) setupBtn.style.display = 'none';
            if(loginHint) loginHint.innerHTML = '👤 نام کاربری: <b>admin</b><br>🔑 رمز عبور خود را وارد کنید.';
        }
    }catch(e){
        console.error('Init setup error:', e);
    }
}

function openFirstSetup(){
    const modal = document.getElementById('firstSetupModal');
    if(modal) modal.classList.add('active');
}

function closeFirstSetup(){
    const modal = document.getElementById('firstSetupModal');
    if(modal) modal.classList.remove('active');
}

async function createAdminAccount(){
    const password = document.getElementById('setupPassword').value;
    const password2 = document.getElementById('setupPassword2').value;
    
    if(password.length < 10){
        showToast('رمز عبور باید حداقل ۱۰ کاراکتر باشد', 'danger');
        return;
    }
    
    if(password !== password2){
        showToast('تکرار رمز عبور مطابقت ندارد', 'danger');
        return;
    }
    
    const strength = checkPasswordStrength(password);
    if(strength.score < 2){
        showToast('رمز ضعیف است. از حروف بزرگ، کوچک، اعداد و علامت استفاده کنید', 'danger');
        return;
    }
    
    try{
        const result = await CryptoLayer.setupFirstPassword(password);
        
        if(result.success){
            State.currentPassword = password;
            State.encryptionKey = result.key;
            
            closeFirstSetup();
            
            const setupBtn = document.getElementById('setupBtn');
            if(setupBtn) setupBtn.style.display = 'none';
            
            // ذخیره‌ی داده‌های خالی اولیه
            await CryptoLayer.saveSecureData({ version: 1, contracts: [] }, password);
            
            // ورود خودکار
            await doLoginAfterSetup(password);
            
            showToast('✅ حساب مدیر با موفقیت ساخته شد', 'success');
        }
    }catch(e){
        console.error(e);
        showToast('خطا در ساخت حساب', 'danger');
    }
}

function checkPasswordStrength(password){
    let score = 0;
    const feedback = [];
    
    if(password.length >= 10) score++;
    else feedback.push('حداقل ۱۰ کاراکتر');
    
    if(password.length >= 14) score++;
    
    if(/[a-z]/.test(password)) score++;
    else feedback.push('حروف کوچک');
    
    if(/[A-Z]/.test(password)) score++;
    else feedback.push('حروف بزرگ');
    
    if(/[0-9]/.test(password)) score++;
    else feedback.push('اعداد');
    
    if(/[^a-zA-Z0-9]/.test(password)) score++;
    else feedback.push('علامت خاص');
    
    return { score, feedback };
}

async function doLoginAfterSetup(password){
    try{
        const result = await CryptoLayer.verifyPassword(password);
        
        if(result.success){
            State.isLoggedIn = true;
            State.currentPassword = password;
            State.encryptionKey = result.key;
            State.loadError = false;
            
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('app').classList.add('active');
            
            State.contracts = [];
            await saveAllData();
            renderAll();
            
            addLog('setup', 'حساب مدیر ساخته شد');
            
            // شروع قفل و BroadcastChannel
            broadcastLockAcquired();
            initBroadcastChannel();
            
            setTimeout(() => refreshDashboard(), 500);
        }
    }catch(e){
        console.error(e);
    }
}

/* ==================== احراز هویت ==================== */
async function doLogin(){
    const usernameEl = document.getElementById('loginUsername');
    const passwordEl = document.getElementById('loginPassword');
    const errorEl = document.getElementById('loginError');
    const loginBtn = document.getElementById('loginBtn');
    
    const username = usernameEl ? usernameEl.value.trim() : 'admin';
    const password = passwordEl ? passwordEl.value : '';
    
    if(!username){ errorEl.textContent = 'نام کاربری را وارد کنید'; return; }
    if(!password){ errorEl.textContent = 'رمز عبور را وارد کنید'; return; }
    
    if(username !== DEFAULT_USERNAME){
        errorEl.textContent = 'نام کاربری اشتباه است';
        addLog('login_failed', `نام کاربری اشتباه: ${username}`);
        return;
    }
    
    if(loginBtn){
        loginBtn.disabled = true;
        loginBtn.textContent = '⏳ در حال بررسی...';
    }
    
    try{
        const result = await CryptoLayer.verifyPassword(password);
        
        if(result.success){
            State.isLoggedIn = true;
            State.currentPassword = password;
            State.encryptionKey = result.key;
            State.loadError = false;
            
            errorEl.textContent = '';
            
            // بارگذاری امن داده‌ها
            const data = await AppMerged.safeLoadData();
            
            // ⭐ محافظت از بازنویسی در خطای رمزگشایی
            if(data._loadError){
                State.isLoggedIn = false;
                State.currentPassword = '';
                State.encryptionKey = null;
                State.loadError = true;
                
                errorEl.textContent = 'اطلاعات ذخیره‌شده قابل رمزگشایی نیست. برای جلوگیری از حذف داده‌ها، هیچ ذخیره‌سازی انجام نمی‌شود.';
                addLog('login_failed', 'خطای رمزگشایی - محافظت از داده');
                return;
            }
            
            State.contracts = data.contracts || [];
            
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('app').classList.add('active');
            document.getElementById('loginPassword').value = '';
            
            await saveAllData();
            renderAll();
            
            addLog('login', 'ورود موفق به سیستم');
            showToast('✅ خوش آمدید', 'success');
            
            setTimeout(() => refreshDashboard(), 500);
            
            // شروع قفل و BroadcastChannel
            broadcastLockAcquired();
            initBroadcastChannel();
            
            // شروع چک پشتیبان خودکار
            setTimeout(() => startAutoBackupCheck(), 5000);
            
            // بارگذاری فایل قبلی اگر وجود دارد
            setTimeout(() => tryLoadExistingFile(), 1000);
            
            // ⭐ Snapshot خودکار بعد از ورود
            setTimeout(async () => {
                await CryptoLayer.createSnapshot(State.contracts, State.currentPassword, 'بعد از ورود');
            }, 3000);
            
        } else {
            errorEl.textContent = result.reason || 'رمز اشتباه است';
            addLog('login_failed', result.reason || 'رمز اشتباه');
        }
    } catch(e){
        console.error(e);
        errorEl.textContent = 'خطا در ورود: ' + e.message;
    } finally {
        if(loginBtn){
            loginBtn.disabled = false;
            loginBtn.textContent = '🔓 ورود به سیستم';
        }
    }
}

/* ==================== درخواست خروج ==================== */
function requestLogout(){
    const modal = document.getElementById('exitModal');
    if(modal){
        document.getElementById('exitModalCount').textContent = toPersianDigits(State.contracts.length);
        modal.classList.add('active');
    }
}

function cancelExit(){
    const modal = document.getElementById('exitModal');
    if(modal) modal.classList.remove('active');
}

async function exitWithBackup(type){
    try{
        if(type === 'json'){
            await exportData();
        } else if(type === 'xlsx'){
            if(typeof exportExcelXLSX === 'function') exportExcelXLSX();
        }
        
        await CryptoLayer.setMeta('lastBackup', Date.now());
        addLog('backup_on_exit', `${State.contracts.length} قرارداد`);
        showToast('✅ پشتیبان دانلود شد', 'success');
        
        setTimeout(() => performLogout(), 800);
    } catch(e){
        console.error(e);
        showToast('خطا در پشتیبان‌گیری', 'danger');
    }
}

async function exitWithoutBackup(){
    if(!confirm('آیا مطمئنید بدون تهیه نسخه پشتیبان خارج می‌شوید؟')){
        return;
    }
    performLogout();
}

async function performLogout(){
    addLog('logout', 'خروج از سیستم');
    
    // ذخیره‌ی نهایی
    if(!State.loadError){
        await saveAllData();
    }
    
    // آزاد کردن قفل
    broadcast({ type: 'lock_released', tabId: State.tabId });
    
    State.isLoggedIn = false;
    State.currentPassword = '';
    State.encryptionKey = null;
    State.contracts = [];
    State.loadError = false;
    
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('app').classList.remove('active');
    document.getElementById('lockBanner').classList.remove('active');
    document.getElementById('exitModal').classList.remove('active');
}

/* ==================== تغییر رمز عبور ==================== */
async function changePasswordSafely(){
    const oldPass = document.getElementById('oldPass').value;
    const newPass = document.getElementById('newPass').value;
    const newPass2 = document.getElementById('newPass2').value;
    
    if(newPass.length < 10){
        showToast('رمز جدید حداقل ۱۰ کاراکتر', 'danger');
        return;
    }
    
    if(newPass !== newPass2){
        showToast('تکرار رمز مطابقت ندارد', 'danger');
        return;
    }
    
    // ⭐ Snapshot قبل از تغییر
    try{
        await CryptoLayer.createSnapshot(State.contracts, State.currentPassword, 'قبل از تغییر رمز');
    }catch(e){
        console.warn('Snapshot failed:', e);
    }
    
    const result = await CryptoLayer.changePassword(oldPass, newPass);
    
    if(result.success){
        State.currentPassword = newPass;
        State.encryptionKey = result.key;
        
        await saveAllData();
        
        addLog('password_change', 'رمز تغییر کرد (با snapshot)');
        showToast('✅ رمز تغییر کرد', 'success');
        closeSettings();
    } else {
        showToast(result.reason, 'danger');
    }
}

/* ==================== ذخیره/بارگذاری داده‌ها ==================== */
async function saveAllData(){
    try{
        // ⭐ اگر خطای رمزگشایی داشتیم، ذخیره نکن
        if(State.loadError){
            console.warn('Skipping save due to load error');
            return false;
        }
        
        // ذخیره‌ی دوگانه (IndexedDB + localStorage)
        const result = await CryptoLayer.saveSecureData({
            version: 1,
            contracts: State.contracts
        }, State.currentPassword);
        
        if(!result.success){
            showToast('خطا در ذخیره‌سازی: ' + (result.reason || ''), 'danger');
            return false;
        }
        
        // Snapshot خودکار هر ۲۰ ذخیره
        State.saveCounter = (State.saveCounter || 0) + 1;
        if(State.saveCounter % 20 === 0){
            await CryptoLayer.createSnapshot(State.contracts, State.currentPassword, 'خودکار');
        }
        
        // Cleanup سطل بازیابی هر ۵۰ ذخیره
        if(State.saveCounter % 50 === 0){
            await CryptoLayer.cleanupTrash();
        }
        
        broadcastDataUpdate();
        updateStorageStatus();
        
        return true;
    } catch(e){
        console.error('Save error:', e);
        showToast('خطا در ذخیره‌سازی', 'danger');
        return false;
    }
}

async function reloadFromStorage(){
    try{
        const data = await AppMerged.safeLoadData();
        if(!data._loadError){
            State.contracts = data.contracts || [];
            renderAll();
        }
    } catch(e){
        console.error(e);
    }
}

/* ==================== محاسبات ==================== */
function calculateInstallment(){
    const total = getMoneyValue('totalPrice');
    const down = getMoneyValue('downPayment');
    const count = parseInt(toEnglishDigits(document.getElementById('installmentCount').value)) || 0;
    const ratePercent = getFloatValue('installmentRate');
    
    if(total > 0 && count > 0){
        const remaining = total - down;
        const profit = Math.round(remaining * (ratePercent / 100) * count);
        const finalTotal = remaining + profit;
        const each = Math.ceil(finalTotal / count);
        
        document.getElementById('eachInstallment').value = formatMoney(each) + ' تومان';
        document.getElementById('showRemaining').textContent = formatMoney(remaining) + ' تومان';
        document.getElementById('showProfit').textContent = formatMoney(profit) + ' تومان';
        document.getElementById('showFinal').textContent = formatMoney(finalTotal) + ' تومان';
        document.getElementById('showEach').textContent = formatMoney(each) + ' تومان';
    } else {
        document.getElementById('eachInstallment').value = '';
        document.getElementById('showRemaining').textContent = '۰ تومان';
        document.getElementById('showProfit').textContent = '۰ تومان';
        document.getElementById('showFinal').textContent = '۰ تومان';
        document.getElementById('showEach').textContent = '۰ تومان';
    }
}

function calculateInstallmentPenalty(inst, contract, today){
    if(!inst || inst.paid) return 0;
    const paidOnInst = inst.paidAmount || 0;
    const rem = inst.amount - paidOnInst;
    if(rem <= 0) return 0;
    
    const dueDate = jalaaliToGregorian(inst.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    const todayClean = new Date(today);
    todayClean.setHours(0, 0, 0, 0);
    
    if(todayClean <= dueDate) return 0;
    
    const daysLate = Math.floor((todayClean - dueDate) / (1000 * 60 * 60 * 24));
    if(daysLate <= 0) return 0;
    
    const rate = contract.penaltyRate || 0;
    let penalty = Math.round(rem * (rate / 100) * daysLate);
    
    if(contract.penaltyCap !== undefined && contract.penaltyCap > 0){
        const maxPenalty = Math.round(inst.amount * (contract.penaltyCap / 100));
        penalty = Math.min(penalty, maxPenalty);
    }
    
    return Math.max(0, penalty);
}

function getPenaltyDetail(inst, contract, today){
    const paidOnInst = inst.paidAmount || 0;
    const rem = inst.amount - paidOnInst;
    const dueDate = jalaaliToGregorian(inst.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    const todayClean = new Date(today);
    todayClean.setHours(0, 0, 0, 0);
    const daysLate = Math.max(0, Math.floor((todayClean - dueDate) / (1000 * 60 * 60 * 24)));
    const rate = contract.penaltyRate || 0;
    const rawPenalty = Math.round(rem * (rate / 100) * daysLate);
    const capAmount = contract.penaltyCap ? Math.round(inst.amount * (contract.penaltyCap / 100)) : Infinity;
    const finalPenalty = Math.min(rawPenalty, capAmount);
    const capped = rawPenalty > capAmount;
    
    return {
        remaining: rem,
        daysLate,
        rate,
        rawPenalty,
        capPercent: contract.penaltyCap,
        capAmount,
        finalPenalty: Math.max(0, finalPenalty),
        capped
    };
}

function getContractStatus(c){
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let paidCount = 0, partialCount = 0, overdueCount = 0, totalPenalty = 0;
    let totalPaidAmount = c.downPayment, totalRemaining = 0, totalChecks = 0;
    
    (c.installments || []).forEach(inst => {
        if(inst.remaining === undefined){
            inst.remaining = inst.paid ? 0 : inst.amount;
            inst.paidAmount = inst.paid ? inst.amount : 0;
        }
        if(inst.payments === undefined) inst.payments = [];
        if(inst.payType === undefined) inst.payType = 'نقدی';
        if(inst.number === undefined) inst.number = 0;
        
        const paidOnInst = inst.paidAmount || 0;
        const rem = inst.amount - paidOnInst;
        
        if(inst.payType === 'چک') totalChecks += rem;
        
        const dueDate = jalaaliToGregorian(inst.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const isOverdue = dueDate < today && rem > 0;
        
        if(rem > 0 && isOverdue){
            const pen = calculateInstallmentPenalty(inst, c, today);
            inst.penalty = pen;
            totalPenalty += pen;
            overdueCount++;
        } else {
            inst.penalty = 0;
        }
        
        if(paidOnInst >= inst.amount) paidCount++;
        else if(paidOnInst > 0) partialCount++;
        
        totalPaidAmount += paidOnInst;
        totalRemaining += rem;
    });
    
    let status = 'active';
    if(totalRemaining <= 0) status = 'paid';
    else if(overdueCount > 0) status = 'overdue';
    
    return {
        paidCount,
        partialCount,
        overdueCount,
        totalPenalty,
        totalPaidAmount,
        remaining: totalRemaining + totalPenalty,
        totalRemaining,
        totalChecks,
        status
    };
}

/* ==================== اعتبارسنجی دقیق تاریخ ==================== */
function isValidJalaliDate(jStr){
    if(!jStr) return false;
    const cleaned = toEnglishDigits(String(jStr)).trim();
    const parts = cleaned.split('/');
    if(parts.length !== 3) return false;
    
    const jy = parseInt(parts[0]);
    const jm = parseInt(parts[1]);
    const jd = parseInt(parts[2]);
    
    if(isNaN(jy) || isNaN(jm) || isNaN(jd)) return false;
    if(jy < 1300 || jy > 1500) return false;
    if(jm < 1 || jm > 12) return false;
    if(jd < 1 || jd > 31) return false;
    
    if(jm <= 6 && jd > 31) return false;
    if(jm >= 7 && jm <= 11 && jd > 30) return false;
    
    if(jm === 12){
        const isLeap = isLeapJalaliYear(jy);
        if(jd > (isLeap ? 30 : 29)) return false;
    }
    
    return true;
}

function isLeapJalaliYear(jy){
    const mod = jy % 33;
    return [1, 5, 9, 13, 17, 22, 26, 30].includes(mod);
}

function validateContractDates(contract){
    const errors = [];
    
    if(!isValidJalaliDate(contract.downPaymentDate)){
        errors.push('تاریخ خرید نامعتبر است');
    }
    
    if(!isValidJalaliDate(contract.startDate)){
        errors.push('تاریخ اولین قسط نامعتبر است');
    }
    
    let prevDate = null;
    (contract.installments || []).forEach((inst, i) => {
        if(!isValidJalaliDate(inst.dueDate)){
            errors.push(`تاریخ قسط ${i + 1} نامعتبر است`);
        }
        
        if(prevDate){
            const prev = jalaaliToGregorian(prevDate);
            const curr = jalaaliToGregorian(inst.dueDate);
            if(curr <= prev){
                errors.push(`تاریخ قسط ${i + 1} باید بعد از قسط ${i} باشد`);
            }
        }
        prevDate = inst.dueDate;
    });
    
    return errors;
}

/* ==================== عملیات قرارداد (CRUD) ==================== */
async function submitContract(){
    if(State.isLocked){
        showToast('⛔ در حال حاضر نمی‌توانید تغییر دهید (تب دیگر فعال است)', 'danger');
        return;
    }
    
    const g = id => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };
    const gn = id => toEnglishDigits(g(id).replace(/[^0-9۰-۹٠-٩]/g, ''));
    
    const name = g('customerName');
    const national = gn('customerNational');
    const phone = gn('customerPhone');
    const guarantorName = g('guarantorName');
    const guarantorNational = gn('guarantorNational');
    const guarantorPhone = gn('guarantorPhone');
    const guarantor2Name = g('guarantor2Name');
    const guarantor2National = gn('guarantor2National');
    const guarantor2Phone = gn('guarantor2Phone');
    const model = g('bikeModel');
    const plate = g('bikePlate');
    const total = getMoneyValue('totalPrice');
    const down = getMoneyValue('downPayment');
    const count = parseInt(gn('installmentCount')) || 0;
    
    if(!name) return showToast('نام مشتری را وارد کنید', 'danger');
    if(!national || national.length !== 10) return showToast('کد ملی مشتری (۱۰ رقم)', 'danger');
    if(!phone || phone.length !== 11 || !phone.startsWith('09')) return showToast('موبایل مشتری (۱۱ رقم)', 'danger');
    if(!guarantorName) return showToast('نام ضامن اول', 'danger');
    if(!guarantorNational || guarantorNational.length !== 10) return showToast('کد ملی ضامن اول', 'danger');
    if(!guarantorPhone || guarantorPhone.length !== 11) return showToast('موبایل ضامن اول', 'danger');
    
    if(guarantor2Name || guarantor2National || guarantor2Phone){
        if(!guarantor2Name || !guarantor2National || guarantor2National.length !== 10 || !guarantor2Phone || guarantor2Phone.length !== 11){
            return showToast('اطلاعات ضامن دوم کامل نیست', 'danger');
        }
    }
    
    if(!model) return showToast('مدل موتور', 'danger');
    if(!plate) return showToast('شماره پلاک', 'danger');
    if(total <= 0) return showToast('قیمت کل', 'danger');
    if(down >= total) return showToast('پیش‌پرداخت کمتر از قیمت', 'danger');
    if(count < 1) return showToast('تعداد اقساط', 'danger');
    
    const dpDate = toEnglishDigits(g('downPaymentDate'));
    const startDate = toEnglishDigits(g('startDate'));
    
    if(!isValidJalaliDate(dpDate)) return showToast('تاریخ خرید نامعتبر است', 'danger');
    if(!isValidJalaliDate(startDate)) return showToast('تاریخ اولین قسط نامعتبر است', 'danger');
    
    const ratePercent = getFloatValue('installmentRate');
    const penaltyRateValue = getFloatValue('penaltyRate') || 0.5;
    const penaltyCapValue = getFloatValue('penaltyCap') || 50;
    const interval = parseInt(gn('installmentInterval')) || 30;
    const tag = g('contractTag') || 'عادی';
    
    const remaining = total - down;
    const profit = Math.round(remaining * (ratePercent / 100) * count);
    const finalTotal = remaining + profit;
    const each = Math.ceil(finalTotal / count);
    
    const baseData = {
        customerName: name,
        customerFather: g('customerFather'),
        customerNational: national,
        customerPhone: phone,
        customerLandline: gn('customerLandline'),
        customerBirth: toEnglishDigits(g('customerBirth')),
        customerAddress: g('customerAddress'),
        guarantorName,
        guarantorFather: g('guarantorFather'),
        guarantorNational,
        guarantorPhone,
        guarantorAddress: g('guarantorAddress'),
        guarantor2Name,
        guarantor2Father: g('guarantor2Father'),
        guarantor2National,
        guarantor2Phone,
        guarantor2Address: g('guarantor2Address'),
        bikeModel: model,
        bikeColor: g('bikeColor'),
        bikeYear: gn('bikeYear'),
        bikeChassis: gn('bikeChassis'),
        bikeEngine: gn('bikeEngine'),
        bikePlate: plate,
        totalPrice: total,
        downPayment: down,
        downPaymentDate: dpDate,
        downPaymentType: g('downPaymentType') || 'نقدی',
        installmentCount: count,
        installmentRate: ratePercent,
        totalProfit: profit,
        finalAmount: finalTotal,
        eachInstallment: each,
        startDate,
        installmentInterval: interval,
        penaltyRate: penaltyRateValue,
        penaltyCap: penaltyCapValue,
        defaultPayType: g('defaultPayType') || 'نقدی',
        notes: g('notes'),
        tag: tag
    };
    
    if(State.editingId){
        const c = State.contracts.find(x => x.id === State.editingId);
        if(!c) return;
        
        if(c.installmentCount !== count || c.eachInstallment !== each || c.startDate !== startDate || (c.installmentInterval || 30) !== interval){
            if(!confirm('جدول اقساط بازسازی می‌شود. ادامه؟')) return;
            c.installments = buildInstallments(count, each, startDate, baseData.defaultPayType, interval);
        }
        
        Object.assign(c, baseData);
        
        const errors = validateContractDates(c);
        if(errors.length > 0){
            return showToast(errors[0], 'danger');
        }
        
        pushHistory(`ویرایش قرارداد ${c.customerName}`);
        await saveAllData();
        cancelEdit();
        renderAll();
        addLog('edit', c.customerName);
        showToast('✅ ویرایش شد', 'success');
        return;
    }
    
    const contract = {
        id: Date.now() + Math.random(),
        ...baseData,
        installments: buildInstallments(count, each, startDate, baseData.defaultPayType, interval),
        createdAt: getTodayJalali()
    };
    
    const errors = validateContractDates(contract);
    if(errors.length > 0){
        return showToast(errors[0], 'danger');
    }
    
    pushHistory(`ثبت قرارداد ${contract.customerName}`);
    State.contracts.push(contract);
    await saveAllData();
    renderAll();
    resetForm();
    addLog('add', contract.customerName);
    showToast('✅ قرارداد ثبت شد', 'success');
}

function buildInstallments(count, each, firstInstallmentDate, payType, interval){
    interval = interval || 30;
    const arr = [];
    for(let i = 0; i < count; i++){
        const dueDate = addDaysToJalali(firstInstallmentDate, i * interval);
        arr.push({
            number: i + 1,
            dueDate,
            amount: each,
            payType,
            checkNumber: '', checkSerial: '', checkBank: '', checkBranch: '', checkPayee: '', checkDate: '',
            payments: [],
            paidAmount: 0,
            remaining: each,
            paid: false,
            paidDate: null,
            penalty: 0
        });
    }
    return arr;
}

function editContract(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    State.editingId = id;
    const set = (id, val) => {
        const el = document.getElementById(id);
        if(!el) return;
        if(id === 'totalPrice' || id === 'downPayment'){
            el.value = val ? Number(val).toLocaleString('en-US') : '';
        } else if(['installmentRate', 'penaltyRate', 'penaltyCap'].includes(id)){
            el.value = val !== undefined && val !== null ? String(val) : '';
        } else {
            el.value = val || '';
        }
    };
    
    const fields = [
        'customerName', 'customerFather', 'customerNational', 'customerPhone', 'customerLandline',
        'customerBirth', 'customerAddress',
        'guarantorName', 'guarantorFather', 'guarantorNational', 'guarantorPhone', 'guarantorAddress',
        'guarantor2Name', 'guarantor2Father', 'guarantor2National', 'guarantor2Phone', 'guarantor2Address',
        'bikeModel', 'bikeColor', 'bikeYear', 'bikeChassis', 'bikeEngine', 'bikePlate',
        'totalPrice', 'downPayment', 'downPaymentDate', 'downPaymentType',
        'installmentCount', 'startDate', 'installmentInterval', 'installmentRate',
        'penaltyRate', 'penaltyCap', 'defaultPayType', 'notes', 'contractTag'
    ];
    
    fields.forEach(k => {
        if(c[k] !== undefined) set(k, c[k]);
        else if(k === 'penaltyCap') set(k, 50);
    });
    
    calculateInstallment();
    
    document.getElementById('formTitle').textContent = 'ویرایش: ' + c.customerName;
    document.getElementById('formIcon').textContent = '✏️';
    document.getElementById('submitBtn').textContent = '💾 ذخیره تغییرات';
    document.getElementById('cancelEditBtn').style.display = 'inline-flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit(){
    State.editingId = null;
    document.getElementById('formTitle').textContent = 'ثبت قرارداد جدید';
    document.getElementById('formIcon').textContent = '📝';
    document.getElementById('submitBtn').textContent = '💾 ثبت قرارداد';
    document.getElementById('cancelEditBtn').style.display = 'none';
    resetForm();
}

function resetForm(){
    const fields = [
        'customerName', 'customerFather', 'customerNational', 'customerPhone', 'customerLandline',
        'customerBirth', 'customerAddress',
        'guarantorName', 'guarantorFather', 'guarantorNational', 'guarantorPhone', 'guarantorAddress',
        'guarantor2Name', 'guarantor2Father', 'guarantor2National', 'guarantor2Phone', 'guarantor2Address',
        'bikeModel', 'bikeColor', 'bikeYear', 'bikeChassis', 'bikeEngine', 'bikePlate',
        'totalPrice', 'downPayment', 'installmentCount', 'eachInstallment',
        'installmentRate', 'notes'
    ];
    
    fields.forEach(id => {
        const el = document.getElementById(id);
        if(el){
            el.value = '';
            el.classList.remove('invalid', 'valid');
        }
    });
    
    document.querySelectorAll('.error-msg').forEach(e => e.classList.remove('show'));
    
    document.getElementById('installmentRate').value = '0';
    document.getElementById('penaltyRate').value = '0.5';
    document.getElementById('penaltyCap').value = '50';
    document.getElementById('installmentInterval').value = '30';
    
    const today = getTodayJalali();
    document.getElementById('downPaymentDate').value = toPersianDigits(today);
    document.getElementById('startDate').value = toPersianDigits(addMonthsToJalali(today, 1));
    document.getElementById('downPaymentType').value = 'نقدی';
    document.getElementById('defaultPayType').value = 'نقدی';
    document.getElementById('contractTag').value = 'عادی';
    
    calculateInstallment();
}

async function deleteContract(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    if(!confirm(`حذف ${c.customerName}؟\nاین مورد به سطل بازیابی منتقل می‌شود.`)) return;
    
    pushHistory(`حذف قرارداد ${c.customerName}`);
    
    // اضافه به سطل بازیابی
    await CryptoLayer.addToTrash(c);
    
    State.contracts = State.contracts.filter(x => x.id !== id);
    await saveAllData();
    renderAll();
    
    addLog('delete_to_trash', c.customerName);
    showToast('به سطل بازیابی منتقل شد (قابل بازیابی)', 'warning');
}

async function clearAllContracts(){
    if(State.contracts.length === 0){
        showToast('قراردادی نیست', 'warning');
        return;
    }
    
    if(!confirm('⚠️ حذف همه قراردادها؟')) return;
    if(!confirm('همه به سطل بازیابی منتقل می‌شوند (قابل بازیابی). ادامه؟')) return;
    
    pushHistory(`حذف همه (${State.contracts.length} مورد)`);
    
    // اضافه همه به سطل بازیابی
    await CryptoLayer.addToTrash(State.contracts);
    
    const count = State.contracts.length;
    State.contracts = [];
    await saveAllData();
    renderAll();
    
    addLog('clear_all_to_trash', `${count} مورد`);
    showToast(`${toPersianDigits(count)} قرارداد به سطل بازیابی منتقل شد`, 'warning');
}

/* ==================== ابزارهای کمکی ==================== */
function getMoneyValue(id){
    const el = document.getElementById(id);
    if(!el) return 0;
    return parseFloat(toEnglishDigits(el.value).replace(/[^0-9]/g, '')) || 0;
}

function getFloatValue(id){
    const el = document.getElementById(id);
    if(!el) return 0;
    let raw = String(el.value)
        .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
        .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
        .replace(/[،,]/g, '.')
        .replace(/[^0-9.]/g, '');
    const parts = raw.split('.');
    if(parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
    return parseFloat(raw) || 0;
}

function startAutoBackupCheck(){
    if(typeof BackupLayer === 'undefined') return;
    
    BackupLayer.startDailyBackupChecker(
        () => State.contracts,
        () => State.currentPassword
    );
}

async function tryLoadExistingFile(){
    if(typeof BackupLayer === 'undefined') return;
    if(!BackupLayer.isSupported()) return;
    
    const fileName = await BackupLayer.loadExistingFile();
    if(fileName){
        showToast(`📁 فایل ذخیره‌سازی متصل: ${fileName}`, 'success');
        
        BackupLayer.startAutoSave(
            () => State.contracts,
            (result) => {
                if(result.success){
                    const indicator = document.getElementById('autoSaveIndicator');
                    if(indicator){
                        indicator.textContent = '✅ ذخیره شد ' + new Date().toLocaleTimeString('fa-IR');
                    }
                }
            }
        );
    }
}

/* ==================== رندر جدول ==================== */
function onSearchChange(){ State.currentPage = 1; renderTable(); }
function changePageSize(){ State.currentPage = 1; renderTable(); }
function goToPage(p){
    if(p < 1 || p > State.totalPages) return;
    State.currentPage = p;
    renderTable();
    const tw = document.querySelector('.table-wrap');
    if(tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyDateFilter(){
    const from = document.getElementById('filterDateFrom')?.value;
    const to = document.getElementById('filterDateTo')?.value;
    State.dateFilter.from = from ? toEnglishDigits(from) : null;
    State.dateFilter.to = to ? toEnglishDigits(to) : null;
    State.currentPage = 1;
    renderTable();
}

function clearDateFilter(){
    const from = document.getElementById('filterDateFrom');
    const to = document.getElementById('filterDateTo');
    if(from) from.value = '';
    if(to) to.value = '';
    State.dateFilter.from = null;
    State.dateFilter.to = null;
    renderTable();
}

function applyTagFilter(tag){
    State.selectedTag = tag;
    document.querySelectorAll('.tag-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.tag === tag);
    });
    State.currentPage = 1;
    renderTable();
}

function renderTable(){
    const search = toEnglishDigits((document.getElementById('searchInput')?.value || '').trim().toLowerCase());
    const filter = document.getElementById('filterStatus')?.value || 'all';
    const filterType = document.getElementById('filterType')?.value || 'all';
    const tbody = document.getElementById('contractsTable');
    const emptyState = document.getElementById('emptyState');
    
    if(!tbody) return;
    tbody.innerHTML = '';
    
    let filtered = State.contracts.filter(c => {
        const matchPayments = (c.installments || []).some(inst =>
            (inst.payments || []).some(p =>
                (p.trackingCode || '').toLowerCase().includes(search) ||
                (p.checkNumber || '').includes(search) ||
                (p.checkSerial || '').includes(search)
            )
        );
        
        const matchSearch = !search ||
            (c.customerName || '').toLowerCase().includes(search) ||
            (c.customerPhone || '').includes(search) ||
            (c.bikeModel || '').toLowerCase().includes(search) ||
            (c.customerNational || '').includes(search) ||
            (c.bikePlate || '').toLowerCase().includes(search) ||
            (c.guarantorName || '').toLowerCase().includes(search) ||
            (c.guarantor2Name || '').toLowerCase().includes(search) ||
            matchPayments;
        
        const s = getContractStatus(c);
        let matchFilter = true;
        if(filter === 'paid') matchFilter = s.status === 'paid';
        else if(filter === 'active') matchFilter = s.status === 'active';
        else if(filter === 'overdue') matchFilter = s.status === 'overdue';
        
        let matchType = true;
        if(filterType !== 'all'){
            matchType = (c.installments || []).some(i => i.payType === filterType);
        }
        
        let matchTag = true;
        if(State.selectedTag && State.selectedTag !== 'all'){
            matchTag = c.tag === State.selectedTag;
        }
        
        let matchDate = true;
        if(State.dateFilter.from || State.dateFilter.to){
            const cDate = jalaaliToGregorian(c.downPaymentDate);
            if(State.dateFilter.from){
                const fromD = jalaaliToGregorian(State.dateFilter.from);
                if(cDate < fromD) matchDate = false;
            }
            if(State.dateFilter.to){
                const toD = jalaaliToGregorian(State.dateFilter.to);
                if(cDate > toD) matchDate = false;
            }
        }
        
        return matchSearch && matchFilter && matchType && matchTag && matchDate;
    });
    
    State.filteredContracts = filtered;
    
    const countEl = document.getElementById('countList');
    if(countEl) countEl.textContent = toPersianDigits(filtered.length);
    
    const pageSize = parseInt(document.getElementById('pageSize')?.value || '20');
    State.totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if(State.currentPage > State.totalPages) State.currentPage = State.totalPages;
    if(State.currentPage < 1) State.currentPage = 1;
    
    const startIdx = (State.currentPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, filtered.length);
    const pageContracts = filtered.slice(startIdx, endIdx);
    
    const pageInfo = document.getElementById('pageInfo');
    if(pageInfo) pageInfo.textContent = `صفحه ${toPersianDigits(State.currentPage)} از ${toPersianDigits(State.totalPages)}`;
    
    const firstPage = document.getElementById('firstPage');
    const prevPage = document.getElementById('prevPage');
    const nextPage = document.getElementById('nextPage');
    const lastPage = document.getElementById('lastPage');
    
    if(firstPage) firstPage.disabled = State.currentPage <= 1;
    if(prevPage) prevPage.disabled = State.currentPage <= 1;
    if(nextPage) nextPage.disabled = State.currentPage >= State.totalPages;
    if(lastPage) lastPage.disabled = State.currentPage >= State.totalPages;
    
    if(emptyState) emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
    
    pageContracts.forEach((c, idx) => {
        const globalIdx = startIdx + idx;
        const s = getContractStatus(c);
        let statusBadge = '';
        if(s.status === 'paid') statusBadge = '<span class="badge badge-success">✅ تسویه</span>';
        else if(s.status === 'overdue') statusBadge = '<span class="badge badge-danger">⚠️ معوق</span>';
        else statusBadge = '<span class="badge badge-info">⏳ فعال</span>';
        
        const progressPercent = Math.min(100, Math.round((s.totalPaidAmount / c.finalAmount) * 100));
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${toPersianDigits(globalIdx + 1)}</td>
            <td><b>${c.customerName}</b><br><small style="color:var(--muted)">${toPersianDigits(c.customerNational || '-')}</small></td>
            <td>${toPersianDigits(c.customerPhone)}</td>
            <td>${c.guarantorName || '-'}<br><small style="color:var(--muted)">${toPersianDigits(c.guarantorPhone || '')}</small></td>
            <td>${c.guarantor2Name || '-'}${c.guarantor2Phone ? '<br><small style="color:var(--muted)">' + toPersianDigits(c.guarantor2Phone) + '</small>' : ''}</td>
            <td>${c.bikeModel}<br><small style="color:var(--muted)">${c.bikeColor || ''}</small></td>
            <td><span class="badge badge-secondary">${toPersianDigits(c.bikePlate || '-')}</span></td>
            <td>${formatMoney(c.totalPrice)}</td>
            <td style="color:var(--success);font-weight:700">${formatMoney(c.totalProfit || 0)}</td>
            <td style="color:var(--success);font-weight:700">${formatMoney(s.totalPaidAmount)}</td>
            <td style="color:var(--danger);font-weight:700">${formatMoney(s.remaining)}</td>
            <td>${statusBadge}<div class="progress"><div class="progress-bar" style="width:${progressPercent}%"></div></div></td>
            <td>
                <button class="btn btn-primary btn-sm" onclick="openInstallments(${c.id})" title="اقساط">📋</button>
                <button class="btn btn-info btn-sm" onclick="editContract(${c.id})" title="ویرایش">✏️</button>
                <button class="btn btn-purple btn-sm" onclick="showContractDetails(${c.id})" title="جزئیات">👁️</button>
                <button class="btn btn-pink btn-sm" onclick="printContractA4(${c.id})" title="چاپ">🖨️</button>
                <button class="btn btn-danger btn-sm" onclick="deleteContract(${c.id})" title="حذف">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    updateStats();
    updateStorageStatus();
}

function updateStats(){
    const totalEl = document.getElementById('statCustomers');
    if(totalEl) totalEl.textContent = toPersianDigits(State.contracts.length);
    
    const total = State.contracts.reduce((sum, c) => sum + c.finalAmount, 0);
    const totalSalesEl = document.getElementById('statTotal');
    if(totalSalesEl) totalSalesEl.textContent = formatMoney(total);
    
    let received = 0, remaining = 0, overdue = 0;
    State.contracts.forEach(c => {
        const s = getContractStatus(c);
        received += s.totalPaidAmount;
        remaining += s.remaining;
        if(s.status === 'overdue') overdue++;
    });
    
    const rEl = document.getElementById('statReceived');
    const rmEl = document.getElementById('statRemaining');
    const ovEl = document.getElementById('statOverdue');
    
    if(rEl) rEl.textContent = formatMoney(received);
    if(rmEl) rmEl.textContent = formatMoney(remaining);
    if(ovEl) ovEl.textContent = toPersianDigits(overdue);
}

async function updateStorageStatus(){
    try{
        const usage = await CryptoLayer.getStorageUsage();
        
        const usedEl = document.getElementById('storageUsed');
        if(usedEl){
            const mb = usage.usage / (1024 * 1024);
            usedEl.textContent = mb > 1 ? mb.toFixed(2) + ' MB' : (usage.usage / 1024).toFixed(1) + ' KB';
        }
        
        const bar = document.getElementById('storageBar');
        if(bar){
            bar.style.width = Math.min(100, usage.percent) + '%';
            bar.classList.remove('warning', 'danger');
            if(usage.percent > 80) bar.classList.add('danger');
            else if(usage.percent > 60) bar.classList.add('warning');
        }
        
        const lastBackup = await CryptoLayer.getMeta('lastBackup');
        const lbEl = document.getElementById('lastBackup');
        if(lbEl){
            if(lastBackup){
                const d = new Date(lastBackup);
                lbEl.textContent = toPersianDigits(gregorianToJalali(d));
            } else {
                lbEl.textContent = 'هرگز';
            }
        }
        
        const fileIndicator = document.getElementById('autoSaveIndicator');
        if(fileIndicator && typeof BackupLayer !== 'undefined'){
            const status = BackupLayer.getFileStatus();
            if(status.hasFileHandle){
                fileIndicator.textContent = '📁 ' + status.fileName;
            } else if(status.hasFileSystemAccess){
                fileIndicator.textContent = '⚠️ فایل ذخیره‌سازی انتخاب نشده';
            } else {
                fileIndicator.textContent = 'ℹ️ مرورگر از ذخیره خودکار پشتیبانی نمی‌کند';
            }
        }
    } catch(e){
        console.error(e);
    }
}

/* ==================== مودال اقساط ==================== */
function openInstallments(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    document.getElementById('modalTitle').textContent = `اقساط ${c.customerName} - ${c.bikeModel}`;
    const s = getContractStatus(c);
    const interval = c.installmentInterval || 30;
    
    let html = `
        <div class="section-title">👤 مشتری</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">نام:</span><span class="v">${c.customerName || '-'}</span></div>
            <div class="info-item"><span class="k">نام پدر:</span><span class="v">${c.customerFather || '-'}</span></div>
            <div class="info-item"><span class="k">کد ملی:</span><span class="v">${toPersianDigits(c.customerNational || '-')}</span></div>
            <div class="info-item"><span class="k">موبایل:</span><span class="v">${toPersianDigits(c.customerPhone || '-')}</span></div>
        </div>
        <div class="section-title">💰 مالی</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">قیمت کل:</span><span class="v">${formatMoney(c.totalPrice)} تومان</span></div>
            <div class="info-item"><span class="k">پیش‌پرداخت:</span><span class="v">${formatMoney(c.downPayment)} تومان</span></div>
            <div class="info-item"><span class="k">درصد قسط:</span><span class="v">${toPersianDigits(c.installmentRate || 0)}٪</span></div>
            <div class="info-item"><span class="k">سود کل:</span><span class="v">${formatMoney(c.totalProfit || 0)} تومان</span></div>
            <div class="info-item"><span class="k">مبلغ نهایی:</span><span class="v" style="color:var(--purple)">${formatMoney(c.finalAmount || 0)} تومان</span></div>
            <div class="info-item"><span class="k">سقف جریمه:</span><span class="v">${toPersianDigits(c.penaltyCap || 50)}٪ قسط</span></div>
        </div>
        <div class="installment-summary" style="margin-top:15px">
            <div class="summary-box"><div class="label">دریافتی</div><div class="value" style="color:var(--success)">${formatMoney(s.totalPaidAmount)}</div></div>
            <div class="summary-box"><div class="label">مانده</div><div class="value" style="color:var(--danger)">${formatMoney(s.remaining)}</div></div>
            <div class="summary-box"><div class="label">جریمه</div><div class="value" style="color:var(--warning)">${formatMoney(s.totalPenalty)}</div></div>
        </div>
        <div class="section-title">📋 جدول اقساط</div>
        <div class="info-note">
            <b>ℹ️ نکته:</b> با تغییر مبلغ هر قسط، اختلاف در 
            <b style="color:var(--purple)">آخرین قسط</b> 
            اعمال می‌شود تا مبلغ نهایی قرارداد (${formatMoney(c.finalAmount)} تومان) ثابت بماند.
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>سررسید</th><th>مبلغ</th><th>نوع</th><th>پرداختی</th><th>مانده</th><th>جریمه</th><th>وضعیت</th><th>عملیات</th></tr></thead>
            <tbody>`;
    
    c.installments.forEach((inst, i) => {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const dueDate = jalaaliToGregorian(inst.dueDate); dueDate.setHours(0, 0, 0, 0);
        const paidAmt = inst.paidAmount || 0;
        const rem = inst.amount - paidAmt;
        const isLast = i === c.installments.length - 1;
        
        let statusBadge;
        if(paidAmt >= inst.amount) statusBadge = '<span class="badge badge-success">✅ کامل</span>';
        else if(paidAmt > 0) statusBadge = '<span class="badge badge-warning">◐ جزئی</span>';
        else if(dueDate < today) statusBadge = '<span class="badge badge-danger">⚠️ معوق</span>';
        else statusBadge = '<span class="badge badge-info">⏳ در انتظار</span>';
        
        let penaltyHtml = '-';
        if(inst.penalty){
            const detail = getPenaltyDetail(inst, c, today);
            penaltyHtml = `${formatMoney(inst.penalty)}${detail.capped ? ' 🔒' : ''}`;
        }
        
        let paymentsHtml = '';
        if(inst.payments && inst.payments.length){
            paymentsHtml = '<div class="payments-list">' + inst.payments.map(p => {
                let line = `<div><b>${formatMoney(p.amount)}</b> - ${toPersianDigits(p.date)}`;
                if(p.trackingCode) line += ` - <span class="tracking-code">${p.trackingCode}</span>`;
                if(p.method) line += ` (${p.method})`;
                if(p.method === 'چک'){
                    const st = p.checkStatus === 'passed' ? '✅' : (p.checkStatus === 'bounced' ? '❌' : '⏳');
                    line += `<div class="check-info-box"><b>چک:</b> ${toPersianDigits(p.checkNumber || '-')} | ${st}</div>`;
                }
                line += '</div>';
                return line;
            }).join('') + '</div>';
        }
        
        html += `<tr style="${isLast ? 'background:rgba(124,58,237,.05)' : ''}">
            <td>${toPersianDigits(i + 1)}${isLast ? ' <span class="badge badge-purple">آخرین</span>' : ''}</td>
            <td><input class="editable-date" type="text" value="${inst.dueDate}" onchange="updateDueDate(${c.id},${i},this.value)"></td>
            <td><input type="text" class="editable-amount" 
                value="${inst.amount.toLocaleString('en-US')}" 
                oninput="this.value = this.value.replace(/[^0-9,]/g,'')"
                onchange="updateInstallmentAmount(${c.id},${i},this.value)"
                title="${isLast ? 'آخرین قسط - با تغییر، مبلغ نهایی تغییر می‌کند' : 'برای ویرایش کلیک کنید'}"></td>
            <td><select onchange="changePayType(${c.id},${i},this.value)" style="font-size:11px;padding:3px">
                <option value="نقدی" ${inst.payType === 'نقدی' ? 'selected' : ''}>نقدی</option>
                <option value="چک" ${inst.payType === 'چک' ? 'selected' : ''}>چک</option>
            </select></td>
            <td style="color:var(--success);font-weight:700">${formatMoney(paidAmt)}${paymentsHtml}</td>
            <td style="color:${rem > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700">${formatMoney(rem)}</td>
            <td style="color:var(--warning)" title="برای جزئیات کلیک کنید" onclick="showPenaltyDetail(${c.id},${i})">${penaltyHtml}</td>
            <td>${statusBadge}</td>
            <td>${rem > 0 ? `<button class="btn btn-success btn-sm" onclick="openPayModal(${c.id},${i})">💰</button>` : ''}
                ${paidAmt > 0 ? `<button class="btn btn-warning btn-sm" onclick="revertInstallment(${c.id},${i})">↩️</button>` : ''}</td>
        </tr>`;
    });
    
    html += `</tbody></table></div>
        <div class="actions" style="margin-top:15px">
            <button class="btn btn-success" onclick="payAllRemaining(${c.id})">✅ تسویه کامل</button>
            <button class="btn btn-pink" onclick="printContractA4(${c.id})">🖨️ چاپ A4</button>
            <button class="btn btn-outline" onclick="closeModal()">بستن</button>
        </div>`;
    
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('installmentModal').classList.add('active');
}

function closeModal(){
    document.getElementById('installmentModal').classList.remove('active');
}

/* ==================== ویرایش مبلغ قسط ==================== */
async function updateInstallmentAmount(id, idx, val){
    if(State.isLocked){
        showToast('⛔ در حال حاضر نمی‌توانید تغییر دهید', 'danger');
        return;
    }
    
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    const newAmount = parseFloat(toEnglishDigits(val).replace(/[^0-9]/g, '')) || 0;
    if(newAmount <= 0){
        showToast('مبلغ معتبر وارد کنید', 'danger');
        openInstallments(id);
        return;
    }
    
    const inst = c.installments[idx];
    const oldAmount = inst.amount;
    
    if(newAmount < (inst.paidAmount || 0)){
        showToast(`مبلغ نمی‌تواند کمتر از پرداختی (${formatMoney(inst.paidAmount)}) باشد`, 'danger');
        openInstallments(id);
        return;
    }
    
    if(idx === c.installments.length - 1){
        if(!confirm('شما در حال تغییر مبلغ آخرین قسط هستید.\nاین باعث تغییر مبلغ نهایی قرارداد می‌شود.\nادامه؟')){
            openInstallments(id);
            return;
        }
        
        pushHistory(`تغییر مبلغ آخرین قسط ${c.customerName}`);
        
        inst.amount = newAmount;
        inst.remaining = newAmount - (inst.paidAmount || 0);
        inst.paid = (inst.paidAmount || 0) >= newAmount;
        if(!inst.paid) inst.paidDate = null;
        
        const totalInstallments = c.installments.reduce((s, i) => s + i.amount, 0);
        c.finalAmount = c.downPayment + totalInstallments;
        const remaining = c.totalPrice - c.downPayment;
        c.totalProfit = c.finalAmount - c.downPayment - remaining;
        
        await saveAllData();
        renderAll();
        openInstallments(id);
        addLog('installment_amount_change', `${c.customerName} - آخرین قسط: ${formatMoney(oldAmount)} → ${formatMoney(newAmount)}`);
        showToast(`✅ آخرین قسط ویرایش شد - مبلغ نهایی: ${formatMoney(c.finalAmount)}`, 'success');
        return;
    }
    
    const othersSum = c.installments.slice(0, -1).reduce((s, i, i2) => s + (i2 === idx ? newAmount : i.amount), 0);
    const newLastAmount = c.finalAmount - othersSum;
    
    if(newLastAmount <= 0){
        showToast('با این مبلغ، آخرین قسط منفی می‌شود', 'danger');
        openInstallments(id);
        return;
    }
    
    const lastInst = c.installments[c.installments.length - 1];
    if(newLastAmount < (lastInst.paidAmount || 0)){
        showToast(`آخرین قسط نمی‌تواند کمتر از پرداختی (${formatMoney(lastInst.paidAmount)}) شود`, 'danger');
        openInstallments(id);
        return;
    }
    
    pushHistory(`تغییر مبلغ قسط ${idx + 1} ${c.customerName}`);
    
    inst.amount = newAmount;
    inst.remaining = newAmount - (inst.paidAmount || 0);
    inst.paid = (inst.paidAmount || 0) >= newAmount;
    if(!inst.paid) inst.paidDate = null;
    
    lastInst.amount = newLastAmount;
    lastInst.remaining = newLastAmount - (lastInst.paidAmount || 0);
    lastInst.paid = (lastInst.paidAmount || 0) >= newLastAmount;
    if(!lastInst.paid) lastInst.paidDate = null;
    
    await saveAllData();
    renderAll();
    openInstallments(id);
    addLog('installment_amount_change', `${c.customerName} - قسط ${idx + 1}: ${formatMoney(oldAmount)} → ${formatMoney(newAmount)}`);
    showToast(`✅ ویرایش شد | آخرین قسط: ${formatMoney(newLastAmount)}`, 'success');
}

async function updateDueDate(id, idx, val){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    const newDate = toEnglishDigits(val.trim());
    if(!isValidJalaliDate(newDate)){
        showToast('تاریخ نامعتبر است', 'danger');
        openInstallments(id);
        return;
    }
    
    pushHistory(`تغییر تاریخ قسط ${idx + 1} ${c.customerName}`);
    c.installments[idx].dueDate = newDate;
    await saveAllData();
    renderAll();
    openInstallments(id);
    showToast('✅ تاریخ ویرایش شد', 'success');
}

async function changePayType(id, idx, val){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    c.installments[idx].payType = val;
    await saveAllData();
    renderAll();
    openInstallments(id);
}

function showPenaltyDetail(contractId, instIdx){
    const c = State.contracts.find(x => x.id === contractId);
    if(!c) return;
    
    const inst = c.installments[instIdx];
    if(!inst.penalty){
        showToast('این قسط جریمه ندارد', 'info');
        return;
    }
    
    const d = getPenaltyDetail(inst, c, new Date());
    
    document.getElementById('modalTitle').textContent = `جزئیات جریمه قسط ${toPersianDigits(instIdx + 1)}`;
    document.getElementById('modalBody').innerHTML = `
        <div class="penalty-detail" style="font-size:13px">
            <div class="row"><span class="k">مانده قسط:</span><span class="v">${formatMoney(d.remaining)} تومان</span></div>
            <div class="row"><span class="k">مدت تاخیر:</span><span class="v">${toPersianDigits(d.daysLate)} روز</span></div>
            <div class="row"><span class="k">نرخ روزانه:</span><span class="v">${toPersianDigits(d.rate)}٪</span></div>
            <div class="row"><span class="k">فرمول:</span><span class="v" style="font-size:11px">${formatMoney(d.remaining)} × ${d.rate}٪ × ${toPersianDigits(d.daysLate)} روز</span></div>
            <div class="row"><span class="k">جریمه محاسبه‌شده:</span><span class="v">${formatMoney(d.rawPenalty)} تومان</span></div>
            <div class="row"><span class="k">سقف مجاز (${toPersianDigits(d.capPercent)}٪):</span><span class="v">${formatMoney(d.capAmount)} تومان</span></div>
            <div class="row"><span class="k">جریمه نهایی:</span><span class="v" style="color:var(--warning);font-size:16px">${formatMoney(d.finalPenalty)} تومان</span></div>
            ${d.capped ? '<div class="row" style="color:var(--danger);font-size:11px">🔒 سقف جریمه اعمال شده است</div>' : ''}
        </div>
        <div class="actions" style="margin-top:15px">
            <button class="btn btn-primary" onclick="openInstallments(${contractId})">↩️ بازگشت</button>
        </div>
    `;
}

/* ==================== مودال پرداخت ==================== */
function openPayModal(id, idx){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    const inst = c.installments[idx];
    const paidAmt = inst.paidAmount || 0;
    const rem = inst.amount - paidAmt;
    const autoTracking = generateTrackingCode();
    
    State.payContext = { contractId: id, idx };
    
    document.getElementById('payModalTitle').textContent = `پرداخت قسط ${toPersianDigits(idx + 1)} - ${c.customerName}`;
    document.getElementById('payModalBody').innerHTML = `
        <div class="box">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>مبلغ قسط:</span><b>${formatMoney(inst.amount)} تومان</b></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>پرداخت شده:</span><b style="color:var(--success)">${formatMoney(paidAmt)} تومان</b></div>
            <div style="display:flex;justify-content:space-between"><span>مانده:</span><b style="color:var(--danger)">${formatMoney(rem)} تومان</b></div>
        </div>
        <div class="form-group" style="margin-top:15px">
            <label>مبلغ پرداختی (تومان) <span class="required">*</span></label>
            <input type="text" id="payAmount" class="money-input" value="${rem.toLocaleString('en-US')}" oninput="formatMoneyInput(this)">
            <div style="display:flex;gap:5px;margin-top:5px">
                <button class="btn btn-outline btn-sm" onclick="setPayAmount(${rem})">کامل</button>
                <button class="btn btn-outline btn-sm" onclick="setPayAmount(${Math.floor(rem / 2)})">نصف</button>
                <button class="btn btn-outline btn-sm" onclick="setPayAmount(${Math.floor(rem / 4)})">۱/۴</button>
            </div>
        </div>
        <div class="form-group"><label>روش پرداخت</label>
            <select id="payMethod" onchange="toggleCheckFields()">
                <option value="نقدی">نقدی</option>
                <option value="کارت به کارت">کارت به کارت</option>
                <option value="واریز بانکی">واریز بانکی</option>
                <option value="چک">چک</option>
            </select>
        </div>
        <div id="checkFields" style="display:none;background:rgba(245,158,11,.15);border:1px dashed var(--warning);border-radius:12px;padding:15px;margin-top:10px;">
            <h4 style="color:var(--warning);margin-bottom:10px;font-size:13px">📄 اطلاعات چک</h4>
            <div class="form-grid">
                <div class="form-group"><label>شماره چک</label><input type="text" id="checkNumber"></div>
                <div class="form-group"><label>سریال چک</label><input type="text" id="checkSerial"></div>
                <div class="form-group"><label>بانک / شعبه</label><input type="text" id="checkBank"></div>
                <div class="form-group"><label>در وجه</label><input type="text" id="checkPayee"></div>
                <div class="form-group" style="grid-column:1/-1"><label>تاریخ چک</label><input type="text" id="checkDate" value="${inst.dueDate}"></div>
            </div>
        </div>
        <div class="form-group" style="margin-top:10px">
            <label>🔖 کد رهگیری</label>
            <input type="text" id="trackingCode" value="${autoTracking}">
        </div>
        <div class="form-group"><label>تاریخ پرداخت</label><input type="text" id="payDate" value="${getTodayJalali()}" oninput="formatDateInput(this)" onchange="formatDateInput(this)"></div>
        <div class="form-group"><label>توضیحات</label><input type="text" id="payNote"></div>
        <div class="actions" style="margin-top:20px">
            <button class="btn btn-success" onclick="confirmPayment()">✅ ثبت</button>
            <button class="btn btn-outline" onclick="closePayModal()">✖ لغو</button>
        </div>`;
    
    document.getElementById('payModal').classList.add('active');
}

function toggleCheckFields(){
    document.getElementById('checkFields').style.display = document.getElementById('payMethod').value === 'چک' ? 'block' : 'none';
}

function setPayAmount(v){
    document.getElementById('payAmount').value = Number(v).toLocaleString('en-US');
}

function closePayModal(){
    document.getElementById('payModal').classList.remove('active');
    State.payContext = null;
}

async function confirmPayment(){
    if(!State.payContext) return;
    
    const c = State.contracts.find(x => x.id === State.payContext.contractId);
    if(!c) return;
    
    const inst = c.installments[State.payContext.idx];
    const amount = getMoneyValue('payAmount');
    const method = document.getElementById('payMethod').value;
    const payDate = toEnglishDigits(document.getElementById('payDate').value.trim()) || getTodayJalali();
    const note = document.getElementById('payNote').value.trim();
    const trackingCode = document.getElementById('trackingCode').value.trim() || generateTrackingCode();
    const paidAmt = inst.paidAmount || 0;
    const rem = inst.amount - paidAmt;
    
    if(amount <= 0){ showToast('مبلغ معتبر', 'danger'); return; }
    if(amount > rem){ showToast('بیشتر از مانده', 'danger'); return; }
    if(!isValidJalaliDate(payDate)){ showToast('تاریخ پرداخت نامعتبر', 'danger'); return; }
    
    const payment = { amount, date: payDate, method, note, trackingCode, createdAt: new Date().toISOString() };
    
    if(method === 'چک'){
        const checkNumber = document.getElementById('checkNumber').value.trim();
        const checkSerial = document.getElementById('checkSerial').value.trim();
        const checkBank = document.getElementById('checkBank').value.trim();
        const checkPayee = document.getElementById('checkPayee').value.trim();
        const checkDate = toEnglishDigits(document.getElementById('checkDate').value.trim()) || payDate;
        
        if(!checkNumber || !checkBank || !checkPayee){
            showToast('اطلاعات چک کامل نیست', 'danger');
            return;
        }
        
        payment.checkNumber = toEnglishDigits(checkNumber);
        payment.checkSerial = toEnglishDigits(checkSerial);
        payment.checkBank = checkBank;
        payment.checkPayee = checkPayee;
        payment.checkDate = checkDate;
        payment.checkStatus = 'in_progress';
        payment.checkStatusDate = '';
        payment.checkStatusNote = '';
        inst.payType = 'چک';
    }
    
    pushHistory(`ثبت پرداخت ${formatMoney(amount)} - ${c.customerName}`);
    
    if(!inst.payments) inst.payments = [];
    inst.payments.push(payment);
    inst.paidAmount = paidAmt + amount;
    inst.remaining = inst.amount - inst.paidAmount;
    inst.paid = inst.paidAmount >= inst.amount;
    if(inst.paid) inst.paidDate = payDate;
    
    await saveAllData();
    closePayModal();
    renderAll();
    openInstallments(c.id);
    addLog('payment', `${formatMoney(amount)} - ${c.customerName}`);
    showToast(`✅ پرداخت - کد: ${trackingCode}`, 'success');
}

async function revertInstallment(id, idx){
    if(!confirm('برگشت پرداخت‌های این قسط؟')) return;
    
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    pushHistory(`برگشت پرداخت قسط ${idx + 1} ${c.customerName}`);
    
    const inst = c.installments[idx];
    inst.paidAmount = 0;
    inst.remaining = inst.amount;
    inst.paid = false;
    inst.paidDate = null;
    inst.payments = [];
    inst.penalty = 0;
    
    await saveAllData();
    renderAll();
    openInstallments(id);
    addLog('payment_revert', `${c.customerName} قسط ${idx + 1}`);
    showToast('برگشت انجام شد', 'warning');
}

async function payAllRemaining(id){
    if(!confirm('تسویه کامل؟')) return;
    
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    pushHistory(`تسویه کامل ${c.customerName}`);
    
    const today = getTodayJalali();
    c.installments.forEach(inst => {
        const paidAmt = inst.paidAmount || 0;
        const rem = inst.amount - paidAmt;
        if(rem > 0){
            if(!inst.payments) inst.payments = [];
            inst.payments.push({
                amount: rem,
                date: today,
                method: 'تسویه نقدی',
                note: 'تسویه کامل',
                trackingCode: generateTrackingCode()
            });
            inst.paidAmount = inst.amount;
            inst.remaining = 0;
            inst.paid = true;
            inst.paidDate = today;
        }
    });
    
    await saveAllData();
    renderAll();
    openInstallments(id);
    addLog('settle_all', c.customerName);
    showToast('✅ تسویه کامل شد', 'success');
}

/* ==================== جزئیات ==================== */
function showContractDetails(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    const s = getContractStatus(c);
    document.getElementById('modalTitle').textContent = `جزئیات ${c.customerName}`;
    document.getElementById('modalBody').innerHTML = `
        <div class="section-title">👤 مشتری</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">نام:</span><span class="v">${c.customerName || '-'}</span></div>
            <div class="info-item"><span class="k">نام پدر:</span><span class="v">${c.customerFather || '-'}</span></div>
            <div class="info-item"><span class="k">کد ملی:</span><span class="v">${toPersianDigits(c.customerNational || '-')}</span></div>
            <div class="info-item"><span class="k">موبایل:</span><span class="v">${toPersianDigits(c.customerPhone || '-')}</span></div>
            <div class="info-item"><span class="k">تلفن ثابت:</span><span class="v">${toPersianDigits(c.customerLandline || '-')}</span></div>
            <div class="info-item"><span class="k">تاریخ تولد:</span><span class="v">${toPersianDigits(c.customerBirth || '-')}</span></div>
            <div class="info-item" style="grid-column:1/-1"><span class="k">آدرس:</span><span class="v">${c.customerAddress || '-'}</span></div>
        </div>
        <div class="section-title">🤝 ضامن اول</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">نام:</span><span class="v">${c.guarantorName || '-'}</span></div>
            <div class="info-item"><span class="k">کد ملی:</span><span class="v">${toPersianDigits(c.guarantorNational || '-')}</span></div>
            <div class="info-item"><span class="k">تماس:</span><span class="v">${toPersianDigits(c.guarantorPhone || '-')}</span></div>
            <div class="info-item"><span class="k">آدرس:</span><span class="v">${c.guarantorAddress || '-'}</span></div>
        </div>
        ${c.guarantor2Name ? `
        <div class="section-title">🤝 ضامن دوم</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">نام:</span><span class="v">${c.guarantor2Name || '-'}</span></div>
            <div class="info-item"><span class="k">کد ملی:</span><span class="v">${toPersianDigits(c.guarantor2National || '-')}</span></div>
            <div class="info-item"><span class="k">تماس:</span><span class="v">${toPersianDigits(c.guarantor2Phone || '-')}</span></div>
            <div class="info-item"><span class="k">آدرس:</span><span class="v">${c.guarantor2Address || '-'}</span></div>
        </div>` : ''}
        <div class="section-title">💰 مالی</div>
        <div class="info-grid">
            <div class="info-item"><span class="k">قیمت کل:</span><span class="v">${formatMoney(c.totalPrice)} تومان</span></div>
            <div class="info-item"><span class="k">پیش‌پرداخت:</span><span class="v">${formatMoney(c.downPayment)} تومان</span></div>
            <div class="info-item"><span class="k">سود:</span><span class="v">${formatMoney(c.totalProfit || 0)} تومان</span></div>
            <div class="info-item"><span class="k">مبلغ نهایی:</span><span class="v">${formatMoney(c.finalAmount || 0)} تومان</span></div>
            <div class="info-item"><span class="k">دریافتی:</span><span class="v">${formatMoney(s.totalPaidAmount)} تومان</span></div>
            <div class="info-item"><span class="k">مانده:</span><span class="v">${formatMoney(s.remaining)} تومان</span></div>
        </div>
        <div class="actions" style="margin-top:15px">
            <button class="btn btn-pink" onclick="printContractA4(${c.id})">🖨️ چاپ A4</button>
            <button class="btn btn-info" onclick="openInstallments(${c.id})">📋 اقساط</button>
            <button class="btn btn-outline" onclick="exportContractPDF(${c.id})">📄 PDF</button>
            <button class="btn btn-danger" onclick="closeModal()">بستن</button>
        </div>`;
    
    document.getElementById('installmentModal').classList.add('active');
}

/* ==================== نمودارها ==================== */
function refreshDashboard(){
    const totalCustomers = State.contracts.length;
    const totalSales = State.contracts.reduce((s, c) => s + c.finalAmount, 0);
    const totalProfit = State.contracts.reduce((s, c) => s + (c.totalProfit || 0), 0);
    
    let totalReceived = 0, totalRemaining = 0, totalPenalty = 0, overdueCount = 0;
    
    State.contracts.forEach(c => {
        const s = getContractStatus(c);
        totalReceived += s.totalPaidAmount;
        totalRemaining += s.remaining;
        totalPenalty += s.totalPenalty;
        if(s.status === 'overdue') overdueCount++;
    });
    
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const weekLater = new Date(today); weekLater.setDate(weekLater.getDate() + 7);
    
    let dueToday = 0, dueWeek = 0;
    State.contracts.forEach(c => {
        (c.installments || []).forEach(inst => {
            if(inst.paid) return;
            const d = jalaaliToGregorian(inst.dueDate);
            d.setHours(0, 0, 0, 0);
            if(d.getTime() === today.getTime()) dueToday++;
            if(d >= today && d <= weekLater) dueWeek++;
        });
    });
    
    const todayJ = getTodayJalali();
    const currentMonth = todayJ.split('/')[0] + '/' + todayJ.split('/')[1];
    let paidMonth = 0;
    
    State.contracts.forEach(c => {
        (c.installments || []).forEach(inst => {
            (inst.payments || []).forEach(p => {
                if(p.date && p.date.startsWith(currentMonth)) paidMonth++;
            });
        });
    });
    
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if(el) el.textContent = val;
    };
    
    setText('dashCustomers', toPersianDigits(totalCustomers));
    setText('dashTotalSales', formatMoney(totalSales));
    setText('dashTotalProfit', formatMoney(totalProfit));
    setText('dashReceived', formatMoney(totalReceived));
    setText('dashRemaining', formatMoney(totalRemaining));
    setText('dashOverdue', toPersianDigits(overdueCount));
    setText('dashDueToday', toPersianDigits(dueToday));
    setText('dashDueWeek', toPersianDigits(dueWeek));
    setText('dashPaidMonth', toPersianDigits(paidMonth));
    setText('dashTotalPenalty', formatMoney(totalPenalty));
    
    drawSalesChart();
    drawStatusChart();
    drawBikeChart();
    drawCheckChart();
}

function refreshCharts(){
    Object.keys(State.charts).forEach(k => {
        if(State.charts[k]){
            State.charts[k].destroy();
            State.charts[k] = null;
        }
    });
    refreshDashboard();
}

function getChartColors(){
    const isDark = document.body.classList.contains('dark');
    return {
        text: isDark ? '#e2e8f0' : '#1e293b',
        muted: isDark ? '#94a3b8' : '#64748b',
        grid: isDark ? 'rgba(148,163,184,.15)' : 'rgba(100,116,139,.12)',
        primary: '#3b82f6', success: '#16a34a', danger: '#dc2626',
        warning: '#f59e0b', purple: '#7c3aed', pink: '#db2777', info: '#0891b2'
    };
}

function drawSalesChart(){
    const ctx = document.getElementById('salesChart');
    if(!ctx || typeof Chart === 'undefined') return;
    
    const colors = getChartColors();
    const today = new Date();
    const labels = [], dataSales = [], dataReceived = [];
    
    for(let i = 5; i >= 0; i--){
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const jStr = dateToJalali(d).substring(0, 7);
        labels.push(jStr);
        
        let sumSales = 0, sumReceived = 0;
        State.contracts.forEach(c => {
            if(c.createdAt && c.createdAt.startsWith(jStr)) sumSales += c.finalAmount;
            (c.installments || []).forEach(inst => {
                (inst.payments || []).forEach(p => {
                    if(p.date && p.date.startsWith(jStr)) sumReceived += p.amount;
                });
            });
        });
        
        dataSales.push(sumSales);
        dataReceived.push(sumReceived);
    }
    
    if(State.charts.sales) State.charts.sales.destroy();
    
    State.charts.sales = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'فروش', data: dataSales, backgroundColor: 'rgba(59,130,246,.6)', borderColor: colors.primary, borderWidth: 2, borderRadius: 8 },
                { label: 'دریافتی', data: dataReceived, backgroundColor: 'rgba(22,163,74,.6)', borderColor: colors.success, borderWidth: 2, borderRadius: 8 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: colors.text, font: { family: 'Vazirmatn', size: 12 } } } },
            scales: {
                y: { beginAtZero: true, ticks: { color: colors.muted, font: { family: 'Vazirmatn' } }, grid: { color: colors.grid } },
                x: { ticks: { color: colors.muted, font: { family: 'Vazirmatn' } }, grid: { color: colors.grid } }
            }
        }
    });
}

function drawStatusChart(){
    const ctx = document.getElementById('statusChart');
    if(!ctx || typeof Chart === 'undefined') return;
    
    const colors = getChartColors();
    let paid = 0, active = 0, overdue = 0;
    
    State.contracts.forEach(c => {
        const s = getContractStatus(c);
        if(s.status === 'paid') paid++;
        else if(s.status === 'overdue') overdue++;
        else active++;
    });
    
    if(State.charts.status) State.charts.status.destroy();
    
    State.charts.status = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['✅ تسویه', '⏳ فعال', '⚠️ معوق'],
            datasets: [{
                data: [paid, active, overdue],
                backgroundColor: ['rgba(22,163,74,.75)', 'rgba(8,145,178,.75)', 'rgba(220,38,38,.75)'],
                borderColor: [colors.success, colors.info, colors.danger],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: colors.text, font: { family: 'Vazirmatn', size: 13 }, padding: 15 } }
            }
        }
    });
}

function drawBikeChart(){
    const ctx = document.getElementById('bikeChart');
    if(!ctx || typeof Chart === 'undefined') return;
    
    const colors = getChartColors();
    const bikeCount = {};
    
    State.contracts.forEach(c => {
        const m = (c.bikeModel || 'نامشخص').trim();
        bikeCount[m] = (bikeCount[m] || 0) + 1;
    });
    
    const sorted = Object.entries(bikeCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const labels = sorted.map(x => x[0]);
    const data = sorted.map(x => x[1]);
    
    if(State.charts.bike) State.charts.bike.destroy();
    
    State.charts.bike = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels.length ? labels : ['-'],
            datasets: [{
                label: 'تعداد',
                data: data.length ? data : [0],
                backgroundColor: ['rgba(59,130,246,.7)', 'rgba(124,58,237,.7)', 'rgba(219,39,119,.7)', 'rgba(245,158,11,.7)', 'rgba(8,145,178,.7)'],
                borderRadius: 8
            }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { color: colors.muted, font: { family: 'Vazirmatn' } }, grid: { color: colors.grid } },
                y: { ticks: { color: colors.text, font: { family: 'Vazirmatn' } }, grid: { color: colors.grid } }
            }
        }
    });
}

function drawCheckChart(){
    const ctx = document.getElementById('checkChart');
    if(!ctx || typeof Chart === 'undefined') return;
    
    const colors = getChartColors();
    let inProgress = 0, passed = 0, bounced = 0;
    
    State.contracts.forEach(c => {
        (c.installments || []).forEach(inst => {
            (inst.payments || []).forEach(p => {
                if(p.method === 'چک'){
                    const st = p.checkStatus || 'in_progress';
                    if(st === 'passed') passed++;
                    else if(st === 'bounced') bounced++;
                    else inProgress++;
                }
            });
        });
    });
    
    if(State.charts.check) State.charts.check.destroy();
    
    State.charts.check = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['⏳ در جریان', '✅ پاس شده', '❌ برگشتی'],
            datasets: [{
                data: [inProgress, passed, bounced],
                backgroundColor: ['rgba(245,158,11,.75)', 'rgba(22,163,74,.75)', 'rgba(220,38,38,.75)'],
                borderColor: [colors.warning, colors.success, colors.danger],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: colors.text, font: { family: 'Vazirmatn', size: 13 }, padding: 15 } }
            }
        }
    });
}

/* ==================== XLSX ==================== */
function exportExcelXLSX(){
    if(State.contracts.length === 0){
        showToast('قراردادی نیست', 'warning');
        return;
    }
    
    if(typeof XLSX === 'undefined'){
        showToast('کتابخانه XLSX بارگذاری نشد', 'danger');
        return;
    }
    
    try{
        const headers = [
            'ردیف', 'نام مشتری', 'نام پدر', 'کد ملی', 'موبایل', 'تلفن ثابت', 'تاریخ تولد', 'آدرس مشتری',
            'نام ضامن ۱', 'نام پدر ضامن ۱', 'کد ملی ضامن ۱', 'تماس ضامن ۱', 'آدرس ضامن ۱',
            'نام ضامن ۲', 'نام پدر ضامن ۲', 'کد ملی ضامن ۲', 'تماس ضامن ۲', 'آدرس ضامن ۲',
            'مدل موتور', 'رنگ', 'سال ساخت', 'شاسی', 'شماره موتور', 'پلاک',
            'قیمت کل', 'پیش‌پرداخت', 'تاریخ خرید', 'نوع پیش‌پرداخت',
            'تعداد اقساط', 'درصد قسط', 'سود کل', 'مبلغ نهایی', 'هر قسط', 'تاریخ اولین قسط',
            'فاصله', 'نرخ جریمه', 'سقف جریمه', 'دسته‌بندی',
            'دریافتی', 'مانده', 'جریمه', 'وضعیت', 'تاریخ ثبت', 'یادداشت'
        ];
        
        const data = State.contracts.map((c, i) => {
            const s = getContractStatus(c);
            return [
                i + 1, c.customerName, c.customerFather || '', c.customerNational || '',
                c.customerPhone, c.customerLandline || '', c.customerBirth || '', c.customerAddress || '',
                c.guarantorName || '', c.guarantorFather || '', c.guarantorNational || '',
                c.guarantorPhone || '', c.guarantorAddress || '',
                c.guarantor2Name || '', c.guarantor2Father || '', c.guarantor2National || '',
                c.guarantor2Phone || '', c.guarantor2Address || '',
                c.bikeModel, c.bikeColor || '', c.bikeYear || '', c.bikeChassis || '',
                c.bikeEngine || '', c.bikePlate || '',
                c.totalPrice, c.downPayment, c.downPaymentDate || '', c.downPaymentType || '',
                c.installmentCount, c.installmentRate || 0, c.totalProfit || 0, c.finalAmount || 0,
                c.eachInstallment, c.startDate, c.installmentInterval || 30, c.penaltyRate,
                c.penaltyCap || 50, c.tag || 'عادی',
                Math.round(s.totalPaidAmount), Math.round(s.remaining), Math.round(s.totalPenalty),
                s.status === 'paid' ? 'تسویه' : (s.status === 'overdue' ? 'معوق' : 'فعال'),
                c.createdAt || '', c.notes || ''
            ];
        });
        
        const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
        ws['!cols'] = headers.map(() => ({ wch: 18 }));
        ws['!dir'] = 'rtl';
        
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'قراردادها');
        
        XLSX.writeFile(wb, `moto_contracts_${getJalaliTimestamp()}.xlsx`);
        addLog('export_xlsx', `${State.contracts.length}`);
        showToast('✅ فایل XLSX دانلود شد', 'success');
    } catch(err){
        console.error(err);
        showToast('خطا در تولید فایل', 'danger');
    }
}

function exportPaymentsXLSX(){
    if(State.contracts.length === 0){
        showToast('قراردادی نیست', 'warning');
        return;
    }
    
    if(typeof XLSX === 'undefined') return;
    
    try{
        const headers = [
            'ردیف', 'نام مشتری', 'موبایل', 'مدل', 'پلاک', 'شماره قسط',
            'مبلغ قسط', 'پرداختی', 'مانده', 'تاریخ پرداخت', 'روش',
            'کد رهگیری', 'شماره چک', 'سریال', 'بانک/شعبه', 'در وجه',
            'تاریخ چک', 'وضعیت چک', 'توضیحات'
        ];
        
        const data = [];
        let idx = 1;
        
        State.contracts.forEach(c => {
            (c.installments || []).forEach((inst, i) => {
                (inst.payments || []).forEach(p => {
                    data.push([
                        idx++, c.customerName, c.customerPhone, c.bikeModel, c.bikePlate || '',
                        i + 1, inst.amount, p.amount, inst.amount - inst.paidAmount,
                        p.date || '', p.method || '', p.trackingCode || '',
                        p.checkNumber || '', p.checkSerial || '', p.checkBank || '',
                        p.checkPayee || '', p.checkDate || '',
                        p.checkStatus === 'passed' ? 'پاس شده' : (p.checkStatus === 'bounced' ? 'برگشتی' : 'در جریان'),
                        p.note || ''
                    ]);
                });
            });
        });
        
        if(data.length === 0){
            showToast('پرداختی نیست', 'warning');
            return;
        }
        
        const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
        ws['!cols'] = headers.map(() => ({ wch: 18 }));
        ws['!dir'] = 'rtl';
        
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'پرداخت‌ها');
        
        XLSX.writeFile(wb, `moto_payments_${getJalaliTimestamp()}.xlsx`);
        showToast('✅ دانلود شد', 'success');
    } catch(err){
        console.error(err);
        showToast('خطا', 'danger');
    }
}

/* ==================== خروجی PDF ==================== */
function exportContractPDF(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    if(typeof window.jspdf === 'undefined'){
        showToast('کتابخانه PDF بارگذاری نشد', 'danger');
        return;
    }
    
    try{
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');
        const s = getContractStatus(c);
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 15;
        let y = margin;
        
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text('Motorcycle Installment Contract', pageWidth / 2, y, { align: 'center' });
        y += 10;
        
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text('Date: ' + getTodayJalali(), margin, y);
        y += 8;
        
        doc.setLineWidth(0.5);
        doc.line(margin, y, pageWidth - margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Customer Information:', margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        
        const info = [
            ['Name:', c.customerName],
            ['Father:', c.customerFather || '-'],
            ['National ID:', c.customerNational || '-'],
            ['Mobile:', c.customerPhone],
            ['Address:', c.customerAddress || '-']
        ];
        
        info.forEach(([k, v]) => {
            doc.text(k, margin, y);
            doc.text(String(v).substring(0, 60), margin + 30, y);
            y += 5;
        });
        
        y += 3;
        doc.setLineWidth(0.3);
        doc.line(margin, y, pageWidth - margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Motorcycle Information:', margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        
        const bikeInfo = [
            ['Model:', c.bikeModel],
            ['Color:', c.bikeColor || '-'],
            ['Plate:', c.bikePlate || '-'],
            ['Chassis:', c.bikeChassis || '-']
        ];
        
        bikeInfo.forEach(([k, v]) => {
            doc.text(k, margin, y);
            doc.text(String(v).substring(0, 60), margin + 30, y);
            y += 5;
        });
        
        y += 3;
        doc.line(margin, y, pageWidth - margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Financial Information:', margin, y);
        y += 6;
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        
        const finInfo = [
            ['Total Price:', formatMoney(c.totalPrice) + ' Toman'],
            ['Down Payment:', formatMoney(c.downPayment) + ' Toman'],
            ['Installments:', c.installmentCount + ' x ' + formatMoney(c.eachInstallment) + ' Toman'],
            ['Rate:', c.installmentRate + '%'],
            ['Profit:', formatMoney(c.totalProfit) + ' Toman'],
            ['Final Amount:', formatMoney(c.finalAmount) + ' Toman'],
            ['Paid:', formatMoney(s.totalPaidAmount) + ' Toman'],
            ['Remaining:', formatMoney(s.remaining) + ' Toman']
        ];
        
        finInfo.forEach(([k, v]) => {
            doc.text(k, margin, y);
            doc.text(String(v), margin + 40, y);
            y += 5;
        });
        
        // صفحه دوم: جدول اقساط
        doc.addPage();
        y = margin;
        
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text('Installments Table:', margin, y);
        y += 8;
        
        doc.setFontSize(8);
        doc.setFillColor(30, 58, 138);
        doc.rect(margin, y, pageWidth - 2 * margin, 7, 'F');
        doc.setTextColor(255, 255, 255);
        
        const cols = [margin + 2, margin + 15, margin + 45, margin + 75, margin + 100, margin + 130, margin + 155];
        const colNames = ['#', 'Due Date', 'Amount', 'Paid', 'Remaining', 'Penalty', 'Status'];
        
        colNames.forEach((n, i) => doc.text(n, cols[i], y + 5));
        y += 7;
        
        doc.setTextColor(0, 0, 0);
        
        c.installments.forEach((inst, i) => {
            if(y > pageHeight - 20){
                doc.addPage();
                y = margin;
            }
            
            const paidAmt = inst.paidAmount || 0;
            const rem = inst.amount - paidAmt;
            
            let status = 'Waiting';
            if(paidAmt >= inst.amount) status = 'Paid';
            else if(paidAmt > 0) status = 'Partial';
            else if(jalaaliToGregorian(inst.dueDate) < new Date()) status = 'Overdue';
            
            const row = [
                String(i + 1),
                inst.dueDate,
                formatMoney(inst.amount),
                formatMoney(paidAmt),
                formatMoney(rem),
                inst.penalty ? formatMoney(inst.penalty) : '-',
                status
            ];
            
            row.forEach((v, j) => {
                doc.text(String(v).substring(0, 20), cols[j], y + 4);
            });
            
            doc.setDrawColor(200);
            doc.line(margin, y + 6, pageWidth - margin, y + 6);
            y += 7;
        });
        
        y += 10;
        doc.setDrawColor(0);
        doc.setLineWidth(0.3);
        
        const signY = y + 15;
        const sigCols = [margin + 15, margin + 70, margin + 125];
        const sigNames = ['Seller', 'Buyer', 'Guarantor'];
        
        sigCols.forEach((x, i) => {
            doc.line(x, signY, x + 45, signY);
            doc.setFontSize(8);
            doc.text(sigNames[i], x + 15, signY + 5);
        });
        
        doc.save(`contract_${c.customerName}_${getJalaliTimestamp()}.pdf`);
        addLog('export_pdf', c.customerName);
        showToast('✅ فایل PDF دانلود شد', 'success');
    } catch(err){
        console.error(err);
        showToast('خطا در تولید PDF', 'danger');
    }
}

/* ==================== ورودی اکسل هوشمند ==================== */
async function importExcelSmart(event){
    const file = event.target.files[0];
    if(!file) return;
    
    if(typeof XLSX === 'undefined'){
        showToast('کتابخانه XLSX بارگذاری نشد', 'danger');
        return;
    }
    
    const reader = new FileReader();
    
    reader.onload = async (e) => {
        try{
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
            
            if(rows.length < 2){
                showToast('فایل خالی است', 'danger');
                return;
            }
            
            const headers = rows[0].map(h => String(h || '').trim());
            const colMap = {};
            
            headers.forEach((h, i) => {
                const hl = h.replace(/[ ‌]/g, '').toLowerCase();
                if(hl.includes('ناممشتری') || hl === 'نام') colMap.customerName = i;
                else if(hl.includes('نامپدر') && !hl.includes('ضامن')) colMap.customerFather = i;
                else if(hl.includes('کدملی') && !hl.includes('ضامن')) colMap.customerNational = i;
                else if(hl.includes('موبایل') && !hl.includes('ضامن')) colMap.customerPhone = i;
                else if(hl.includes('تلفنثابت')) colMap.customerLandline = i;
                else if(hl.includes('آدرس')) colMap.customerAddress = i;
                else if(hl.includes('مدلموتور') || hl === 'مدل') colMap.bikeModel = i;
                else if(hl.includes('رنگ')) colMap.bikeColor = i;
                else if(hl.includes('پلاک')) colMap.bikePlate = i;
                else if(hl.includes('شاسی')) colMap.bikeChassis = i;
                else if(hl.includes('قیمتکل')) colMap.totalPrice = i;
                else if(hl.includes('پیشپرداخت') || hl.includes('پیش‌پرداخت')) colMap.downPayment = i;
                else if(hl.includes('تاریخخرید') || hl.includes('تاریخپیشپرداخت')) colMap.downPaymentDate = i;
                else if(hl.includes('تعداداقساط')) colMap.installmentCount = i;
                else if(hl.includes('درصدقسط')) colMap.installmentRate = i;
                else if(hl.includes('تاریخاولینقسط')) colMap.startDate = i;
            });
            
            const required = ['customerName', 'totalPrice'];
            const missing = required.filter(k => colMap[k] === undefined);
            
            if(missing.length > 0){
                const missingNames = missing.map(k => ({
                    customerName: 'نام مشتری',
                    totalPrice: 'قیمت کل'
                }[k])).join('، ');
                showToast(`ستون‌های الزامی پیدا نشد: ${missingNames}`, 'danger');
                return;
            }
            
            let added = 0;
            let errors = [];
            
            rows.slice(1).forEach((row, rowIdx) => {
                const g = k => colMap[k] !== undefined ? String(row[colMap[k]] || '').trim() : '';
                const gn = k => parseFloat(toEnglishDigits(g(k)).replace(/[^0-9]/g, '')) || 0;
                
                const cName = g('customerName');
                if(!cName) return;
                
                const total = gn('totalPrice');
                const down = gn('downPayment');
                const count = parseInt(toEnglishDigits(g('installmentCount'))) || 12;
                
                if(total <= 0){
                    errors.push(`ردیف ${rowIdx + 2}: قیمت کل نامعتبر`);
                    return;
                }
                
                if(down >= total){
                    errors.push(`ردیف ${rowIdx + 2}: پیش‌پرداخت بیشتر از قیمت`);
                    return;
                }
                
                const rate = parseFloat(toEnglishDigits(g('installmentRate')).replace(/[^0-9.]/g, '')) || 0;
                const dpDate = toEnglishDigits(g('downPaymentDate')) || getTodayJalali();
                
                if(!isValidJalaliDate(dpDate)){
                    errors.push(`ردیف ${rowIdx + 2}: تاریخ خرید نامعتبر`);
                    return;
                }
                
                let startDate = toEnglishDigits(g('startDate'));
                if(!isValidJalaliDate(startDate)){
                    startDate = addMonthsToJalali(dpDate, 1);
                }
                
                const remaining = total - down;
                const profit = Math.round(remaining * (rate / 100) * count);
                const finalTotal = remaining + profit;
                const each = Math.ceil(finalTotal / count);
                
                const contract = {
                    id: Date.now() + Math.random() + added,
                    customerName: cName,
                    customerFather: g('customerFather'),
                    customerNational: toEnglishDigits(g('customerNational')),
                    customerPhone: toEnglishDigits(g('customerPhone')),
                    customerLandline: toEnglishDigits(g('customerLandline')),
                    customerBirth: '',
                    customerAddress: g('customerAddress'),
                    guarantorName: '', guarantorFather: '', guarantorNational: '',
                    guarantorPhone: '', guarantorAddress: '',
                    guarantor2Name: '', guarantor2Father: '', guarantor2National: '',
                    guarantor2Phone: '', guarantor2Address: '',
                    bikeModel: g('bikeModel') || 'نامشخص',
                    bikeColor: g('bikeColor'),
                    bikeYear: '', bikeChassis: toEnglishDigits(g('bikeChassis')), bikeEngine: '',
                    bikePlate: g('bikePlate') || '-',
                    totalPrice: total,
                    downPayment: down,
                    downPaymentDate: dpDate,
                    downPaymentType: 'نقدی',
                    installmentCount: count,
                    installmentRate: rate,
                    totalProfit: profit,
                    finalAmount: finalTotal,
                    eachInstallment: each,
                    startDate,
                    installmentInterval: 30,
                    penaltyRate: 0.5,
                    penaltyCap: 50,
                    defaultPayType: 'نقدی',
                    notes: 'ورودی از اکسل',
                    tag: 'عادی',
                    createdAt: getTodayJalali(),
                    installments: buildInstallments(count, each, startDate, 'نقدی', 30)
                };
                
                State.contracts.push(contract);
                added++;
            });
            
            pushHistory(`ورود از اکسل (${added} مورد)`);
            await saveAllData();
            renderAll();
            addLog('import_xlsx', `${added}`);
            
            let msg = `✅ ${toPersianDigits(added)} قرارداد اضافه شد`;
            if(errors.length > 0){
                msg += ` | ${toPersianDigits(errors.length)} ردیف رد شد`;
                console.warn('Import errors:', errors);
            }
            
            showToast(msg, 'success');
            
        } catch(err){
            console.error(err);
            showToast('خطا در خواندن فایل: ' + err.message, 'danger');
        }
    };
    
    reader.readAsArrayBuffer(file);
    event.target.value = '';
}

/* ==================== مدیریت چک‌ها ==================== */
function getAllChecks(){
    const checks = [];
    
    State.contracts.forEach(c => {
        (c.installments || []).forEach((inst, instIdx) => {
            (inst.payments || []).forEach((p, payIdx) => {
                if(p.method === 'چک'){
                    checks.push({
                        contractId: c.id,
                        contractName: c.customerName,
                        customerPhone: c.customerPhone,
                        instIdx, payIdx,
                        checkNumber: p.checkNumber || '',
                        checkSerial: p.checkSerial || '',
                        checkBank: p.checkBank || '',
                        checkPayee: p.checkPayee || '',
                        checkDate: p.checkDate || '',
                        amount: p.amount,
                        checkStatus: p.checkStatus || 'in_progress',
                        checkStatusDate: p.checkStatusDate || ''
                    });
                }
            });
        });
    });
    
    return checks;
}

function renderChecksTable(){
    const allChecks = getAllChecks();
    const search = toEnglishDigits((document.getElementById('checkSearch')?.value || '').trim().toLowerCase());
    const filter = document.getElementById('checkFilter')?.value || 'all';
    
    const filtered = allChecks.filter(ch => {
        if(filter !== 'all' && ch.checkStatus !== filter) return false;
        if(!search) return true;
        return (
            ch.contractName.toLowerCase().includes(search) ||
            ch.checkNumber.includes(search) ||
            ch.checkSerial.includes(search) ||
            ch.checkBank.toLowerCase().includes(search) ||
            ch.checkPayee.toLowerCase().includes(search)
        );
    });
    
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if(el) el.textContent = val;
    };
    
    setText('checkTotal', toPersianDigits(allChecks.length));
    setText('checkInProgress', toPersianDigits(allChecks.filter(c => c.checkStatus === 'in_progress').length));
    setText('checkPassed', toPersianDigits(allChecks.filter(c => c.checkStatus === 'passed').length));
    setText('checkBounced', toPersianDigits(allChecks.filter(c => c.checkStatus === 'bounced').length));
    
    const tbody = document.getElementById('checksTable');
    const empty = document.getElementById('checksEmpty');
    if(!tbody) return;
    
    tbody.innerHTML = '';
    
    if(filtered.length === 0){
        if(empty) empty.style.display = 'block';
        return;
    }
    
    if(empty) empty.style.display = 'none';
    
    filtered.forEach((ch, idx) => {
        let statusBadge = '';
        if(ch.checkStatus === 'passed') statusBadge = '<span class="check-status-badge passed">✅ پاس شده</span>';
        else if(ch.checkStatus === 'bounced') statusBadge = '<span class="check-status-badge bounced">❌ برگشتی</span>';
        else statusBadge = '<span class="check-status-badge in-progress">⏳ در جریان</span>';
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${toPersianDigits(idx + 1)}</td>
            <td><b>${ch.contractName}</b><br><small style="color:var(--muted)">${toPersianDigits(ch.customerPhone)}</small></td>
            <td>${toPersianDigits(ch.checkNumber || '-')}</td>
            <td>${toPersianDigits(ch.checkSerial || '-')}</td>
            <td>${ch.checkBank || '-'}</td>
            <td>${ch.checkPayee || '-'}</td>
            <td>${formatMoney(ch.amount)}</td>
            <td>${toPersianDigits(ch.checkDate || '-')}</td>
            <td>${statusBadge}</td>
            <td><button class="btn btn-info btn-sm" onclick="openCheckStatusModal(${ch.contractId},${ch.instIdx},${ch.payIdx})">🔄</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function openCheckStatusModal(contractId, instIdx, payIdx){
    const c = State.contracts.find(x => x.id === contractId);
    if(!c) return;
    
    const p = c.installments[instIdx].payments[payIdx];
    State.checkContext = { contractId, instIdx, payIdx };
    
    const currentStatus = p.checkStatus || 'in_progress';
    
    document.getElementById('checkModalTitle').textContent = `وضعیت چک ${toPersianDigits(p.checkNumber || '')}`;
    document.getElementById('checkStatusBody').innerHTML = `
        <div class="box" style="margin-bottom:15px">
            <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span>مشتری:</span><b>${c.customerName}</b></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:5px"><span>مبلغ:</span><b>${formatMoney(p.amount)} تومان</b></div>
            <div style="display:flex;justify-content:space-between"><span>تاریخ:</span><b>${toPersianDigits(p.checkDate || '-')}</b></div>
        </div>
        <div class="form-group" style="margin-bottom:15px">
            <label>وضعیت</label>
            <select id="newCheckStatus" style="font-size:14px;padding:12px">
                <option value="in_progress" ${currentStatus === 'in_progress' ? 'selected' : ''}>⏳ در جریان</option>
                <option value="passed" ${currentStatus === 'passed' ? 'selected' : ''}>✅ پاس شده</option>
                <option value="bounced" ${currentStatus === 'bounced' ? 'selected' : ''}>❌ برگشتی</option>
            </select>
        </div>
        <div class="form-group" style="margin-bottom:15px">
            <label>تاریخ تغییر</label>
            <input type="text" id="checkStatusDate" value="${toPersianDigits(p.checkStatusDate || getTodayJalali())}" oninput="formatDateInput(this)" onchange="formatDateInput(this)">
        </div>
        <div class="form-group" style="margin-bottom:15px">
            <label>توضیحات</label>
            <textarea id="checkStatusNote" rows="3" style="resize:vertical">${p.checkStatusNote || ''}</textarea>
        </div>
        <div class="actions">
            <button class="btn btn-success" onclick="saveCheckStatus()">💾 ذخیره</button>
            <button class="btn btn-outline" onclick="closeCheckStatusModal()">✖ لغو</button>
        </div>
    `;
    
    document.getElementById('checkStatusModal').classList.add('active');
}

function closeCheckStatusModal(){
    document.getElementById('checkStatusModal').classList.remove('active');
    State.checkContext = null;
}

async function saveCheckStatus(){
    if(!State.checkContext) return;
    
    const c = State.contracts.find(x => x.id === State.checkContext.contractId);
    if(!c) return;
    
    const p = c.installments[State.checkContext.instIdx].payments[State.checkContext.payIdx];
    const newStatus = document.getElementById('newCheckStatus').value;
    
    pushHistory(`تغییر وضعیت چک ${p.checkNumber}`);
    
    p.checkStatus = newStatus;
    p.checkStatusDate = toEnglishDigits(document.getElementById('checkStatusDate').value.trim()) || getTodayJalali();
    p.checkStatusNote = document.getElementById('checkStatusNote').value.trim();
    
    await saveAllData();
    closeCheckStatusModal();
    renderChecksTable();
    
    if(document.getElementById('content-dashboard').classList.contains('active')){
        refreshDashboard();
    }
    
    const names = { in_progress: 'در جریان', passed: 'پاس شده', bounced: 'برگشتی' };
    addLog('check_status_change', `${p.checkNumber} - ${names[newStatus]} - ${c.customerName}`);
    showToast(`✅ "${names[newStatus]}"`, 'success');
}

/* ==================== چاپ A4 ==================== */
function printContractA4(id){
    const c = State.contracts.find(x => x.id === id);
    if(!c) return;
    
    const s = getContractStatus(c);
    const win = window.open('', '_blank');
    
    let rows = '';
    c.installments.forEach((inst, i) => {
        const paidAmt = inst.paidAmount || 0;
        const rem = inst.amount - paidAmt;
        let statusText = 'در انتظار';
        if(paidAmt >= inst.amount) statusText = '✅ پرداخت شده';
        else if(paidAmt > 0) statusText = '◐ جزئی';
        else if(jalaaliToGregorian(inst.dueDate) < new Date()) statusText = '⚠️ معوق';
        
        rows += `<tr>
            <td>${i + 1}</td>
            <td>${inst.dueDate}</td>
            <td>${formatMoney(inst.amount)}</td>
            <td>${inst.payType || 'نقدی'}</td>
            <td>${formatMoney(paidAmt)}</td>
            <td>${formatMoney(rem)}</td>
            <td>${inst.penalty ? formatMoney(inst.penalty) : '-'}</td>
            <td>${statusText}</td>
        </tr>`;
    });
    
    win.document.write(`
        <!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
        <title>قرارداد ${c.customerName}</title>
        <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet" />
        <style>
            @page { size: A4; margin: 15mm 12mm; }
            * { box-sizing: border-box; font-family: 'Vazirmatn', Tahoma, sans-serif; }
            body { padding:0; margin:0; color:#000; font-size:11px; line-height:1.7; }
            h1 { text-align:center; color:#1e3a8a; border-bottom:2px solid #1e3a8a; padding-bottom:8px; font-size:18px; margin-bottom:5px; }
            .header-sub { text-align:center; color:#64748b; font-size:10px; margin-bottom:15px; }
            h3 { background:#1e3a8a; color:#fff; padding:5px 10px; border-radius:4px; font-size:12px; margin: 12px 0 6px; }
            .info { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid #999; border-radius:4px; overflow:hidden; }
            .info div { padding:5px 8px; font-size:10.5px; border-bottom:1px solid #ddd; }
            .info div:nth-child(odd) { border-left:1px solid #ddd; background:#f8fafc; }
            table { width:100%; border-collapse:collapse; margin-top:8px; font-size:10px; }
            th, td { border:1px solid #999; padding:4px; text-align:center; }
            th { background:#1e3a8a; color:#fff; font-size:10px; }
            tbody tr:nth-child(even) { background:#f8fafc; }
            .footer { margin-top:40px; display:flex; justify-content:space-around; gap:10px; flex-wrap:wrap; }
            .sign { flex:1; border-top:1px solid #000; text-align:center; padding-top:5px; font-size:11px; max-width:180px; }
            .designer-print { text-align:center; margin-top:25px; font-size:10px; color:#666; border-top:1px dashed #ccc; padding-top:8px; }
            .date-print { text-align:left; font-size:10px; color:#666; margin-bottom:10px; }
            .summary-row { display:flex; gap:10px; margin-top:10px; }
            .summary-box { flex:1; background:#eff6ff; border:1px solid #3b82f6; border-radius:4px; padding:6px; text-align:center; font-size:10px; }
            .summary-box b { display:block; font-size:12px; color:#1e3a8a; margin-top:2px; }
        </style>
        </head><body>
        <div class="date-print">تاریخ چاپ: ${getTodayJalali()}</div>
        <h1>🏍️ قرارداد فروش اقساطی موتورسیکلت</h1>
        <div class="header-sub">بنگاه موتورفروشی</div>

        <h3>👤 مشخصات مشتری</h3>
        <div class="info">
            <div><b>نام:</b> ${c.customerName}</div>
            <div><b>نام پدر:</b> ${c.customerFather||'-'}</div>
            <div><b>کد ملی:</b> ${c.customerNational||'-'}</div>
            <div><b>موبایل:</b> ${c.customerPhone}</div>
            <div><b>تلفن ثابت:</b> ${c.customerLandline||'-'}</div>
            <div><b>تاریخ تولد:</b> ${c.customerBirth||'-'}</div>
            <div style="grid-column:1/-1"><b>آدرس:</b> ${c.customerAddress||'-'}</div>
        </div>

        <h3>🤝 مشخصات ضامن اول</h3>
        <div class="info">
            <div><b>نام:</b> ${c.guarantorName||'-'}</div>
            <div><b>نام پدر:</b> ${c.guarantorFather||'-'}</div>
            <div><b>کد ملی:</b> ${c.guarantorNational||'-'}</div>
            <div><b>تماس:</b> ${c.guarantorPhone||'-'}</div>
            <div style="grid-column:1/-1"><b>آدرس:</b> ${c.guarantorAddress||'-'}</div>
        </div>

        ${c.guarantor2Name ? `
        <h3>🤝 مشخصات ضامن دوم</h3>
        <div class="info">
            <div><b>نام:</b> ${c.guarantor2Name||'-'}</div>
            <div><b>نام پدر:</b> ${c.guarantor2Father||'-'}</div>
            <div><b>کد ملی:</b> ${c.guarantor2National||'-'}</div>
            <div><b>تماس:</b> ${c.guarantor2Phone||'-'}</div>
            <div style="grid-column:1/-1"><b>آدرس:</b> ${c.guarantor2Address||'-'}</div>
        </div>` : ''}

        <h3>🏍️ مشخصات موتورسیکلت</h3>
        <div class="info">
            <div><b>مدل:</b> ${c.bikeModel}</div>
            <div><b>رنگ:</b> ${c.bikeColor||'-'}</div>
            <div><b>سال ساخت:</b> ${c.bikeYear||'-'}</div>
            <div><b>پلاک:</b> ${c.bikePlate||'-'}</div>
            <div><b>شاسی:</b> ${c.bikeChassis||'-'}</div>
            <div><b>شماره موتور:</b> ${c.bikeEngine||'-'}</div>
        </div>

        <h3>💰 اطلاعات مالی</h3>
        <div class="info">
            <div><b>قیمت کل:</b> ${formatMoney(c.totalPrice)} تومان</div>
            <div><b>پیش‌پرداخت:</b> ${formatMoney(c.downPayment)} تومان</div>
            <div><b>تاریخ خرید:</b> ${c.downPaymentDate}</div>
            <div><b>تاریخ اولین قسط:</b> ${c.startDate}</div>
            <div><b>تعداد اقساط:</b> ${c.installmentCount}</div>
            <div><b>مبلغ هر قسط:</b> ${formatMoney(c.eachInstallment)} تومان</div>
            <div><b>درصد قسط:</b> ${c.installmentRate||0}٪</div>
            <div><b>سود کل:</b> ${formatMoney(c.totalProfit||0)} تومان</div>
            <div><b>مبلغ نهایی:</b> ${formatMoney(c.finalAmount||0)} تومان</div>
            <div><b>نرخ جریمه:</b> ${c.penaltyRate}٪ (سقف: ${c.penaltyCap||50}٪)</div>
        </div>

        <div class="summary-row">
            <div class="summary-box">دریافتی کل<b>${formatMoney(s.totalPaidAmount)} تومان</b></div>
            <div class="summary-box">مانده کل<b>${formatMoney(s.remaining)} تومان</b></div>
            <div class="summary-box">جریمه دیرکرد<b>${formatMoney(s.totalPenalty)} تومان</b></div>
        </div>

        <h3>📋 جدول اقساط</h3>
        <table>
            <thead><tr><th>#</th><th>سررسید</th><th>مبلغ</th><th>نوع</th><th>پرداخت شده</th><th>مانده</th><th>جریمه</th><th>وضعیت</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>

        <div class="footer">
            <div class="sign">امضای فروشنده</div>
            <div class="sign">امضای خریدار</div>
            <div class="sign">امضای ضامن ۱</div>
            ${c.guarantor2Name ? '<div class="sign">امضای ضامن ۲</div>' : ''}
        </div>

        <div class="designer-print">طراحی و توسعه: احمد علی پرست</div>
        </body></html>
    `);
    win.document.close();
    setTimeout(() => win.print(), 500);
}

function printAllContracts(){
    if(State.contracts.length === 0){
        showToast('قراردادی نیست', 'warning');
        return;
    }
    
    if(!confirm(`چاپ همه ${toPersianDigits(State.contracts.length)} قرارداد؟`)) return;
    
    showToast('در حال آماده‌سازی...', 'info');
    
    let printed = 0;
    const ids = State.contracts.map(c => c.id);
    
    const printNext = () => {
        if(printed >= ids.length){
            showToast('✅ همه آماده چاپ شدند', 'success');
            return;
        }
        printContractA4(ids[printed]);
        printed++;
        setTimeout(printNext, 800);
    };
    
    printNext();
}

/* ==================== تنظیمات ==================== */
function openSettings(){
    const settingsBody = document.getElementById('settingsBody');
    if(!settingsBody) return;
    
    const fileStatus = typeof BackupLayer !== 'undefined' ? BackupLayer.getFileStatus() : null;
    
    settingsBody.innerHTML = `
        <div class="section-title">🔐 تغییر رمز عبور</div>
        <div class="form-group" style="margin-bottom:10px"><label>رمز فعلی</label><input type="password" id="oldPass"></div>
        <div class="form-group" style="margin-bottom:10px"><label>رمز جدید (حداقل ۱۰ کاراکتر)</label><input type="password" id="newPass"></div>
        <div class="form-group" style="margin-bottom:15px"><label>تکرار رمز جدید</label><input type="password" id="newPass2"></div>
        <button class="btn btn-primary" onclick="changePasswordSafely()">💾 تغییر رمز</button>
        
        <div class="section-title" style="margin-top:20px">📸 نسخه‌های داخلی و سطل بازیابی</div>
        <div class="actions" style="margin-bottom:15px">
            <button class="btn btn-info btn-sm" onclick="AppMerged.showSnapshotsList()">📸 نسخه‌های داخلی</button>
            <button class="btn btn-warning btn-sm" onclick="AppMerged.showTrashList()">🗑️ سطل بازیابی</button>
        </div>
        
        <div class="section-title" style="margin-top:20px">💾 فایل پشتیبان خودکار</div>
        <div id="fileSection" style="font-size:12px;line-height:1.8">
            ${fileStatus ? `
                <div style="margin-bottom:8px">
                    <b>مرورگر:</b> ${fileStatus.browser}<br>
                    <b>پشتیبانی فایل:</b> ${fileStatus.hasFileSystemAccess ? '✅ بله' : '❌ خیر'}<br>
                    <b>فایل متصل:</b> ${fileStatus.fileName || 'هیچ'}<br>
                    <b>ذخیره خودکار:</b> ${fileStatus.autoSaveActive ? '✅ فعال' : '❌ غیرفعال'}
                </div>
                ${fileStatus.hasFileSystemAccess ? `
                    <button class="btn btn-success btn-sm" onclick="pickSaveLocation()">📁 انتخاب فایل ذخیره‌سازی</button>
                    <button class="btn btn-warning btn-sm" onclick="disconnectFile()">🔌 قطع اتصال</button>
                ` : `
                    <div style="color:var(--warning);margin-top:8px">
                        ⚠️ مرورگر شما از ذخیره‌ی خودکار به فایل پشتیبانی نمی‌کند.
                    </div>
                `}
            ` : ''}
        </div>
        
        <div class="section-title" style="margin-top:20px">📊 اطلاعات نسخه</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.8">
            نسخه: <b>${APP_CONFIG.VERSION}</b><br>
            تقویم: <b>${typeof jalaali !== 'undefined' ? '✅ jalaali-js' : '⚠️ fallback'}</b><br>
            رمزنگاری: <b>✅ AES-256-GCM</b><br>
            PBKDF2: <b>210,000 تکرار</b><br>
            ذخیره‌سازی: <b>✅ IndexedDB + localStorage</b><br>
            قفل همزمانی: <b>${State.broadcastChannel ? '✅ BroadcastChannel' : '⚠️ غیرفعال'}</b><br>
            کاربر: <b>admin</b>
        </div>
        
        <div class="section-title" style="margin-top:20px">⚠️ منطقه خطر</div>
        <button class="btn btn-danger btn-sm" onclick="AppMerged.factoryResetConfirm()">🗑️ پاک کردن همه داده‌ها (Factory Reset)</button>
    `;
    
    document.getElementById('settingsModal').classList.add('active');
}

function closeSettings(){
    document.getElementById('settingsModal').classList.remove('active');
}

async function pickSaveLocation(){
    if(typeof BackupLayer === 'undefined') return;
    
    const result = await BackupLayer.pickSaveLocation();
    
    if(result.success){
        showToast(`📁 فایل: ${result.fileName}`, 'success');
        
        BackupLayer.startAutoSave(
            () => State.contracts,
            (res) => {
                if(res.success){
                    const indicator = document.getElementById('autoSaveIndicator');
                    if(indicator){
                        indicator.textContent = '✅ ذخیره شد ' + new Date().toLocaleTimeString('fa-IR');
                    }
                }
            }
        );
        
        openSettings();
    } else {
        showToast(result.reason || 'لغو شد', 'warning');
    }
}

async function disconnectFile(){
    if(!confirm('اتصال فایل قطع شود؟')) return;
    
    if(typeof BackupLayer !== 'undefined'){
        await BackupLayer.clearFileHandle();
        BackupLayer.stopAutoSave();
        showToast('اتصال قطع شد', 'warning');
        openSettings();
    }
}

function toggleTheme(){
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    localStorage.setItem('moto_theme', isDark ? 'dark' : 'light');
    
    const btn = document.getElementById('themeToggle');
    if(btn) btn.textContent = isDark ? '☀️' : '🌙';
    
    showToast(isDark ? '🌙 حالت تاریک' : '☀️ حالت روشن', 'success');
    
    if(typeof refreshCharts === 'function'){
        setTimeout(refreshCharts, 100);
    }
}

function switchTab(name){
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    const tab = document.getElementById('tab-' + name);
    const content = document.getElementById('content-' + name);
    
    if(tab) tab.classList.add('active');
    if(content) content.classList.add('active');
    
    if(name === 'dashboard') setTimeout(refreshDashboard, 100);
    if(name === 'checks') setTimeout(renderChecksTable, 100);
    if(name === 'logs') setTimeout(renderLogs, 100);
}

/* ==================== لاگ‌ها ==================== */
async function addLog(action, details){
    try{
        const logs = (await CryptoLayer.getMeta('logs')) || [];
        logs.unshift({
            action,
            details,
            date: Date.now(),
            jalali: getTodayJalali()
        });
        
        const trimmed = logs.slice(0, 500);
        await CryptoLayer.setMeta('logs', trimmed);
    }catch(e){
        console.error('Log error:', e);
    }
}

async function renderLogs(){
    const logs = (await CryptoLayer.getMeta('logs')) || [];
    const el = document.getElementById('logsList');
    if(!el) return;
    
    if(logs.length === 0){
        el.innerHTML = '<div class="empty"><span>📭</span>هیچ لاگی ثبت نشده</div>';
        return;
    }
    
    el.innerHTML = logs.map(l => `
        <div class="user-card">
            <div class="info">
                <div class="name">${l.action}</div>
                <div class="meta">${l.details || ''}</div>
            </div>
            <div style="font-size:11px;color:var(--muted);text-align:left">
                <div>${toPersianDigits(l.jalali)}</div>
            </div>
        </div>
    `).join('');
}

async function clearAllLogsSafely(){
    if(!confirm('همه لاگ‌ها پاک شوند؟\nقبل از پاک کردن، آرشیو می‌شوند.')){
        return;
    }
    
    try{
        const archiveResult = await CryptoLayer.archiveLogs();
        
        await CryptoLayer.setMeta('logs', []);
        await addLog('logs_cleared', `آرشیو شد: ${archiveResult.archived || 0} لاگ`);
        
        renderLogs();
        
        showToast(`✅ لاگ‌ها پاک شدند (${archiveResult.archived || 0} لاگ آرشیو شد)`, 'success');
    }catch(e){
        showToast('خطا در آرشیو', 'danger');
    }
}

/* ==================== پشتیبان‌گیری سریع ==================== */
async function backupNow(){
    await exportData();
}

async function exportData(){
    try{
        const result = await CryptoLayer.loadSecureData(State.currentPassword);
        
        if(!result.success){
            showToast('خطا در دسترسی به داده‌ها', 'danger');
            return;
        }
        
        const data = {
            version: APP_CONFIG.VERSION,
            app: 'moto-installments',
            timestamp: Date.now(),
            jalaliDate: getJalaliTimestamp(),
            count: State.contracts.length,
            contracts: State.contracts
        };
        
        // ⭐ اگر File System Access پشتیبانی شود
        if(typeof BackupLayer !== 'undefined' && BackupLayer.isSupported()){
            const status = BackupLayer.getFileStatus();
            if(status.hasFileHandle){
                const writeResult = await BackupLayer.writeToFile(data);
                if(writeResult.success){
                    await CryptoLayer.setMeta('lastBackup', Date.now());
                    addLog('export_to_file', `${State.contracts.length} قرارداد`);
                    showToast('✅ در فایل ذخیره شد', 'success');
                    updateStorageStatus();
                    return;
                }
            }
        }
        
        // ⭐ Fallback: دانلود معمولی
        BackupLayer.downloadJSONBackup(State.contracts);
        await CryptoLayer.setMeta('lastBackup', Date.now());
        addLog('export_json', `${State.contracts.length}`);
        showToast('✅ خروجی JSON دانلود شد', 'success');
        updateStorageStatus();
    }catch(e){
        console.error(e);
        showToast('خطا', 'danger');
    }
}

async function importData(event){
    const file = event.target.files[0];
    if(!file) return;
    
    try{
        const text = await file.text();
        const data = JSON.parse(text);
        const newContracts = Array.isArray(data) ? data : (data.contracts || []);
        
        if(!Array.isArray(newContracts)) throw new Error('invalid');
        
        // حذف id تکراری
        const ids = new Set(State.contracts.map(c => String(c.id)));
        const fixedContracts = newContracts.map(c => ({
            ...c,
            id: ids.has(String(c.id)) ? Date.now() + Math.floor(Math.random() * 1000000) : c.id
        }));
        
        let action = '';
        if(confirm('اضافه شوند؟ (لغو = جایگزینی)')){
            action = 'append';
        } else if(confirm('جایگزین شوند؟')){
            action = 'replace';
        } else {
            event.target.value = '';
            return;
        }
        
        pushHistory(`ورود از JSON`);
        
        if(action === 'append'){
            State.contracts = State.contracts.concat(fixedContracts);
        } else {
            State.contracts = fixedContracts;
        }
        
        await saveAllData();
        renderAll();
        addLog('import_json', `${newContracts.length}`);
        showToast('✅ ورودی انجام شد', 'success');
    }catch(err){
        showToast('فایل نامعتبر', 'danger');
    }
    
    event.target.value = '';
}

/* ==================== توست ==================== */
function showToast(msg, type = ''){
    const t = document.getElementById('toast');
    if(!t) return;
    
    t.textContent = msg;
    t.className = 'toast show ' + type;
    
    setTimeout(() => {
        t.className = 'toast ' + type;
    }, 3500);
}

/* ==================== رندر کلی ==================== */
function renderAll(){
    renderTable();
    updateStats();
    updateStorageStatus();
    updateUndoRedoButtons();
}

/* ==================== راه‌اندازی ==================== */
async function init(){
    const savedTheme = localStorage.getItem('moto_theme') || 'light';
    if(savedTheme === 'dark') document.body.classList.add('dark');
    
    // چک HTTPS
    if(typeof CryptoLayer !== 'undefined'){
        CryptoLayer.checkHTTPS();
    }
    
    // چک پشتیبانی فایل
    if(typeof BackupLayer !== 'undefined'){
        BackupLayer.checkFileSystemSupport();
    }
    
    // چک راه‌اندازی اولیه
    await checkInitialSetup();
    
    // چک تاریخ
    const loginPassword = document.getElementById('loginPassword');
    if(loginPassword){
        loginPassword.addEventListener('keydown', (e) => {
            if(e.key === 'Enter') doLogin();
        });
    }
    
    // رویدادهای Escape
    document.addEventListener('keydown', (e) => {
        if(e.key === 'Escape'){
            closeModal();
            closePayModal();
            closeSettings();
            closeCheckStatusModal();
            cancelExit();
            closeFirstSetup();
        }
        
        if((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey){
            e.preventDefault();
            undo();
        }
        
        if((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))){
            e.preventDefault();
            redo();
        }
    });
    
    // قبل از بستن
    window.addEventListener('beforeunload', (e) => {
        if(State.isLoggedIn && State.contracts.length > 0){
            if(typeof BackupLayer !== 'undefined' && BackupLayer.isSupported()){
                BackupLayer.flushBeforeUnload(() => State.contracts);
            }
            
            e.preventDefault();
            e.returnValue = 'آیا از بستن مطمئنید؟ پیشنهاد می‌شود ابتدا پشتیبان بگیرید.';
            return e.returnValue;
        }
    });
    
    // چک قدرت رمز زنده
    const setupPass = document.getElementById('setupPassword');
    if(setupPass){
        setupPass.addEventListener('input', (e) => {
            const strength = checkPasswordStrength(e.target.value);
            const indicator = document.getElementById('passwordStrength');
            
            if(!indicator) return;
            
            const colors = ['danger', 'warning', 'info', 'success', 'success', 'success'];
            const labels = ['خیلی ضعیف', 'ضعیف', 'متوسط', 'خوب', 'قوی', 'خیلی قوی'];
            
            const color = colors[Math.min(strength.score, 5)];
            const label = labels[Math.min(strength.score, 5)];
            
            indicator.innerHTML = `
                <span style="color:var(--${color});font-weight:700">${label}</span>
                ${strength.feedback.length > 0 ? 
                    '<br><span style="color:var(--muted)">' + strength.feedback.join(' + ') + '</span>' 
                    : ''}
            `;
        });
    }
    
    // کلیک بیرون مودال‌ها
    ['installmentModal', 'payModal', 'settingsModal', 'checkStatusModal', 'exitModal', 'firstSetupModal', 'snapshotsModal', 'trashModal'].forEach(id => {
        const el = document.getElementById(id);
        if(el){
            el.addEventListener('click', (e) => {
                if(e.target.id === id){
                    el.classList.remove('active');
                }
            });
        }
    });
    
    console.log('✅ app.js نهایی بارگذاری شد');
    console.log('📋 نسخه:', APP_CONFIG.VERSION);
}

if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/* ==================== صادرات ==================== */
window.AppCore = {
    State, APP_CONFIG,
    doLogin, requestLogout, cancelExit, exitWithBackup, exitWithoutBackup, performLogout,
    changePasswordSafely,
    loadAllData: reloadFromStorage, saveAllData,
    calculateInstallment, getContractStatus, getPenaltyDetail,
    submitContract, editContract, cancelEdit, resetForm, deleteContract, clearAllContracts,
    undo, redo, pushHistory,
    isValidJalaliDate, validateContractDates,
    broadcastLockAcquired, broadcastDataUpdate,
    checkInitialSetup, openFirstSetup, closeFirstSetup, createAdminAccount, checkPasswordStrength
};

window.AppUI = {
    renderAll, renderTable, renderChecksTable, renderLogs, showToast,
    refreshDashboard, refreshCharts, switchTab,
    openInstallments, openPayModal, openCheckStatusModal,
    openSettings, closeSettings,
    printContractA4, printAllContracts,
    exportExcelXLSX, exportPaymentsXLSX, exportContractPDF, importExcelSmart,
    backupNow, exportData, importData,
    pickSaveLocation, disconnectFile, toggleTheme,
    updateInstallmentAmount, updateDueDate, changePayType, showPenaltyDetail,
    saveCheckStatus, onSearchChange, changePageSize, goToPage,
    applyDateFilter, clearDateFilter, applyTagFilter
};

console.log('✅ app.js نسخه نهایی بارگذاری شد');