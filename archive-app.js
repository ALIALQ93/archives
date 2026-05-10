/**
 * نظام الأرشيف — Supabase (Postgres + Auth)
 * الملفات في جدول card_attachments (bytea) — بدون Supabase Storage
 *
 * أنشئ الجداول بتشغيل الهجرة في supabase/migrations أو من SQL Editor.
 * في لوحة Supabase: Authentication → إيقاف «Confirm email» للتطوير إن لزم.
 */

const SUPABASE_URL = 'https://zajewewtlxykqvcailnh.supabase.co';
const SUPABASE_ANON_KEY =
    'sb_publishable_xzsvplR08i4nQPRFljRoFw_5FqfUaSZ';

const _create =
    typeof window.supabase?.createClient === 'function'
        ? window.supabase.createClient.bind(window.supabase)
        : window.supabase?.default?.createClient;
if (!_create) {
    console.error('تأكد من تحميل مكتبة @supabase/supabase-js قبل archive-app.js');
}
const sb = _create(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
    },
});

let currentUser = null;
let companyId = null;
let currentEditingId = null;
let sections = [];
let cards = [];
let users = [];
let uploadedFiles = [];
let dashboardChannels = [];
let sectionChannel = null;
let cardsChannel = null;
let usersChannel = null;
let dashboardInterval = null;

function teardownDashboardChannels() {
    dashboardChannels.forEach((ch) => {
        try {
            sb.removeChannel(ch);
        } catch (_) {}
    });
    dashboardChannels = [];
}

function teardownTabChannels() {
    if (sectionChannel) {
        try {
            sb.removeChannel(sectionChannel);
        } catch (_) {}
        sectionChannel = null;
    }
    if (cardsChannel) {
        try {
            sb.removeChannel(cardsChannel);
        } catch (_) {}
        cardsChannel = null;
    }
    if (usersChannel) {
        try {
            sb.removeChannel(usersChannel);
        } catch (_) {}
        usersChannel = null;
    }
}

function teardownAllRealtime() {
    teardownDashboardChannels();
    teardownTabChannels();
}

function stopDashboardPolling() {
    if (dashboardInterval) {
        clearInterval(dashboardInterval);
        dashboardInterval = null;
    }
}

async function dataUrlToUint8Array(dataUrl) {
    const res = await fetch(dataUrl);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
}

function parseBytea(content) {
    if (!content) return new Uint8Array(0);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (typeof content === 'string') {
        if (content.startsWith('\\x')) {
            const hex = content.slice(2);
            const out = new Uint8Array(hex.length / 2);
            for (let i = 0; i < hex.length; i += 2) {
                out[i / 2] = parseInt(hex.substr(i, 2), 16);
            }
            return out;
        }
    }
    return new Uint8Array(0);
}

async function byteaToDataUrl(mime, content) {
    const u8 = parseBytea(content);
    const blob = new Blob([u8], { type: mime || 'application/octet-stream' });
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
    });
}

function showAlert(elementId, message, type) {
    const alertDiv = document.getElementById(elementId);
    if (!alertDiv) return;
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    setTimeout(() => {
        alertDiv.textContent = '';
        alertDiv.className = '';
    }, 5000);
}

sb.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
        currentUser = session.user;
        const { data: prof, error } = await sb
            .from('profiles')
            .select('company_id')
            .eq('id', session.user.id)
            .maybeSingle();
        if (error || !prof?.company_id) {
            console.error('لم يُعثر على ملف المستخدم:', error);
            await sb.auth.signOut();
            return;
        }
        companyId = prof.company_id;
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('registerScreen').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        loadUserData();
        loadDashboard();
    } else {
        currentUser = null;
        companyId = null;
        teardownAllRealtime();
        stopDashboardPolling();
        document.getElementById('loginScreen').style.display = 'block';
        document.getElementById('app').style.display = 'none';
    }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    try {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        showAlert('loginAlert', 'تم تسجيل الدخول بنجاح', 'success');
    } catch (error) {
        showAlert('loginAlert', 'خطأ في تسجيل الدخول: ' + error.message, 'error');
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    const fullName = document.getElementById('fullName').value;
    const companyName = document.getElementById('companyName').value;
    try {
        const { error } = await sb.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName,
                    company_name: companyName,
                    role: 'admin',
                },
            },
        });
        if (error) throw error;
        showAlert(
            'registerAlert',
            'تم إنشاء الحساب. إن وُجد تأكيد بريد، راجع صندوق الوارد ثم سجّل الدخول.',
            'success'
        );
        setTimeout(() => showLogin(), 2000);
    } catch (error) {
        showAlert('registerAlert', 'خطأ في إنشاء الحساب: ' + error.message, 'error');
    }
});

function logout() {
    sb.auth.signOut();
}

function showLogin() {
    document.getElementById('loginScreen').style.display = 'block';
    document.getElementById('registerScreen').style.display = 'none';
}

function showRegister() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('registerScreen').style.display = 'block';
}

async function loadUserData() {
    if (!currentUser) return;
    const { data } = await sb
        .from('profiles')
        .select('full_name')
        .eq('id', currentUser.id)
        .maybeSingle();
    document.getElementById('userName').textContent =
        data?.full_name || currentUser.email || '';
}

function switchTab(tabName, event) {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((content) => content.classList.remove('active'));

    if (event && event.target) {
        event.target.classList.add('active');
    } else {
        document.querySelectorAll('.tab').forEach((tab) => {
            if (
                tab.textContent.includes(
                    tabName === 'dashboard'
                        ? 'لوحة التحكم'
                        : tabName === 'sections'
                          ? 'الأقسام'
                          : tabName === 'cards'
                            ? 'بطاقات'
                            : tabName === 'users'
                              ? 'المستخدمون'
                              : 'الإعدادات'
                )
            ) {
                tab.classList.add('active');
            }
        });
    }
    document.getElementById(tabName).classList.add('active');

    if (tabName === 'sections') loadSections();
    if (tabName === 'cards') loadCards();
    if (tabName === 'users') loadUsers();
    if (tabName === 'settings') loadSettings();
}

