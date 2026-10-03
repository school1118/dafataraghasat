/* ============================================================
   merged.js - توابع ادغام‌شده
   ============================================================
   این فایل باید بعد از app.js لود شود
============================================================ */

'use strict';

window.AppMerged = {
    
    /* ============ بارگذاری امن ============ */
    safeLoadData: async function(){
        try{
            if(typeof CryptoLayer === 'undefined'){
                return {
                    _loadError: true,
                    reason: 'CryptoLayer not loaded',
                    contracts: []
                };
            }
            
            const result = await CryptoLayer.loadSecureData(window.AppCore.State.currentPassword);
            
            if(!result.success){
                return {
                    _loadError: true,
                    reason: result.reason || 'رمزگشایی ناموفق',
                    contracts: []
                };
            }
            
            if(!result.data){
                return {
                    version: 1,
                    contracts: []
                };
            }
            
            // مهاجرت داده
            const contracts = (result.data.contracts || []).map(c => ({
                ...c,
                guarantor2Name: c.guarantor2Name || '',
                guarantor2Father: c.guarantor2Father || '',
                guarantor2National: c.guarantor2National || '',
                guarantor2Phone: c.guarantor2Phone || '',
                guarantor2Address: c.guarantor2Address || '',
                installmentInterval: c.installmentInterval || 30,
                installmentRate: c.installmentRate || 0,
                penaltyCap: c.penaltyCap !== undefined ? c.penaltyCap : 50,
                startDate: c.startDate || c.downPaymentDate || '',
                createdAt: c.createdAt || new Date().toLocaleDateString('fa-IR'),
                tag: c.tag || 'عادی'
            }));
            
            return {
                version: result.data.version || 1,
                contracts: contracts
            };
            
        }catch(e){
            console.error('Safe load error:', e);
            return {
                _loadError: true,
                reason: e.message,
                contracts: []
            };
        }
    },
    
    /* ============ Snapshots ============ */
    showSnapshotsList: async function(){
        try{
            const snapshots = await CryptoLayer.listSnapshots();
            
            let html = `
                <div class="section-title">📸 نسخه‌های داخلی (Snapshots)</div>
                <div style="max-height:400px;overflow-y:auto;margin-top:10px">
            `;
            
            if(snapshots.length === 0){
                html += '<div style="text-align:center;padding:20px;color:var(--muted)">هیچ نسخه‌ای موجود نیست</div>';
            } else {
                snapshots.forEach(s => {
                    const date = new Date(s.date);
                    const jalaliDate = new Intl.DateTimeFormat('fa-IR', {
                        year: 'numeric', month: '2-digit', day: '2-digit'
                    }).format(date);
                    const time = date.toLocaleTimeString('fa-IR');
                    
                    html += `
                        <div class="user-card" style="margin-bottom:8px">
                            <div class="info">
                                <div class="name">
                                    📸 ${jalaliDate} - ${time}
                                </div>
                                <div class="meta">
                                    ${s.count} قرارداد
                                    ${s.label ? ' | ' + s.label : ''}
                                </div>
                            </div>
                            <div style="display:flex;gap:6px">
                                <button class="btn btn-success btn-sm" onclick="AppMerged.restoreSnapshotById('${s.id}')">
                                    ↩️ بازیابی
                                </button>
                                <button class="btn btn-danger btn-sm" onclick="AppMerged.deleteSnapshotById('${s.id}')">
                                    🗑️
                                </button>
                            </div>
                        </div>
                    `;
                });
            }
            
            html += '</div>';
            
            const modal = document.getElementById('snapshotsModal');
            if(modal){
                document.getElementById('snapshotsBody').innerHTML = html;
                modal.classList.add('active');
            }
        }catch(e){
            console.error(e);
            alert('خطا در بارگذاری نسخه‌ها: ' + e.message);
        }
    },
    
    restoreSnapshotById: async function(id){
        if(!confirm('این نسخه جایگزین اطلاعات فعلی شود؟')) return;
        
        try{
            const state = window.AppCore.State;
            await CryptoLayer.createSnapshot(state.contracts, state.currentPassword, 'قبل از بازیابی');
            
            const result = await CryptoLayer.restoreSnapshot(id, state.currentPassword);
            
            if(result.success){
                state.contracts = result.contracts;
                await window.AppCore.saveAllData();
                window.AppUI.renderAll();
                
                document.getElementById('snapshotsModal').classList.remove('active');
                alert('✅ بازیابی موفق');
            } else {
                alert('❌ ' + result.reason);
            }
        }catch(e){
            alert('❌ خطا: ' + e.message);
        }
    },
    
    deleteSnapshotById: async function(id){
        if(!confirm('این نسخه پاک شود؟')) return;
        
        const result = await CryptoLayer.deleteSnapshot(id);
        if(result.success){
            AppMerged.showSnapshotsList();
        }
    },
    
    /* ============ Trash ============ */
    showTrashList: async function(){
        try{
            const trash = await CryptoLayer.getTrash();
            
            let html = `
                <div class="section-title">🗑️ سطل بازیابی</div>
                <div style="margin-bottom:10px">
                    <span class="badge badge-info">${trash.length} مورد</span>
                    ${trash.length > 0 ? `
                        <button class="btn btn-danger btn-sm" style="margin-right:10px" onclick="AppMerged.emptyTrashConfirm()">
                            🗑️ خالی کردن
                        </button>
                    ` : ''}
                </div>
                <div style="max-height:400px;overflow-y:auto">
            `;
            
            if(trash.length === 0){
                html += '<div style="text-align:center;padding:20px;color:var(--muted)">سطل بازیابی خالی است</div>';
            } else {
                trash.sort((a, b) => b.deletedAtTimestamp - a.deletedAtTimestamp);
                
                trash.forEach(item => {
                    const date = new Date(item.deletedAtTimestamp);
                    const jalaliDate = new Intl.DateTimeFormat('fa-IR', {
                        year: 'numeric', month: '2-digit', day: '2-digit'
                    }).format(date);
                    
                    html += `
                        <div class="user-card" style="margin-bottom:8px">
                            <div class="info">
                                <div class="name">${item.customerName || 'نامشخص'}</div>
                                <div class="meta">
                                    ${item.bikeModel || '-'} | حذف: ${jalaliDate}
                                </div>
                            </div>
                            <button class="btn btn-success btn-sm" onclick="AppMerged.restoreTrashById(${item.id})">
                                ↩️ بازیابی
                            </button>
                        </div>
                    `;
                });
            }
            
            html += '</div>';
            
            const modal = document.getElementById('trashModal');
            if(modal){
                document.getElementById('trashBody').innerHTML = html;
                modal.classList.add('active');
            }
        }catch(e){
            console.error(e);
            alert('خطا: ' + e.message);
        }
    },
    
    restoreTrashById: async function(id){
        if(!confirm('این مورد بازگردانده شود؟')) return;
        
        try{
            const result = await CryptoLayer.restoreFromTrash(id);
            
            if(result.success){
                const state = window.AppCore.State;
                const exists = state.contracts.some(c => c.id === result.item.id);
                
                if(exists) result.item.id = Date.now() + Math.random();
                
                delete result.item.deletedAt;
                delete result.item.deletedAtTimestamp;
                
                state.contracts.push(result.item);
                await window.AppCore.saveAllData();
                window.AppUI.renderAll();
                
                AppMerged.showTrashList();
                alert('✅ بازیابی شد');
            } else {
                alert('❌ ' + (result.error || 'خطا'));
            }
        }catch(e){
            alert('❌ خطا: ' + e.message);
        }
    },
    
    emptyTrashConfirm: async function(){
        if(!confirm('همه پاک شوند؟ قابل بازگشت نیست.')) return;
        
        try{
            await CryptoLayer.emptyTrash();
            AppMerged.showTrashList();
        }catch(e){
            alert('خطا: ' + e.message);
        }
    },
    
    /* ============ Factory Reset ============ */
    factoryResetConfirm: async function(){
        if(!confirm('⚠️ تمام داده‌ها پاک می‌شوند!\nادامه؟')) return;
        if(!confirm('مطمئنید؟ قابل بازگشت نیست!')) return;
        
        const txt = prompt('برای تأیید، بنویسید: DELETE');
        if(txt !== 'DELETE'){
            alert('لغو شد');
            return;
        }
        
        try{
            const state = window.AppCore.State;
            await CryptoLayer.createSnapshot(state.contracts, state.currentPassword, 'پشتیبان قبل از Factory Reset');
            await CryptoLayer.factoryReset();
            
            localStorage.removeItem('moto_last_backup');
            localStorage.removeItem('moto_theme');
            
            alert('✅ همه چیز پاک شد. صفحه رفرش می‌شود.');
            location.reload();
        }catch(e){
            alert('خطا: ' + e.message);
        }
    }
};

console.log('✅ merged.js بارگذاری شد');