/* ============================================================
   crypto.js - لایه امنیتی و ذخیره‌سازی (نسخه نهایی)
   ============================================================
   - AES-256-GCM
   - PBKDF2 با 210,000 تکرار (OWASP 2023)
   - IndexedDB + localStorage (ذخیره‌سازی دوگانه)
   - سطل بازیابی (Trash)
   - Snapshots (20 نسخه)
   - آرشیو لاگ‌ها
============================================================ */

'use strict';

/* ==================== ثابت‌ها ==================== */
const CRYPTO_CONFIG = {
    ALGORITHM: 'AES-GCM',
    KEY_LENGTH: 256,
    IV_LENGTH: 12,
    SALT_LENGTH: 32,
    PBKDF2_ITERATIONS: 210000,
    HASH: 'SHA-256',
    DB_NAME: 'MotoContractsSecureDB',
    DB_VERSION: 2,
    STORE_NAME: 'contracts',
    META_STORE: 'meta',
    SNAPSHOT_STORE: 'snapshots',
    TRASH_STORE: 'trash',
    MAX_SNAPSHOTS: 20,
    TRASH_LIMIT: 200,
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 5 * 60 * 1000
};

/* ==================== IndexedDB ==================== */
let dbInstance = null;

function openDB(){
    return new Promise((resolve, reject) => {
        if(dbInstance) return resolve(dbInstance);
        
        const request = indexedDB.open(CRYPTO_CONFIG.DB_NAME, CRYPTO_CONFIG.DB_VERSION);
        
        request.onerror = () => reject(new Error('خطا در باز کردن پایگاه داده'));
        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            
            // ⭐ چک کردن وجود همه‌ی Storeها
            const requiredStores = [
                CRYPTO_CONFIG.STORE_NAME,
                CRYPTO_CONFIG.META_STORE,
                CRYPTO_CONFIG.SNAPSHOT_STORE,
                CRYPTO_CONFIG.TRASH_STORE
            ];
            
            const missingStores = requiredStores.filter(s => !dbInstance.objectStoreNames.contains(s));
            
            if(missingStores.length > 0){
                // بستن دیتابیس و ارتقا دادن
                const currentVersion = dbInstance.version;
                dbInstance.close();
                dbInstance = null;
                
                // باز کردن با نسخه‌ی بالاتر
                const upgradeRequest = indexedDB.open(CRYPTO_CONFIG.DB_NAME, currentVersion + 1);
                
                upgradeRequest.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    
                    if(!db.objectStoreNames.contains(CRYPTO_CONFIG.STORE_NAME)){
                        const store = db.createObjectStore(CRYPTO_CONFIG.STORE_NAME, { keyPath: 'id' });
                        store.createIndex('customerName', 'customerName', { unique: false });
                        store.createIndex('createdAt', 'createdAt', { unique: false });
                        store.createIndex('status', 'status', { unique: false });
                    }
                    
                    if(!db.objectStoreNames.contains(CRYPTO_CONFIG.META_STORE)){
                        db.createObjectStore(CRYPTO_CONFIG.META_STORE, { keyPath: 'key' });
                    }
                    
                    if(!db.objectStoreNames.contains(CRYPTO_CONFIG.SNAPSHOT_STORE)){
                        db.createObjectStore(CRYPTO_CONFIG.SNAPSHOT_STORE, { keyPath: 'id' });
                    }
                    
                    if(!db.objectStoreNames.contains(CRYPTO_CONFIG.TRASH_STORE)){
                        db.createObjectStore(CRYPTO_CONFIG.TRASH_STORE, { keyPath: 'id' });
                    }
                };
                
                upgradeRequest.onsuccess = (ev) => {
                    dbInstance = ev.target.result;
                    resolve(dbInstance);
                };
                
                upgradeRequest.onerror = () => reject(upgradeRequest.error);
                
            } else {
                resolve(dbInstance);
            }
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if(!db.objectStoreNames.contains(CRYPTO_CONFIG.STORE_NAME)){
                const store = db.createObjectStore(CRYPTO_CONFIG.STORE_NAME, { keyPath: 'id' });
                store.createIndex('customerName', 'customerName', { unique: false });
                store.createIndex('createdAt', 'createdAt', { unique: false });
                store.createIndex('status', 'status', { unique: false });
            }
            
            if(!db.objectStoreNames.contains(CRYPTO_CONFIG.META_STORE)){
                db.createObjectStore(CRYPTO_CONFIG.META_STORE, { keyPath: 'key' });
            }
            
            if(!db.objectStoreNames.contains(CRYPTO_CONFIG.SNAPSHOT_STORE)){
                db.createObjectStore(CRYPTO_CONFIG.SNAPSHOT_STORE, { keyPath: 'id' });
            }
            
            if(!db.objectStoreNames.contains(CRYPTO_CONFIG.TRASH_STORE)){
                db.createObjectStore(CRYPTO_CONFIG.TRASH_STORE, { keyPath: 'id' });
            }
        };
    });
}

