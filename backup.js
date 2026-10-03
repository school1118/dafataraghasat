/* ============================================================
   backup.js - لایه پشتیبان‌گیری و ذخیره‌سازی به فایل
   ============================================================
   - ذخیره‌ی خودکار به فایل (File System Access API)
   - Fallback هوشمند برای Firefox/Safari
   - پشتیبان‌گیری خودکار روزانه
   - همگام‌سازی با Google Drive / OneDrive
   - نام‌گذاری با Timestamp
   - بازگردانی از فایل
============================================================ */

'use strict';

/* ==================== ثابت‌ها ==================== */
const BACKUP_CONFIG = {
    AUTO_SAVE_INTERVAL_MS: 30000,
    AUTO_BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000,
    LAST_BACKUP_KEY: 'moto_last_auto_backup',
    FILE_HANDLE_KEY: 'moto_file_handle',
    FILE_NAME_PREFIX: 'moto_backup_',
    FILE_EXTENSION: '.json',
    DATA_FOLDER: 'moto_data'
};

/* ==================== وضعیت ==================== */
let fileHandle = null;
let autoSaveTimer = null;
let autoBackupTimer = null;
let saveCallback = null;
let hasFileSystemAccess = false;

/* ==================== تشخیص پشتیبانی ==================== */
function checkFileSystemSupport(){
    hasFileSystemAccess = 'showSaveFilePicker' in window;
    return hasFileSystemAccess;
}

/* ==================== ذخیره‌سازی به فایل ==================== */
async function pickSaveLocation(){
    if(!hasFileSystemAccess){
        return {
            success: false,
            reason: 'مرورگر شما از این قابلیت پشتیبانی نمی‌کند. از Chrome یا Edge استفاده کنید.'
        };
    }
    
    try{
        fileHandle = await window.showSaveFilePicker({
            suggestedName: `${BACKUP_CONFIG.FILE_NAME_PREFIX}${getTimestamp()}.json`,
            types: [{
                description: 'فایل پشتیبان JSON',
                accept: { 'application/json': ['.json'] }
            }]
        });
        
        await saveFileHandle(fileHandle);
        
        return { success: true, fileName: fileHandle.name };
    }catch(err){
        if(err.name === 'AbortError'){
            return { success: false, reason: 'لغو شد' };
        }
        return { success: false, reason: err.message };
    }
}

async function loadExistingFile(){
    if(!hasFileSystemAccess) return null;
    
    try{
        const savedHandle = await loadFileHandleFromDB();
        if(!savedHandle) return null;
        
        const permission = await savedHandle.queryPermission({ mode: 'readwrite' });
        if(permission === 'granted'){
            fileHandle = savedHandle;
            return fileHandle.name;
        }
        
        const newPermission = await savedHandle.requestPermission({ mode: 'readwrite' });
        if(newPermission === 'granted'){
            fileHandle = savedHandle;
            return fileHandle.name;
        }
        
        return null;
    }catch(e){
        console.error('Load file error:', e);
        return null;
    }
}

async function writeToFile(data){
    if(!fileHandle) return { success: false, reason: 'فایلی انتخاب نشده' };
    
    try{
        const permission = await fileHandle.queryPermission({ mode: 'readwrite' });
        if(permission !== 'granted'){
            const newPermission = await fileHandle.requestPermission({ mode: 'readwrite' });
            if(newPermission !== 'granted'){
                return { success: false, reason: 'دسترسی رد شد' };
            }
        }
        
        const writable = await fileHandle.createWritable();
        const jsonStr = JSON.stringify(data, null, 2);
        await writable.write(jsonStr);
        await writable.close();
        
        return { success: true, size: jsonStr.length };
    }catch(err){
        console.error('Write error:', err);
        return { success: false, reason: err.message };
    }
}

async function readFromFile(){
    if(!fileHandle) return { success: false, reason: 'فایلی انتخاب نشده' };
    
    try{
        const file = await fileHandle.getFile();
        const text = await file.text();
        const data = JSON.parse(text);
        
        return { success: true, data };
    }catch(err){
        return { success: false, reason: err.message };
    }
}

