/**
 * نظام الأرشيف — Supabase (Postgres + Auth)
 * الملفات في جدول card_attachments (bytea) — بدون Supabase Storage
 *
 * الإعداد: ملف config.js (من config.example.js) يعرّف window.ARCHIVE_SUPABASE
 * في المتصفح لا يوجد process.env — إما هذا الملف أو أداة بناء (Vite) لحقن المتغيرات.
 *
 * أنشئ الجداول بتشغيل الهجرة في supabase/migrations أو من SQL Editor.
 *
 * الأولوية: window.ARCHIVE_SUPABASE من config.js ثم وسوم meta في index.html
 * (مناسب لـ GitHub Pages حيث قد لا يُرفع config.js).
 */

function readArchiveMeta(name) {
    if (typeof document === 'undefined') return '';
    const el = document.querySelector(`meta[name="${name}"]`);
    const v = el && el.getAttribute('content');
    return v && String(v).trim() ? String(v).trim() : '';
}

const CFG =
    typeof window !== 'undefined' && window.ARCHIVE_SUPABASE ? window.ARCHIVE_SUPABASE : {};
const SUPABASE_URL = CFG.url || readArchiveMeta('archive-supabase-url');
const SUPABASE_ANON_KEY = CFG.anonKey || readArchiveMeta('archive-supabase-anon-key');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(
        '[الأرشيف] أضف meta archive-supabase-url و archive-supabase-anon-key أو ملف config.js'
    );
}

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

document.addEventListener('DOMContentLoaded', function () {
    checkRegistrationOpen();
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        var m = document.createElement('div');
        m.setAttribute('dir', 'rtl');
        m.style.cssText =
            'background:#fff3e0;border-bottom:2px solid #ff9800;color:#e65100;padding:14px 20px;font-size:14px;text-align:center;line-height:1.6;';
        m.innerHTML =
            '<strong>إعداد Supabase ناقص:</strong> أضف وسوم meta في <code>index.html</code> أو ملف <code>config.js</code> — راجع لوحة المشروع → Settings → API.';
        document.body.insertBefore(m, document.body.firstChild);
    }
});

let currentUser = null;
/** ملف المستخدم الحالي من profiles */
let currentProfile = null;
let registrationOpen = false;
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
let loginSubmitting = false;
/** يمنع أن محاولة دخول قديمة (INITIAL_SESSION) تُخرجك بعد نجاح محاولة أحدث */
let sessionEnterGeneration = 0;
let pendingSessionUserId = null;
/** آخر تقرير تشخيص — للنسخ من واجهة الدخول */
let lastLoginDiagnostic = null;

// #region agent log
const AGENT_DEBUG_SESSION =
    typeof location !== 'undefined' &&
    /(?:\?|&)(?:agent_debug=1|debug=1)(?:&|$)/.test(location.search || '');

let agentRunId = /(?:\?|&)agent_run=post-fix(?:&|$)/.test(
    typeof location !== 'undefined' ? location.search || '' : ''
)
    ? 'post-fix'
    : 'pre-fix';

function agentLog(hypothesisId, location, message, data) {
    if (!AGENT_DEBUG_SESSION) return;
    const payload = {
        sessionId: '914ae3',
        hypothesisId,
        location,
        message,
        data: data || {},
        timestamp: Date.now(),
        runId: agentRunId,
    };
    try {
        const key = 'debug_914ae3';
        const arr = JSON.parse(sessionStorage.getItem(key) || '[]');
        arr.push(payload);
        if (arr.length > 80) arr.splice(0, arr.length - 80);
        sessionStorage.setItem(key, JSON.stringify(arr));
    } catch (_) {}
    fetch('http://127.0.0.1:7942/ingest/dba8d5d2-ad16-4f61-8c5a-656cf263c58b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '914ae3' },
        body: JSON.stringify(payload),
    }).catch(() => {});
    console.info('[agent-debug]', hypothesisId, message, data || '');
}

/** ربط JWT بالعميل قبل استعلام profiles (يتجنب فشل القراءة بعد signIn مباشرة) */
async function syncSessionOnClient(session) {
    if (!session?.access_token) {
        agentLog('B', 'archive-app.js:syncSessionOnClient', 'no access_token', {});
        return false;
    }
    const { error } = await sb.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
    });
    if (error) {
        agentLog('B', 'archive-app.js:syncSessionOnClient', 'setSession failed', {
            msg: String(error.message || error).slice(0, 120),
        });
        return false;
    }
    const {
        data: { session: active },
    } = await sb.auth.getSession();
    const ok = !!(active?.user && active.access_token);
    agentLog('B', 'archive-app.js:syncSessionOnClient', 'getSession', {
        ok,
        uid: active?.user?.id || null,
    });
    return ok;
}
// #endregion

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

function showToast(message, type, durationMs) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = message;
    container.appendChild(t);
    const ms = durationMs !== undefined ? durationMs : 4000;
    if (ms <= 0) return;
    setTimeout(() => {
        t.classList.add('toast-out');
        setTimeout(() => t.remove(), 300);
    }, ms);
}