/* ==================== Meta Store ==================== */
async function setMeta(key, value){
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CRYPTO_CONFIG.META_STORE, 'readwrite');
        const store = tx.objectStore(CRYPTO_CONFIG.META_STORE);
        const request = store.put({ key, value, updatedAt: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function getMeta(key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CRYPTO_CONFIG.META_STORE, 'readonly');
        const store = tx.objectStore(CRYPTO_CONFIG.META_STORE);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
    });
}

async function deleteMeta(key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CRYPTO_CONFIG.META_STORE, 'readwrite');
        const store = tx.objectStore(CRYPTO_CONFIG.META_STORE);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/* ==================== ابزارهای Crypto ==================== */
function bufferToBase64(buffer){
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for(let i = 0; i < bytes.byteLength; i++){
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBuffer(base64){
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i++){
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function stringToBuffer(str){
    return new TextEncoder().encode(str);
}

function bufferToString(buffer){
    return new TextDecoder().decode(buffer);
}

function generateSalt(){
    return crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.SALT_LENGTH));
}

/* ==================== Password Hashing ==================== */
async function hashPassword(password, salt){
    const passwordBuffer = stringToBuffer(password);
    
    const baseKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: CRYPTO_CONFIG.PBKDF2_ITERATIONS,
            hash: CRYPTO_CONFIG.HASH
        },
        baseKey,
        CRYPTO_CONFIG.KEY_LENGTH
    );
    
    return bufferToBase64(derivedBits);
}

async function deriveEncryptionKey(password, salt){
    const passwordBuffer = stringToBuffer(password);
    
    const baseKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    
    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: CRYPTO_CONFIG.PBKDF2_ITERATIONS,
            hash: CRYPTO_CONFIG.HASH
        },
        baseKey,
        { name: CRYPTO_CONFIG.ALGORITHM, length: CRYPTO_CONFIG.KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/* ==================== رمزنگاری AES-GCM ==================== */
async function encryptData(data, key){
    const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.IV_LENGTH));
    const jsonStr = JSON.stringify(data);
    const plainBuffer = stringToBuffer(jsonStr);
    
    const cipherBuffer = await crypto.subtle.encrypt(
        { name: CRYPTO_CONFIG.ALGORITHM, iv: iv },
        key,
        plainBuffer
    );
    
    return {
        iv: bufferToBase64(iv),
        cipher: bufferToBase64(cipherBuffer)
    };
}

async function decryptData(encrypted, key){
    try{
        const iv = new Uint8Array(base64ToBuffer(encrypted.iv));
        const cipherBuffer = base64ToBuffer(encrypted.cipher);
        
        const plainBuffer = await crypto.subtle.decrypt(
            { name: CRYPTO_CONFIG.ALGORITHM, iv: iv },
            key,
            cipherBuffer
        );
        
        return JSON.parse(bufferToString(plainBuffer));
    }catch(e){
        console.error('Decryption failed:', e);
        return null;
    }
}

/* ==================== احراز هویت ==================== */
async function initAuth(){
    const existingHash = await getMeta('passwordHash');
    const existingSalt = await getMeta('passwordSalt');
    
    if(!existingHash || !existingSalt){
        return { isFirstRun: true };
    }
    
    return { isFirstRun: false };
}