async function refreshDashboardStats() {
    if (!companyId) return;
    const { count: secCount } = await sb
        .from('sections')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId);

    const { data: cardRows } = await sb
        .from('archive_cards')
        .select('status')
        .eq('company_id', companyId);

    let active = 0,
        archived = 0,
        deleted = 0;
    (cardRows || []).forEach((c) => {
        if (c.status === 'active') active++;
        else if (c.status === 'archived') archived++;
        else if (c.status === 'deleted') deleted++;
    });

    const { count: userCount } = await sb
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId);

    document.getElementById('totalSections').textContent = secCount ?? 0;
    document.getElementById('totalCards').textContent = cardRows?.length ?? 0;
    document.getElementById('totalUsers').textContent = userCount ?? 0;
    document.getElementById('activeCards').textContent = active;
    document.getElementById('archivedCards').textContent = archived;
    document.getElementById('deletedCards').textContent = deleted;
}

function loadDashboard() {
    teardownDashboardChannels();
    stopDashboardPolling();
    refreshDashboardStats();

    if (!companyId) return;

    const subscribe = (table) => {
        const ch = sb
            .channel(`dash-${table}-${companyId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table,
                    filter: `company_id=eq.${companyId}`,
                },
                () => refreshDashboardStats()
            )
            .subscribe();
        dashboardChannels.push(ch);
    };

    try {
        subscribe('sections');
        subscribe('archive_cards');
        const chUsers = sb
            .channel(`dash-prof-${companyId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'profiles',
                    filter: `company_id=eq.${companyId}`,
                },
                () => refreshDashboardStats()
            )
            .subscribe();
        dashboardChannels.push(chUsers);
    } catch (_) {}

    dashboardInterval = setInterval(refreshDashboardStats, 12000);
}

async function exportData() {
    if (!companyId) return;
    const exportPayload = {
        sections: [],
        cards: [],
        users: [],
        exportDate: new Date().toISOString(),
    };

    try {
        const [{ data: secData, error: e1 }, { data: cardData, error: e2 }, { data: userData, error: e3 }] =
            await Promise.all([
                sb.from('sections').select('*').eq('company_id', companyId).order('sort_order'),
                sb
                    .from('archive_cards')
                    .select(
                        '*, card_attachments ( id, file_name, mime_type, size_bytes, uploaded_at )'
                    )
                    .eq('company_id', companyId),
                sb.from('profiles').select('*').eq('company_id', companyId),
            ]);
        if (e1) throw e1;
        if (e2) throw e2;
        if (e3) throw e3;

        exportPayload.sections = (secData || []).map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            order: s.sort_order,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
        }));

        exportPayload.cards = (cardData || []).map((c) => ({
            id: c.id,
            title: c.title,
            sectionId: c.section_id,
            reference: c.reference,
            date: c.card_date,
            status: c.status,
            description: c.description,
            fileUrl: c.file_url,
            notes: c.notes,
            priority: c.priority,
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            attachedFilesMeta: c.card_attachments || [],
        }));

        exportPayload.users = userData || [];

        const dataStr = JSON.stringify(exportPayload, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `archive_export_${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        URL.revokeObjectURL(url);
        alert('تم تصدير البيانات بنجاح');
    } catch (error) {
        alert('خطأ في تصدير البيانات: ' + error.message);
    }
}

function mapSectionRow(s) {
    return {
        id: s.id,
        name: s.name,
        description: s.description,
        order: s.sort_order,
        created_at: s.created_at,
        updated_at: s.updated_at,
    };
}

function mapCardRow(c) {
    const att = c.card_attachments;
    const n = Array.isArray(att) ? att.length : 0;
    return {
        id: c.id,
        sectionId: c.section_id,
        title: c.title,
        reference: c.reference,
        date: c.card_date,
        status: c.status,
        description: c.description,
        fileUrl: c.file_url,
        notes: c.notes,
        priority: c.priority,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        attachmentCount: n,
        attachedFiles: null,
        attachedFilesLoaded: false,
    };
}

function loadSections() {
    if (!companyId) return;
    if (sectionChannel) {
        try {
            sb.removeChannel(sectionChannel);
        } catch (_) {}
        sectionChannel = null;
    }

    sectionChannel = sb
        .channel(`sections-live-${companyId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'sections',
                filter: `company_id=eq.${companyId}`,
            },
            () => fetchSectionsData()
        )
        .subscribe();

    fetchSectionsData();
}

async function fetchSectionsData() {
    if (!companyId) return;
    const { data, error } = await sb
        .from('sections')
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order', { ascending: true });
    if (error) {
        console.error(error);
        return;
    }
    sections = (data || []).map(mapSectionRow);
    updateSectionFilter();
    renderSections();
}