function updateOrgBranding(name) {
    const label = name && String(name).trim() ? String(name).trim() : 'نظام الأرشيف الإلكتروني';
    document.querySelectorAll('[data-org-name]').forEach((el) => {
        el.textContent = label;
    });
    document.title = label;
}

async function fetchOrgBranding() {
    try {
        const { data } = await sb.from('app_settings').select('name').eq('id', 1).maybeSingle();
        if (data?.name) updateOrgBranding(data.name);
    } catch (_) {}
}

function toggleSidebar() {
    document.getElementById('app')?.classList.toggle('sidebar-open');
}

function closeSidebar() {
    document.getElementById('app')?.classList.remove('sidebar-open');
}

const PAGE_TITLES = {
    dashboard: 'لوحة التحكم',
    sections: 'الأقسام',
    cards: 'بطاقات الأرشيف',
    users: 'المستخدمون',
    settings: 'الإعدادات',
};

function showAlert(elementId, message, type, durationMs) {
    const alertDiv = document.getElementById(elementId);
    if (!alertDiv) return;
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    const ms = durationMs !== undefined ? durationMs : 8000;
    if (ms <= 0) return;
    setTimeout(() => {
        alertDiv.textContent = '';
        alertDiv.className = '';
    }, ms);
}

/** ترجمة أخطاء المصادقة الشائعة + إظهار التفاصيل في وحدة التحكم */
function formatAuthError(error, context) {
    if (context) console.warn('[auth]', context, error);
    const msg = (error && error.message) || String(error);
    const lower = msg.toLowerCase();
    if (lower.includes('invalid login') || lower.includes('invalid credentials')) {
        return 'البريد أو كلمة المرور غير صحيحة.';
    }
    if (lower.includes('email not confirmed') || msg.includes('confirm')) {
        return 'يجب تأكيد البريد أولاً — راجع صندوق الوارد أو عطّل «Confirm email» من لوحة Supabase للتجربة.';
    }
    if (lower.includes('signup') && lower.includes('disabled')) {
        return 'تسجيل الدخول بالبريد معطّل في المشروع: Authentication → Providers → Email.';
    }
    if (lower.includes('public_registration_closed')) {
        return 'التسجيل العام مغلق. اطلب من المدير إنشاء حساب لك.';
    }
    if (lower.includes('user already registered') || lower.includes('already been registered')) {
        return 'هذا البريد مسجّل مسبقاً.';
    }
    return msg + (error && error.status ? ` (رمز HTTP: ${error.status})` : '');
}

function formatUserMgmtError(err) {
    const msg = (err && err.message) || String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('public_registration_closed')) {
        return 'لا يمكن إنشاء المستخدم: التسجيل مغلق ولم يُرسل طلب دعوة من المدير.';
    }
    if (lower.includes('duplicate') || lower.includes('already')) {
        return 'البريد الإلكتروني مستخدم مسبقاً.';
    }
    return formatAuthError(err, 'userMgmt');
}

const VALID_ROLES = ['admin', 'user', 'viewer'];

function normalizeRole(role) {
    const r = String(role || 'user')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');
    if (r === 'super_admin' || r === 'سوبر_أدمن') return 'admin';
    return VALID_ROLES.includes(r) ? r : 'user';
}

/** إنشاء مستخدم من المدير عبر REST دون تبديل جلسة المدير الحالية */
async function inviteUserByAdmin({ email, password, fullName, role, phone }) {
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
                invited_by_admin: 'true',
                role: normalizeRole(role),
                phone: phone || '',
            },
        }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const errMsg =
            json.error_description ||
            json.msg ||
            json.message ||
            json.error ||
            'فشل إنشاء المستخدم';
        throw new Error(errMsg);
    }
    return json;
}

function userRole() {
    return normalizeRole(currentProfile && currentProfile.role);
}

function isAdmin() {
    return userRole() === 'admin';
}

function canWriteArchive() {
    const r = userRole();
    return r === 'admin' || r === 'user';
}

function roleLabel(role) {
    const labels = { admin: 'مدير', user: 'مستخدم', viewer: 'مشاهد' };
    return labels[role] || role;
}

function applyRoleUI() {
    const write = canWriteArchive();
    const admin = isAdmin();

    document.querySelectorAll('[data-requires-write]').forEach((el) => {
        el.style.display = write ? '' : 'none';
    });
    document.querySelectorAll('[data-requires-admin]').forEach((el) => {
        el.style.display = admin ? '' : 'none';
    });

    const usersNav = document.querySelector('.nav-item[data-tab="users"]');
    if (usersNav) usersNav.style.display = admin ? '' : 'none';

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.querySelectorAll('input, textarea, button').forEach((el) => {
            el.disabled = !admin;
        });
    }
}

async function checkRegistrationOpen() {
    const { data, error } = await sb.rpc('registration_open');
    if (error) {
        console.warn('[registration_open]', error);
        registrationOpen = false;
    } else {
        registrationOpen = data === true;
    }
    const registerBtn = document.getElementById('registerLinkBtn');
    if (registerBtn) registerBtn.style.display = registrationOpen ? '' : 'none';
}