async function verifyPassword(password){
    const lockUntil = await getMeta('lockUntil');
    if(lockUntil && Date.now() < lockUntil){
        const remainingSec = Math.ceil((lockUntil - Date.now()) / 1000);
        return {
            success: false,
            reason: `حساب قفل است. ${remainingSec} ثانیه صبر کنید.`
        };
    }
    
    const saltBase64 = await getMeta('passwordSalt');
    const storedHash = await getMeta('passwordHash');
    
    if(!saltBase64 || !storedHash){
        return { success: false, reason: 'سیستم راه‌اندازی نشده' };
    }
    
    const salt = new Uint8Array(base64ToBuffer(saltBase64));
    const inputHash = await hashPassword(password, salt);
    
    if(inputHash === storedHash){
        await setMeta('loginAttempts', 0);
        await deleteMeta('lockUntil');
        
        const key = await deriveEncryptionKey(password, salt);
        
        return { success: true, key, salt };
    } else {
        const attempts = (await getMeta('loginAttempts')) || 0;
        const newAttempts = attempts + 1;
        
        if(newAttempts >= CRYPTO_CONFIG.MAX_LOGIN_ATTEMPTS){
            const lockUntilTime = Date.now() + CRYPTO_CONFIG.LOCKOUT_DURATION_MS;
            await setMeta('lockUntil', lockUntilTime);
            await setMeta('loginAttempts', 0);
            
            return {
                success: false,
                reason: `تعداد تلاش‌ها بیش از حد مجاز. حساب برای ۵ دقیقه قفل شد.`
            };
        }
        
        await setMeta('loginAttempts', newAttempts);
        const remaining = CRYPTO_CONFIG.MAX_LOGIN_ATTEMPTS - newAttempts;
        
        return {
            success: false,
            reason: `رمز اشتباه است. ${remaining} تلاش باقی مانده.`
        };
    }
}

async function setupFirstPassword(password){
    const salt = generateSalt();
    const saltBase64 = bufferToBase64(salt);
    const hash = await hashPassword(password, salt);
    
    await setMeta('passwordSalt', saltBase64);
    await setMeta('passwordHash', hash);
    await setMeta('installedAt', Date.now());
    
    const key = await deriveEncryptionKey(password, salt);
    
    return { success: true, key, salt };
}

async function changePassword(oldPassword, newPassword){
    const verify = await verifyPassword(oldPassword);
    if(!verify.success) return { success: false, reason: verify.reason };
    
    const newSalt = generateSalt();
    const newSaltBase64 = bufferToBase64(newSalt);
    const newHash = await hashPassword(newPassword, newSalt);
    
    await setMeta('passwordSalt', newSaltBase64);
    await setMeta('passwordHash', newHash);
    await setMeta('passwordChangedAt', Date.now());
    
    const newKey = await deriveEncryptionKey(newPassword, newSalt);
    
    return { success: true, key: newKey, salt: newSalt };
}

/* ==================== ذخیره‌سازی دوگانه ==================== */
async function saveSecureData(data, password){
    try{
        const saltBase64 = await getMeta('passwordSalt');
        if(!saltBase64) return { success: false, reason: 'سیستم راه‌اندازی نشده' };
        
        const salt = new Uint8Array(base64ToBuffer(saltBase64));
        const key = await deriveEncryptionKey(password, salt);
        
        const encrypted = await encryptData({
            version: 2,
            data: data,
            timestamp: Date.now()
        }, key);
        
        const record = {
            version: 2,
            alg: 'AES-256-GCM',
            kdf: 'PBKDF2-SHA-256',
            iterations: CRYPTO_CONFIG.PBKDF2_ITERATIONS,
            salt: saltBase64,
            iv: encrypted.iv,
            ciphertext: encrypted.cipher,
            savedAt: new Date().toISOString()
        };
        
        // ذخیره در IndexedDB
        await setMeta('mainData', record);
        
        // ذخیره در localStorage (Backup)
        try{
            localStorage.setItem('moto_secure_backup', JSON.stringify(record));
        }catch(e){
            console.warn('localStorage backup failed:', e);
        }
        
        return { success: true, record };
    }catch(e){
        console.error('Save secure error:', e);
        return { success: false, reason: e.message };
    }
}

async function loadSecureData(password){
    try{
        let record = await getMeta('mainData');
        
        if(!record){
            try{
                const lsRaw = localStorage.getItem('moto_secure_backup');
                if(lsRaw) record = JSON.parse(lsRaw);
            }catch(e){}
        }
        
        if(!record) return { success: true, data: null };
        
        const salt = new Uint8Array(base64ToBuffer(record.salt));
        const key = await deriveEncryptionKey(password, salt);
        
        const decrypted = await decryptData({
            iv: record.iv,
            cipher: record.ciphertext
        }, key);
        
        if(!decrypted){
            return { success: false, reason: 'رمزگشایی ناموفق بود' };
        }
        
        return { success: true, data: decrypted.data };
    }catch(e){
        console.error('Load secure error:', e);
        return { success: false, reason: e.message };
    }
}