function renderSections(sectionsToRender = null) {
    const container = document.getElementById('sectionsTableContainer');
    const sectionsList = sectionsToRender || sections;

    if (sectionsList.length === 0) {
        container.innerHTML = '<div class="table-empty"><p>لا توجد أقسام</p></div>';
        return;
    }

    let tableHTML = `
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>اسم القسم</th>
                    <th>الوصف</th>
                    <th>الترتيب</th>
                    <th>الإجراءات</th>
                </tr>
            </thead>
            <tbody>
    `;

    sectionsList.forEach((section, index) => {
        tableHTML += `
            <tr>
                <td>${index + 1}</td>
                <td><strong>${section.name}</strong></td>
                <td>${section.description || 'لا يوجد وصف'}</td>
                <td>${section.order || 0}</td>
                <td>
                    <div class="table-actions">
                        <button onclick="editSection('${section.id}')" class="btn btn-secondary">
                            <i class="fas fa-edit"></i> تعديل
                        </button>
                        <button onclick="deleteSection('${section.id}')" class="btn btn-danger">
                            <i class="fas fa-trash"></i> حذف
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });

    tableHTML += `
            </tbody>
        </table>
    `;

    container.innerHTML = tableHTML;
}

function openSectionModal(id = null) {
    currentEditingId = id;
    document.getElementById('sectionModalTitle').textContent = id ? 'تعديل القسم' : 'إضافة قسم جديد';
    if (id) {
        const section = sections.find((s) => s.id === id);
        document.getElementById('sectionName').value = section.name || '';
        document.getElementById('sectionDescription').value = section.description || '';
        document.getElementById('sectionOrder').value = section.order || 0;
    } else {
        document.getElementById('sectionForm').reset();
    }
    document.getElementById('sectionModal').classList.add('active');
}

function closeSectionModal() {
    document.getElementById('sectionModal').classList.remove('active');
    currentEditingId = null;
}

document.getElementById('sectionModal').addEventListener('click', (e) => {
    if (e.target.id === 'sectionModal') closeSectionModal();
});

document.getElementById('sectionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!companyId) return;
    const row = {
        company_id: companyId,
        name: document.getElementById('sectionName').value,
        description: document.getElementById('sectionDescription').value,
        sort_order: parseInt(document.getElementById('sectionOrder').value, 10) || 0,
        updated_at: new Date().toISOString(),
    };

    try {
        if (currentEditingId) {
            await sb.from('sections').update(row).eq('id', currentEditingId).eq('company_id', companyId);
        } else {
            row.created_at = new Date().toISOString();
            await sb.from('sections').insert(row);
        }
        closeSectionModal();
        await fetchSectionsData();
        refreshDashboardStats();
    } catch (err) {
        alert('خطأ: ' + err.message);
    }
});

function editSection(id) {
    openSectionModal(id);
}

async function deleteSection(id) {
    if (!confirm('هل أنت متأكد من حذف هذا القسم؟')) return;
    if (!companyId) return;
    try {
        await sb.from('sections').delete().eq('id', id).eq('company_id', companyId);
        await fetchSectionsData();
        refreshDashboardStats();
    } catch (err) {
        alert('خطأ: ' + err.message);
    }
}

function filterSections() {
    const search = document.getElementById('sectionSearch').value.toLowerCase();
    const filtered = sections.filter(
        (s) =>
            s.name.toLowerCase().includes(search) ||
            (s.description && s.description.toLowerCase().includes(search))
    );
    renderSections(filtered);
}

function loadCards() {
    if (!companyId) return;
    if (sections.length === 0) {
        fetchSectionsData().then(() => loadCardsData());
    } else {
        updateSectionFilter();
        loadCardsData();
    }
}

function loadCardsData() {
    if (!companyId) return;
    if (cardsChannel) {
        try {
            sb.removeChannel(cardsChannel);
        } catch (_) {}
        cardsChannel = null;
    }

    cardsChannel = sb
        .channel(`cards-live-${companyId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'archive_cards',
                filter: `company_id=eq.${companyId}`,
            },
            () => fetchCardsData()
        )
        .subscribe();

    fetchCardsData();
}

async function fetchCardsData() {
    if (!companyId) return;
    const { data, error } = await sb
        .from('archive_cards')
        .select('*, card_attachments ( id )')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });
    if (error) {
        console.error(error);
        return;
    }
    cards = (data || []).map(mapCardRow);
    renderCards();
}

function updateSectionFilter() {
    const sectionFilter = document.getElementById('cardFilterSection');
    if (sectionFilter) {
        sectionFilter.innerHTML = '<option value="">جميع الأقسام</option>';
        sections.forEach((section) => {
            sectionFilter.innerHTML += `<option value="${section.id}">${section.name}</option>`;
        });
    }
}