/** جلب ملف المستخدم: استعلام جدول ثم دالة RPC إذا فشل الـ RLS */
async function fetchMyProfileForLogin(userId) {
    const fromTable = await sb
        .from('profiles')
        .select('full_name, role, phone, email')
        .eq('id', userId)
        .maybeSingle();

    if (!fromTable.error && fromTable.data) {
        return { prof: fromTable.data, error: null, via: 'table' };
    }

    const tableErr = fromTable.error;
    const rpcRes = await sb.rpc('get_my_profile');

    if (rpcRes.error) {
        console.warn('[profiles] فشل الجدول ثم فشل get_my_profile:', tableErr, rpcRes.error);
        return { prof: null, error: tableErr || rpcRes.error, via: null };
    }

    let row = rpcRes.data;
    if (Array.isArray(row)) row = row.length ? row[0] : null;
    if (row && typeof row === 'object') {
        return {
            prof: {
                full_name: row.full_name,
                role: row.role,
                phone: row.phone,
                email: row.email,
            },
            error: null,
            via: 'rpc',
        };
    }

    return { prof: null, error: tableErr, via: null };
}

function isLikelyTransientProfileError(error) {
    if (!error) return true;
    const blob = ((error.message || '') + ' ' + (error.code || '') + ' ' + (error.details || '')).toLowerCase();
    return /permission|jwt|pgrst|42501|network|fetch|timeout|502|503|504|failed|abort|load/.test(blob);
}

function profileRetryDelayMs(attemptIndex) {
    return Math.min(3200, 250 + attemptIndex * 220);
}

/** إعادة المحاولة — JWT قد لا يكون جاهزاً فور signIn أو عند INITIAL_SESSION */
async function fetchMyProfileForLoginWithRetry(userId, session, attempts) {
    const max = attempts !== undefined ? attempts : 10;
    let last = { prof: null, error: null, via: null };
    for (let i = 0; i < max; i++) {
        if (i > 0) {
            await new Promise((r) => setTimeout(r, profileRetryDelayMs(i)));
        }
        if (session) {
            await syncSessionOnClient(session);
        }
        last = await fetchMyProfileForLogin(userId);
        // #region agent log
        agentLog('B', 'archive-app.js:fetchMyProfileForLoginWithRetry', 'profile attempt', {
            attempt: i + 1,
            hasProf: !!last.prof,
            via: last.via,
            errCode: last.error?.code,
            errMsg: last.error?.message ? String(last.error.message).slice(0, 120) : null,
        });
        // #endregion
        if (last.prof) return last;
        loginDebugLog('profile-retry', { attempt: i + 1, error: last.error });
        if (!isLikelyTransientProfileError(last.error) && i >= 2) break;
    }
    return last;
}

function buildLoginDiagnostic(session, result, extra) {
    const uid = session?.user?.id || null;
    const email = session?.user?.email || null;
    return {
        time: new Date().toISOString(),
        authUserId: uid,
        email,
        profileLoaded: !!result?.prof,
        via: result?.via || null,
        error: result?.error
            ? {
                  message: result.error.message || String(result.error),
                  code: result.error.code || null,
                  details: result.error.details || null,
              }
            : result?.prof
              ? null
              : { message: 'لا يوجد صف في profiles لهذا المعرف (أو لم يُقرأ بعد)' },
        supabaseUrl: SUPABASE_URL || '(غير مضبوط)',
        hint:
            'قارن authUserId مع profiles.id في Supabase → SQL: supabase/sql/diagnose_login.sql',
        ...extra,
    };
}

function logLoginDiagnostic(session, result, extra) {
    const report = buildLoginDiagnostic(session, result, extra);
    lastLoginDiagnostic = report;
    console.error('[إصلاح الدخول] معرف حساب المصادقة:', report.authUserId, '| البريد:', report.email);
    console.error('[إصلاح الدخول] التفاصيل الكاملة:', report);
    updateLoginDiagnosticUI(true);
    return report;
}

function updateLoginDiagnosticUI(show) {
    const hint = document.getElementById('loginDiagnosticsHint');
    const btn = document.getElementById('loginCopyDiagnosticBtn');
    if (hint) hint.style.display = show ? 'block' : 'none';
    if (btn) btn.style.display = show ? 'inline-flex' : 'none';
}

async function copyLoginDiagnostic() {
    if (!lastLoginDiagnostic) {
        showToast('لا يوجد تقرير بعد — جرّب تسجيل الدخول مرة أخرى', 'info');
        return;
    }
    const text = JSON.stringify(lastLoginDiagnostic, null, 2);
    try {
        await navigator.clipboard.writeText(text);
        showToast('تم نسخ تقرير التشخيص', 'success');
    } catch (_) {
        prompt('انسخ التقرير:', text);
    }
}

/** وعد واحد — يمنع تضارب نموذج الدخول مع onAuthStateChange */
let pendingSessionEnter = null;