/* ==================== سطل بازیابی (Trash) ==================== */
async function addToTrash(items){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.TRASH_STORE, 'readwrite');
            const store = tx.objectStore(CRYPTO_CONFIG.TRASH_STORE);
            
            const itemsToAdd = Array.isArray(items) ? items : [items];
            itemsToAdd.forEach(item => {
                store.put({
                    ...item,
                    deletedAt: new Date().toISOString(),
                    deletedAtTimestamp: Date.now()
                });
            });
            
            tx.oncomplete = () => resolve({ success: true, count: itemsToAdd.length });
            tx.onerror = () => reject(tx.error);
        });
    }catch(e){
        return { success: false, error: e.message };
    }
}

async function getTrash(){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.TRASH_STORE, 'readonly');
            const store = tx.objectStore(CRYPTO_CONFIG.TRASH_STORE);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }catch(e){
        return [];
    }
}

async function restoreFromTrash(id){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.TRASH_STORE, 'readwrite');
            const store = tx.objectStore(CRYPTO_CONFIG.TRASH_STORE);
            const getReq = store.get(id);
            
            getReq.onsuccess = () => {
                const item = getReq.result;
                if(!item){
                    reject(new Error('آیتم در سطل بازیابی پیدا نشد'));
                    return;
                }
                
                store.delete(id);
                
                tx.oncomplete = () => resolve({ success: true, item });
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }catch(e){
        return { success: false, error: e.message };
    }
}

async function emptyTrash(){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.TRASH_STORE, 'readwrite');
            const store = tx.objectStore(CRYPTO_CONFIG.TRASH_STORE);
            store.clear();
            tx.oncomplete = () => resolve({ success: true });
            tx.onerror = () => reject(tx.error);
        });
    }catch(e){
        return { success: false, error: e.message };
    }
}

async function cleanupTrash(){
    try{
        const all = await getTrash();
        if(all.length <= CRYPTO_CONFIG.TRASH_LIMIT) return;
        
        all.sort((a, b) => a.deletedAtTimestamp - b.deletedAtTimestamp);
        const toDelete = all.slice(0, all.length - CRYPTO_CONFIG.TRASH_LIMIT);
        
        const db = await openDB();
        const tx = db.transaction(CRYPTO_CONFIG.TRASH_STORE, 'readwrite');
        const store = tx.objectStore(CRYPTO_CONFIG.TRASH_STORE);
        
        toDelete.forEach(item => store.delete(item.id));
    }catch(e){
        console.error('Cleanup trash error:', e);
    }
}

/* ==================== Snapshots ==================== */
async function createSnapshot(contracts, password, label = ''){
    try{
        const saltBase64 = await getMeta('passwordSalt');
        if(!saltBase64) return { success: false };
        
        const salt = new Uint8Array(base64ToBuffer(saltBase64));
        const key = await deriveEncryptionKey(password, salt);
        
        const encrypted = await encryptData({
            version: 2,
            contracts: contracts,
            timestamp: Date.now(),
            label: label
        }, key);
        
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.SNAPSHOT_STORE, 'readwrite');
            const store = tx.objectStore(CRYPTO_CONFIG.SNAPSHOT_STORE);
            
            const snapshot = {
                id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                createdAt: new Date().toISOString(),
                timestamp: Date.now(),
                label: label,
                count: contracts.length,
                iv: encrypted.iv,
                ciphertext: encrypted.cipher
            };
            
            store.put(snapshot);
            
            const getAllReq = store.getAll();
            getAllReq.onsuccess = () => {
                const all = getAllReq.result || [];
                if(all.length > CRYPTO_CONFIG.MAX_SNAPSHOTS){
                    all.sort((a, b) => a.timestamp - b.timestamp);
                    const toDelete = all.slice(0, all.length - CRYPTO_CONFIG.MAX_SNAPSHOTS);
                    toDelete.forEach(item => store.delete(item.id));
                }
            };
            
            tx.oncomplete = () => resolve({ success: true, count: contracts.length });
            tx.onerror = () => reject(tx.error);
        });
    }catch(e){
        console.error('Snapshot error:', e);
        return { success: false, error: e.message };
    }
}

async function listSnapshots(){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.SNAPSHOT_STORE, 'readonly');
            const store = tx.objectStore(CRYPTO_CONFIG.SNAPSHOT_STORE);
            const request = store.getAll();
            request.onsuccess = () => {
                const all = request.result || [];
                all.sort((a, b) => b.timestamp - a.timestamp);
                resolve(all.map(s => ({
                    id: s.id,
                    createdAt: s.createdAt,
                    label: s.label,
                    count: s.count,
                    date: new Date(s.timestamp)
                })));
            };
            request.onerror = () => reject(request.error);
        });
    }catch(e){
        return [];
    }
}