function renderCards(cardsToRender = null) {
    const container = document.getElementById('cardsTableContainer');
    const cardsList = cardsToRender || cards;

    if (cardsList.length === 0) {
        container.innerHTML = '<div class="table-empty"><p>لا توجد بطاقات</p></div>';
        return;
    }

    let tableHTML = `
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>عنوان البطاقة</th>
                    <th>القسم</th>
                    <th>رقم المرجع</th>
                    <th>التاريخ</th>
                    <th>الحالة</th>
                    <th>الأولوية</th>
                    <th>الملفات</th>
                    <th>رابط الملف</th>
                    <th>الإجراءات</th>
                </tr>
            </thead>
            <tbody>
    `;

    cardsList.forEach((card, index) => {
        const section = sections.find((s) => s.id === card.sectionId);
        const statusBadge = {
            active: '<span class="badge badge-success">نشط</span>',
            archived: '<span class="badge badge-primary">مؤرشف</span>',
            deleted: '<span class="badge" style="background: #ffebee; color: #c62828;">محذوف</span>',
        }[card.status] || '<span class="badge">غير محدد</span>';

        const priorityBadge = {
            low: '<span class="badge" style="background: #e8f5e9; color: #2e7d32;">منخفضة</span>',
            medium: '<span class="badge" style="background: #fff3e0; color: #e65100;">متوسطة</span>',
            high: '<span class="badge" style="background: #ffe0b2; color: #e65100;">عالية</span>',
            urgent: '<span class="badge" style="background: #ffebee; color: #c62828;">عاجلة</span>',
        }[card.priority] || '<span class="badge">متوسطة</span>';

        const filesCount =
            card.attachmentCount != null
                ? card.attachmentCount
                : card.attachedFiles?.length || 0;
        const filesDisplay =
            filesCount > 0
                ? `<span class="badge badge-primary"><i class="fas fa-paperclip"></i> ${filesCount} ملف</span>`
                : '<span style="color: #999;">لا يوجد</span>';

        tableHTML += `
            <tr>
                <td>${index + 1}</td>
                <td>
                    <strong>${card.title || 'بدون عنوان'}</strong>
                    ${
                        card.description
                            ? `<br><small style="color: #666;">${
                                  card.description.length > 50
                                      ? card.description.substring(0, 50) + '...'
                                      : card.description
                              }</small>`
                            : ''
                    }
                </td>
                <td>${section ? section.name : 'غير محدد'}</td>
                <td>${card.reference || 'غير محدد'}</td>
                <td>${card.date || 'غير محدد'}</td>
                <td>${statusBadge}</td>
                <td>${priorityBadge}</td>
                <td>${filesDisplay}</td>
                <td style="max-width: 200px;">
                    ${
                        card.fileUrl
                            ? `
                        <a href="${card.fileUrl}" target="_blank" 
                           style="color: #2196F3; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border-radius: 4px; background: #e3f2fd; transition: all 0.3s;" 
                           title="${card.fileUrl}">
                            <i class="fas fa-external-link-alt"></i>
                            <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;">
                                ${
                                    card.fileUrl.length > 25
                                        ? card.fileUrl.substring(0, 25) + '...'
                                        : card.fileUrl
                                }
                            </span>
                        </a>
                    `
                            : '<span style="color: #999; font-size: 12px;"><i class="fas fa-minus"></i> لا يوجد</span>'
                    }
                </td>
                <td>
                    <div class="table-actions">
                        <button onclick="viewCardDetails('${card.id}')" class="btn btn-info" title="عرض التفاصيل">
                            <i class="fas fa-eye"></i> عرض
                        </button>
                        ${
                            filesCount > 0
                                ? `
                        <button onclick="viewAttachedFiles('${card.id}')" class="btn btn-warning" title="عرض المرفقات">
                            <i class="fas fa-paperclip"></i> المرفقات
                        </button>
                        `
                                : ''
                        }
                        <button onclick="editCard('${card.id}')" class="btn btn-secondary" title="تعديل">
                            <i class="fas fa-edit"></i> تعديل
                        </button>
                        <button onclick="attachFilesToCard('${card.id}')" class="btn btn-primary" title="إرفاق ملفات">
                            <i class="fas fa-plus"></i> إرفاق
                        </button>
                        <button onclick="deleteCard('${card.id}')" class="btn btn-danger" title="حذف">
                            <i class="fas fa-trash"></i> حذف
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });

    tableHTML += `
            </tbody>
        </table>
    `;

    container.innerHTML = tableHTML;
}

function attachFilesToCard(cardId) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) {
        alert('البطاقة غير موجودة');
        return;
    }
    openCardModal(cardId);
    setTimeout(() => {
        document.getElementById('cardFiles')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
}

async function loadAttachmentsForCard(card) {
    if (card.attachedFilesLoaded && card.attachedFiles) return card;
    const { data, error } = await sb.from('card_attachments').select('*').eq('card_id', card.id);
    if (error) {
        console.error(error);
        return card;
    }
    const files = await Promise.all(
        (data || []).map(async (a) => ({
            attachmentId: a.id,
            name: a.file_name,
            type: a.mime_type || '',
            size: a.size_bytes || 0,
            data: await byteaToDataUrl(a.mime_type, a.content),
            uploadedAt: a.uploaded_at,
        }))
    );
    card.attachedFiles = files;
    card.attachedFilesLoaded = true;
    card.attachmentCount = files.length;
    return card;
}

async function viewCardDetails(cardId) {
    let card = cards.find((c) => c.id === cardId);
    if (!card) {
        alert('البطاقة غير موجودة');
        return;
    }
    card = await loadAttachmentsForCard(card);

    const section = sections.find((s) => s.id === card.sectionId);
    const statusText = { active: 'نشط', archived: 'مؤرشف', deleted: 'محذوف' }[card.status] || 'غير محدد';
    const priorityText = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', urgent: 'عاجلة' }[card.priority] || 'متوسطة';

    let detailsHTML = `
        <div style="padding: 20px;">
            <h3 style="margin-bottom: 20px; color: #667eea;"><i class="fas fa-file-alt"></i> ${card.title || 'بدون عنوان'}</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px;">
                <div><strong>القسم:</strong> ${section ? section.name : 'غير محدد'}</div>
                <div><strong>رقم المرجع:</strong> ${card.reference || 'غير محدد'}</div>
                <div><strong>التاريخ:</strong> ${card.date || 'غير محدد'}</div>
                <div><strong>الحالة:</strong> ${statusText}</div>
                <div><strong>الأولوية:</strong> ${priorityText}</div>
            </div>
            ${card.description ? `<div style="margin-bottom: 15px;"><strong>الوصف:</strong><br>${escapeHtml(card.description)}</div>` : ''}
            ${card.notes ? `<div style="margin-bottom: 15px; padding: 10px; background: #f5f5f5; border-radius: 6px;"><strong>ملاحظات:</strong><br>${escapeHtml(card.notes)}</div>` : ''}
            ${card.fileUrl ? `<div style="margin-bottom: 15px;"><strong>رابط الملف:</strong> <a href="${card.fileUrl}" target="_blank" style="color: #2196F3;">${escapeHtml(card.fileUrl)}</a></div>` : ''}
    `;

    if (card.attachedFiles && card.attachedFiles.length > 0) {
        detailsHTML += `
            <div style="margin-top: 20px;">
                <strong><i class="fas fa-paperclip"></i> الملفات المرفقة (${card.attachedFiles.length}):</strong>
                <div style="margin-top: 15px; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px;">
        `;
        card.attachedFiles.forEach((file, index) => {
            const icon = getFileIcon(file.type);
            const size = formatFileSize(file.size);
            const uploadDate = file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString('ar-SA') : 'غير محدد';
            const fileType = file.type || '';
            const isImage = fileType.includes('image');
            const isText = fileType.includes('text') || fileType.includes('plain');
            const isPDF = fileType.includes('pdf');

            detailsHTML += `
                <div style="border: 2px solid #e0e0e0; border-radius: 8px; padding: 15px; background: #fafafa;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="${icon}" style="font-size: 32px; color: #667eea;"></i>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 600; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(file.name)}">
                                ${escapeHtml(file.name)}
                            </div>
                            <div style="font-size: 12px; color: #666; margin-top: 4px;">
                                ${size} • ${uploadDate}
                            </div>
                        </div>
                    </div>
                    ${isImage ? `<div style="margin-bottom: 10px; text-align: center;"><img src="${file.data}" alt="" style="max-width: 100%; max-height: 200px; border-radius: 6px;" /></div>` : ''}
                    ${isText ? `<div style="margin-bottom: 10px; max-height: 150px; overflow-y: auto; padding: 10px; background: white; border-radius: 4px;"><pre style="margin:0;font-size:11px;white-space:pre-wrap;">${getTextPreview(file.data)}</pre></div>` : ''}
                    ${isPDF ? `<div style="margin-bottom: 10px; text-align: center; padding: 15px;"><i class="fas fa-file-pdf" style="font-size: 48px; color: #f44336;"></i></div>` : ''}
                    <div style="display: flex; gap: 8px;">
                        <button onclick="previewFile('${card.id}', ${index})" class="btn btn-info" style="flex:1;padding:8px;font-size:12px;"><i class="fas fa-eye"></i> معاينة</button>
                        <button onclick="downloadFile('${card.id}', ${index}, event)" class="btn btn-primary" style="flex:1;padding:8px;font-size:12px;"><i class="fas fa-download"></i> تحميل</button>
                    </div>
                </div>
            `;
        });
        detailsHTML += `</div></div>`;
    }

    detailsHTML += `
            <div style="margin-top: 20px; text-align: center;">
                <button onclick="closeCardDetailsModal()" class="btn btn-secondary"><i class="fas fa-times"></i> إغلاق</button>
                <button onclick="editCard('${cardId}'); closeCardDetailsModal();" class="btn btn-primary" style="margin-right: 10px;"><i class="fas fa-edit"></i> تعديل</button>
            </div>
        </div>
    `;

    const modal = document.createElement('div');
    modal.id = 'cardDetailsModal';
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
            <div class="modal-header">
                <h2>تفاصيل البطاقة</h2>
                <button class="close-btn" onclick="closeCardDetailsModal()">&times;</button>
            </div>
            ${detailsHTML}
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target.id === 'cardDetailsModal') closeCardDetailsModal();
    });
}

function closeCardDetailsModal() {
    const modal = document.getElementById('cardDetailsModal');
    if (modal) modal.remove();
}

async function viewAttachedFiles(cardId) {
    let card = cards.find((c) => c.id === cardId);
    if (!card) {
        alert('البطاقة غير موجودة');
        return;
    }
    card = await loadAttachmentsForCard(card);
    if (!card.attachedFiles || card.attachedFiles.length === 0) {
        alert('لا توجد ملفات مرفقة');
        return;
    }

    let filesHTML = `<div style="padding: 20px;"><h3 style="margin-bottom: 20px; color: #ff9800;"><i class="fas fa-paperclip"></i> الملفات المرفقة (${card.attachedFiles.length})</h3>`;
    filesHTML += `<div style="margin-bottom: 15px;"><strong>عنوان البطاقة:</strong> ${escapeHtml(card.title || '')}</div>`;
    filesHTML += `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px;">`;

    card.attachedFiles.forEach((file, index) => {
        const icon = getFileIcon(file.type);
        const size = formatFileSize(file.size);
        filesHTML += `
            <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px;">
                <i class="${icon}"></i> <strong>${escapeHtml(file.name)}</strong>
                <div style="font-size: 12px; color: #666;">${size}</div>
                <button onclick="previewFile('${card.id}', ${index})" class="btn btn-info" style="margin-top:8px;width:100%;">معاينة</button>
                <button onclick="downloadFile('${card.id}', ${index}, event)" class="btn btn-primary" style="margin-top:6px;width:100%;">تحميل</button>
            </div>
        `;
    });
    filesHTML += '</div></div>';

    const modal = document.createElement('div');
    modal.id = 'attachedFilesModal';
    modal.className = 'modal active';
    modal.innerHTML = `<div class="modal-content" style="max-width: 900px;"><div class="modal-header"><h2>المرفقات</h2><button class="close-btn" onclick="document.getElementById('attachedFilesModal').remove()">&times;</button></div>${filesHTML}</div>`;
    document.body.appendChild(modal);
}

async function previewFile(cardId, fileIndex) {
    let card = cards.find((c) => c.id === cardId);
    if (!card) return;
    card = await loadAttachmentsForCard(card);
    const file = card.attachedFiles[fileIndex];
    if (!file) return;

    const fileType = file.type || '';
    const isImage = fileType.includes('image');
    const isPDF = fileType.includes('pdf');
    const isText = fileType.includes('text') || fileType.includes('plain');

    let previewContent = '';
    if (isImage) {
        previewContent = `<div style="text-align:center;"><img src="${file.data}" style="max-width:100%;max-height:70vh;" alt=""/></div>`;
    } else if (isPDF) {
        previewContent = `<iframe src="${file.data}" style="width:100%;height:70vh;border:none;"></iframe>`;
    } else if (isText) {
        previewContent = `<pre style="white-space:pre-wrap;padding:16px;max-height:70vh;overflow:auto;">${getTextPreview(file.data)}</pre>`;
    } else {
        previewContent = `<p style="padding:20px;">لا يمكن معاينة هذا النوع.</p>`;
    }

    const previewModal = document.createElement('div');
    previewModal.id = 'filePreviewModal';
    previewModal.className = 'modal active';
    previewModal.innerHTML = `
        <div class="modal-content" style="max-width: 90%; max-height: 90vh;">
            <div class="modal-header">
                <h2><i class="fas fa-eye"></i> ${escapeHtml(file.name)}</h2>
                <button class="close-btn" onclick="closeFilePreviewModal()">&times;</button>
            </div>
            ${previewContent}
            <div style="padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
                <button onclick="downloadFile('${cardId}', ${fileIndex}, event)" class="btn btn-primary"><i class="fas fa-download"></i> تحميل</button>
                <button onclick="closeFilePreviewModal()" class="btn btn-secondary" style="margin-right: 10px;"><i class="fas fa-times"></i> إغلاق</button>
            </div>
        </div>
    `;
    document.body.appendChild(previewModal);
    previewModal.addEventListener('click', (e) => {
        if (e.target.id === 'filePreviewModal') closeFilePreviewModal();
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function getTextPreview(fileData) {
    try {
        if (!fileData || !String(fileData).includes(',')) return 'لا يمكن قراءة محتوى الملف';
        const base64Data = String(fileData).split(',')[1];
        const textContent = atob(base64Data);
        return escapeHtml(textContent.length > 500 ? textContent.substring(0, 500) + '\n\n...' : textContent);
    } catch (e) {
        return 'لا يمكن قراءة محتوى الملف';
    }
}

function closeFilePreviewModal() {
    const modal = document.getElementById('filePreviewModal');
    if (modal) modal.remove();
}

async function openCardModal(id = null) {
    currentEditingId = id;
    uploadedFiles = [];
    document.getElementById('uploadedFilesList').innerHTML = '';
    document.getElementById('cardFiles').value = '';

    document.getElementById('cardModalTitle').textContent = id ? 'تعديل البطاقة' : 'إضافة بطاقة جديدة';

    if (sections.length === 0 && companyId) {
        const { data } = await sb.from('sections').select('*').eq('company_id', companyId).order('sort_order');
        sections = (data || []).map(mapSectionRow);
    }

    const sectionSelect = document.getElementById('cardSection');
    sectionSelect.innerHTML = '<option value="">اختر القسم</option>';
    sections.forEach((section) => {
        sectionSelect.innerHTML += `<option value="${section.id}">${section.name}</option>`;
    });

    if (id) {
        const card = cards.find((c) => c.id === id);
        if (card) {
            document.getElementById('cardTitle').value = card.title || '';
            document.getElementById('cardSection').value = card.sectionId || '';
            document.getElementById('cardReference').value = card.reference || '';
            document.getElementById('cardDate').value = card.date || '';
            document.getElementById('cardStatus').value = card.status || 'active';
            document.getElementById('cardDescription').value = card.description || '';
            document.getElementById('cardFileUrl').value = card.fileUrl || '';
            document.getElementById('cardNotes').value = card.notes || '';
            document.getElementById('cardPriority').value = card.priority || 'medium';
            const loaded = await loadAttachmentsForCard({ ...card, attachedFilesLoaded: false });
            uploadedFiles = (loaded.attachedFiles || []).map((f) => ({ ...f }));
            updateFilesList();
        }
    } else {
        document.getElementById('cardForm').reset();
        document.getElementById('cardPriority').value = 'medium';
    }

    document.getElementById('cardModal').classList.add('active');
}

function closeCardModal() {
    document.getElementById('cardModal').classList.remove('active');
    currentEditingId = null;
    uploadedFiles = [];
    document.getElementById('uploadedFilesList').innerHTML = '';
    document.getElementById('cardFiles').value = '';
}

document.getElementById('cardModal').addEventListener('click', (e) => {
    if (e.target.id === 'cardModal') closeCardModal();
});

document.getElementById('cardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!companyId) return;

    const row = {
        company_id: companyId,
        section_id: document.getElementById('cardSection').value || null,
        title: document.getElementById('cardTitle').value,
        reference: document.getElementById('cardReference').value || null,
        card_date: document.getElementById('cardDate').value || null,
        status: document.getElementById('cardStatus').value,
        description: document.getElementById('cardDescription').value || null,
        file_url: document.getElementById('cardFileUrl').value || null,
        notes: document.getElementById('cardNotes').value || null,
        priority: document.getElementById('cardPriority').value,
        updated_at: new Date().toISOString(),
    };

    try {
        if (currentEditingId) {
            await sb.from('archive_cards').update(row).eq('id', currentEditingId).eq('company_id', companyId);

            const keptIds = uploadedFiles.filter((f) => f.attachmentId).map((f) => f.attachmentId);
            const { data: oldAtt } = await sb.from('card_attachments').select('id').eq('card_id', currentEditingId);
            const toDelete = (oldAtt || []).map((a) => a.id).filter((aid) => !keptIds.includes(aid));
            if (toDelete.length) {
                await sb.from('card_attachments').delete().in('id', toDelete);
            }
            for (const f of uploadedFiles) {
                if (!f.attachmentId && f.data) {
                    const bin = await dataUrlToUint8Array(f.data);
                    await sb.from('card_attachments').insert({
                        card_id: currentEditingId,
                        file_name: f.name,
                        mime_type: f.type || null,
                        size_bytes: f.size || bin.length,
                        content: bin,
                    });
                }
            }
        } else {
            row.created_at = new Date().toISOString();
            const { data: ins, error } = await sb.from('archive_cards').insert(row).select('id').single();
            if (error) throw error;
            const newId = ins.id;
            for (const f of uploadedFiles) {
                if (f.data) {
                    const bin = await dataUrlToUint8Array(f.data);
                    await sb.from('card_attachments').insert({
                        card_id: newId,
                        file_name: f.name,
                        mime_type: f.type || null,
                        size_bytes: f.size || bin.length,
                        content: bin,
                    });
                }
            }
        }
        closeCardModal();
        await fetchCardsData();
        refreshDashboardStats();
    } catch (err) {
        alert('خطأ في حفظ البطاقة: ' + err.message);
    }
});

function editCard(id) {
    openCardModal(id);
}

async function deleteCard(id) {
    if (!confirm('هل أنت متأكد من حذف هذه البطاقة؟')) return;
    if (!companyId) return;
    try {
        await sb.from('archive_cards').delete().eq('id', id).eq('company_id', companyId);
        await fetchCardsData();
        refreshDashboardStats();
    } catch (err) {
        alert('خطأ: ' + err.message);
    }
}

function filterCards() {
    const search = document.getElementById('cardSearch').value.toLowerCase();
    const statusFilter = document.getElementById('cardFilterStatus')?.value || '';
    const sectionFilter = document.getElementById('cardFilterSection')?.value || '';

    let filtered = cards.filter((c) => {
        const matchesSearch =
            !search ||
            (c.title && c.title.toLowerCase().includes(search)) ||
            (c.reference && c.reference.toLowerCase().includes(search)) ||
            (c.description && c.description.toLowerCase().includes(search)) ||
            (c.notes && c.notes.toLowerCase().includes(search));
        const matchesStatus = !statusFilter || c.status === statusFilter;
        const matchesSection = !sectionFilter || c.sectionId === sectionFilter;
        return matchesSearch && matchesStatus && matchesSection;
    });

    renderCards(filtered);
}

function loadUsers() {
    if (!companyId) return;
    if (usersChannel) {
        try {
            sb.removeChannel(usersChannel);
        } catch (_) {}
        usersChannel = null;
    }

    usersChannel = sb
        .channel(`profiles-live-${companyId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'profiles',
                filter: `company_id=eq.${companyId}`,
            },
            () => fetchUsersData()
        )
        .subscribe();
    fetchUsersData();
}

async function fetchUsersData() {
    if (!companyId) return;
    const { data, error } = await sb
        .from('profiles')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });
    if (error) {
        console.error(error);
        return;
    }
    users = (data || [])
        .filter((p) => p.id !== currentUser?.id)
        .map((p) => ({
            id: p.id,
            fullName: p.full_name,
            email: p.email,
            role: p.role,
            phone: p.phone,
        }));
    renderUsers();
}

function renderUsers(usersToRender = null) {
    const grid = document.getElementById('usersGrid');
    const usersList = usersToRender || users;

    if (usersList.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>لا يوجد مستخدمون آخرون</p></div>';
        return;
    }

    grid.innerHTML = usersList
        .map((user) => {
            const roleBadge = {
                admin: '<span class="badge badge-primary">مدير</span>',
                user: '<span class="badge badge-success">مستخدم</span>',
                viewer: '<span class="badge" style="background: #fff3e0; color: #e65100;">مشاهد</span>',
            }[user.role] || '';

            return `
            <div class="card">
                <div class="card-header">
                    <div>
                        <div class="card-title">${escapeHtml(user.fullName || 'غير محدد')}</div>
                        <div class="card-info">${escapeHtml(user.email || '')}</div>
                        <div class="card-info">${escapeHtml(user.phone || 'لا يوجد رقم هاتف')}</div>
                        ${roleBadge}
                    </div>
                </div>
                <div class="card-actions">
                    <button onclick="editUser('${user.id}')" class="btn btn-secondary"><i class="fas fa-edit"></i> تعديل</button>
                    <button onclick="deleteUser('${user.id}')" class="btn btn-danger"><i class="fas fa-trash"></i> حذف</button>
                </div>
            </div>
        `;
        })
        .join('');
}

function openUserModal(id = null) {
    currentEditingId = id;
    document.getElementById('userModalTitle').textContent = id ? 'تعديل المستخدم' : 'إضافة مستخدم جديد';
    if (id) {
        const user = users.find((u) => u.id === id);
        document.getElementById('userFullName').value = user.fullName || '';
        document.getElementById('userEmail').value = user.email || '';
        document.getElementById('userRole').value = user.role || 'user';
        document.getElementById('userPhone').value = user.phone || '';
    } else {
        document.getElementById('userForm').reset();
    }
    document.getElementById('userModal').classList.add('active');
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('active');
    currentEditingId = null;
}

document.getElementById('userModal').addEventListener('click', (e) => {
    if (e.target.id === 'userModal') closeUserModal();
});

document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!companyId) return;

    const fullName = document.getElementById('userFullName').value;
    const email = document.getElementById('userEmail').value;
    const password = document.getElementById('userPassword').value;
    const role = document.getElementById('userRole').value;
    const phone = document.getElementById('userPhone').value;

    try {
        if (currentEditingId) {
            const { error } = await sb
                .from('profiles')
                .update({
                    full_name: fullName,
                    email,
                    role,
                    phone: phone || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', currentEditingId)
                .eq('company_id', companyId);
            if (error) throw error;
            if (password) {
                alert('تغيير كلمة المرور للمستخدم يتم من لوحة Supabase أو عبر رابط استعادة كلمة المرور.');
            }
        } else {
            if (!password) {
                alert('يجب إدخال كلمة مرور للمستخدم الجديد');
                return;
            }
            const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                    email,
                    password,
                    data: {
                        full_name: fullName,
                        join_company: true,
                        company_id: companyId,
                        role,
                        phone,
                    },
                }),
            });
            const json = await res.json();
            if (!res.ok) {
                throw new Error(json.error_description || json.msg || json.message || 'فشل إنشاء المستخدم');
            }
        }
        closeUserModal();
        await fetchUsersData();
        refreshDashboardStats();
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
});

function editUser(id) {
    openUserModal(id);
}

async function deleteUser(id) {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم من الفريق؟ (حساب الدخول قد يبقى في المصادقة)')) return;
    if (!companyId) return;
    try {
        const { error } = await sb.from('profiles').delete().eq('id', id).eq('company_id', companyId);
        if (error) throw error;
        await fetchUsersData();
        refreshDashboardStats();
    } catch (err) {
        alert('خطأ: ' + err.message);
    }
}

function filterUsers() {
    const search = document.getElementById('userSearch').value.toLowerCase();
    const filtered = users.filter(
        (u) =>
            (u.fullName && u.fullName.toLowerCase().includes(search)) ||
            (u.email && u.email.toLowerCase().includes(search)) ||
            (u.phone && u.phone.includes(search))
    );
    renderUsers(filtered);
}

async function loadSettings() {
    if (!companyId) return;
    const { data } = await sb.from('companies').select('*').eq('id', companyId).maybeSingle();
    if (data) {
        document.getElementById('settingsCompanyName').value = data.name || '';
        document.getElementById('settingsPhone').value = data.phone || '';
        document.getElementById('settingsEmail').value = data.email || '';
        document.getElementById('settingsAddress').value = data.address || '';
        document.getElementById('settingsNotes').value = data.notes || '';
    }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!companyId) return;
    try {
        const { error } = await sb
            .from('companies')
            .update({
                name: document.getElementById('settingsCompanyName').value,
                phone: document.getElementById('settingsPhone').value || null,
                email: document.getElementById('settingsEmail').value || null,
                address: document.getElementById('settingsAddress').value || null,
                notes: document.getElementById('settingsNotes').value || null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', companyId);
        if (error) throw error;
        alert('تم حفظ الإعدادات بنجاح');
    } catch (err) {
        alert('خطأ: ' + err.message);
    }
});

function handleFileUpload(event) {
    const files = event.target.files;
    const filesList = document.getElementById('uploadedFilesList');
    filesList.innerHTML = '';

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > 5 * 1024 * 1024) {
            alert(`الملف ${file.name} كبير جداً. الحد الأقصى 5MB`);
            continue;
        }
        const reader = new FileReader();
        reader.onload = function (ev) {
            const fileData = {
                name: file.name,
                type: file.type,
                size: file.size,
                data: ev.target.result,
                uploadedAt: new Date().toISOString(),
            };
            uploadedFiles.push(fileData);
            displayUploadedFile(fileData, uploadedFiles.length - 1);
        };
        reader.readAsDataURL(file);
    }
}

function displayUploadedFile(fileData, index) {
    const filesList = document.getElementById('uploadedFilesList');
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.id = `file-${index}`;
    const icon = getFileIcon(fileData.type);
    const size = formatFileSize(fileData.size);
    fileItem.innerHTML = `
        <i class="${icon}"></i>
        <div class="file-item-info">
            <div class="file-item-name">${escapeHtml(fileData.name)}</div>
            <div class="file-item-size">${size}</div>
        </div>
        <button type="button" class="file-item-remove" onclick="removeFile(${index})">
            <i class="fas fa-times"></i>
        </button>
    `;
    filesList.appendChild(fileItem);
}

function removeFile(index) {
    uploadedFiles.splice(index, 1);
    updateFilesList();
}

function updateFilesList() {
    const filesList = document.getElementById('uploadedFilesList');
    filesList.innerHTML = '';
    uploadedFiles.forEach((file, index) => {
        displayUploadedFile(file, index);
    });
}

function getFileIcon(fileType) {
    const t = fileType || '';
    if (t.includes('pdf')) return 'fas fa-file-pdf';
    if (t.includes('word') || t.includes('document')) return 'fas fa-file-word';
    if (t.includes('excel') || t.includes('spreadsheet')) return 'fas fa-file-excel';
    if (t.includes('image')) return 'fas fa-file-image';
    if (t.includes('text')) return 'fas fa-file-alt';
    return 'fas fa-file';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function downloadFile(cardId, fileIndex, event) {
    if (event) event.preventDefault();
    const card = cards.find((c) => c.id === cardId);
    if (!card || !card.attachedFiles || !card.attachedFiles[fileIndex]) {
        alert('الملف غير موجود');
        return;
    }
    const file = card.attachedFiles[fileIndex];
    const link = document.createElement('a');
    link.href = file.data;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('sectionModal').classList.contains('active')) closeSectionModal();
        else if (document.getElementById('cardModal').classList.contains('active')) closeCardModal();
        else if (document.getElementById('userModal').classList.contains('active')) closeUserModal();
    }
});