function showLoginScreen() {
    const authWrap = document.getElementById('authWrapper');
    const loginScreen = document.getElementById('loginScreen');
    const registerScreen = document.getElementById('registerScreen');
    const appEl = document.getElementById('app');
    if (authWrap) authWrap.style.display = '';
    if (loginScreen) loginScreen.style.display = 'block';
    if (registerScreen) registerScreen.style.display = 'none';
    if (appEl) appEl.style.display = 'none';
}

function showMainApp(session, prof, via) {
    // #region agent log
    agentLog('C', 'archive-app.js:showMainApp', 'enter', {
        via,
        role: prof?.role,
        hasAuthWrap: !!document.getElementById('authWrapper'),
        hasApp: !!document.getElementById('app'),
    });
    // #endregion
    const normRole = normalizeRole(prof.role);
    currentProfile = { ...prof, role: normRole };
    currentUser = session.user;
    const name = prof.full_name || session.user.email || '';
    const nameEl = document.getElementById('userName');
    if (nameEl) nameEl.textContent = name + ' — ' + roleLabel(normRole);

    applyRoleUI();

    const authWrap = document.getElementById('authWrapper');
    const appEl = document.getElementById('app');
    if (authWrap) authWrap.style.display = 'none';
    if (appEl) appEl.style.display = 'flex';

    const loginAlert = document.getElementById('loginAlert');
    if (loginAlert) {
        loginAlert.textContent = '';
        loginAlert.className = '';
    }

    if (via === 'rpc') {
        console.info('[profiles] تم تحميل الملف عبر get_my_profile (RPC)');
    }

    fetchOrgBranding();
    loadDashboard();
    // #region agent log
    agentLog('C', 'archive-app.js:showMainApp', 'after display', {
        authDisplay: document.getElementById('authWrapper')?.style?.display,
        appDisplay: document.getElementById('app')?.style?.display,
    });
    // #endregion
}

/**
 * @returns {Promise<boolean>} true إذا فُتح التطبيق
 */
function isStaleSessionEnter(generation) {
    return generation !== sessionEnterGeneration;
}

async function handleAuthenticatedSession(session) {
    if (!session?.user) return false;

    const uid = session.user.id;
    const generation = ++sessionEnterGeneration;
    // #region agent log
    agentLog('D', 'archive-app.js:handleAuthenticatedSession', 'enter', {
        uid,
        generation,
        hasPending: !!pendingSessionEnter,
        hasCurrentProfile: !!currentProfile,
        loginSubmitting,
    });
    // #endregion
    if (currentProfile && currentUser?.id === uid) {
        updateLoginDiagnosticUI(false);
        showMainApp(session, currentProfile, 'cache');
        return true;
    }

    if (pendingSessionEnter && pendingSessionUserId === uid) {
        // #region agent log
        agentLog('D', 'archive-app.js:handleAuthenticatedSession', 'await pending', { uid });
        // #endregion
        return pendingSessionEnter;
    }

    pendingSessionUserId = uid;
    pendingSessionEnter = (async () => {
        try {
            loginDebugLog('session', { id: uid, email: session.user.email, generation });

            const sessionReady = await syncSessionOnClient(session);
            if (isStaleSessionEnter(generation)) return false;
            if (!sessionReady) {
                logLoginDiagnostic(session, { prof: null, error: { message: 'setSession/getSession failed' } }, {
                    step: 'syncSessionOnClient',
                });
                showLoginScreen();
                showAlert(
                    'loginAlert',
                    'تعذّر تفعيل الجلسة على المتصفح. حدّث الصفحة (Ctrl+Shift+R) وحاول مرة أخرى.',
                    'error',
                    60000
                );
                if (!isStaleSessionEnter(generation)) await sb.auth.signOut();
                return false;
            }

            const loginAlert = document.getElementById('loginAlert');
            if (loginAlert && loginSubmitting) {
                loginAlert.textContent = 'جاري تحميل ملف المستخدم…';
                loginAlert.className = 'alert alert-success';
            }

            const result = await fetchMyProfileForLoginWithRetry(uid, session);
            const { prof, error, via } = result;

            if (isStaleSessionEnter(generation)) return false;

            if (!prof) {
                loginDebugLog('profile-failed', { error, via });
                logLoginDiagnostic(session, result, { step: 'fetchMyProfile', attempts: 10 });
                // #region agent log
                agentLog('B', 'archive-app.js:handleAuthenticatedSession', 'profile missing', {
                    via,
                    errCode: error?.code,
                    errMsg: error?.message ? String(error.message).slice(0, 120) : null,
                });
                // #endregion
                showLoginScreen();
                showAlert('loginAlert', formatProfileLoadError(error, session), 'error', 90000);
                if (!isStaleSessionEnter(generation)) await sb.auth.signOut();
                return false;
            }

            updateLoginDiagnosticUI(false);
            lastLoginDiagnostic = null;
            showMainApp(session, prof, via);
            // #region agent log
            agentLog('D', 'archive-app.js:handleAuthenticatedSession', 'success', { via, role: prof.role });
            // #endregion
            return true;
        } catch (err) {
            if (!isStaleSessionEnter(generation)) {
                logLoginDiagnostic(session, { prof: null, error: err }, { step: 'exception' });
                console.error('[login] خطأ غير متوقع:', err);
                showLoginScreen();
                showAlert(
                    'loginAlert',
                    'خطأ أثناء فتح التطبيق: ' + ((err && err.message) || String(err)),
                    'error',
                    60000
                );
                try {
                    await sb.auth.signOut();
                } catch (_) {}
            }
            return false;
        } finally {
            if (pendingSessionUserId === uid) {
                pendingSessionEnter = null;
                pendingSessionUserId = null;
            }
        }
    })();

    return pendingSessionEnter;
}