async function restoreSnapshot(snapshotId, password){
    try{
        const db = await openDB();
        const snapshot = await new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.SNAPSHOT_STORE, 'readonly');
            const store = tx.objectStore(CRYPTO_CONFIG.SNAPSHOT_STORE);
            const request = store.get(snapshotId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        
        if(!snapshot){
            return { success: false, reason: 'نسخه پیدا نشد' };
        }
        
        const saltBase64 = await getMeta('passwordSalt');
        const salt = new Uint8Array(base64ToBuffer(saltBase64));
        const key = await deriveEncryptionKey(password, salt);
        
        const decrypted = await decryptData({
            iv: snapshot.iv,
            cipher: snapshot.ciphertext
        }, key);
        
        if(!decrypted){
            return { success: false, reason: 'رمزگشایی ناموفق - رمز اشتباه؟' };
        }
        
        return { success: true, contracts: decrypted.contracts };
    }catch(e){
        return { success: false, reason: e.message };
    }
}

async function deleteSnapshot(snapshotId){
    try{
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CRYPTO_CONFIG.SNAPSHOT_STORE, 'readwrite');
            const store = tx.objectStore(CRYPTO_CONFIG.SNAPSHOT_STORE);
            store.delete(snapshotId);
            tx.oncomplete = () => resolve({ success: true });
            tx.onerror = () => reject(tx.error);
        });
    }catch(e){
        return { success: false };
    }
}

/* ==================== آرشیو لاگ‌ها ==================== */
async function archiveLogs(){
    try{
        const logs = await getMeta('logs');
        if(!logs || logs.length === 0) return { success: true, archived: 0 };
        
        const archive = await getMeta('logsArchive') || [];
        
        const archiveEntry = {
            archivedAt: new Date().toISOString(),
            count: logs.length,
            logs: logs
        };
        
        archive.push(archiveEntry);
        const trimmedArchive = archive.slice(-5);
        
        await setMeta('logsArchive', trimmedArchive);
        
        return { success: true, archived: logs.length };
    }catch(e){
        return { success: false, error: e.message };
    }
}

async function getLogsArchive(){
    try{
        return await getMeta('logsArchive') || [];
    }catch(e){
        return [];
    }
}

/* ==================== محاسبه حجم ==================== */
async function getStorageUsage(){
    if(navigator.storage && navigator.storage.estimate){
        try{
            const estimate = await navigator.storage.estimate();
            return {
                usage: estimate.usage || 0,
                quota: estimate.quota || 0,
                percent: estimate.quota ? (estimate.usage / estimate.quota) * 100 : 0
            };
        }catch(e){
            return { usage: 0, quota: 0, percent: 0 };
        }
    }
    return { usage: 0, quota: 0, percent: 0 };
}

/* ==================== امنیت ==================== */
function isSecureContext(){
    return window.isSecureContext === true || 
           location.protocol === 'https:' || 
           location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1';
}

function checkHTTPS(){
    if(!isSecureContext()){
        console.warn('⚠️ برنامه روی HTTPS اجرا نمی‌شود.');
        return false;
    }
    return true;
}

/* ==================== Factory Reset ==================== */
async function factoryReset(){
    return new Promise((resolve, reject) => {
        const deleteReq = indexedDB.deleteDatabase(CRYPTO_CONFIG.DB_NAME);
        deleteReq.onsuccess = () => {
            dbInstance = null;
            localStorage.removeItem('moto_secure_backup');
            resolve({ success: true });
        };
        deleteReq.onerror = () => reject(deleteReq.error);
    });
}

/* ==================== صادرات ==================== */
window.CryptoLayer = {
    openDB,
    setMeta,
    getMeta,
    deleteMeta,
    initAuth,
    verifyPassword,
    setupFirstPassword,
    changePassword,
    encryptData,
    decryptData,
    deriveEncryptionKey,
    saveSecureData,
    loadSecureData,
    addToTrash,
    getTrash,
    restoreFromTrash,
    emptyTrash,
    cleanupTrash,
    createSnapshot,
    listSnapshots,
    restoreSnapshot,
    deleteSnapshot,
    archiveLogs,
    getLogsArchive,
    getStorageUsage,
    isSecureContext,
    checkHTTPS,
    factoryReset,
    bufferToBase64,
    base64ToBuffer,
    generateSalt
};

console.log('✅ crypto.js نسخه نهایی بارگذاری شد');
console.log('🔐 PBKDF2: 210,000 تکرار');
console.log('💾 ذخیره‌سازی: IndexedDB + localStorage');
console.log('🗑️ سطل بازیابی: فعال');
console.log('📸 Snapshots: 20 نسخه');