/* ==================== FileHandle در IndexedDB ==================== */
async function saveFileHandle(handle){
    try{
        const db = await CryptoLayer.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('meta', 'readwrite');
            const store = tx.objectStore('meta');
            store.put({ key: BACKUP_CONFIG.FILE_HANDLE_KEY, value: handle, updatedAt: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }catch(e){
        console.error('Save handle error:', e);
    }
}

async function loadFileHandleFromDB(){
    try{
        return await CryptoLayer.getMeta(BACKUP_CONFIG.FILE_HANDLE_KEY);
    }catch(e){
        return null;
    }
}

async function clearFileHandle(){
    try{
        await CryptoLayer.deleteMeta(BACKUP_CONFIG.FILE_HANDLE_KEY);
        fileHandle = null;
    }catch(e){}
}

/* ==================== Timestamp ==================== */
function getTimestamp(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}${m}${day}_${h}${mi}${s}`;
}

function getJalaliTimestamp(){
    try{
        const d = new Date();
        const jy = new Intl.DateTimeFormat('fa-IR', { year: 'numeric' }).format(d);
        const jm = new Intl.DateTimeFormat('fa-IR', { month: '2-digit' }).format(d);
        const jd = new Intl.DateTimeFormat('fa-IR', { day: '2-digit' }).format(d);
        return `${jy}-${jm}-${jd}`.replace(/\//g, '-');
    }catch(e){
        return getTimestamp();
    }
}

/* ==================== ذخیره‌ی خودکار ==================== */
function startAutoSave(getDataCallback, onSave){
    stopAutoSave();
    saveCallback = onSave;
    
    autoSaveTimer = setInterval(async () => {
        if(!fileHandle) return;
        
        try{
            const data = getDataCallback();
            if(!data) return;
            
            const result = await writeToFile(data);
            
            if(result.success && saveCallback){
                saveCallback({ success: true, size: result.size });
            }
        }catch(e){
            console.error('Auto save error:', e);
        }
    }, BACKUP_CONFIG.AUTO_SAVE_INTERVAL_MS);
    
    return true;
}

function stopAutoSave(){
    if(autoSaveTimer){
        clearInterval(autoSaveTimer);
        autoSaveTimer = null;
    }
}

/* ==================== پشتیبان‌گیری خودکار روزانه ==================== */
async function shouldRunDailyBackup(){
    try{
        const lastBackup = await CryptoLayer.getMeta(BACKUP_CONFIG.LAST_BACKUP_KEY);
        if(!lastBackup) return true;
        
        const hoursSince = (Date.now() - lastBackup) / (1000 * 60 * 60);
        return hoursSince >= 24;
    }catch(e){
        return true;
    }
}

async function runDailyBackup(contracts, password){
    try{
        // ذخیره در IndexedDB به صورت Snapshot
        const result = await CryptoLayer.createSnapshot(contracts, password, 'پشتیبان خودکار روزانه');
        
        if(result.success){
            await CryptoLayer.setMeta(BACKUP_CONFIG.LAST_BACKUP_KEY, Date.now());
        }
        
        return result;
    }catch(e){
        return { success: false, error: e.message };
    }
}

function startDailyBackupChecker(getContractsCallback, getPasswordCallback){
    if(autoBackupTimer) clearInterval(autoBackupTimer);
    
    autoBackupTimer = setInterval(async () => {
        if(await shouldRunDailyBackup()){
            const contracts = getContractsCallback();
            const password = getPasswordCallback();
            if(contracts && password){
                await runDailyBackup(contracts, password);
                console.log('✅ پشتیبان خودکار روزانه گرفته شد');
            }
        }
    }, 6 * 60 * 60 * 1000);
}

/* ==================== دانلود معمولی (Fallback) ==================== */
function downloadBackupFile(data, prefix = 'moto_backup'){
    try{
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${prefix}_${getJalaliTimestamp()}_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        
        return { success: true, method: 'download' };
    }catch(e){
        return { success: false, reason: e.message };
    }
}

function downloadJSONBackup(contracts){
    return downloadBackupFile({
        version: 1,
        app: 'moto-installments',
        timestamp: Date.now(),
        jalaliDate: getJalaliTimestamp(),
        count: contracts.length,
        contracts: contracts
    }, 'moto_backup');
}

function uploadBackupFile(){
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if(!file){
                resolve({ success: false, reason: 'فایلی انتخاب نشد' });
                return;
            }
            
            try{
                const text = await file.text();
                const data = JSON.parse(text);
                
                if(!data.contracts || !Array.isArray(data.contracts)){
                    resolve({ success: false, reason: 'ساختار فایل نامعتبر است' });
                    return;
                }
                
                resolve({
                    success: true,
                    data: data,
                    fileName: file.name,
                    contractCount: data.contracts.length,
                    jalaliDate: data.jalaliDate || '-'
                });
            }catch(err){
                resolve({ success: false, reason: 'خطا در خواندن فایل: ' + err.message });
            }
        };
        
        input.click();
    });
}

/* ==================== راهنمای همگام‌سازی ابری ==================== */
function getCloudSyncInstructions(){
    return {
        googleDrive: {
            title: 'همگام‌سازی با Google Drive',
            steps: [
                'در Chrome یا Edge، روی دکمه "انتخاب فایل ذخیره‌سازی" بزنید',
                'در پنجره‌ی بازشده، به پوشه‌ی Google Drive بروید',
                'یک فایل با نام دلخواه بسازید و ذخیره کنید',
                'از این به بعد، هر ۳۰ ثانیه یک بار، داده‌ها خودکار در فایل ذخیره می‌شوند',
                'Google Drive خودش فایل را با ابر همگام می‌کند',
                'روی کامپیوتر دوم، همان فایل را باز کنید و برنامه را وصل کنید'
            ]
        },
        oneDrive: {
            title: 'همگام‌سازی با OneDrive',
            steps: [
                'در Chrome یا Edge، روی دکمه "انتخاب فایل ذخیره‌سازی" بزنید',
                'در پنجره‌ی بازشده، به پوشه‌ی OneDrive بروید',
                'یک فایل بسازید و ذخیره کنید',
                'هر تغییر، خودکار در فایل ذخیره می‌شود',
                'OneDrive خودش فایل را با ابر همگام می‌کند',
                'روی کامپیوتر دوم، همان فایل را باز کنید'
            ]
        },
        usb: {
            title: 'پشتیبان روی فلش USB',
            steps: [
                'فلش USB را به کامپیوتر وصل کنید',
                'روی دکمه "انتخاب فایل ذخیره‌سازی" بزنید',
                'فلش USB را انتخاب کنید',
                'یک فایل بسازید و ذخیره کنید',
                'هر تغییر خودکار در فلش ذخیره می‌شود'
            ]
        }
    };
}

/* ==================== وضعیت فایل ==================== */
function getFileStatus(){
    return {
        hasFileSystemAccess: hasFileSystemAccess,
        hasFileHandle: fileHandle !== null,
        fileName: fileHandle ? fileHandle.name : null,
        autoSaveActive: autoSaveTimer !== null,
        browser: detectBrowser()
    };
}

function detectBrowser(){
    const ua = navigator.userAgent;
    if(ua.includes('Firefox')) return 'firefox';
    if(ua.includes('Edg')) return 'edge';
    if(ua.includes('Chrome')) return 'chrome';
    if(ua.includes('Safari')) return 'safari';
    return 'unknown';
}

/* ==================== ذخیره قبل از بستن ==================== */
async function flushBeforeUnload(getDataCallback){
    if(!fileHandle) return false;
    
    try{
        const data = getDataCallback();
        if(!data) return false;
        
        await Promise.race([
            writeToFile(data),
            new Promise(resolve => setTimeout(resolve, 2000))
        ]);
        
        return true;
    }catch(e){
        console.error('Flush error:', e);
        return false;
    }
}

/* ==================== صادرات ==================== */
window.BackupLayer = {
    checkFileSystemSupport,
    isSupported: () => hasFileSystemAccess,
    pickSaveLocation,
    loadExistingFile,
    writeToFile,
    readFromFile,
    clearFileHandle,
    flushBeforeUnload,
    startAutoSave,
    stopAutoSave,
    runDailyBackup,
    shouldRunDailyBackup,
    startDailyBackupChecker,
    downloadJSONBackup,
    uploadBackupFile,
    getFileStatus,
    getCloudSyncInstructions,
    getTimestamp,
    getJalaliTimestamp,
    detectBrowser
};

console.log('✅ backup.js بارگذاری شد');
console.log('📁 File System Access:', hasFileSystemAccess ? '✅' : '❌');