/** رسالة واضحة عند فشل قراءة profiles بعد نجاح Auth */
function formatProfileLoadError(error, session) {
    const uid = session?.user?.id || '(غير معروف)';
    const email = session?.user?.email || '';
    if (!error) {
        return (
            'تم التحقق من كلمة المرور، لكن لا يوجد صف في جدول profiles يطابق حسابك.\n' +
            'المعرف المطلوب في profiles.id: ' +
            uid +
            '\nالبريد: ' +
            email +
            '\n\nشغّل في SQL Editor: supabase/sql/repair_login_profile.sql (بعد تعديل البريد).'
        );
    }
    const msg = error.message || String(error);
    const code = error.code || error.details || '';
    let hint = '';
    if (/permission denied|42501|pgrst/i.test(msg + code)) {
        hint = '\n\nشغّل: supabase/sql/full_setup_single_org.sql (قسم الصلاحيات والسياسات).';
    } else if (/get_my_profile|42883|does not exist/i.test(msg + code)) {
        hint = '\n\nشغّل: supabase/migrations/20260517150000_get_my_profile_rpc.sql';
    } else if (/company_id|is_super_admin/i.test(msg)) {
        hint = '\n\nالمتصفح يحمّل نسخة قديمة من archive-app.js — حدّث GitHub ثم Ctrl+Shift+R.';
    }
    return (
        'فشل تحميل ملف المستخدم (profiles) رغم نجاح تسجيل الدخول.\n' +
        'المعرف: ' +
        uid +
        ' | البريد: ' +
        email +
        '\nالخطأ: ' +
        msg +
        (code ? '\nالتفاصيل: ' + code : '') +
        hint
    );
}

const LOGIN_DEBUG =
    typeof location !== 'undefined' && /(?:\?|&)debug=1(?:&|$)/.test(location.search || '');

function loginDebugLog(step, detail) {
    if (!LOGIN_DEBUG) return;
    console.info('[login-debug]', step, detail !== undefined ? detail : '');
}

sb.auth.onAuthStateChange(async (event, session) => {
    loginDebugLog('auth-event', event);
    // #region agent log
    agentLog('A', 'archive-app.js:onAuthStateChange', 'event', {
        event,
        hasSession: !!session?.user,
        loginSubmitting,
        skipped: !!(session?.user && loginSubmitting),
    });
    // #endregion
    if (session?.user) {
        if (loginSubmitting && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
            agentLog('A', 'archive-app.js:onAuthStateChange', 'skip during form login', { event });
            return;
        }
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            await handleAuthenticatedSession(session);
        }
    } else if (event === 'SIGNED_OUT') {
        // #region agent log
        agentLog('E', 'archive-app.js:onAuthStateChange', 'SIGNED_OUT', {});
        // #endregion
        currentUser = null;
        currentProfile = null;
        teardownAllRealtime();
        stopDashboardPolling();
        showLoginScreen();
        checkRegistrationOpen();
    }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginSubmitting) return;

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginSubmitBtn');
    const prevText = btn ? btn.textContent : '';

    loginSubmitting = true;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'جاري الدخول…';
    }

    try {
        loginDebugLog('signIn-start', email);
        // #region agent log
        agentLog('A', 'archive-app.js:loginForm', 'submit', { hasEmail: !!email });
        // #endregion
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        // #region agent log
        agentLog('A', 'archive-app.js:loginForm', 'signIn result', {
            ok: !error,
            hasSession: !!data?.session,
            errMsg: error?.message ? String(error.message).slice(0, 80) : null,
        });
        // #endregion
        if (error) throw error;
        if (!data.session) {
            showAlert(
                'loginAlert',
                'لم تُنشأ جلسة — غالباً البريد غير مؤكد. راجع البريد أو عطّل تأكيد البريد من لوحة Supabase (Authentication → Providers → Email → Confirm email).',
                'error',
                15000
            );
            return;
        }
        await syncSessionOnClient(data.session);
        showAlert('loginAlert', 'جاري فتح الأرشيف…', 'success', 0);

        const opened = await handleAuthenticatedSession(data.session);
        // #region agent log
        agentLog('D', 'archive-app.js:loginForm', 'handleAuthenticatedSession done', { opened });
        // #endregion
        if (!opened) {
            return;
        }
        updateLoginDiagnosticUI(false);
        showAlert('loginAlert', '', 'success', 0);
    } catch (error) {
        console.error('[إصلاح الدخول] فشل signIn:', formatAuthError(error, 'signIn'));
        showAlert('loginAlert', 'خطأ في تسجيل الدخول: ' + formatAuthError(error, 'signIn'), 'error');
    } finally {
        loginSubmitting = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = prevText;
        }
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!registrationOpen) {
        showAlert(
            'registerAlert',
            'التسجيل العام مغلق. اطلب من مدير النظام إنشاء حساب لك.',
            'error'
        );
        return;
    }
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const fullName = document.getElementById('fullName').value.trim();
    try {
        const { error } = await sb.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName,
                },
            },
        });
        if (error) throw error;
        showAlert(
            'registerAlert',
            'تم إنشاء حساب المدير الأول. إن وُجد تأكيد بريد، راجع صندوق الوارد ثم سجّل الدخول.',
            'success'
        );
        registrationOpen = false;
        setTimeout(() => showLogin(), 2000);
    } catch (error) {
        const msg = formatAuthError(error, 'signUp');
        const hint =
            msg.includes('public_registration_closed') || msg.includes('registration')
                ? ' يوجد مستخدمون بالفعل — اطلب من المدير إضافتك.'
                : '';
        showAlert('registerAlert', 'خطأ في إنشاء الحساب: ' + msg + hint, 'error');
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

function switchTab(tabName, event) {
    if (tabName === 'users' && !isAdmin()) return;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    const nav =
        (event && event.target && event.target.closest('.nav-item')) ||
        document.querySelector('.nav-item[data-tab="' + tabName + '"]');
    if (nav) nav.classList.add('active');

    const page = document.getElementById(tabName);
    if (page) page.classList.add('active');

    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = PAGE_TITLES[tabName] || '';

    closeSidebar();

    if (tabName === 'sections') loadSections();
    if (tabName === 'cards') loadCards();
    if (tabName === 'users') loadUsers();
    if (tabName === 'settings') loadSettings();
}

async function refreshDashboardStats() {
    if (!currentProfile) return;
    const { count: secCount } = await sb.from('sections').select('*', { count: 'exact', head: true });

    const { data: cardRows } = await sb.from('archive_cards').select('status');

    let active = 0,
        archived = 0,
        deleted = 0;
    (cardRows || []).forEach((c) => {
        if (c.status === 'active') active++;
        else if (c.status === 'archived') archived++;
        else if (c.status === 'deleted') deleted++;
    });

    const { count: userCount } = await sb.from('profiles').select('*', { count: 'exact', head: true });

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

    if (!currentProfile) return;

    const subscribe = (table) => {
        const ch = sb
            .channel(`dash-${table}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table },
                () => refreshDashboardStats()
            )
            .subscribe();
        dashboardChannels.push(ch);
    };

    try {
        subscribe('sections');
        subscribe('archive_cards');
        subscribe('profiles');
    } catch (_) {}

    dashboardInterval = setInterval(refreshDashboardStats, 12000);
}

async function exportData() {
    if (!currentProfile) return;
    const exportPayload = {
        sections: [],
        cards: [],
        users: [],
        exportDate: new Date().toISOString(),
    };

    try {
        const [{ data: secData, error: e1 }, { data: cardData, error: e2 }, { data: userData, error: e3 }] =
            await Promise.all([
                sb.from('sections').select('*').order('sort_order'),
                sb
                    .from('archive_cards')
                    .select(
                        '*, card_attachments ( id, file_name, mime_type, size_bytes, uploaded_at )'
                    ),
                sb.from('profiles').select('*'),
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
        showToast('تم تصدير البيانات بنجاح', 'success');
    } catch (error) {
        showToast('خطأ في تصدير البيانات: ' + error.message, 'error');
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
    if (!currentProfile) return;
    if (sectionChannel) {
        try {
            sb.removeChannel(sectionChannel);
        } catch (_) {}
        sectionChannel = null;
    }

    sectionChannel = sb
        .channel('sections-live')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'sections' },
            () => fetchSectionsData()
        )
        .subscribe();

    fetchSectionsData();
}

async function fetchSectionsData() {
    if (!currentProfile) return;
    const { data, error } = await sb.from('sections').select('*').order('sort_order', { ascending: true });
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
        container.innerHTML =
            '<div class="empty-state"><i class="fas fa-folder-open empty-icon"></i><p>لا توجد أقسام بعد</p>' +
            (canWriteArchive()
                ? '<button type="button" class="btn btn-primary btn-sm" onclick="openSectionModal()"><i class="fas fa-plus"></i> إضافة قسم</button>'
                : '') +
            '</div>';
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
                <td><strong>${escapeHtml(section.name || '')}</strong></td>
                <td>${escapeHtml(section.description || 'لا يوجد وصف')}</td>
                <td>${section.order || 0}</td>
                <td>
                    <div class="table-actions">
                        ${
                            canWriteArchive()
                                ? `
                        <button onclick="editSection('${section.id}')" class="btn btn-secondary">
                            <i class="fas fa-edit"></i> تعديل
                        </button>
                        <button onclick="deleteSection('${section.id}')" class="btn btn-danger">
                            <i class="fas fa-trash"></i> حذف
                        </button>
                        `
                                : '<span style="color:#999;">عرض فقط</span>'
                        }
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
    if (!canWriteArchive()) {
        alert('ليس لديك صلاحية التعديل.');
        return;
    }
    const row = {
        name: document.getElementById('sectionName').value,
        description: document.getElementById('sectionDescription').value,
        sort_order: parseInt(document.getElementById('sectionOrder').value, 10) || 0,
        updated_at: new Date().toISOString(),
    };

    try {
        if (currentEditingId) {
            await sb.from('sections').update(row).eq('id', currentEditingId);
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
    if (!canWriteArchive()) {
        alert('ليس لديك صلاحية الحذف.');
        return;
    }
    if (!confirm('هل أنت متأكد من حذف هذا القسم؟')) return;
    try {
        await sb.from('sections').delete().eq('id', id);
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
    if (!currentProfile) return;
    if (sections.length === 0) {
        fetchSectionsData().then(() => loadCardsData());
    } else {
        updateSectionFilter();
        loadCardsData();
    }
}

function loadCardsData() {
    if (!currentProfile) return;
    if (cardsChannel) {
        try {
            sb.removeChannel(cardsChannel);
        } catch (_) {}
        cardsChannel = null;
    }

    cardsChannel = sb
        .channel('cards-live')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'archive_cards' },
            () => fetchCardsData()
        )
        .subscribe();

    fetchCardsData();
}

async function fetchCardsData() {
    if (!currentProfile) return;
    const { data, error } = await sb
        .from('archive_cards')
        .select('*, card_attachments ( id )')
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
            sectionFilter.innerHTML += `<option value="${section.id}">${escapeHtml(section.name || '')}</option>`;
        });
    }
}

function renderCards(cardsToRender = null) {
    const container = document.getElementById('cardsTableContainer');
    const cardsList = cardsToRender || cards;

    if (cardsList.length === 0) {
        container.innerHTML =
            '<div class="empty-state"><i class="fas fa-file-alt empty-icon"></i><p>لا توجد بطاقات بعد</p>' +
            (canWriteArchive()
                ? '<button type="button" class="btn btn-primary btn-sm" onclick="openCardModal()"><i class="fas fa-plus"></i> إضافة بطاقة</button>'
                : '') +
            '</div>';
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
                    <strong>${escapeHtml(card.title || 'بدون عنوان')}</strong>
                    ${
                        card.description
                            ? `<br><small style="color: #666;">${escapeHtml(
                                  card.description.length > 50
                                      ? card.description.substring(0, 50) + '...'
                                      : card.description
                              )}</small>`
                            : ''
                    }
                </td>
                <td>${section ? escapeHtml(section.name) : 'غير محدد'}</td>
                <td>${escapeHtml(card.reference || 'غير محدد')}</td>
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
                        ${
                            canWriteArchive()
                                ? `
                        <button onclick="editCard('${card.id}')" class="btn btn-secondary" title="تعديل">
                            <i class="fas fa-edit"></i> تعديل
                        </button>
                        <button onclick="attachFilesToCard('${card.id}')" class="btn btn-primary" title="إرفاق ملفات">
                            <i class="fas fa-plus"></i> إرفاق
                        </button>
                        <button onclick="deleteCard('${card.id}')" class="btn btn-danger" title="حذف">
                            <i class="fas fa-trash"></i> حذف
                        </button>
                        `
                                : ''
                        }
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
            <h3 style="margin-bottom: 20px; color: #667eea;"><i class="fas fa-file-alt"></i> ${escapeHtml(card.title || 'بدون عنوان')}</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px;">
                <div><strong>القسم:</strong> ${section ? escapeHtml(section.name) : 'غير محدد'}</div>
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

    if (sections.length === 0) {
        const { data } = await sb.from('sections').select('*').order('sort_order');
        sections = (data || []).map(mapSectionRow);
    }

    const sectionSelect = document.getElementById('cardSection');
    sectionSelect.innerHTML = '<option value="">اختر القسم</option>';
    sections.forEach((section) => {
        sectionSelect.innerHTML += `<option value="${section.id}">${escapeHtml(section.name || '')}</option>`;
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
    if (!canWriteArchive()) {
        alert('ليس لديك صلاحية التعديل.');
        return;
    }

    const row = {
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
            await sb.from('archive_cards').update(row).eq('id', currentEditingId);

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
    if (!canWriteArchive()) {
        alert('ليس لديك صلاحية الحذف.');
        return;
    }
    if (!confirm('هل أنت متأكد من حذف هذه البطاقة؟')) return;
    try {
        await sb.from('archive_cards').delete().eq('id', id);
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
    if (!isAdmin()) return;
    if (usersChannel) {
        try {
            sb.removeChannel(usersChannel);
        } catch (_) {}
        usersChannel = null;
    }

    usersChannel = sb
        .channel('profiles-live')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'profiles' },
            () => fetchUsersData()
        )
        .subscribe();
    fetchUsersData();
}

async function fetchUsersData() {
    if (!isAdmin()) return;
    const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
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
    const isEdit = Boolean(id);
    const emailInput = document.getElementById('userEmail');
    const pwdInput = document.getElementById('userPassword');
    const pwdHint = document.getElementById('userPasswordHint');
    const roleSelect = document.getElementById('userRole');

    document.getElementById('userModalTitle').textContent = isEdit
        ? 'تعديل المستخدم'
        : 'إضافة مستخدم جديد';

    if (isEdit) {
        const user = users.find((u) => u.id === id);
        document.getElementById('userFullName').value = user?.fullName || '';
        emailInput.value = user?.email || '';
        emailInput.readOnly = true;
        pwdInput.value = '';
        pwdInput.required = false;
        if (pwdHint) pwdHint.textContent = 'تغيير كلمة المرور: من لوحة Supabase أو رابط «نسيت كلمة المرور».';
        roleSelect.value = normalizeRole(user?.role);
        document.getElementById('userPhone').value = user?.phone || '';
        if (id === currentUser?.id) {
            roleSelect.disabled = true;
        } else {
            roleSelect.disabled = false;
        }
    } else {
        document.getElementById('userForm').reset();
        emailInput.readOnly = false;
        pwdInput.required = true;
        if (pwdHint) pwdHint.textContent = 'مطلوبة للمستخدم الجديد (6 أحرف على الأقل).';
        roleSelect.disabled = false;
    }

    document.getElementById('userModal').classList.add('active');
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('active');
    currentEditingId = null;
    const emailInput = document.getElementById('userEmail');
    const roleSelect = document.getElementById('userRole');
    const pwdInput = document.getElementById('userPassword');
    if (emailInput) emailInput.readOnly = false;
    if (roleSelect) roleSelect.disabled = false;
    if (pwdInput) pwdInput.required = false;
}

document.getElementById('userModal').addEventListener('click', (e) => {
    if (e.target.id === 'userModal') closeUserModal();
});

document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isAdmin()) {
        alert('صلاحية المدير مطلوبة.');
        return;
    }

    const fullName = document.getElementById('userFullName').value.trim();
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const password = document.getElementById('userPassword').value;
    const role = normalizeRole(document.getElementById('userRole').value);
    const phone = document.getElementById('userPhone').value.trim();

    if (!fullName) {
        alert('أدخل الاسم الكامل.');
        return;
    }
    if (!email) {
        alert('أدخل البريد الإلكتروني.');
        return;
    }

    try {
        if (currentEditingId) {
            if (currentEditingId === currentUser?.id && role !== 'admin') {
                alert('لا يمكنك إزالة صلاحية المدير عن حسابك.');
                return;
            }
            const { error } = await sb
                .from('profiles')
                .update({
                    full_name: fullName,
                    email,
                    role,
                    phone: phone || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', currentEditingId);
            if (error) throw error;
            alert('تم تحديث بيانات المستخدم.');
        } else {
            if (!password || password.length < 6) {
                alert('كلمة المرور مطلوبة (6 أحرف على الأقل).');
                return;
            }
            await inviteUserByAdmin({ email, password, fullName, role, phone });
            alert(
                'تم إنشاء الحساب وربطه بجدول profiles.\n' +
                    'إن كان تأكيد البريد مفعّلاً في Supabase، يجب على المستخدم تأكيد بريده قبل أول دخول.'
            );
        }
        closeUserModal();
        await fetchUsersData();
        refreshDashboardStats();
    } catch (error) {
        alert('خطأ: ' + formatUserMgmtError(error));
    }
});

function editUser(id) {
    openUserModal(id);
}

async function deleteUser(id) {
    if (!isAdmin()) {
        alert('صلاحية المدير مطلوبة.');
        return;
    }
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟ (حساب الدخول قد يبقى في المصادقة)')) return;
    try {
        const { error } = await sb.from('profiles').delete().eq('id', id);
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
    if (!currentProfile) return;
    const { data } = await sb.from('app_settings').select('*').eq('id', 1).maybeSingle();
    if (data) {
        document.getElementById('settingsOrgName').value = data.name || '';
        document.getElementById('settingsPhone').value = data.phone || '';
        document.getElementById('settingsEmail').value = data.email || '';
        document.getElementById('settingsAddress').value = data.address || '';
        document.getElementById('settingsNotes').value = data.notes || '';
        updateOrgBranding(data.name);
    }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isAdmin()) {
        alert('صلاحية المدير مطلوبة لحفظ الإعدادات.');
        return;
    }
    try {
        const { error } = await sb
            .from('app_settings')
            .update({
                name: document.getElementById('settingsOrgName').value,
                phone: document.getElementById('settingsPhone').value || null,
                email: document.getElementById('settingsEmail').value || null,
                address: document.getElementById('settingsAddress').value || null,
                notes: document.getElementById('settingsNotes').value || null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', 1);
        if (error) throw error;
        updateOrgBranding(document.getElementById('settingsOrgName').value);
        showToast('تم حفظ الإعدادات بنجاح', 'success');
    } catch (err) {
        showToast('خطأ: ' + err.message, 'error');
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
