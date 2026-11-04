const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const crypto = require("crypto");

const app = express();
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.path.indexOf('/api/') === 0) {
        res.on('finish', () => { if (res.statusCode < 400) bumpActivity(); });
    }
    next();
});

// ── إعدادات ──────────────────────────────────────────────────────────────
// عنوان موقع فلاش (تطبيق الويب الأساسي) — يقدر ينغيّر من متغير البيئة FLASH_URL على Render
const FLASH_API = String(process.env.FLASH_URL || 'https://flash-gpeb.onrender.com').replace(/\/+$/, '');

// مفتاح سرّي مشترك مع فلاش (لازم نفس القيمة بالضبط في INTERNAL_API_KEY على موقع فلاش وعلى البنك)
// يُستخدم لتوقيع رابط الدخول من فلاش، ولتأمين الطلبات بين الموقعين. بدونه الربط يتوقف (أمان).
const INTERNAL_API_KEY = String(process.env.INTERNAL_API_KEY || '').trim();
function internalHeaders() { return { 'x-internal-key': INTERNAL_API_KEY, 'Content-Type': 'application/json' }; }
// وضع «داخل فلاش»: فلاش يمرّر طلبات /bank لهذا السيرفر ويرسل ترويسة موقّعة، فنضبط الروابط والتحويلات على المسار /bank
const PROXY_TOKEN = INTERNAL_API_KEY ? crypto.createHmac('sha256', INTERNAL_API_KEY).update('flash-proxy-v1').digest('hex') : '';
function pfx(req) {
    return (PROXY_TOKEN && req.get('x-flash-proxy') === PROXY_TOKEN && req.get('x-forwarded-prefix') === '/bank') ? '/bank' : '';
}
function flashHome(req) { return pfx(req) ? '/' : '/to-flash'; }
app.get('/api/flash-status', async (req, res) => {
    try {
        const r = await fetch(FLASH_API + '/healthz', { signal: AbortSignal.timeout(9000) });
        res.json({ up: r.status < 500 });
    } catch (e) { res.json({ up: false }); }
});
app.get('/to-flash', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send('<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>فلاش</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a1628;color:#e2e8f0;font-family:Tahoma,Arial,sans-serif;text-align:center;padding:20px}.sp{width:54px;height:54px;border:5px solid #1e3a5f;border-top-color:#3b82f6;border-radius:50%;animation:r 1s linear infinite;margin:0 auto 18px}@keyframes r{to{transform:rotate(360deg)}}p{font-size:18px;line-height:1.9;margin:0}small{color:#64748b;display:block;margin-top:10px}</style></head><body><div><div class="sp"></div><p>⚡ جاري تشغيل فلاش...</p><small id="m">ثواني ويفتح تلقائياً</small></div><script>var t0=Date.now(),T=' + JSON.stringify(FLASH_API) + ';function chk(){fetch("/api/flash-status").then(function(r){return r.json()}).then(function(d){if(d&&d.up){location.href=T}else{nx()}}).catch(nx)}function nx(){if(Date.now()-t0>180000){document.getElementById("m").textContent="فلاش تأخر، حدّث الصفحة بعد شوي";return}setTimeout(chk,2500)}chk();</script></body></html>');
});
async function flashGet(path) {
    if (!INTERNAL_API_KEY) throw new Error('INTERNAL_API_KEY غير مضبوط على خدمة البنك');
    const r = await fetch(FLASH_API + path, { headers: internalHeaders() });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); }
    catch (e) { throw new Error(`رد غير متوقع من ${FLASH_API} (حالة ${r.status}) — تأكد إن FLASH_URL في إعدادات البنك هو رابط موقع فلاش الحقيقي، وإن فلاش محدّث`); }
    if (r.status === 403 || r.status === 503) throw new Error((data && data.msg) || 'مفتاح INTERNAL_API_KEY مو نفسه بين فلاش والبنك');
    return data;
}
function ensureInternalFlash(req, res, next) {
    if (!INTERNAL_API_KEY || req.headers['x-internal-key'] !== INTERNAL_API_KEY) {
        return res.status(403).json({ success: false, msg: 'طلب غير مصرّح به' });
    }
    next();
}

const MONGO_URI = String(process.env.MONGO_URI || '').trim();
if (!MONGO_URI) console.log("❌ MONGO_URI غير مضبوط — أضفه في Environment على Render");
mongoose.connect(MONGO_URI)
.then(() => console.log("✅ Bank MongoDB connected"))
.catch(err => console.log("❌ MongoDB error:", err));

// ── موديلات البنك ──────────────────────────────────────────────────────────

// حسابات البنك
const AccountSchema = new mongoose.Schema({
    discord: { type: String, required: true, unique: true },
    discordTag: String,
    accountNumber: { type: String, unique: true },   // 6 أرقام
    balance: { type: Number, default: 0 },
    savingsBalance: { type: Number, default: 0 },
    isFrozen: { type: Boolean, default: false },
    cardLimit: { type: Number, default: -1 },             // -1 يعني اتبع الإعداد العام
    supportBanned: { type: Boolean, default: false }, // محظور من خدمة العملاء
    createdAt: { type: Date, default: Date.now }
});
const Account = mongoose.model("Account", AccountSchema);

// سجل المعاملات
const TransactionSchema = new mongoose.Schema({
    fromDiscord: String,
    toDiscord: String,
    fromAccount: String,
    toAccount: String,
    amount: Number,
    type: String, // transfer / deposit / withdraw / loan_receive / loan_pay / savings_deposit / savings_withdraw / interest
    note: String,
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model("Transaction", TransactionSchema);

// القروض
const LoanSchema = new mongoose.Schema({
    discord: String,
    discordTag: String,
    accountNumber: String,
    amount: Number,
    remaining: Number,
    status: { type: String, default: "pending" }, // pending / approved / rejected / paid / expired
    requestedAt: { type: Date, default: Date.now },
    approvedAt: Date,
    expiresAt: Date  // تاريخ انتهاء صلاحية القرض (إن وجد)
});
const Loan = mongoose.model("Loan", LoanSchema);

// الإشعارات
const NotificationSchema = new mongoose.Schema({
    discord: String,
    message: String,
    type: String, // info / success / warning / danger
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
// كل إشعار جديد في البنك يتحوّل تلقائياً كإشعار Push على جهاز العضو عبر تطبيق فلاش (تطبيق واحد بس)
NotificationSchema.pre('save', function () { this.$locals.wasNew = this.isNew; });
NotificationSchema.post('save', function (doc) { if (doc.$locals && doc.$locals.wasNew) relayNotifToFlash(doc); });
function relayNotifToFlash(n) {
    try {
        if (!INTERNAL_API_KEY || !n || !n.discord || !n.message) return;
        fetch(FLASH_API + '/api/bank/notify', {
            method: 'POST', headers: internalHeaders(),
            body: JSON.stringify({ uid: String(n.discord), title: '🏦 بنك فلاش', body: String(n.message) }),
            signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        }).catch(() => {});
    } catch (e) {}
}
const Notification = mongoose.model("Notification", NotificationSchema);

// حساب فلاش المرتبط (يتحدّث كل مرة العضو يدخل البنك من فلاش): الاسم + الرتبة + هل هو من كبار المسؤولين
const FlashLinkSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    name: String, rank: String, unit: String,
    isSenior: { type: Boolean, default: false },
    isOwner: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
});
const FlashLink = mongoose.model("FlashLink", FlashLinkSchema);

// طلبات البطاقات البنكية
const CardRequestSchema = new mongoose.Schema({
    discord: String,
    discordTag: String,
    accountNumber: String,
    // بيانات مطلوبة
    monthlyIncome: Number,   // قديم (ما عاد يُطلب)
    jobTitle: String,        // قديم
    employerName: String,    // قديم
    requestReason: String,
    // بيانات البطاقة العسكرية (الرتبة/القطاع/اليونت تجي من فلاش وليست من إدخال المستخدم)
    militaryCardNumber: String,  // الرقم اللي كتبه المستخدم
    militaryRank: String,
    militarySector: String,
    militaryUnit: String,
    flashRank: String, flashSector: String, flashUnit: String,  // اللي في فلاش فعلياً (للمقارنة)
    pledgeAccepted: { type: Boolean, default: false },
    // حالة الطلب
    status: { type: String, default: 'pending' }, // pending / approved / rejected / disabled / expired
    adminNote: String,
    requestedAt: { type: Date, default: Date.now },
    reviewedAt: Date,
    // بيانات البطاقة الحقيقية (تُضاف عند القبول)
    cardNumber: String,       // 16 رقم مقسمة 4x4
    cardHolderName: String,   // اسم حامل البطاقة
    cardCVV: String,          // 3 أرقام
    cardExpiry: Date,         // تاريخ انتهاء صلاحية البطاقة (يحدده كبار المسؤولين)
    // ── تحكم البطاقة (حق كبار المسؤولين) ──
    cardColor: { type: String, default: 'blue' },   // يحدده الأدمن وقت الموافقة
    cardPIN: { type: String, default: null },       // رقم سري 4 أرقام يحدده المستخدم أول مرة
    cardPINHash: { type: String, default: null },   // الرقم السري مشفّر (hash) — ما أحد يشوفه
    pinSet: { type: Boolean, default: false },      // هل المستخدم حط الرقم السري؟
    cardFrozen: { type: Boolean, default: false },  // فريز شكلي من كبار المسؤولين فقط
});
const CardRequest = mongoose.model("CardRequest", CardRequestSchema);

// (تذاكر خدمة العملاء صارت في نظام فلاش المنقول — SupportTicket معرّف أسفل)

// سجل أحداث البنك العام (لكبار المسؤولين فقط)
const BankLogSchema = new mongoose.Schema({
    action: String,         // نوع الحدث
    description: String,    // وصف تفصيلي
    performedBy: String,    // discord id من نفذ العملية
    performedByTag: String,
    targetDiscord: String,  // المستهدف (إن وجد)
    targetTag: String,
    meta: mongoose.Schema.Types.Mixed, // بيانات إضافية
    createdAt: { type: Date, default: Date.now }
});
const BankLog = mongoose.model("BankLog", BankLogSchema);

// الموظفون (إدارة / موظفون عاديون)
const StaffSchema = new mongoose.Schema({
    discord: { type: String, required: true, unique: true },
    discordTag: String,
    role: { type: String, default: 'staff' }, // 'staff' | 'management'
    hiredBy: String,       // discord id من وظّفه
    hiredByTag: String,
    hiredAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true }
});
const Staff = mongoose.model("Staff", StaffSchema);

// إعدادات البنك والصيانة
const BankSettingsSchema = new mongoose.Schema({
    isMaintenance: { type: Boolean, default: false },
    disableRegister: { type: Boolean, default: false },
    disableTransfer: { type: Boolean, default: false },
    disableLoans: { type: Boolean, default: false },
    disableCards: { type: Boolean, default: false },
    disableSupport: { type: Boolean, default: false },
    disableSupportReason: { type: String, default: '' },
    interestRate: { type: Number, default: 2 }, 
    globalCardLimit: { type: Number, default: 1 },
    adminList: { type: [String], default: [] },
    // رسوم التحويل (تذهب لرئيس البنك)
    transferFee: { type: Number, default: 0 },           // مبلغ ثابت يُخصم عند كل تحويل
    transferFeeRecipient: { type: String, default: '' }, // رقم حساب رئيس البنك
    // رسوم تجديد البطاقة
    cardRenewalFee: { type: Number, default: 0 },
    // إعداد انتهاء القروض
    loanExpiryDays: { type: Number, default: 0 },           // 0 = بدون انتهاء
    loanExpiryApplyTo: { type: String, default: 'new' },  // 'new' | 'existing' | 'both'
    supportCanned: { type: [{ title: String, text: String }], default: [] },   // ردود جاهزة لخدمة العملاء
    logClearUsed: { type: Boolean, default: false },      // زر حذف اللوق الشامل انستخدم؟
    notifWipeDone: { type: Boolean, default: false }      // مسح سجل الإشعارات مرة وحدة عند هذا التحديث
});
const BankSettings = mongoose.model("BankSettings", BankSettingsSchema);

// إعدادات رواتب العساكر (ربط مع موقع فلاش)
const MilitarySalarySchema = new mongoose.Schema({
    isActive: { type: Boolean, default: false },
    periodValue: { type: Number, default: 1 },          // الرقم (مثلاً 7)
    periodUnit: { type: String, default: 'days' },       // days | weeks | months
    ranksSalaries: { type: Map, of: Number, default: {} }, // رتبة -> راتب
    lastPayoutAt: { type: Date, default: null },
    nextPayoutAt: { type: Date, default: null },
});
const MilitarySalarySettings = mongoose.model("MilitarySalarySettings", MilitarySalarySchema);

async function getMilitarySalarySettings() {
    let s = await MilitarySalarySettings.findOne();
    if (!s) s = await MilitarySalarySettings.create({});
    return s;
}

// يحسب المدة بالميلي ثانية حسب الوحدة (أيام / أسابيع / أشهر)
function periodToMs(value, unit) {
    const v = Math.max(0, parseFloat(value) || 0);
    if (unit === 'weeks') return v * 7 * 24 * 60 * 60 * 1000;
    if (unit === 'months') return v * 30 * 24 * 60 * 60 * 1000; // تقريبي: الشهر = 30 يوم
    return v * 24 * 60 * 60 * 1000; // days (افتراضي)
}

// يصرف الراتب لقائمة عساكر (advance = دفعة مسبقة لأشخاص محددين، ما تغيّر موعد الدفعة القادمة)
async function payMilitarySalaries(list, settings, advance) {
    let paidCount = 0, totalPaid = 0;
    const tag = advance ? ' (دفعة مسبقة)' : '';
    for (const p of list) {
        const salary = settings.ranksSalaries.get(p.rank);
        if (!salary || salary <= 0) continue; // ما فيه راتب محدد لهذي الرتبة

        const acc = await Account.findOne({ discord: p.discord });
        if (!acc || acc.isFrozen) continue; // ما عنده حساب بنكي أو حسابه مجمد

        await Account.findByIdAndUpdate(acc._id, { $inc: { balance: salary } });
        await Transaction.create({
            toDiscord: p.discord,
            toAccount: acc.accountNumber,
            amount: salary,
            type: 'deposit',
            note: `راتب عسكري${tag} — رتبة ${p.rank}`
        });
        await Notification.create({
            discord: p.discord,
            message: `💰 تم إيداع راتبك العسكري${tag} (${salary.toLocaleString()} $) عن رتبة ${p.rank}.`,
            type: 'success'
        });
        paidCount++;
        totalPaid += salary;
    }
    return { paidCount, totalPaid };
}

// تنفيذ عملية صرف رواتب العساكر: يجيب رتبة كل عسكري من موقع فلاش
// ويودع الراتب المحدد لرتبته في حسابه البنكي المسجل
async function runMilitarySalaryPayout() {
    const settings = await getMilitarySalarySettings();
    if (!settings.isActive) return { success: false, msg: "رواتب العساكر غير مفعّلة" };

    let personnel;
    try {
        const data = await flashGet('/api/bank/personnel-ranks');
        if (!data.success) throw new Error(data.msg || "فشل جلب بيانات العساكر");
        personnel = data.personnel;
    } catch (e) {
        console.log("❌ تعذر الاتصال بموقع فلاش:", e.message);
        return { success: false, msg: "تعذر الاتصال بموقع فلاش: " + e.message };
    }

    const { paidCount, totalPaid } = await payMilitarySalaries(personnel, settings, false);

    const now = new Date();
    const nextPayoutAt = new Date(now.getTime() + periodToMs(settings.periodValue, settings.periodUnit));
    await MilitarySalarySettings.updateOne({}, { lastPayoutAt: now, nextPayoutAt });

    await BankLog.create({
        action: 'military_salary_payout',
        description: `صرف رواتب العساكر: ${paidCount} حساب بإجمالي ${totalPaid.toLocaleString()} $`,
        performedBy: 'system',
        performedByTag: 'نظام رواتب العساكر'
    });

    return { success: true, paidCount, totalPaid, nextPayoutAt };
}

// فحص دوري كل دقيقة: إذا حان وقت صرف الرواتب ينفذها تلقائياً
setInterval(async () => {
    try {
        const settings = await getMilitarySalarySettings();
        if (settings.isActive && settings.nextPayoutAt && new Date() >= new Date(settings.nextPayoutAt)) {
            await runMilitarySalaryPayout();
            bumpActivity();
        }
    } catch (e) {
        console.log("❌ خطأ في فحص رواتب العساكر:", e.message);
    }
}, 60 * 1000);

const SUPER_ADMIN_IDS = ['1003511814140743825','1231269832201207808'];

// ── نظام التحديث اللحظي (Real-time activity signal) ──────────────────────
// أي عملية تغيّر رصيد/حساب/تذكرة تستدعي هذي الدالة، وكل الأطراف (الشخص
// نفسه، الطرف الثاني، الأدمن) يشوفون التحديث خلال أقرب دورة بولنق.
let lastBankActivity = Date.now();
let lastTicketActivity = Date.now();
function bumpActivity() { lastBankActivity = Date.now(); }
function bumpTicketActivity() { lastTicketActivity = Date.now(); bumpActivity(); }

 async function initBankSettings() {
    const s = await BankSettings.findOne();
    if (!s) await BankSettings.create({});
}
initBankSettings();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(session({ 
    secret: 'norv_bank_secret_789',
    resave: false, 
    saveUninitialized: false,
    name: 'bank_session',
    cookie: { 
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(passport.initialize());  // ← أضف هذا
app.use(passport.session());     // ← وهذا
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ── حماية حساب المالك المخفي: أي طلب على حسابه/بطاقته/قرضه من غيره يرجع "غير موجود" ──
function ownerGuard(kind) {
    return async (req, res, next) => {
        try {
            if (!ownerUids.size || !req.isAuthenticated() || isOwnerUid(req.user.id)) return next();
            const id = req.params.id;
            if (!mongoose.Types.ObjectId.isValid(id)) return next();
            const M = kind === 'acc' ? Account : kind === 'card' ? CardRequest : Loan;
            const doc = await M.findById(id, { discord: 1 }).lean();
            if (doc && ownerUids.has(String(doc.discord))) return res.status(404).json({ success: false, msg: 'غير موجود' });
        } catch (e) {}
        next();
    };
}
app.use('/api/admin/accounts/:id', ownerGuard('acc'));
app.use('/api/superadmin/accounts/:id', ownerGuard('acc'));
app.use('/api/admin/cards/:id', ownerGuard('card'));
app.use('/api/superadmin/cards/:id', ownerGuard('card'));
app.use('/api/admin/loans/:id', ownerGuard('loan'));



// جدار حماية لفحص صيانة البنك العامة
// يتحقق أن هذا الشخص مسجّل فعلاً في موقع فلاش (عسكري معه رتبة معتمدة، أو مواطن مقبول ومسجّل)
async function isFlashMember(discordId) {
    // الدخول للبنك يتم فقط عبر زر فلاش (رابط موقّع)، فأي حساب مسجّل هنا هو عضو فلاش فعلاً
    try { return !!(await FlashLink.exists({ uid: String(discordId) })); }
    catch (e) { return false; }
}

async function checkMaintenance(req, res, next) {
    const s = await BankSettings.findOne();
    if (s && s.isMaintenance) {
        // إذا كان سوبر أدمن أو أدمن خله يدخل، الباقي ينقفل عليهم
        if (req.isAuthenticated()) {
            const role = await getBankRole(req.user.id);
            if (role === 'super_admin' || role === 'admin') return next();
        }
        return res.status(503).json({ success: false, maintenance: true, msg: "🚨 البنك مغلق حالياً للصيانة العامة بطلب من الإدارة العليا." });
    }
    // البنك مخصص فقط لمنسوبي فلاش (عسكر مسجلين أو مواطنين مقبولين) — موظفو وإدارة البنك مستثنون من هذا الشرط
    if (req.isAuthenticated()) {
        const role = await getBankRole(req.user.id);
        if (role === 'user') {
            const member = await isFlashMember(req.user.id);
            if (!member) {
                return res.status(403).json({ success: false, notFlashMember: true, msg: "🚫 هذا البنك مخصص لمنسوبي فلاش فقط (عسكر مسجلين أو مواطنين مقبولين)." });
            }
        }
    }
    next();
}

// ── دوال مساعدة ─────────────────────────────────────────────────────────────
// ترتيب الرتب: user < staff (موظف) < management (إداري) < admin (رئيس البنك) < super_admin (كبار المسؤولين)
async function getBankRole(discordId) {
    if (SUPER_ADMIN_IDS.includes(discordId)) return 'super_admin';
    try { const fl = await FlashLink.findOne({ uid: String(discordId) }, { isSenior: 1 }).lean(); if (fl && fl.isSenior) return 'super_admin'; } catch (e) {}
    const s = await BankSettings.findOne();
    if (s && s.adminList.includes(discordId)) return 'admin';
    const staff = await Staff.findOne({ discord: discordId, isActive: true });
    if (staff) return staff.role === 'management' ? 'management' : 'staff';
    return 'user';
}

// إشعار الخطر: كل كبار المسؤولين (الأيديات الثابتة + أي كبير مسؤولين داخل من فلاش)
async function isBankOwner(discordId) {
    return (await getBankRole(String(discordId))) === 'super_admin';
}

async function isBankAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getBankRole(req.user.id);
    if (role === 'admin' || role === 'super_admin') return next();
    return res.status(403).json({ success: false, msg: "غير مصرح" });
}

async function isBankSuperAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getBankRole(req.user.id);
    if (role === 'super_admin') return next();
    return res.status(403).json({ success: false, msg: "للمسؤولين الكبار فقط" });
}

// موظف فما فوق: يقدر يوصل القروض والبطاقات وخدمة العملاء (بدون التحويل/القرض العام ولا الحسابات)
async function isStaffOrAbove(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getBankRole(req.user.id);
    if (['staff', 'management', 'admin', 'super_admin'].includes(role)) { req.bankRole = role; return next(); }
    return res.status(403).json({ success: false, msg: "غير مصرح" });
}

// إداري فما فوق: زيادة على الموظف، يوصل قسم الحسابات
async function isManagementOrAbove(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getBankRole(req.user.id);
    if (['management', 'admin', 'super_admin'].includes(role)) { req.bankRole = role; return next(); }
    return res.status(403).json({ success: false, msg: "غير مصرح" });
}

// دالة إرسال الويب هوك للديسكورد عند العمليات المالية
async function sendDiscordWebhook(title, description, color = 3066993) {
    const WEBHOOK_URL = "https://discord.com/api/webhooks/1216447814457008169/6vD9pP1Isk29QY0L5fWubHjV-C6x6yvOnp7B4m-972Jc5g9v6";
    try {
    const fetch = (await import('node-fetch')).default;
    await fetch(WEBHOOK_URL, {

            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: title,
                    description: description,
                    color: color,
                    timestamp: new Date()
                }]
            })
        });
    } catch (err) {
        console.log("Webhook error:", err.message);
    }
}

// ── الدخول من فلاش (SSO): فلاش يوقّع رابط قصير العمر فيه الاسم والرتبة، والبنك يفتح/يدخل الحساب تلقائياً ──
const usedSsoNonces = new Map();
setInterval(() => { const now = Date.now(); for (const [k, exp] of usedSsoNonces) if (exp < now) usedSsoNonces.delete(k); }, 60 * 1000);

async function genAccountNumber() {
    for (let i = 0; i < 40; i++) {
        const n = String(Math.floor(100000 + Math.random() * 900000));
        if (!(await Account.exists({ accountNumber: n }))) return n;
    }
    throw new Error('تعذر توليد رقم حساب');
}
function ssoPage(msg, home) {
    home = home || '/to-flash';
    return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>بنك فلاش</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a1628;color:#e2e8f0;font-family:Tahoma,Arial,sans-serif;text-align:center;padding:20px;">
<div><div style="font-size:48px;">🏦</div><p style="font-size:18px;line-height:1.9;max-width:420px;">${msg}</p>
<a href="${home}" style="display:inline-block;margin-top:14px;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold;">↩️ الرجوع لفلاش</a></div></body></html>`;
}
app.get('/sso', async (req, res) => {
    const sp = (m) => ssoPage(m, flashHome(req));
    try {
        if (!INTERNAL_API_KEY) return res.status(503).send(sp('الربط مع فلاش غير مفعّل بعد (INTERNAL_API_KEY ناقص في إعدادات البنك).'));
        const t = String(req.query.t || '');
        const parts = t.split('.');
        if (parts.length !== 2) return res.status(400).send(sp('رابط الدخول غير صالح. ارجع لفلاش واضغط زر «بنك فلاش».'));
        const want = crypto.createHmac('sha256', INTERNAL_API_KEY).update(parts[0]).digest('base64url');
        const a = Buffer.from(parts[1]), b = Buffer.from(want);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send(sp('رابط الدخول غير صالح. ارجع لفلاش واضغط زر «بنك فلاش».'));
        let p;
        try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return res.status(400).send(sp('رابط الدخول تالف.')); }
        if (!p || !p.uid || !p.exp || Date.now() > Number(p.exp)) return res.status(400).send(sp('انتهت صلاحية رابط الدخول. ارجع لفلاش واضغط زر «بنك فلاش» من جديد.'));
        if (!p.n || usedSsoNonces.has(p.n)) return res.status(400).send(sp('رابط الدخول انستخدم قبل. ارجع لفلاش واضغط زر «بنك فلاش» من جديد.'));
        usedSsoNonces.set(p.n, Number(p.exp) + 60000);

        const uid = String(p.uid).slice(0, 64);
        const name = String(p.name || 'عضو').slice(0, 60);
        await FlashLink.findOneAndUpdate({ uid }, { $set: { name, rank: String(p.rank || '').slice(0, 60), unit: String(p.unit || '').slice(0, 60), isSenior: !!p.senior, ...(p.owner !== undefined ? { isOwner: !!p.owner } : {}), updatedAt: new Date() } }, { upsert: true });
        refreshAuthSets();

        let acc = await Account.findOne({ discord: uid });
        if (!acc) {
            const settings = await BankSettings.findOne();
            if (settings && settings.disableRegister && !p.senior) {
                return res.status(403).send(sp('🔒 تم إيقاف فتح الحسابات البنكية الجديدة مؤقتاً من قِبل إدارة البنك.'));
            }
            acc = await Account.create({ discord: uid, discordTag: name, accountNumber: await genAccountNumber(), balance: 0, savingsBalance: 0 });
            await Notification.create({ discord: uid, message: `مرحباً بك في بنك فلاش! 🎉 رقم حسابك هو: ${acc.accountNumber}`, type: 'success' });
            await BankLog.create({ action: 'register', description: `حساب جديد تلقائي من فلاش: ${name} — رقم الحساب: ${acc.accountNumber}`, performedBy: uid, performedByTag: name });
            bumpActivity();
        } else if (acc.discordTag !== name) {
            await Account.updateOne({ _id: acc._id }, { discordTag: name });
        }

        req.login({ id: uid, username: name }, (err) => {
            if (err) { console.error('❌ SSO login:', err.message); return res.status(500).send(sp('تعذر تسجيل الدخول.')); }
            res.redirect(pfx(req) + '/');
        });
    } catch (e) {
        console.error('❌ SSO:', e.message);
        res.status(500).send(sp('تعذر الدخول للبنك: ' + e.message));
    }
});
app.get('/logout', (req, res) => req.logout(() => res.redirect(flashHome(req))));

app.get('/api/auth/me', async (req, res) => {
    if (req.isAuthenticated()) {
        const role = await getBankRole(req.user.id);
        let flashRegistered = true;
        if (role === 'user') flashRegistered = await isFlashMember(req.user.id);
        const account = await Account.findOne({ discord: req.user.id });
        const settings = await BankSettings.findOne();
        res.json({ loggedIn: true, user: req.user, role, hasAccount: !!account, maintenance: settings?.isMaintenance || false, flashRegistered, isOwner: await isBankOwner(req.user.id), realOwner: isOwnerUid(req.user.id) });
    } else {
        const settings = await BankSettings.findOne();
        res.json({ loggedIn: false, maintenance: settings?.isMaintenance || false });
    }
});

// ── APIs الحساب ────────────────────────────────────────────────────────────
app.get('/api/account', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json(null);
    try {
        const account = await Account.findOne({ discord: req.user.id });
        res.json(account);
    } catch (e) { res.json(null); }
});

app.get('/api/account/transactions', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const account = await Account.findOne({ discord: req.user.id });
        if (!account) return res.json([]);
        const txs = await Transaction.find({
            $or: [{ fromAccount: account.accountNumber }, { toAccount: account.accountNumber }]
        }).sort({ createdAt: -1 }).limit(50);
        res.json(txs);
    } catch (e) { res.json([]); }
});

// ── APIs داخلية لموقع فلاش (سداد مخالفات المواطنين) ────────────────────────
// يتحقق من رصيد المواطن قبل ما يعرض له فورم البطاقة
app.get('/api/flash/balance/:discordId', ensureInternalFlash, async (req, res) => {
    try {
        const account = await Account.findOne({ discord: req.params.discordId });
        if (!account) return res.json({ success: true, hasAccount: false });
        res.json({ success: true, hasAccount: true, balance: account.balance, isFrozen: !!account.isFrozen });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

// يسدد مخالفة عبر بطاقة المواطن (رقم البطاقة + الرقم السري) — يخصم من رصيده مباشرة
app.post('/api/flash/violations/pay', ensureInternalFlash, checkMaintenance, async (req, res) => {
    try {
        const { discordId, cardNumber, cardPIN, amount, reason } = req.body;
        if (!discordId || !cardNumber || !cardPIN || !amount) {
            return res.json({ success: false, msg: 'بيانات ناقصة' });
        }
        const settings = await BankSettings.findOne();
        if (settings && settings.disableCards) {
            return res.json({ success: false, msg: '🔒 الدفع بالبطاقة موقف حالياً من قبل إدارة البنك.' });
        }

        const account = await Account.findOne({ discord: discordId });
        if (!account) return res.json({ success: false, msg: 'لا يوجد حساب بنكي لهذا المواطن' });
        if (account.isFrozen) return res.json({ success: false, msg: 'الحساب البنكي مجمّد' });

        const normalizedInput = String(cardNumber).replace(/\s/g, '');
        const card = await CardRequest.findOne({ discord: discordId, status: 'approved' });
        if (!card || !card.cardNumber) return res.json({ success: false, msg: 'لا توجد بطاقة بنكية مفعّلة لهذا المواطن' });
        if (card.cardFrozen) return res.json({ success: false, msg: 'البطاقة مجمّدة' });
        if (!card.pinSet) return res.json({ success: false, msg: 'لم يتم تعيين رقم سري لهذه البطاقة بعد' });
        const normalizedStored = String(card.cardNumber).replace(/\s/g, '');
        if (normalizedStored !== normalizedInput || !verifyPin(cardPIN, card.cardPINHash)) {
            return res.json({ success: false, msg: 'رقم البطاقة أو الرقم السري غير صحيح' });
        }

        const amt = Number(amount);
        if (!(amt > 0)) return res.json({ success: false, msg: 'مبلغ غير صالح' });
        if (account.balance < amt) return res.json({ success: false, msg: 'الرصيد لا يكفي' });

        account.balance -= amt;
        await account.save();

        await Transaction.create({
            fromDiscord: discordId, fromAccount: account.accountNumber,
            toDiscord: null, toAccount: null,
            amount: amt, type: 'violation_payment', note: reason || 'سداد مخالفة مرورية',
        });
        await Notification.create({
            discord: discordId, type: 'warning',
            message: `💳 تم خصم ${amt} من حسابك لسداد مخالفة${reason ? ' — ' + reason : ''}. الرصيد الحالي: ${account.balance}`,
        });
        await BankLog.create({
            action: 'violation_payment', description: `سداد مخالفة عبر موقع فلاش — ${reason || ''} — المبلغ: ${amt}`,
            performedBy: discordId, performedByTag: account.discordTag,
        });
        bumpActivity();

        res.json({ success: true, newBalance: account.balance });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

app.post('/api/account/transfer', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    
    // التحقق من قفل التحويل
    const settings = await BankSettings.findOne();
    if (settings && settings.disableTransfer) {
        return res.json({ success: false, msg: "🔒 عذراً، تم إيقاف الحوالات البنكية مؤقتاً من قِبل إدارة البنك." });
    }

    try {
        const { toAccountNumber, amount, note } = req.body;
        const amountNum = parseFloat(amount);
        
        if (!toAccountNumber || !amountNum || amountNum <= 0)
            return res.json({ success: false, msg: "بيانات غير صحيحة" });

        const fromAcc = await Account.findOne({ discord: req.user.id });
        if (!fromAcc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (fromAcc.isFrozen) return res.json({ success: false, msg: "حسابك مجمد، تواصل مع إدارة البنك" });
        if (fromAcc.accountNumber === toAccountNumber) return res.json({ success: false, msg: "لا يمكن التحويل لنفسك" });

        const toAcc = await Account.findOne({ accountNumber: toAccountNumber });
        if (!toAcc) return res.json({ success: false, msg: "رقم الحساب المستهدف غير موجود" });
        if (toAcc.isFrozen) return res.json({ success: false, msg: "الحساب المستهدف مجمد" });

        // رسوم التحويل
        const transferFee = settings?.transferFee || 0;
        const totalDeducted = amountNum + transferFee;
        if (fromAcc.balance < totalDeducted)
            return res.json({ success: false, msg: `رصيدك غير كافٍ${transferFee > 0 ? ` (المبلغ + رسوم التحويل ${transferFee.toLocaleString()} $)` : ''}` });

        await Account.findByIdAndUpdate(fromAcc._id, { $inc: { balance: -totalDeducted } });
        await Account.findByIdAndUpdate(toAcc._id, { $inc: { balance: amountNum } });

        // إرسال رسوم التحويل لحساب رئيس البنك
        if (transferFee > 0 && settings?.transferFeeRecipient) {
            const feeAcc = await Account.findOne({ accountNumber: settings.transferFeeRecipient });
            if (feeAcc) {
                await Account.findByIdAndUpdate(feeAcc._id, { $inc: { balance: transferFee } });
                await Transaction.create({
                    fromAccount: fromAcc.accountNumber,
                    toAccount: feeAcc.accountNumber,
                    amount: transferFee,
                    type: 'transfer_fee',
                    note: `رسوم تحويل من ${fromAcc.discordTag}`
                });
            }
        }

        await Transaction.create({
            fromDiscord: fromAcc.discord,
            toDiscord: toAcc.discord,
            fromAccount: fromAcc.accountNumber,
            toAccount: toAcc.accountNumber,
            amount: amountNum,
            type: 'transfer',
            note: note || 'بدون ملاحظات'
        });

        await Notification.create({
            discord: toAcc.discord,
            message: `📨 تحويل وارد من ${fromAcc.discordTag}: ${amountNum.toLocaleString()} $ | الملاحظة: ${note || 'لا يوجد'}`,
            type: 'info'
        });

        // سجل البنك
        await BankLog.create({ action: 'transfer', description: `تحويل ${amountNum.toLocaleString()} $ من ${fromAcc.discordTag} إلى ${toAcc.discordTag}${transferFee > 0 ? ` + رسوم ${transferFee} $` : ''}`, performedBy: fromAcc.discord, performedByTag: fromAcc.discordTag, targetDiscord: toAcc.discord, targetTag: toAcc.discordTag });

        // إرسال سجل العمليات لديسكورد عبر الويب هوك
        await sendDiscordWebhook(
            "💸 عملية تحويل مالي جديدة",
            `**المُرسِل:** ${fromAcc.discordTag} (${fromAcc.accountNumber})\n**المُستقبِل:** ${toAcc.discordTag} (${toAcc.accountNumber})\n**المبلغ:** ${amountNum.toLocaleString()} $${transferFee > 0 ? `\n**الرسوم:** ${transferFee.toLocaleString()} $` : ''}\n**الملاحظة:** ${note || 'لا يوجد'}`
        );

        bumpActivity();
        res.json({ success: true, msg: `تم التحويل بنجاح${transferFee > 0 ? ` (خُصمت رسوم ${transferFee.toLocaleString()} $)` : ''}`, newBalance: fromAcc.balance - totalDeducted });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.post('/api/account/savings/deposit', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    try {
        const { amount } = req.body;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0) return res.json({ success: false, msg: "مبلغ غير صحيح" });

        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (acc.isFrozen) return res.json({ success: false, msg: "حسابك مجمد" });
        if (acc.balance < amountNum) return res.json({ success: false, msg: "رصيدك غير كافٍ" });

        await Account.findByIdAndUpdate(acc._id, { $inc: { balance: -amountNum, savingsBalance: amountNum } });
        await Transaction.create({
            fromDiscord: acc.discord, fromAccount: acc.accountNumber,
            toAccount: acc.accountNumber, amount: amountNum,
            type: 'savings_deposit', note: 'إيداع في حساب التوفير'
        });

        bumpActivity();
        res.json({ success: true, msg: `تم إيداع ${amountNum.toLocaleString()} $ في التوفير` });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.post('/api/account/savings/withdraw', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    try {
        const { amount } = req.body;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0) return res.json({ success: false, msg: "مبلغ غير صحيح" });

        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (acc.isFrozen) return res.json({ success: false, msg: "حسابك مجمد" });
        if (acc.savingsBalance < amountNum) return res.json({ success: false, msg: "رصيد التوفير غير كافٍ" });

        await Account.findByIdAndUpdate(acc._id, { $inc: { balance: amountNum, savingsBalance: -amountNum } });
        await Transaction.create({
            fromDiscord: acc.discord, fromAccount: acc.accountNumber,
            toAccount: acc.accountNumber, amount: amountNum,
            type: 'savings_withdraw', note: 'سحب من حساب التوفير'
        });

        bumpActivity();
        res.json({ success: true, msg: `تم سحب ${amountNum.toLocaleString()} $ من التوفير` });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.post('/api/account/loan/request', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    
    // التحقق من قفل القروض
    const settings = await BankSettings.findOne();
    if (settings && settings.disableLoans) {
        return res.json({ success: false, msg: "🔒 عذراً، تم إيقاف استقبال طلبات القروض البنكية مؤقتاً بطلب من إدارة البنك." });
    }

    try {
        const { amount } = req.body;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0 || amountNum > 1000000) 
            return res.json({ success: false, msg: "المبلغ غير صحيح (الحد الأقصى 1,000,000 $)" });

        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (acc.isFrozen) return res.json({ success: false, msg: "حسابك مجمد" });

        const existLoan = await Loan.findOne({ discord: req.user.id, status: { $in: ['pending', 'approved'] } });
        if (existLoan) return res.json({ success: false, msg: "عندك قرض قائم، سدد القرض الحالي أولاً" });

        await Loan.create({
            discord: req.user.id,
            discordTag: req.user.username,
            accountNumber: acc.accountNumber,
            amount: amountNum,
            remaining: amountNum
        });

        bumpActivity();
        res.json({ success: true, msg: "تم إرسال طلب القرض لإدارة البنك، انتظر الموافقة" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.post('/api/account/loan/pay', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    try {
        const { amount } = req.body;
        const amountNum = parseFloat(amount);
        if (!amountNum || amountNum <= 0) return res.json({ success: false, msg: "مبلغ غير صحيح" });

        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (acc.balance < amountNum) return res.json({ success: false, msg: "رصيدك غير كافٍ" });

        const loan = await Loan.findOne({ discord: req.user.id, status: 'approved' });
        if (!loan) return res.json({ success: false, msg: "ليس لديك قرض نشط" });

        const payAmount = Math.min(amountNum, loan.remaining);
        const newRemaining = loan.remaining - payAmount;

        if (newRemaining <= 0) {
            await Loan.findByIdAndUpdate(loan._id, { remaining: 0, status: 'paid' });
        } else {
            await Loan.findByIdAndUpdate(loan._id, { remaining: newRemaining });
        }

        await Account.findByIdAndUpdate(acc._id, { $inc: { balance: -payAmount } });
        await Transaction.create({
            fromDiscord: acc.discord, fromAccount: acc.accountNumber,
            amount: payAmount, type: 'loan_pay', note: 'سداد قرض'
        });

        bumpActivity();
        const msg = newRemaining <= 0 ? `✅ تم سداد القرض بالكامل! دفعت ${payAmount.toLocaleString()} $` : `تم سداد ${payAmount.toLocaleString()} $، المتبقي ${newRemaining.toLocaleString()} $`;
        res.json({ success: true, msg });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.get('/api/account/loan', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json(null);
    try {
        const loan = await Loan.findOne({ discord: req.user.id, status: { $in: ['pending', 'approved'] } });
        res.json(loan);
    } catch (e) { res.json(null); }
});

app.get('/api/notifications', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const notifs = await Notification.find({ discord: req.user.id }).sort({ createdAt: -1 }).limit(20);
        res.json(notifs);
    } catch (e) { res.json([]); }
});

app.put('/api/notifications/read', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false });
    try {
        await Notification.updateMany({ discord: req.user.id, read: false }, { read: true });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// ── APIs الإدارة (رئيس البنك + كبار المسؤولين) ────────────────────────────────────────────────────────────
app.get('/api/admin/settings', isBankAdmin, async (req, res) => {
    const s = await BankSettings.findOne();
    res.json(s);
});

// تغيير حالات القفل والميزات
app.post('/api/admin/toggle-feature', isBankAdmin, async (req, res) => {
    try {
        const { feature, value } = req.body;
        const role = await getBankRole(req.user.id);

        // شروط الصلاحيات المطلوبة:
        if ((feature === 'isMaintenance' || feature === 'disableRegister') && role !== 'super_admin') {
            return res.json({ success: false, msg: "⛔ عذراً، هذه الميزة يتحكم بها كبار المسؤولين فقط!" });
        }

        // الميزات المسموحة لرئيس البنك (الأدمن) وكبار المسؤولين
        if (['disableTransfer', 'disableLoans', 'disableCards', 'disableSupport'].includes(feature) || role === 'super_admin') {
            const updateObj = {};
            updateObj[feature] = Object.assign(value);
            // إذا كانوا يقفلون الدعم، الـ reason إجباري
            if (feature === 'disableSupport' && value === true) {
                const { reason } = req.body;
                if (!reason || !reason.trim()) {
                    return res.json({ success: false, msg: "⚠️ يجب إدخال سبب قفل خدمة العملاء" });
                }
                updateObj['disableSupportReason'] = reason.trim();
            }
            if (feature === 'disableSupport' && value === false) {
                updateObj['disableSupportReason'] = '';
            }
            await BankSettings.updateOne({}, updateObj);
            return res.json({ success: true, msg: "تم تحديث حالة القفل بنجاح" });
        }

        return res.json({ success: false, msg: "غير مصرح لك بتعديل هذه الميزة" });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

app.get('/api/admin/accounts', isManagementOrAbove, async (req, res) => {
    try {
        const hid = hiddenOwnerIds(req);
        const accounts = await Account.find(hid.length ? { discord: { $nin: hid } } : {}).sort({ createdAt: -1 });
        res.json(accounts);
    } catch (e) { res.json([]); }
});

app.put('/api/admin/accounts/:id/freeze', isManagementOrAbove, async (req, res) => {
    try {
        const acc = await Account.findById(req.params.id);
        if (!acc) return res.json({ success: false, msg: "الحساب غير موجود" });
        await Account.findByIdAndUpdate(req.params.id, { isFrozen: !acc.isFrozen });
        bumpActivity();
        res.json({ success: true, frozen: !acc.isFrozen });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/admin/accounts/:id/balance', isBankAdmin, async (req, res) => {
    try {
        const myRole = await getBankRole(req.user.id);
        if (myRole !== 'super_admin') return res.json({ success: false, msg: "⛔ الإيداع والخصم اليدوي متاح لكبار المسؤولين فقط" });
        const { amount, type, note } = req.body;
        const amountNum = parseFloat(amount);
        const acc = await Account.findById(req.params.id);
        if (!acc) return res.json({ success: false, msg: "الحساب غير موجود" });

        const change = type === 'add' ? amountNum : -amountNum;
        await Account.findByIdAndUpdate(req.params.id, { $inc: { balance: change } });
        await Transaction.create({
            toAccount: acc.accountNumber,
            amount: amountNum,
            type: type === 'add' ? 'deposit' : 'withdraw',
            note: note || (type === 'add' ? 'إيداع يدوي من الإدارة' : 'خصم يدوي من الإدارة')
        });

        await Notification.create({
            discord: acc.discord,
            message: type === 'add' 
                ? `💰 تم إيداع ${amountNum.toLocaleString()} $ في حسابك من الإدارة. الملاحظة: ${note || 'لا يوجد'}` 
                : `📤 تم خصم ${amountNum.toLocaleString()} $ من حسابك بواسطة الإدارة. الملاحظة: ${note || 'لا يوجد'}`,
            type: type === 'add' ? 'success' : 'warning'
        });

        await BankLog.create({ action: type === 'add' ? 'manual_deposit' : 'manual_deduct', description: `${type === 'add' ? 'إيداع' : 'خصم'} ${amountNum.toLocaleString()} $ ${type === 'add' ? 'في' : 'من'} حساب ${acc.discordTag}${note ? ` — ${note}` : ''}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: acc.discord, targetTag: acc.discordTag });

        bumpActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.get('/api/admin/loans', isStaffOrAbove, async (req, res) => {
    try {
        const hid = hiddenOwnerIds(req);
        const q = { status: { $in: ['pending', 'approved'] } };
        if (hid.length) q.discord = { $nin: hid };
        const loans = await Loan.find(q).sort({ requestedAt: -1 });
        res.json(loans);
    } catch (e) { res.json([]); }
});

app.put('/api/admin/loans/:id/:action', isStaffOrAbove, async (req, res) => {
    try {
        const { id, action } = req.params;
        const loan = await Loan.findById(id);
        if (!loan) return res.json({ success: false, msg: "القرض غير موجود" });

        if (action === 'approve') {
            // تحديد تاريخ انتهاء القرض إن كان مفعلاً
            const settings = await BankSettings.findOne();
            let expiryDate = undefined;
            if (settings?.loanExpiryDays > 0 && (settings.loanExpiryApplyTo === 'new' || settings.loanExpiryApplyTo === 'both')) {
                expiryDate = new Date(Date.now() + settings.loanExpiryDays * 24 * 60 * 60 * 1000);
            }
            await Loan.findByIdAndUpdate(id, { status: 'approved', approvedAt: new Date(), ...(expiryDate ? { expiresAt: expiryDate } : {}) });
            await Account.findOneAndUpdate({ discord: loan.discord }, { $inc: { balance: loan.amount } });
            await Transaction.create({
                toDiscord: loan.discord,
                toAccount: loan.accountNumber,
                amount: loan.amount,
                type: 'loan_receive',
                note: 'قرض بنكي معتمد'
            });
            await Notification.create({
                discord: loan.discord,
                message: `✅ تمت الموافقة على قرضك بمبلغ ${loan.amount.toLocaleString()} $! تم إضافته لرصيدك.${expiryDate ? ` ⏳ ينتهي بتاريخ ${expiryDate.toLocaleDateString('ar-SA')}` : ''}`,
                type: 'success'
            });
            await BankLog.create({ action: 'loan_approve', description: `موافقة على قرض ${loan.discordTag} بمبلغ ${loan.amount.toLocaleString()} $`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: loan.discord, targetTag: loan.discordTag });
        } else {
            await Loan.findByIdAndUpdate(id, { status: 'rejected' });
            await Notification.create({
                discord: loan.discord,
                message: `❌ تم رفض طلب قرضك بمبلغ ${loan.amount.toLocaleString()} $.`,
                type: 'danger'
            });
            await BankLog.create({ action: 'loan_reject', description: `رفض قرض ${loan.discordTag} بمبلغ ${loan.amount.toLocaleString()} $`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: loan.discord, targetTag: loan.discordTag });
        }
        bumpActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// ── APIs رواتب العساكر (ربط مع موقع فلاش — كبار المسؤولين فقط) ──────────────
app.get('/api/superadmin/military-salary/ranks', isBankSuperAdmin, async (req, res) => {
    try {
        const data = await flashGet('/api/bank/ranks');
        if (!data.success) return res.json({ success: false, msg: "تعذر جلب الرتب من موقع فلاش" });

        const settings = await getMilitarySalarySettings();
        const salaries = {};
        data.ranks.forEach(r => { salaries[r] = settings.ranksSalaries.get(r) || 0; });

        res.json({ success: true, ranks: data.ranks, salaries });
    } catch (e) {
        res.json({ success: false, msg: "تعذر الاتصال بموقع فلاش: " + e.message });
    }
});

app.get('/api/superadmin/military-salary/status', isBankSuperAdmin, async (req, res) => {
    const settings = await getMilitarySalarySettings();
    res.json({
        success: true,
        isActive: settings.isActive,
        periodValue: settings.periodValue,
        periodUnit: settings.periodUnit,
        ranksSalaries: Object.fromEntries(settings.ranksSalaries),
        lastPayoutAt: settings.lastPayoutAt,
        nextPayoutAt: settings.nextPayoutAt,
    });
});

app.post('/api/superadmin/military-salary/save', isBankSuperAdmin, async (req, res) => {
    try {
        const { periodValue, periodUnit, ranksSalaries } = req.body;
        if (!periodValue || parseFloat(periodValue) <= 0) return res.json({ success: false, msg: "أدخل مدة صحيحة أكبر من صفر" });
        if (!['days', 'weeks', 'months'].includes(periodUnit)) return res.json({ success: false, msg: "وحدة مدة غير صحيحة" });

        const settings = await getMilitarySalarySettings();
        settings.periodValue = parseFloat(periodValue);
        settings.periodUnit = periodUnit;
        settings.ranksSalaries = new Map(Object.entries(ranksSalaries || {}).map(([r, v]) => [r, Math.max(0, parseFloat(v) || 0)]));
        await settings.save();

        await BankLog.create({ action: 'military_salary_config', description: `تحديث إعدادات رواتب العساكر — كل ${periodValue} ${periodUnit === 'days' ? 'يوم' : periodUnit === 'weeks' ? 'أسبوع' : 'شهر'}`, performedBy: req.user.id, performedByTag: req.user.username });

        res.json({ success: true, msg: "تم حفظ إعدادات الرواتب بنجاح" });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

app.post('/api/superadmin/military-salary/toggle', isBankSuperAdmin, async (req, res) => {
    try {
        const settings = await getMilitarySalarySettings();
        const newActive = !settings.isActive;

        if (newActive) {
            if (!settings.ranksSalaries || settings.ranksSalaries.size === 0) {
                return res.json({ success: false, msg: "يجب تحديد رواتب الرتب وحفظها أولاً قبل التفعيل" });
            }
            const nextPayoutAt = new Date(Date.now() + periodToMs(settings.periodValue, settings.periodUnit));
            await MilitarySalarySettings.updateOne({}, { isActive: true, nextPayoutAt });
            await BankLog.create({ action: 'military_salary_activate', description: `تفعيل رواتب العساكر — أول دفعة بتاريخ ${nextPayoutAt.toLocaleString('ar-SA')}`, performedBy: req.user.id, performedByTag: req.user.username });
        } else {
            await MilitarySalarySettings.updateOne({}, { isActive: false, nextPayoutAt: null });
            await BankLog.create({ action: 'military_salary_deactivate', description: `إيقاف رواتب العساكر`, performedBy: req.user.id, performedByTag: req.user.username });
        }

        res.json({ success: true, isActive: newActive });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

app.post('/api/superadmin/military-salary/run-now', isBankSuperAdmin, async (req, res) => {
    const settings = await getMilitarySalarySettings();
    if (!settings.isActive) return res.json({ success: false, msg: "يجب تفعيل النظام أولاً" });
    const result = await runMilitarySalaryPayout();
    res.json(result);
});

// قائمة العساكر المستحقين (عندهم حساب + راتب لرتبتهم) لاختيار أشخاص محددين للصرف المسبق
app.get('/api/superadmin/military-salary/personnel', isBankSuperAdmin, async (req, res) => {
    try {
        const settings = await getMilitarySalarySettings();
        const data = await flashGet('/api/bank/personnel-ranks');
        if (!data.success) return res.json({ success: false, msg: "تعذر جلب العساكر من فلاش" });
        const ids = data.personnel.map(p => String(p.discord));
        const accs = await Account.find({ discord: { $in: ids } }, { discord: 1, discordTag: 1, isFrozen: 1 }).lean();
        const accMap = new Map(accs.map(a => [String(a.discord), a]));
        const list = [];
        for (const p of data.personnel) {
            const acc = accMap.get(String(p.discord));
            const salary = settings.ranksSalaries.get(p.rank);
            if (!acc || acc.isFrozen || !salary || salary <= 0) continue;
            list.push({ discord: String(p.discord), name: p.registeredName || acc.discordTag || p.discordTag || String(p.discord), rank: p.rank, salary });
        }
        res.json({ success: true, list });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// صرف راتب مسبق لأشخاص محددين فقط (ما يغيّر موعد الدفعة القادمة)
app.post('/api/superadmin/military-salary/pay-selected', isBankSuperAdmin, async (req, res) => {
    try {
        const uids = Array.isArray(req.body.uids) ? req.body.uids.map(String).slice(0, 200) : [];
        if (!uids.length) return res.json({ success: false, msg: "اختر شخص واحد على الأقل" });
        const settings = await getMilitarySalarySettings();
        const data = await flashGet('/api/bank/personnel-ranks');
        if (!data.success) return res.json({ success: false, msg: "تعذر جلب العساكر من فلاش" });
        const set = new Set(uids);
        const chosen = data.personnel.filter(p => set.has(String(p.discord)));
        if (!chosen.length) return res.json({ success: false, msg: "ما لقينا الأشخاص المختارين" });
        const { paidCount, totalPaid } = await payMilitarySalaries(chosen, settings, true);
        if (!paidCount) return res.json({ success: false, msg: "ما تم الصرف: تأكد أن لهم حسابات غير مجمدة ورواتب محددة لرتبهم" });
        await BankLog.create({
            action: 'military_salary_advance',
            description: `صرف راتب مسبق لـ ${paidCount} شخص بإجمالي ${totalPaid.toLocaleString()} $`,
            performedBy: req.user.id, performedByTag: req.user.username
        });
        bumpActivity();
        res.json({ success: true, paidCount, totalPaid });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── APIs البطاقات البنكية ─────────────────────────────────────────────────────

// تقديم طلب بطاقة
app.post('/api/account/card/request', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    const settings = await BankSettings.findOne();
    if (settings && settings.disableCards) return res.json({ success: false, msg: "🔒 طلب البطاقات موقوف حالياً من قِبل الإدارة." });

    try {
        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب بنكي" });
        if (acc.isFrozen) return res.json({ success: false, msg: "حسابك مجمد، لا يمكن طلب بطاقة" });

        // فحص عدد البطاقات المسموح
        const limit = acc.cardLimit !== -1 ? acc.cardLimit : (settings?.globalCardLimit ?? 1);
        const existing = await CardRequest.countDocuments({ discord: req.user.id, status: { $in: ['pending', 'approved'] } });
        if (existing >= limit) return res.json({ success: false, msg: `لقد وصلت للحد الأقصى من البطاقات المسموح بها (${limit})` });

        const { militaryCardNumber, militaryRank, militarySector, militaryUnit, requestReason, pledge } = req.body;
        const mRank = String(militaryRank || '').trim().slice(0, 60);
        const mSector = String(militarySector || '').trim().slice(0, 60);
        const mUnit = String(militaryUnit || '').trim().slice(0, 60);
        const num = String(militaryCardNumber || '').trim().slice(0, 20);
        const reason = String(requestReason || '').trim().slice(0, 500);
        if (!mSector || !mRank || !mUnit) return res.json({ success: false, msg: "يجب تعبئة القطاع والرتبة واليونت" });
        if (!reason) return res.json({ success: false, msg: "اكتب سبب طلب البطاقة" });
        if (!pledge) return res.json({ success: false, msg: "يجب الموافقة على التعهد" });

        // التحقق من البطاقة العسكرية من موقع فلاش (الرتبة/القطاع/اليونت من فلاش مو من المستخدم)
        let info;
        try {
            info = await flashGet('/api/bank/member-card?uid=' + encodeURIComponent(req.user.id));
            if (!info.success) throw new Error(info.msg || 'فشل');
        } catch (e) {
            return res.json({ success: false, msg: "تعذر التحقق من بطاقتك العسكرية من فلاش، جرّب بعد شوي" });
        }

        let autoReject = null;
        if (!info.found) autoReject = 'لا توجد بطاقة عسكرية لك في فلاش';
        else if (!num) autoReject = 'لم تُدخل رقم بطاقتك العسكرية';
        else if (!/^[0-9]{8}$/.test(num) || num !== String(info.cardNumber)) autoReject = 'رقم البطاقة العسكرية غير صحيح أو ليست بطاقتك';
        else if (info.revoked) autoReject = 'بطاقتك العسكرية ملغاة';
        else if (info.blocked) autoReject = 'حسابك العسكري موقوف';

        await CardRequest.create({
            discord: req.user.id,
            discordTag: req.user.username,
            accountNumber: acc.accountNumber,
            requestReason: reason,
            militaryCardNumber: num,
            militaryRank: mRank,
            militarySector: mSector,
            militaryUnit: mUnit,
            flashRank: info.rank || '',
            flashSector: info.sector || '',
            flashUnit: info.unit || '',
            pledgeAccepted: true,
            ...(autoReject ? { status: 'rejected', reviewedAt: new Date(), adminNote: 'رفض تلقائي: ' + autoReject } : {})
        });

        if (autoReject) {
            await Notification.create({ discord: req.user.id, message: `❌ تم رفض طلب البطاقة تلقائياً: ${autoReject}.`, type: 'danger' });
            bumpActivity();
            return res.json({ success: false, msg: "تم رفض طلبك تلقائياً: " + autoReject });
        }

        await Notification.create({
            discord: req.user.id,
            message: `📤 تم إرسال طلب البطاقة البنكية للمراجعة. سيتم إشعارك بالقرار.`,
            type: 'info'
        });

        bumpActivity();
        res.json({ success: true, msg: "✅ تم إرسال طلب البطاقة للمراجعة من قِبل الإدارة" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// قائمة الرتب من فلاش لعرضها في فورم الطلب
app.get('/api/account/card/military-options', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false });
    try {
        const d = await flashGet('/api/bank/ranks');
        res.json({ success: !!d.success, ranks: d.ranks || [] });
    } catch (e) { res.json({ success: false, ranks: [] }); }
});

// عرض طلبات بطاقة المستخدم
app.get('/api/account/cards', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const cards = await CardRequest.find({ discord: req.user.id }).sort({ requestedAt: -1 });
        res.json(cards.map(c => cardSafe(c, false)));
    } catch (e) { res.json([]); }
});

// عرض جميع طلبات البطاقات للأدمن
app.get('/api/admin/cards', isStaffOrAbove, async (req, res) => {
    try {
        const hid = hiddenOwnerIds(req);
        const q = { status: 'pending' };
        if (hid.length) q.discord = { $nin: hid };
        const cards = await CardRequest.find(q).sort({ requestedAt: -1 });
        res.json(cards.map(c => cardSafe(c, true)));
    } catch (e) { res.json([]); }
});

// قرار الأدمن على طلب البطاقة
app.put('/api/admin/cards/:id/:action', isStaffOrAbove, async (req, res) => {
    try {
        const { id, action } = req.params;
        const { adminNote } = req.body;
        const card = await CardRequest.findById(id);
        if (!card) return res.json({ success: false, msg: "الطلب غير موجود" });

        if (action === 'approve') {
            // توليد بيانات بطاقة حقيقية
            const generateCardNumber = () => {
                let num = '';
                for (let i = 0; i < 16; i++) num += Math.floor(Math.random() * 10);
                return num.replace(/(.{4})/g, '$1 ').trim();
            };
            const generateCVV = () => String(Math.floor(100 + Math.random() * 900));
            const cardAcc = await Account.findOne({ discord: card.discord });
            const holderName = cardAcc?.discordTag || card.discordTag;
            const ALLOWED_COLORS = ['blue', 'green', 'red', 'gold', 'purple', 'black'];
            const { cardColor } = req.body;
            const finalColor = ALLOWED_COLORS.includes(cardColor) ? cardColor : 'blue';
            await CardRequest.findByIdAndUpdate(id, {
                status: 'approved', reviewedAt: new Date(), adminNote,
                cardNumber: generateCardNumber(),
                cardHolderName: holderName,
                cardCVV: generateCVV(),
                cardColor: finalColor,
                pinSet: false,
                cardPIN: null, cardPINHash: null
            });
            await Notification.create({
                discord: card.discord,
                message: `✅ تمت الموافقة على طلب بطاقتك البنكية! يمكنك الاطلاع على بيانات بطاقتك في صفحة البطاقات.${adminNote ? ' ملاحظة: ' + adminNote : ''}`,
                type: 'success'
            });
            await BankLog.create({ action: 'card_approve', description: `موافقة على بطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        } else {
            await CardRequest.findByIdAndUpdate(id, { status: 'rejected', reviewedAt: new Date(), adminNote });
            await Notification.create({
                discord: card.discord,
                message: `❌ تم رفض طلب بطاقتك البنكية.${adminNote ? ' السبب: ' + adminNote : ''}`,
                type: 'danger'
            });
            await BankLog.create({ action: 'card_reject', description: `رفض بطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        }
        bumpActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// تعطيل/تفعيل بطاقة من الأدمن (قفل البطاقة من الأدمن لا يفكه المستخدم)
app.put('/api/admin/cards/:id/toggle-disable', isBankAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        const newStatus = card.status === 'disabled' ? 'approved' : 'disabled';
        await CardRequest.findByIdAndUpdate(req.params.id, { status: newStatus });
        await Notification.create({
            discord: card.discord,
            message: newStatus === 'disabled' 
                ? `🚫 تم تعطيل بطاقتك البنكية من قِبل الإدارة. تواصل مع الدعم للاستفسار.`
                : `✅ تم إعادة تفعيل بطاقتك البنكية.`,
            type: newStatus === 'disabled' ? 'danger' : 'success'
        });
        bumpActivity();
        res.json({ success: true, status: newStatus });
    } catch (e) { res.json({ success: false }); }
});

// المستخدم يحط الرقم السري أول مرة بعد الموافقة على بطاقته
app.post('/api/account/card/:id/set-pin', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    try {
        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "يجب أن يتكون الرقم السري من 4 أرقام" });
        const card = await CardRequest.findOne({ _id: req.params.id, discord: req.user.id });
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        if (card.status !== 'approved') return res.json({ success: false, msg: "لا يمكن تعيين رقم سري لهذه البطاقة" });
        if (card.pinSet) return res.json({ success: false, msg: "تم تعيين الرقم السري مسبقاً" });
        await CardRequest.findByIdAndUpdate(card._id, { cardPINHash: hashPin(pin), cardPIN: null, pinSet: true });
        res.json({ success: true, msg: "✅ تم حفظ الرقم السري بنجاح" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── تحكم البطاقة (حق كبار المسؤولين فقط) ──────────────────────────────────
// عرض كل البطاقات المفعّلة (لصفحة تحكم كبار المسؤولين)
app.get('/api/superadmin/cards/control', isBankSuperAdmin, async (req, res) => {
    try {
        const hid = hiddenOwnerIds(req);
        const q = { status: { $in: ['approved', 'disabled'] } };
        if (hid.length) q.discord = { $nin: hid };
        const cards = await CardRequest.find(q).sort({ reviewedAt: -1 });
        res.json(cards.map(c => cardSafe(c, true)));
    } catch (e) { res.json([]); }
});

// إعادة تعيين الرقم السري: ما أحد يشوف الرقم (حتى كبار المسؤولين) — الإعادة تمسحه ويحط العضو رقم جديد بنفسه
app.put('/api/superadmin/cards/:id/pin', isBankSuperAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        await CardRequest.findByIdAndUpdate(card._id, { cardPIN: null, cardPINHash: null, pinSet: false });
        await Notification.create({ discord: card.discord, message: `🔐 تمت إعادة تعيين الرقم السري لبطاقتك. افتح صفحة البطاقات وعيّن رقماً سرياً جديداً (احفظه — ما أحد يعرفه).`, type: 'warning' });
        await BankLog.create({ action: 'card_pin_reset', description: `إعادة تعيين الرقم السري لبطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        bumpActivity();
        res.json({ success: true, msg: "✅ تمت إعادة التعيين — العضو يحط رقماً جديداً بنفسه" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// فريز/فك فريز البطاقة (شكلي — حق كبار المسؤولين فقط)
app.put('/api/superadmin/cards/:id/freeze', isBankSuperAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        const newFrozen = !card.cardFrozen;
        await CardRequest.findByIdAndUpdate(card._id, { cardFrozen: newFrozen });
        await Notification.create({
            discord: card.discord,
            message: newFrozen ? `🔒 تم تجميد بطاقتك من قِبل كبار المسؤولين.` : `🔓 تم فك تجميد بطاقتك.`,
            type: newFrozen ? 'warning' : 'success'
        });
        await BankLog.create({ action: 'card_freeze', description: `${newFrozen ? 'تجميد' : 'فك تجميد'} بطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true, frozen: newFrozen });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// حذف بطاقة نهائياً (حق كبار المسؤولين فقط)
app.delete('/api/superadmin/cards/:id', isBankSuperAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        await CardRequest.findByIdAndDelete(req.params.id);
        await Notification.create({ discord: card.discord, message: `🗑️ تم حذف بطاقتك البنكية نهائياً من قِبل كبار المسؤولين.`, type: 'danger' });
        await BankLog.create({ action: 'card_delete', description: `حذف بطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// تعيين حد البطاقات لحساب معين
app.post('/api/admin/accounts/:id/card-limit', isManagementOrAbove, async (req, res) => {
    try {
        const { limit } = req.body;
        await Account.findByIdAndUpdate(req.params.id, { cardLimit: parseInt(limit) });
        res.json({ success: true, msg: "تم تحديث حد البطاقات" });
    } catch (e) { res.json({ success: false }); }
});

// إرسال إشعار/ملاحظة لحساب من الأدمن
app.post('/api/admin/accounts/:id/notify', isManagementOrAbove, async (req, res) => {
    try {
        const { message } = req.body;
        let { type } = req.body;
        const acc = await Account.findById(req.params.id);
        if (!acc) return res.json({ success: false, msg: "الحساب غير موجود" });
        if (!message) return res.json({ success: false, msg: "الرسالة مطلوبة" });

        // الإداري (management) يقدر يرسل إشعار غير مهم فقط (info)، ما يجيه أي عداد/رقم إشعار للعضو
        const isManagementOnly = req.bankRole === 'management';
        if (isManagementOnly) type = 'info';
        // إشعار الخطر 🚨 (يطلع له صوت عند العضو) مسموح للمالك فقط (كبار المسؤولين)
        if (type === 'danger' && !(await isBankOwner(req.user.id))) {
            return res.json({ success: false, msg: "إشعار الخطر للمالك فقط" });
        }

        await Notification.create({
            discord: acc.discord,
            message: `📢 رسالة من الإدارة: ${message}`,
            type: type || 'info',
            read: isManagementOnly ? true : false   // مقروء مسبقاً حتى ما يظهر رقم إشعار جديد للعضو
        });
        res.json({ success: true, msg: "تم إرسال الإشعار" });
    } catch (e) { res.json({ success: false }); }
});

// حظر/رفع حظر مستخدم من خدمة العملاء
app.put('/api/admin/accounts/:id/support-ban', isBankAdmin, async (req, res) => {
    try {
        const acc = await Account.findById(req.params.id);
        if (!acc) return res.json({ success: false, msg: "الحساب غير موجود" });
        await Account.findByIdAndUpdate(req.params.id, { supportBanned: !acc.supportBanned });
        res.json({ success: true, banned: !acc.supportBanned });
    } catch (e) { res.json({ success: false }); }
});

// تعيين الحد العام للبطاقات
app.post('/api/admin/global-card-limit', isBankAdmin, async (req, res) => {
    try {
        const { limit } = req.body;
        await BankSettings.updateOne({}, { globalCardLimit: parseInt(limit) });
        res.json({ success: true, msg: "تم تحديث الحد العام للبطاقات" });
    } catch (e) { res.json({ success: false }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// 🎧 خدمة العملاء (منقولة من فلاش بالكامل): مساعد آلي، تكتات بالصور والصوت، رد/تعديل/حذف رسائل،
// ملاحظات داخلية، ردود جاهزة، فحص العضو، تقييمات، حظر، تعديل الحساب... كل شي
// ═══════════════════════════════════════════════════════════════════════════
const BANK_CFG = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    SUPPORT_AI_MODEL: process.env.SUPPORT_AI_MODEL || 'claude-sonnet-4-6',
    MAX_PHOTO_MB: 1,
    SITE_NAME: 'بنك فلاش'
};
const SUPPORT_CATEGORIES = ['مشكلة في الحساب البنكي', 'تحويل / رصيد', 'قرض', 'البطاقة البنكية', 'رواتب العساكر', 'اقتراح', 'أخرى'];

// ── الصلاحيات: كبار المسؤولين + المالك المخفي ──
const seniorUids = new Set(SUPER_ADMIN_IDS);
const ownerUids = new Set(String(process.env.BANK_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
async function refreshAuthSets() {
    try {
        const list = await FlashLink.find({ $or: [{ isSenior: true }, { isOwner: true }] }, { uid: 1, isSenior: 1, isOwner: 1 }).lean();
        const sen = new Set(SUPER_ADMIN_IDS), own = new Set(String(process.env.BANK_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
        list.forEach(l => { if (l.isSenior || l.isOwner) sen.add(l.uid); if (l.isOwner) own.add(l.uid); });
        own.forEach(u => sen.add(u));
        seniorUids.clear(); sen.forEach(u => seniorUids.add(u));
        ownerUids.clear(); own.forEach(u => ownerUids.add(u));
    } catch (e) {}
}
setTimeout(refreshAuthSets, 3000);
setInterval(refreshAuthSets, 60 * 1000);
function isSeniorAdmin(uid) { return !!uid && seniorUids.has(String(uid)); }
function isOwnerUid(uid) { return !!uid && ownerUids.has(String(uid)); }
// المالك مخفي عن الكل (حتى كبار المسؤولين) ما عدا نفسه
function hiddenOwnerIds(req) {
    if (req && req.user && ownerUids.has(String(req.user.id))) return [];
    return Array.from(ownerUids);
}
function stealthActor(uid) { return isOwnerUid(uid); }
async function isSupportAdmin(uid) {
    if (!uid) return false;
    if (isSeniorAdmin(uid)) return true;
    const r = await getBankRole(String(uid));
    return r === 'staff' || r === 'management' || r === 'admin' || r === 'super_admin';
}
// يكتب في سجل البنك (نفس واجهة logEvent حقت فلاش)
async function logEvent(o) {
    try {
        await BankLog.create({ action: o.action, description: o.details || '', performedBy: o.actorId || null, performedByTag: o.actorTag || '', targetDiscord: o.discordId || null, targetTag: o.discordTag || '' });
    } catch (e) {}
}
function sseBroadcast() { bumpTicketActivity(); }   // البنك يشتغل بالبولنق (خلف بروكسي فلاش ما يمشي SSE)

// حاجز: خدمة العملاء تحتاج تسجيل دخول + احترام الصيانة/القفل/الحظر
app.use('/api/support', async (req, res, next) => {
    try {
        if (!req.isAuthenticated()) return res.status(401).json({ error: 'سجّل دخولك من فلاش أولاً' });
        const role = await getBankRole(String(req.user.id));
        const staff = ['staff', 'management', 'admin', 'super_admin'].includes(role);
        const s = await BankSettings.findOne();
        if (!staff && s && s.isMaintenance) return res.status(503).json({ error: '🚨 البنك مغلق حالياً للصيانة العامة.' });
        if (!staff && s && s.disableSupport && req.method !== 'GET') return res.status(403).json({ error: s.disableSupportReason || '🔒 خدمة العملاء موقوفة حالياً.' });
        next();
    } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

const SupportTicket = mongoose.model("SupportTicketV2", new mongoose.Schema({
    no: { type: Number, index: true },
    uid: { type: String, default: null, index: true },
    guestToken: { type: String, default: null, index: true },
    deviceToken: { type: String, default: null, index: true },
    name: String,
    category: String,
    place: String,
    subject: String,
    ua: String,
    status: { type: String, default: "ai" },
    adminUid: { type: String, default: null },
    adminName: { type: String, default: null },
    discordMsgId: { type: String, default: null },
    unreadUser: { type: Number, default: 0 },
    unreadAdmin: { type: Number, default: 0 },
    ratingRequired: { type: Boolean, default: false },
    rating: { type: Number, default: null },
    ratingComment: { type: String, default: null },
    ratedAt: { type: Date, default: null },
    closedByUid: { type: String, default: null },
    closedByName: { type: String, default: null },
    shared: { type: [String], default: [] },
    messages: [{
        sender: String,
        name: String,
        text: String,
        image: String,
        imageChannelId: { type: String, default: null }, imageMessageId: { type: String, default: null },
        audio: { type: Buffer, default: undefined },
        audioChannelId: { type: String, default: null }, audioMessageId: { type: String, default: null },
        audioMime: { type: String, default: null }, audioDuration: { type: Number, default: null }, audioWave: { type: String, default: null },
        suggest: Boolean,
        role: String,
        senderUid: { type: String, default: null },
        replyTo: { type: Number, default: null },
        edited: { type: Boolean, default: false }, editedAt: { type: Date, default: null },
        edits: { type: [{ _id: false, text: String, at: Date }], default: [] },
        deleted: { type: Boolean, default: false }, deletedAt: { type: Date, default: null },
        deletedByUid: { type: String, default: null }, deletedByName: { type: String, default: null },
        revealed: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
    }],
    mver: { type: Number, default: 0 },
}, { timestamps: true }));

const SupportRating = mongoose.model("SupportRating", new mongoose.Schema({
    ticketId: String, no: Number, uid: String, name: String, category: String,
    adminUid: { type: String, index: true }, adminName: String,
    stars: Number, comment: String,
    at: { type: Date, default: Date.now },
}));
const SUPPORT_CANNED_SEEDS = [
    { title: "ترحيب", text: "هلا والله 👋 معك إدارة بنك فلاش، كيف أقدر أخدمك؟" },
    { title: "نحتاج لقطة شاشة", text: "ممكن ترسل لقطة شاشة توضح المشكلة؟" },
    { title: "جاري المراجعة", text: "استلمنا طلبك وجاري المراجعة، لا تقفل التكت وبنرد عليك بأقرب وقت 🙏" },
    { title: "تم الحل", text: "تم حل المشكلة ✅ لو احتجت أي شي ثاني افتح تكت جديد، وبنسكّر هذا التكت." },
    { title: "الرقم السري", text: "الرقم السري للبطاقة ما يعرفه أحد ولا حتى الإدارة، إذا نسيته نعيد تعيينه لك وتحط رقم جديد بنفسك." },
];

const SupportBan = mongoose.model("SupportBan", new mongoose.Schema({
    uid: { type: String, default: null, index: true },
    deviceTokens: { type: [String], default: [], index: true },
    name: String,
    reason: String,
    bannedBy: String,
    bannedByName: String,
    createdAt: { type: Date, default: Date.now },
}));
async function supportBanned(uid, gt) {
    if (uid) { try { const a = await Account.findOne({ discord: String(uid) }, { supportBanned: 1 }).lean(); if (a && a.supportBanned) return { uid }; } catch (e) {} }
    const or = [];
    if (uid) or.push({ uid });
    if (gt) or.push({ deviceTokens: gt });
    if (!or.length) return null;
    return SupportBan.findOne({ $or: or }).lean();
}
const SUPPORT_BANNED_MSG = "تم حظرك من خدمة الدعم الفني";

const SUPPORT_AI_PROMPT = [
    "أنت مساعد خدمة العملاء في «بنك فلاش» — نظام بنك داخل لعبة أدوار (محاكاة) تابع لموقع فلاش، ولا يمت للواقع بصلة.",
    "البنك فيه: حساب بنكي لكل عضو، تحويل أموال بين الحسابات برقم الحساب، توفير بفائدة، قروض بموافقة الإدارة، بطاقات بنكية بطلب وموافقة وفيها رقم سري من 4 أرقام يحدده العضو بنفسه، كشف حساب، إشعارات، رواتب العساكر حسب الرتبة، وسداد المخالفات بالبطاقة من موقع فلاش.",
    "الموقع يتحدّث لحظياً بدون ريفرش، فلا تنصح بتحديث الصفحة كحل أول.",
    "",
    "أسلوبك: لهجة سعودية بيضاء بسيطة ومحترمة، ردود قصيرة (٢–٥ أسطر).",
    "إذا المشكلة غير واضحة اسأل سؤال واحد فقط كل مرة: أي صفحة/قسم؟ وش اللي صار بالضبط؟ وش نص الخطأ إن وجد؟ متى صار؟ واطلب لقطة شاشة (يقدر يرفق صورة بزر 📎).",
    "اعطه خطوات عملية قصيرة للمشاكل الشائعة: الدخول للبنك من زر «بنك فلاش» داخل فلاش من جديد، التأكد إن حسابه مو مجمّد، ومراجعة كشف الحساب.",
    "",
    "ممنوع: تخترع ميزات أو قرارات أو وعود. ما تقدر تغيّر أرصدة أو تعتمد قروض أو بطاقات أو تفك تجميد، هذي من صلاحية الإدارة فقط. لا تطلب الرقم السري للبطاقة أبداً ولا تقل إنك تعرفه، وما أحد يعرفه حتى الإدارة.",
    "إذا المشكلة تحتاج إدارة (قرض، بطاقة، رصيد ناقص، حساب مجمّد، شكوى، خطأ ما انحل) قل له يضغط زر «تحدث مع عضو حقيقي» وأضف في آخر ردك العلامة [[HUMAN]] بدون أي شرح لها.",
].join("\n");

function supportGuestToken(req) {
    const g = req.get("x-guest-token") || req.query.gt || "";
    return /^[a-f0-9]{32}$/.test(String(g)) ? String(g) : null;
}
function supportCleanImage(v) {
    if (!v || typeof v !== "string") return null;
    if (v.length > BANK_CFG.MAX_PHOTO_MB * 1024 * 1024 * 1.4) return null;
    return /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v) ? v : null;
}
const SUPPORT_AUDIO_MAX_BYTES = 1200 * 1024;
const SUPPORT_AUDIO_MAX_SEC = 180;
const SUPPORT_AUDIO_EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3" };
function supportCleanAudio(b) {
    if (!b || typeof b.audio !== "string") return null;
    const mime = String(b.audioMime || "").split(";")[0].trim().toLowerCase();
    const ext = SUPPORT_AUDIO_EXT[mime];
    if (!ext) return null;
    if (b.audio.length > SUPPORT_AUDIO_MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/=]+$/.test(b.audio)) return null;
    const buf = Buffer.from(b.audio, "base64");
    if (buf.length < 200 || buf.length > SUPPORT_AUDIO_MAX_BYTES) return null;
    const okMagic = (ext === "webm" && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
        || (ext === "ogg" && buf.toString("latin1", 0, 4) === "OggS")
        || (ext === "m4a" && buf.toString("latin1", 4, 8) === "ftyp")
        || (ext === "mp3" && (buf.toString("latin1", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)));
    if (!okMagic) return null;
    let dur = Math.round(Number(b.audioDuration) || 0);
    dur = Math.min(SUPPORT_AUDIO_MAX_SEC, Math.max(1, dur));
    let wf = typeof b.audioWave === "string" && b.audioWave.length <= 400 && /^[A-Za-z0-9+/=]*$/.test(b.audioWave) ? b.audioWave : "";
    return { buf, mime, ext, dur, wf };
}
async function supportAudioFields(c) {
    const base = { audioMime: c.mime, audioDuration: c.dur, audioWave: c.wf };
    return Object.assign(base, { audio: c.buf });
}
function supportLastPreview(t, forUser) {
    let m = {};
    const arr = t.messages || [];
    for (let i = arr.length - 1; i >= 0; i--) { if (!arr[i].deleted && !(forUser && arr[i].sender === "note")) { m = arr[i]; break; } }
    return (m.text || ((m.audioDuration || m.audioChannelId) ? "🎙️ رسالة صوتية" : "")).slice(0, 60);
}
async function supportLoad(req, res, full) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404).json({ error: "التكت غير موجود" }); return null; }
    const q = SupportTicket.findById(req.params.id);
    if (!full) q.select("-messages.audio");
    const t = await q;
    if (!t) { res.status(404).json({ error: "التكت غير موجود" }); return null; }
    const uid = req.user ? req.user.id : null;
    const gt = supportGuestToken(req);
    let role = null;
    if ((uid && t.uid === uid) || (!t.uid && gt && t.guestToken === gt) || (gt && t.deviceToken && t.deviceToken === gt)) role = "owner";
    else if (uid && await isSupportAdmin(uid)) {
        role = "admin";
        if (!isSeniorAdmin(uid) && !(t.status === "waiting" || t.adminUid === uid)) { res.status(403).json({ error: "هذا التكت مو من صلاحياتك" }); return null; }
    }
    if (!role) { res.status(403).json({ error: "ما عندك صلاحية على هذا التكت" }); return null; }
    return { t, role, uid };
}
// هل الرسالة لهذا المشاهد؟ (العضو: رسايله | الإداري: رسايله هو)
function supportIsOwnMsg(m, role, uid, username) {
    if (role === "owner") return m.sender === "user";
    return m.sender === "admin" && (m.senderUid ? m.senderUid === uid : (!!username && m.name === username));
}
// المحذوف: يشوفه الكبار (أحمر) والعضو فقط إذا الكبار عرضوها له
function supportCanSeeDeleted(m, ctx) { return !!(ctx.senior || (ctx.role === "owner" && m.revealed)); }
function supportPubMsg(m, i, ctx) {
    ctx = ctx || { role: "owner", senior: false, uid: null, username: null, msgs: null };
    if (m.deleted && !supportCanSeeDeleted(m, ctx)) return { i, sender: m.sender, name: m.name, hid: true, at: m.createdAt };
    const o = { i, sender: m.sender, name: m.name, text: m.text || "", img: !!(m.image || m.imageChannelId), aud: !!(m.audio || m.audioChannelId || m.audioDuration), dur: m.audioDuration || 0, wf: m.audioWave || "", suggest: !!m.suggest, role: m.role || null, at: m.createdAt,
        own: supportIsOwnMsg(m, ctx.role, ctx.uid, ctx.username), ed: !!m.edited, edAt: m.editedAt || null };
    if (m.deleted) { o.del = true; o.delBy = m.deletedByName || ""; o.delAt = m.deletedAt || null; o.rev = !!m.revealed; }
    if (typeof m.replyTo === "number" && m.replyTo >= 0 && ctx.msgs && ctx.msgs[m.replyTo]) {
        const q = ctx.msgs[m.replyTo];
        const hidden = (q.sender === "note" && ctx.role !== "admin") || (q.deleted && !supportCanSeeDeleted(q, ctx));
        o.rp = m.replyTo;
        o.rpn = hidden ? "" : (q.name || "");
        o.rpt = hidden ? "رسالة محذوفة" : (q.text ? String(q.text).slice(0, 80) : ((q.audioDuration || q.audioChannelId) ? "🎙️ رسالة صوتية" : ((q.image || q.imageChannelId) ? "📷 صورة" : "")));
    }
    if (ctx.senior && m.edits && m.edits.length) o.edits = m.edits.map(e => ({ text: e.text, at: e.at }));
    return o;
}
function supportCtx(x, req) {
    return { role: x.role, senior: x.role === "admin" && isSeniorAdmin(x.uid), uid: x.uid, username: req.user ? req.user.username : null, msgs: x.t.messages };
}
function supportPubTicket(t) {
    return { id: String(t._id), no: t.no, name: t.name, category: t.category, place: t.place, subject: t.subject, status: t.status, adminName: t.adminName, guest: !t.uid, updatedAt: t.updatedAt, createdAt: t.createdAt, rating: t.rating == null ? null : t.rating, needRate: !!(t.status === "closed" && t.ratingRequired && t.rating == null) };
}
function supportEvent(t, from, extra) { bumpTicketActivity(); }
const supportAiTypingSet = new Set();
function supportTyping(t, on) { if (on) supportAiTypingSet.add(String(t._id)); else supportAiTypingSet.delete(String(t._id)); }
function supportAddMsg(t, m) {
    t.messages.push(Object.assign({ createdAt: new Date() }, m));
}


async function supportImageFields(image) { return image ? { image } : {}; }

async function supportAskAi(t) {
    if (!BANK_CFG.ANTHROPIC_API_KEY || typeof fetch !== "function") return null;
    const convo = t.messages.filter(m => !m.deleted && (m.sender === "user" || m.sender === "ai")).slice(-14);
    let lastImgDataUrl = null;
    {
        const lm = convo[convo.length - 1];
        if (lm && lm.sender === "user") {
            if (lm.image) lastImgDataUrl = lm.image;
        }
    }
    const msgs = [];
    convo.forEach((m, idx) => {
        const role = m.sender === "user" ? "user" : "assistant";
        const parts = [];
        if (role === "user" && (m.image || m.imageChannelId) && idx === convo.length - 1) {
            const mm = lastImgDataUrl ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(lastImgDataUrl) : null;
            if (mm) parts.push({ type: "image", source: { type: "base64", media_type: mm[1], data: mm[2] } });
        }
        parts.push({ type: "text", text: m.text || ((m.image || m.imageChannelId) ? "(أرسل صورة)" : (m.audioDuration ? "(أرسل رسالة صوتية)" : "...")) });
        const last = msgs[msgs.length - 1];
        if (last && last.role === role) last.content.push(...parts); else msgs.push({ role, content: parts });
    });
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length) return null;

    let ctx = "الزائر غير مسجّل دخول (يتواصل من صفحة تسجيل الدخول).";
    if (t.uid) {
        const p = await FlashLink.findOne({ uid: String(t.uid) }).lean();
        const a = await Account.findOne({ discord: String(t.uid) }, { isFrozen: 1 }).lean();
        ctx = "العضو مسجّل دخول: الاسم " + t.name + (p ? "، الرتبة " + (p.rank || "-") + "، اليونت " + (p.unit || "-") : "") + (a ? (a.isFrozen ? "، حسابه البنكي مجمّد" : "، حسابه البنكي شغّال") : "") + ".";
    }
    ctx += " تصنيف التكت: " + (t.category || "-") + (t.place ? " — مكان المشكلة: " + t.place : "") + ". تاريخ اليوم: " + new Date().toISOString().slice(0, 10) + ".";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: ctrl.signal,
            headers: { "content-type": "application/json", "x-api-key": BANK_CFG.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: BANK_CFG.SUPPORT_AI_MODEL, max_tokens: 600, system: SUPPORT_AI_PROMPT + "\n\n" + ctx, messages: msgs }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
        return (d.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim() || null;
    } finally { clearTimeout(timer); }
}

function supportNorm(s) {
    return String(s || "").toLowerCase().replace(/[\u064B-\u065F\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const SUPPORT_FAQ = [
    { id: "human", keys: ["عضو حقيقي", "شخص حقيقي", "اكلم اداري", "ابي اداري", "ابغى اداري", "ابي ادارة", "ابغى ادارة", "موظف", "مسؤول", "مسوول", "بشري", "انسان", "مو بوت", "اكلم احد"], human: true,
      a: "أكيد 👍 اضغط زر «🧑‍💼 تحدث مع عضو حقيقي» فوق، وبيوصل طلبك لفريق الإدارة وأول ما يدخل أحد بيرد عليك هنا مباشرة." },
    { id: "thanks", keys: ["شكرا", "مشكور", "يعطيك العافيه", "الله يعطيك", "تسلم", "جزاك الله", "ممنون"], bare: true,
      a: "العفو 🌹 إذا عندك أي شي ثاني اكتبه لي، وإذا انحلت مشكلتك تقدر تسكّر التكت." },
    { id: "hello", keys: ["السلام عليكم", "سلام عليكم", "هلا", "مرحبا", "اهلين", "اهلا", "هاي", "صباح الخير", "مساء الخير"], bare: true,
      a: "هلا والله 👋 وش المشكلة اللي تواجهك في البنك؟ اكتب لي وين صارت وش اللي صار بالضبط، وإذا فيه رسالة خطأ اكتبها أو أرفق صورة 📎" },
    { id: "login", keys: ["ما اقدر ادخل", "ماقدر ادخل", "ما يدخل", "ما يفتح", "تسجيل الدخول", "تسجيل دخول", "الدخول للبنك", "ما يفتح البنك", "رابط الدخول", "انتهت صلاحية"],
      a: "الدخول للبنك يتم فقط من زر «بنك فلاش» داخل تطبيق فلاش.\n1) ارجع لفلاش واضغط الزر من جديد (رابط الدخول يعيش دقيقة وينستخدم مرة وحدة).\n2) تأكد إن حسابك في فلاش مسجّل ومكتمل.\n3) إذا البنك واقف يظهر لك تنبيه صيانة." },
    { id: "frozen", keys: ["مجمد", "مجمّد", "تجميد", "حسابي موقوف", "فريز", "موقوف"],
      a: "التجميد يصدر من إدارة البنك فقط، وما تقدر تحول وأنت مجمّد. اضغط «تحدث مع عضو حقيقي» ووضّح لهم وبيراجعون حسابك.", human: true },
    { id: "transfer", keys: ["تحويل", "حوالة", "حوالات", "حولت", "ما وصلت", "ما وصل المبلغ", "رقم الحساب", "رسوم التحويل", "رسوم"],
      a: "لتحويل مبلغ: افتح «تحويل»، اكتب رقم حساب المستلم (6 أرقام) والمبلغ، وتأكد إن رصيدك يكفي المبلغ + رسوم التحويل (إن وجدت). التحويل يوصل لحظياً، وتلقاه في «كشف حساب».\nإذا حولت وما وصل، اكتب لي رقم حساب المستلم والمبلغ تقريباً." },
    { id: "balance", keys: ["رصيدي", "الرصيد", "رصيد ناقص", "انخصم", "خصم", "اختفى", "ناقص", "راتبي", "الراتب", "رواتب"],
      a: "كل حركة على حسابك (خصم/إيداع/راتب/رسوم) تنكتب في «كشف حساب» مع التاريخ والملاحظة، راجعه أول.\nرواتب العساكر تنزل تلقائياً حسب رتبتك في الجدول اللي تحدده الإدارة.\nإذا شفت حركة ما تعرفها اضغط «تحدث مع عضو حقيقي».", human: true },
    { id: "savings", keys: ["توفير", "ادخار", "فائدة", "الفايده", "حساب التوفير"],
      a: "حساب التوفير من صفحة «التوفير»: تقدر تودع وتسحب، وتنضاف عليك فائدة بنسبة تحددها إدارة البنك." },
    { id: "loan", keys: ["قرض", "قروض", "اقتراض", "سلفة", "سداد القرض", "ادفع القرض"],
      a: "طلب القرض من صفحة «القروض»: اكتب المبلغ وتنتظر موافقة الإدارة، وإذا انقبل ينزل في رصيدك مباشرة. السداد من نفس الصفحة، وبعض القروض ممكن يكون لها تاريخ انتهاء. إذا انتظرت طويل اضغط «تحدث مع عضو حقيقي».", human: false },
    { id: "card", keys: ["بطاقه", "بطاقة", "بطاقتي", "البطاقه البنكيه", "طلب بطاقه", "رقم البطاقه", "تجديد البطاقه", "جددوا", "منتهيه"],
      a: "البطاقة البنكية من صفحة «بطاقاتي»: تقدم طلب وتكتب رقم بطاقتك العسكرية، وتنتظر موافقة الإدارة. بعد القبول تحط رقمك السري (4 أرقام) وتتفعل البطاقة. إذا انتهت صلاحيتها تقدر تطلب تجديدها من نفس الصفحة." },
    { id: "pin", keys: ["الرقم السري", "رقم سري", "الباسورد", "باسورد", "كلمه المرور", "كلمة المرور", "نسيت الرقم", "نسيت الرقم السري", "pin"],
      a: "الرقم السري للبطاقة تحطه أنت بنفسك أول مرة، وما يظهر على البطاقة ولا يعرفه أحد، حتى الإدارة. لازم تحفظه.\nإذا نسيته اضغط «تحدث مع عضو حقيقي» وتطلب إعادة تعيينه، وتحط رقم جديد بنفسك.", human: true },
    { id: "violation", keys: ["سداد المخالفه", "ادفع المخالفه", "مخالفه", "مخالفات", "دفع المخالفه بالبطاقه"],
      a: "سداد المخالفات يتم من موقع فلاش نفسه بإدخال رقم بطاقتك البنكية ورقمك السري، ويتخصم من رصيدك مباشرة. تأكد إن بطاقتك مفعّلة وغير مجمّدة وإن رصيدك يكفي." },
    { id: "notif", keys: ["اشعار", "اشعارات", "إشعار", "تنبيه"],
      a: "إشعارات البنك تجيك داخل البنك (🔔) وكذلك تنرسل كإشعار على جهازك عبر فلاش إذا كنت مفعّل الإشعارات هناك." },
    { id: "loading", keys: ["جاري التحميل", "جار التحميل", "تعليق", "معلق الموقع", "ما يشتغل", "لا يعمل", "صفحه بيضاء", "bug", "بطيء", "يهنق", "هنق", "فاضيه"],
      a: "البنك يتحدث لحظياً بدون ما تحتاج تحدّث الصفحة، فإذا صار تعليق جرّب:\n1) ارجع لفلاش وافتح البنك من جديد.\n2) تأكد من الإنترنت.\nوإذا لسا موجودة، اكتب لي وش الصفحة وش اللي يظهر لك." },
    { id: "suggest", keys: ["اقتراح", "اقترح", "فكره", "فكرة", "ابي اضيف", "ياليت", "يا ليت"], human: true,
      a: "يسعدنا اقتراحك 🙏 اكتبه هنا بالتفصيل، واضغط «تحدث مع عضو حقيقي» عشان يوصل للإدارة." },
    { id: "complaint", keys: ["شكوى", "شكويه", "اشتكي", "ظلم", "ظلمني", "تعدي", "تجاوز", "سرقه", "نصب"], human: true,
      a: "نأسف لهذا الشي، الشكاوى تتابعها الإدارة مباشرة. اضغط «🧑‍💼 تحدث مع عضو حقيقي» ووضّح لهم القصة وأرفق أي إثبات عندك." },
];
const SUPPORT_HINT = { "مشكلة في الحساب البنكي": "frozen", "تحويل / رصيد": "transfer", "قرض": "loan", "البطاقة البنكية": "card", "رواتب العساكر": "balance", "اقتراح": "suggest", "تسجيل الدخول": "login", "التحويل": "transfer", "القروض": "loan", "بطاقاتي": "card" };

function supportFaqReply(t) {
    const users = t.messages.filter(m => m.sender === "user");
    const lastUser = users[users.length - 1] || {};
    const prevAi = [...t.messages].reverse().find(m => m.sender === "ai");
    const aiCount = t.messages.filter(m => m.sender === "ai").length;
    const text = supportNorm(lastUser.text);
    const out = (txt, human) => ({ text: txt + (human ? " [[HUMAN]]" : ""), suggest: !!human });

    if (!text) {
        return out(users.length > 1 && aiCount >= 1 ? "وصلتنا الصورة 👍 إذا ما قدرت توصف لي المشكلة بكلام، اضغط «تحدث مع عضو حقيقي» وبيشوفها الإداري." : "وصلتنا الصورة 👍 اكتب لي الحين وش المشكلة بالضبط وفي أي صفحة صارت؟", users.length > 1 && aiCount >= 1);
    }
    let best = null, bestScore = 0;
    for (const f of SUPPORT_FAQ) {
        let sc = 0;
        for (const k of f.keys) {
            if (k.charAt(0) === "=") { if (text.split(" ").indexOf(supportNorm(k.slice(1))) !== -1) sc += 1; continue; }
            const nk = supportNorm(k);
            if (nk && text.indexOf(nk) !== -1) sc += nk.indexOf(" ") !== -1 ? 2 : 1;
        }
        if (f.bare && text.split(" ").length > 6) sc = 0;
        if (sc > bestScore) { best = f; bestScore = sc; }
    }
    if (!best && users.length === 1) {
        const hid = SUPPORT_HINT[t.place] || SUPPORT_HINT[t.category];
        if (hid) best = SUPPORT_FAQ.find(f => f.id === hid) || null;
    }
    if (best) {
        const ans = typeof best.a === "function" ? best.a() : best.a;
        const tail = best.id === "hello" || best.id === "thanks" || best.id === "human" ? "" : "\n\nإذا ما انحلت مشكلتك اضغط «تحدث مع عضو حقيقي» 👇";
        if (prevAi && prevAi.text && prevAi.text.indexOf(ans.slice(0, 40)) !== -1 && best.id !== "hello" && best.id !== "thanks") {
            return out("شكلي كررت عليك نفس الجواب 😅 إذا الحل ما نفع، اضغط «تحدث مع عضو حقيقي» وبيتابع معك أحد من الإدارة.", true);
        }
        return out(ans + tail, !!best.human);
    }
    if (aiCount >= 2 || (prevAi && (prevAi.suggest || String(prevAi.text || "").indexOf("ما فهمت مشكلتك") === 0))) {
        return out("ما قدرت أحدد مشكلتك بالضبط 🙏 اضغط «تحدث مع عضو حقيقي» وبيساعدك أحد من الإدارة.", true);
    }
    return out("ما فهمت مشكلتك بالضبط، ممكن توضح لي أكثر؟\n• في أي صفحة صارت؟\n• وش اللي صار بالضبط؟\n• هل ظهرت لك رسالة خطأ؟ (اكتبها أو أرفق صورة 📎)", false);
}

const supportAiBusy = new Set();
const supportAiAgain = new Set();
async function supportRunAi(id) {
    if (supportAiBusy.has(id)) { supportAiAgain.add(id); return; }
    supportAiBusy.add(id);
    try {
        let t = await SupportTicket.findById(id);
        if (!t || t.status !== "ai") return;
        supportTyping(t, true);
        let text = null;
        const aiCount = t.messages.filter(m => m.sender === "ai").length;
        if (aiCount < 40) {
            if (CONFIG.ANTHROPIC_API_KEY) { try { text = await supportAskAi(t); } catch (e) { console.error("❌ فشل المساعد الآلي:", e.message); } }
            if (!text) {
                if (!CONFIG.ANTHROPIC_API_KEY) await new Promise(r => setTimeout(r, 900));
                const f = supportFaqReply(t);
                text = f.text;
            }
        }
        t = await SupportTicket.findById(id);
        if (!t || t.status !== "ai") { if (t) supportTyping(t, false); return; }
        let suggest = false;
        if (!text) {
            text = "ما قدرت أرد عليك الحين 🙏 اضغط زر «تحدث مع عضو حقيقي» وبيتواصل معك أحد من الإدارة.";
            suggest = true;
        } else if (text.indexOf("[[HUMAN]]") !== -1) {
            text = text.split("[[HUMAN]]").join("").trim();
            suggest = true;
        }
        supportAddMsg(t, { sender: "ai", name: "المساعد الآلي", text: text.slice(0, 1800), suggest });
        t.unreadUser += 1;
        await t.save();
        supportTyping(t, false);
        supportEvent(t, "ai");
    } catch (e) {
        console.error("❌ supportRunAi:", e.message);
    } finally {
        supportAiBusy.delete(id);
        if (supportAiAgain.delete(id)) supportRunAi(id);
    }
}

async function supportNotifyDiscord(t) {
    try {
        const lastUser = [...t.messages].reverse().find(m => m.sender === "user");
        await sendDiscordWebhook("🎧 تكت دعم جديد #" + t.no + " بانتظار إداري",
            "**العضو:** " + (t.name || "-") + "\n**التصنيف:** " + (t.category || "-") + (t.place ? " — " + t.place : "") + "\n**آخر رسالة:** " + String((lastUser && lastUser.text) || (lastUser && lastUser.image ? "(صورة)" : "-")).slice(0, 700), 15105815);
    } catch (e) { console.error("❌ فشل إشعار ويب هوك التكت:", e.message); }
}
async function supportDiscordJoined(t) { }

const supportGuestThrottle = new Map();
const supportCreateLock = new Set();
function supportClientIp(req) { return String((req.headers["x-forwarded-for"] || req.ip || "")).split(",")[0].trim(); }
app.post("/api/support/tickets", async (req, res) => {
    const uid = req.user ? req.user.id : null;
    const gt = supportGuestToken(req);
    if (!uid && !gt) return res.status(400).json({ error: "تعذر تحديد هويتك، حدّث الصفحة وحاول مرة ثانية" });
    if (await supportBanned(uid, gt)) return res.status(403).json({ error: SUPPORT_BANNED_MSG });
    const b = req.body || {};
    const name = uid ? String(req.user.username || "عضو") : String(b.name || "").trim().slice(0, 40);
    if (!uid && name.length < 2) return res.status(400).json({ error: "اكتب اسمك" });
    const text = String(b.text || "").trim().slice(0, 1500);
    const image = supportCleanImage(b.image);
    if (b.image && !image) return res.status(400).json({ error: "الصورة غير صالحة أو حجمها كبير" });
    if (!text && !image) return res.status(400).json({ error: "اكتب وصف المشكلة" });
    if (!uid) {
        const ip = supportClientIp(req);
        const arr = (supportGuestThrottle.get(ip) || []).filter(x => Date.now() - x < 3600000);
        if (arr.length >= 5) return res.status(429).json({ error: "فتحت تكتات كثير، جرّب بعد شوي" });
        arr.push(Date.now()); supportGuestThrottle.set(ip, arr);
    }
    const lockKey = (uid || "") + "|" + (gt || "");
    if (supportCreateLock.has(lockKey)) return res.status(429).json({ error: "لحظة، طلبك السابق قيد التنفيذ" });
    supportCreateLock.add(lockKey);
    try {
    const idOr = [];
    if (uid) idOr.push({ uid });
    if (gt) idOr.push({ deviceToken: gt }, { guestToken: gt });
    const open = await SupportTicket.countDocuments({ status: { $ne: "closed" }, $or: idOr });
    if (open >= 1) return res.status(400).json({ error: "عندك تكت مفتوح على هذا الجهاز، لازم تسكّره أول عشان تقدر تفتح تكت جديد" });
    const unrated = await SupportTicket.findOne({ status: "closed", ratingRequired: true, rating: null, $or: idOr }).select("_id").lean();
    if (unrated) return res.status(400).json({ error: "لازم تقيّم تكتك السابق أول عشان تقدر تفتح تكت جديد", needRate: String(unrated._id) });
    const last = await SupportTicket.findOne().sort({ no: -1 }).select("no").lean();
    const category = SUPPORT_CATEGORIES.includes(b.category) ? b.category : "أخرى";
    const place = category === "أخرى" ? "" : String(b.place || "").replace(/[<>]/g, "").trim().slice(0, 60);
    const t = await SupportTicket.create({
        no: ((last && last.no) || 1000) + 1,
        uid, guestToken: uid ? null : gt, deviceToken: gt, name, category, place,
        subject: (text || "صورة").slice(0, 60),
        ua: String(req.get("user-agent") || "").slice(0, 160),
        status: "ai",
        messages: [Object.assign({ sender: "user", name, text }, await supportImageFields(image))],
    });
    res.json({ ok: true, id: String(t._id) });
    supportEvent(t, "user", { kind: "new" });
    supportRunAi(String(t._id));
    } finally { supportCreateLock.delete(lockKey); }
});

app.get("/api/support/tickets", async (req, res) => {
    const uid = req.user ? req.user.id : null;
    const gt = supportGuestToken(req);
    const or = [];
    if (uid) or.push({ uid });
    if (gt) or.push({ guestToken: gt, uid: null }, { deviceToken: gt });
    if (!or.length) return res.json({ tickets: [] });
    const banned = !!(await supportBanned(uid, gt));
    const list = await SupportTicket.find({ $or: or }).sort({ updatedAt: -1 }).limit(50).select("-messages.image -messages.audio").lean();
    res.json({ banned, tickets: list.map(t => Object.assign(supportPubTicket(t), { unread: t.unreadUser || 0, last: supportLastPreview(t, true) })) });
});

app.get("/api/support/badges", async (req, res) => {
    const uid = req.user ? req.user.id : null;
    const gt = supportGuestToken(req);
    const or = [];
    if (uid) or.push({ uid });
    if (gt) or.push({ guestToken: gt, uid: null }, { deviceToken: gt });
    const out = { user: 0, admin: null };
    if (or.length) out.user = await SupportTicket.countDocuments({ $or: or, unreadUser: { $gt: 0 } });
    if (uid && await isSupportAdmin(uid)) {
        if (isSeniorAdmin(uid)) {
            out.admin = {
                waiting: await SupportTicket.countDocuments({ status: "waiting" }),
                unread: await SupportTicket.countDocuments({ status: { $in: ["waiting", "active"] }, unreadAdmin: { $gt: 0 } }),
            };
        } else {
            out.admin = {
                waiting: await SupportTicket.countDocuments({ status: "waiting" }),
                unread: await SupportTicket.countDocuments({ status: "active", adminUid: uid, unreadAdmin: { $gt: 0 } }),
            };
        }
    }
    res.json(out);
});

app.get("/api/support/tickets/:id", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const { t, role } = x;
    const sctx = supportCtx(x, req);
    const msgs = t.messages.map((m, i) => supportPubMsg(m, i, sctx)).slice(after).filter(m => role === "admin" || m.sender !== "note");
    if (role === "owner" && t.unreadUser) { t.unreadUser = 0; await t.save(); }
    if (role === "admin" && t.unreadAdmin) { t.unreadAdmin = 0; await t.save(); }
    const canInspect = role === "admin" && supportCanInspect(t, x.uid);
    res.json({ ticket: supportPubTicket(t), role, msgs, n: t.messages.length, mver: t.mver || 0, shared: (role === "owner" || canInspect) ? (t.shared || []) : [], canInspect, typing: supportAiTypingSet.has(String(t._id)), peers: supportPeersFor(t, req) });
});

app.get("/api/support/tickets/:id/img/:i", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const m = x.t.messages[parseInt(req.params.i, 10)];
    if (m && m.deleted && !supportCanSeeDeleted(m, supportCtx(x, req))) return res.status(404).end();
    const mm = m && m.image ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(m.image) : null;
    if (!mm) return res.status(404).end();
    res.set({ "Content-Type": mm[1], "Cache-Control": "private, max-age=86400" });
    res.send(Buffer.from(mm[2], "base64"));
});

app.get("/api/support/tickets/:id/audio/:i", async (req, res) => {
    const x = await supportLoad(req, res, true); if (!x) return;
    const m = x.t.messages[parseInt(req.params.i, 10)];
    if (!m) return res.status(404).end();
    if (m.deleted && !supportCanSeeDeleted(m, supportCtx(x, req))) return res.status(404).end();
    const hasDb = !!(m.audio && m.audio.length);
    if (!hasDb) return res.status(404).end();
    const buf = Buffer.from(m.audio);
    const size = buf.length;
    const h = { "Content-Type": m.audioMime || "audio/webm", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" };
    const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (rg && (rg[1] || rg[2])) {
        let start, end;
        if (rg[1] === "") { start = Math.max(0, size - parseInt(rg[2], 10)); end = size - 1; }
        else { start = parseInt(rg[1], 10); end = rg[2] ? Math.min(parseInt(rg[2], 10), size - 1) : size - 1; }
        if (!(start <= end) || start >= size) { res.set("Content-Range", "bytes */" + size); return res.status(416).end(); }
        res.status(206).set(Object.assign(h, { "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 }));
        return res.end(buf.subarray(start, end + 1));
    }
    res.set(Object.assign(h, { "Content-Length": size }));
    res.end(buf);
});

// رد المساعد الآلي على الرسالة الصوتية (ما يسمع الصوت)
async function supportVoiceAiReply(id) {
    try {
        const t = await SupportTicket.findById(id).select("-messages.audio");
        if (!t || t.status !== "ai") return;
        supportAddMsg(t, { sender: "ai", name: "المساعد الآلي", text: "🎙️ وصلتني رسالتك الصوتية، بس أنا مساعد آلي وما أقدر أسمع الصوت. اكتب مشكلتك كتابة وأساعدك، أو اضغط «تحدث مع عضو حقيقي» عشان الإداري يسمع رسالتك.", suggest: true });
        t.unreadUser += 1;
        await t.save();
        supportEvent(t, "ai");
    } catch (e) { console.error("❌ supportVoiceAiReply:", e.message); }
}

const supportMsgThrottle = new Map();
app.post("/api/support/tickets/:id/messages", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (t.status === "closed") return res.status(400).json({ error: "التكت مغلق" });
    const key = String(t._id) + ":" + role;
    if (Date.now() - (supportMsgThrottle.get(key) || 0) < 700) return res.status(429).json({ error: "على راحتك شوي" });
    supportMsgThrottle.set(key, Date.now());
    const audioIn = (req.body || {}).audio ? supportCleanAudio(req.body) : null;
    if ((req.body || {}).audio && !audioIn) return res.status(400).json({ error: "الرسالة الصوتية غير صالحة أو حجمها كبير" });
    const text = audioIn ? "" : String((req.body || {}).text || "").trim().slice(0, 1500);
    const image = audioIn ? null : supportCleanImage((req.body || {}).image);
    if (!audioIn && (req.body || {}).image && !image) return res.status(400).json({ error: "الصورة غير صالحة أو حجمها كبير" });
    if (!text && !image && !audioIn) return res.status(400).json({ error: "اكتب رسالة أو أرفق صورة" });
    if (audioIn && t.messages.filter(m => m.audioDuration || m.audioChannelId).length >= 5) return res.status(400).json({ error: "وصلت الحد الأقصى للرسائل الصوتية بهذا التكت" });
    if (t.messages.length >= 250) return res.status(400).json({ error: "وصل التكت للحد الأقصى من الرسائل، افتح تكت جديد" });
    if (image && t.messages.filter(m => m.image || m.imageChannelId).length >= 6) return res.status(400).json({ error: "وصلت الحد الأقصى للصور بهذا التكت" });
    // رد على رسالة (اقتباس): لازم الرسالة موجودة وما تكون محذوفة أو ملاحظة داخلية للعضو
    let replyTo = null;
    const rpIn = (req.body || {}).replyTo;
    if (rpIn !== undefined && rpIn !== null && rpIn !== "") {
        const k = parseInt(rpIn, 10), q = t.messages[k];
        const qOk = q && !q.deleted && q.sender !== "system" && !(q.sender === "note" && role !== "admin");
        if (!(k >= 0 && qOk)) return res.status(400).json({ error: "الرسالة اللي تبي ترد عليها غير موجودة" });
        replyTo = k;
    }

    if (role === "owner") {
        if (await supportBanned(uid, supportGuestToken(req))) return res.status(403).json({ error: SUPPORT_BANNED_MSG });
        supportAddMsg(t, Object.assign({ sender: "user", name: t.name, text, senderUid: uid || null, replyTo }, await supportImageFields(image), audioIn ? await supportAudioFields(audioIn) : {}));
        if (t.status !== "ai") t.unreadAdmin += 1;
        await t.save();
        res.json({ ok: true });
        supportEvent(t, "user");
        if (t.status === "ai") { if (audioIn) supportVoiceAiReply(String(t._id)); else supportRunAi(String(t._id)); }
    } else {
        const senior = isSeniorAdmin(uid);
        if (!senior && t.status !== "active") return res.status(400).json({ error: "استلم التكت أول عشان تقدر ترد" });
        if (!senior && t.adminUid !== uid) return res.status(403).json({ error: "هذا التكت مستلمه " + (t.adminName || "إداري ثاني") });
        if (senior && t.status === "ai") t.status = "waiting";
        supportAddMsg(t, Object.assign({ sender: "admin", name: req.user.username, role: senior ? "senior" : "admin", text, senderUid: uid, replyTo }, await supportImageFields(image), audioIn ? await supportAudioFields(audioIn) : {}));
        t.unreadUser += 1;
        await t.save();
        res.json({ ok: true });
        supportEvent(t, "admin");
    }
});

// ── خيارات الرسالة: تعديل (صاحبها) / حذف (صاحبها أو الكبار) / عرض المحذوف للعضو (الكبار) ──
async function supportMsgLoad(req, res) {
    const x = await supportLoad(req, res); if (!x) return null;
    const i = parseInt(req.params.i, 10);
    const m = x.t.messages[i];
    if (!(i >= 0) || !m) { res.status(404).json({ error: "الرسالة غير موجودة" }); return null; }
    x.i = i; x.m = m; x.senior = x.role === "admin" && isSeniorAdmin(x.uid);
    return x;
}
app.post("/api/support/tickets/:id/messages/:i/edit", async (req, res) => {
    const x = await supportMsgLoad(req, res); if (!x) return;
    const { t, m } = x;
    if (t.status === "closed") return res.status(400).json({ error: "التكت مغلق" });
    if (m.deleted) return res.status(400).json({ error: "الرسالة محذوفة" });
    if (m.sender !== "user" && m.sender !== "admin") return res.status(400).json({ error: "هذي الرسالة ما تنعدل" });
    if (!supportIsOwnMsg(m, x.role, x.uid, req.user ? req.user.username : null)) return res.status(403).json({ error: "تعدّل رسايلك أنت بس" });
    if (m.audio || m.audioChannelId || m.audioDuration) return res.status(400).json({ error: "الرسالة الصوتية ما تنعدل" });
    const text = String((req.body || {}).text || "").trim().slice(0, 1500);
    if (!text) return res.status(400).json({ error: "اكتب النص الجديد" });
    if (text === (m.text || "")) return res.json({ ok: true });
    if (!m.edits) m.edits = [];
    m.edits.push({ text: m.text || "", at: new Date() });
    if (m.edits.length > 20) m.edits = m.edits.slice(-20);
    m.text = text; m.edited = true; m.editedAt = new Date();
    t.mver = (t.mver || 0) + 1;
    await t.save();
    res.json({ ok: true });
    supportEvent(t, x.role === "owner" ? "user" : "admin");
});
app.post("/api/support/tickets/:id/messages/:i/delete", async (req, res) => {
    const x = await supportMsgLoad(req, res); if (!x) return;
    const { t, m } = x;
    if (m.deleted) return res.status(400).json({ error: "الرسالة محذوفة من قبل" });
    if (m.sender === "system" || m.sender === "note") return res.status(400).json({ error: "هذي الرسالة ما تنحذف" });
    const own = supportIsOwnMsg(m, x.role, x.uid, req.user ? req.user.username : null);
    if (!own && !x.senior) return res.status(403).json({ error: "تحذف رسايلك أنت بس" });
    if (t.status === "closed" && !x.senior) return res.status(400).json({ error: "التكت مغلق" });
    const dn = x.role === "owner" ? (t.name || "العضو") : (stealthActor(x.uid) ? "كبار المسؤولين" : req.user.username);
    m.deleted = true; m.deletedAt = new Date(); m.deletedByUid = x.uid || null; m.deletedByName = dn; m.revealed = false;
    supportAddMsg(t, { sender: "system", name: dn, text: own ? (dn + " حذف رسالة") : (dn + " حذف رسالة " + (m.name || "")).trim() });
    t.mver = (t.mver || 0) + 1;
    await t.save();
    res.json({ ok: true });
    supportEvent(t, x.role === "owner" ? "user" : "admin");
});
app.post("/api/support/tickets/:id/messages/:i/reveal", async (req, res) => {
    const x = await supportMsgLoad(req, res); if (!x) return;
    const { t, m } = x;
    if (!x.senior) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    if (!m.deleted) return res.status(400).json({ error: "هذي الرسالة مو محذوفة" });
    m.revealed = !!(req.body || {}).show;
    t.mver = (t.mver || 0) + 1;
    await t.save();
    res.json({ ok: true, revealed: m.revealed });
    supportEvent(t, "admin");
});

app.post("/api/support/tickets/:id/human", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role } = x;
    if (role !== "owner") return res.status(403).json({ error: "هذا الزر لصاحب التكت" });
    if (t.status !== "ai") return res.status(400).json({ error: t.status === "closed" ? "التكت مغلق" : "طلبك وصل للإدارة من قبل" });
    t.status = "waiting";
    supportAddMsg(t, { sender: "system", name: "النظام", text: "📨 تم إرسال طلبك لفريق الإدارة، أول ما يدخل إداري بتوصلك رسالته هنا مباشرة." });
    t.unreadAdmin += 1;
    await t.save();
    res.json({ ok: true });
    supportEvent(t, "system", { kind: "human" });
    supportNotifyDiscord(t);
});

app.post("/api/support/admin/tickets/:id/join", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    const x = await supportLoad(req, res); if (!x) return;
    const { t } = x;
    if (t.status === "closed") return res.status(400).json({ error: "التكت مغلق" });
    if (t.status === "active" && t.adminUid && t.adminUid !== req.user.id) return res.status(400).json({ error: "هذا التكت مستلمه " + t.adminName });
    if (t.status === "active" && t.adminUid === req.user.id) return res.json({ ok: true });
    t.status = "active";
    t.adminUid = req.user.id;
    t.adminName = req.user.username;
    supportAddMsg(t, { sender: "system", name: "النظام", text: "✅ دخل الإداري " + req.user.username + " للتكت" });
    t.unreadUser += 1;
    await t.save();
    res.json({ ok: true });
    supportEvent(t, "system", { kind: "join" });
    supportDiscordJoined(t);
});

app.post("/api/support/tickets/:id/close", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (role !== "admin" && !(uid && isSeniorAdmin(uid))) return res.status(403).json({ error: "إغلاق التكت من الإدارة فقط" });
    if (t.status === "closed") return res.json({ ok: true });
    t.status = "closed";
    t.ratingRequired = true;
    t.closedByUid = uid; t.closedByName = req.user.username;
    supportAddMsg(t, { sender: "system", name: "النظام", text: "🔒 تم إغلاق التكت بواسطة " + req.user.username });
    t.unreadUser += 1;
    await t.save();
    res.json({ ok: true });
    supportEvent(t, "system", { kind: "close" });
});

app.post("/api/support/tickets/:id/rate", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role } = x;
    if (role !== "owner") return res.status(403).json({ error: "التقييم لصاحب التكت فقط" });
    if (t.status !== "closed") return res.status(400).json({ error: "التكت لسا مفتوح" });
    const stars = parseInt((req.body || {}).stars, 10);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: "اختر من 1 إلى 5 نجوم" });
    const comment = String((req.body || {}).comment || "").replace(/[<>]/g, "").trim().slice(0, 300);
    const r = await SupportTicket.updateOne({ _id: t._id, rating: null }, { $set: { rating: stars, ratingComment: comment, ratedAt: new Date() } });
    if (!(r.modifiedCount ?? r.nModified)) return res.status(400).json({ error: "سبق وقيّمت هذا التكت" });
    const who = t.adminUid ? { uid: t.adminUid, name: t.adminName } : { uid: t.closedByUid || "none", name: t.closedByName || "غير محدد" };
    await SupportRating.create({ ticketId: String(t._id), no: t.no, uid: t.uid, name: t.name, category: t.category, adminUid: who.uid, adminName: who.name, stars, comment });
    res.json({ ok: true });
    supportEvent(t, "user", { kind: "rate" });
});

app.get("/api/support/admin/ratings/:uid", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    const list = await SupportRating.find({ adminUid: String(req.params.uid) }).sort({ at: -1 }).limit(200).lean();
    res.json({ list: list.map(r => ({ ticketId: r.ticketId, no: r.no, name: r.name, category: r.category, stars: r.stars, comment: r.comment || "", at: r.at })) });
});
app.get("/api/support/admin/ratings", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    const cnt = n => ({ $sum: { $cond: [{ $eq: ["$stars", n] }, 1, 0] } });
    const admins = await SupportRating.aggregate([
        { $group: { _id: "$adminUid", name: { $last: "$adminName" }, count: { $sum: 1 }, avg: { $avg: "$stars" }, s1: cnt(1), s2: cnt(2), s3: cnt(3), s4: cnt(4), s5: cnt(5) } },
        { $sort: { avg: -1, count: -1 } },
    ]);
    const recent = await SupportRating.find({ comment: { $nin: [null, ""] } }).sort({ at: -1 }).limit(30).lean();
    const total = admins.reduce((a, r) => a + r.count, 0);
    const sum = admins.reduce((a, r) => a + r.avg * r.count, 0);
    res.json({
        total, avg: total ? sum / total : 0,
        admins: admins.map(r => ({ uid: r._id, name: r.name || "-", count: r.count, avg: r.avg, dist: [r.s1, r.s2, r.s3, r.s4, r.s5] })),
        recent: recent.map(r => ({ no: r.no, name: r.name, adminName: r.adminName, stars: r.stars, comment: r.comment, category: r.category, at: r.at })),
    });
});

app.post("/api/support/tickets/:id/note", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (role !== "admin") return res.status(403).json({ error: "الملاحظات الداخلية للإدارة فقط" });
    if (t.status === "closed") return res.status(400).json({ error: "التكت مغلق" });
    const senior = isSeniorAdmin(uid);
    if (!senior && t.adminUid !== uid) return res.status(403).json({ error: "استلم التكت أول" });
    const text = String((req.body || {}).text || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "اكتب الملاحظة" });
    if (t.messages.length >= 250) return res.status(400).json({ error: "وصل التكت للحد الأقصى من الرسائل" });
    supportAddMsg(t, { sender: "note", name: req.user.username, role: senior ? "senior" : "admin", text });
    await t.save();
    res.json({ ok: true });
    sseBroadcast("ticket", { id: String(t._id), status: t.status, n: t.messages.length, from: "note" }, c => c.isAdmin);
});

async function supportCannedList() {
    const s = await BankSettings.findOne();
    if (!s.supportCanned || !s.supportCanned.length) {
        s.supportCanned = SUPPORT_CANNED_SEEDS.map(r => ({ title: r.title, text: r.text }));
        await s.save();
    }
    return s;
}
app.get("/api/support/admin/canned", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    const s = await supportCannedList();
    res.json({ list: s.supportCanned.map(r => ({ id: String(r._id), title: r.title, text: r.text })) });
});
app.post("/api/support/admin/canned", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    const title = String((req.body || {}).title || "").replace(/[<>]/g, "").trim().slice(0, 40);
    const text = String((req.body || {}).text || "").replace(/[<>]/g, "").trim().slice(0, 500);
    if (!title || !text) return res.status(400).json({ error: "اكتب العنوان والنص" });
    const s = await supportCannedList();
    if (s.supportCanned.length >= 30) return res.status(400).json({ error: "وصلت الحد الأقصى (30 رد)" });
    s.supportCanned.push({ title, text });
    await s.save();
    res.json({ ok: true });
});
app.delete("/api/support/admin/canned/:rid", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    const s = await supportCannedList();
    const before = s.supportCanned.length;
    s.supportCanned = s.supportCanned.filter(r => String(r._id) !== req.params.rid);
    if (s.supportCanned.length === before) return res.status(404).json({ error: "غير موجود" });
    await s.save();
    res.json({ ok: true });
});


// ---------- فحص العضو داخل التكت (الإداري يختار كل خانة تظهر للعضو) ----------
const SUPPORT_CATS = {
    account: { title: "معلومات الحساب البنكي", keys: ["account.name", "account.number", "account.balance", "account.savings", "account.status", "account.created"] },
    card: { title: "معلومات البطاقة", keys: ["card.status", "card.number", "card.holder", "card.expiry"] },
    transfers: { title: "الحوالات", keys: ["tx.lastIn", "tx.lastOut", "tx.count"] },
    loans: { title: "القروض", keys: ["loan.active", "loan.remaining", "loan.pending"] },
    flash: { title: "معلومات فلاش", keys: ["flash.name", "flash.rank", "flash.unit"] },
    log: { title: "آخر حركات الحساب", keys: [] },
};
const SUPPORT_FIXED_KEYS = [].concat(...Object.values(SUPPORT_CATS).map(c => c.keys));
const SUPPORT_DYN_KEY = /^tx:[a-f0-9]{24}$/;
function supportCanInspect(t, uid) {
    return !!uid && (isSeniorAdmin(uid) || (t.status === "active" && t.adminUid === uid));
}
const TX_LABELS = { transfer: "حوالة", deposit: "إيداع", withdraw: "خصم", loan_receive: "استلام قرض", loan_pay: "سداد قرض", savings_deposit: "إيداع توفير", savings_withdraw: "سحب توفير", interest: "فائدة", transfer_fee: "رسوم تحويل", card_renewal_fee: "رسوم تجديد بطاقة", violation_payment: "سداد مخالفة" };
async function supportCatRows(cat, uid, opts) {
    const only = opts.only || null;
    if (only) {
        const has = cat === "log" ? Array.from(only).some(k => SUPPORT_DYN_KEY.test(k)) : SUPPORT_CATS[cat].keys.some(k => only.has(k));
        if (!has) return [];
    }
    const R = (k, l, v) => ({ k, l, v: v == null || v === "" ? "—" : String(v) });
    const D = (k, l, v) => ({ k, l, v: v ? new Date(v).toISOString() : "—", d: !!v });
    const money = n => (Number(n) || 0).toLocaleString("en-US") + " $";
    uid = String(uid);
    let rows = [];
    const acc = await Account.findOne({ discord: uid }).lean();
    if (cat === "account") {
        if (!acc) return [R("account.name", "الحساب", "ما له حساب بنكي")].filter(r => !only || only.has(r.k));
        rows.push(R("account.name", "الاسم", acc.discordTag), R("account.number", "رقم الحساب", acc.accountNumber), R("account.balance", "الرصيد الحالي", money(acc.balance)),
            R("account.savings", "رصيد التوفير", money(acc.savingsBalance)), R("account.status", "حالة الحساب", acc.isFrozen ? "مجمّد" : "نشط"), D("account.created", "تاريخ فتح الحساب", acc.createdAt));
    } else if (cat === "card") {
        const c = await CardRequest.findOne({ discord: uid, status: { $in: ["approved", "disabled"] } }).sort({ reviewedAt: -1 }).lean();
        if (!c) return [R("card.status", "البطاقة", "ما عنده بطاقة مفعّلة")].filter(r => !only || only.has(r.k));
        rows.push(R("card.status", "حالة البطاقة", c.status === "disabled" ? "معطّلة من الإدارة" : c.cardFrozen ? "مجمّدة" : "مفعّلة"), R("card.number", "رقم البطاقة", c.cardNumber), R("card.holder", "اسم حامل البطاقة", c.cardHolderName), D("card.expiry", "تاريخ الانتهاء", c.cardExpiry));
    } else if (cat === "transfers") {
        if (!acc) return [R("tx.count", "الحوالات", "ما له حساب")].filter(r => !only || only.has(r.k));
        const [lastIn, lastOut, cnt] = await Promise.all([
            Transaction.findOne({ type: "transfer", toAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean(),
            Transaction.findOne({ type: "transfer", fromAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean(),
            Transaction.countDocuments({ type: "transfer", $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] }),
        ]);
        rows.push(R("tx.lastIn", "آخر حوالة واردة", lastIn ? money(lastIn.amount) + " — " + new Date(lastIn.createdAt).toISOString().slice(0, 10) : "ما فيه"), R("tx.lastOut", "آخر حوالة صادرة", lastOut ? money(lastOut.amount) + " — " + new Date(lastOut.createdAt).toISOString().slice(0, 10) : "ما فيه"), R("tx.count", "عدد الحوالات", cnt));
    } else if (cat === "loans") {
        const ls = await Loan.find({ discord: uid, status: { $in: ["pending", "approved"] } }).lean();
        const act = ls.filter(l => l.status === "approved");
        rows.push(R("loan.active", "قروض شغّالة", act.length), R("loan.remaining", "المتبقي عليه", money(act.reduce((a, l) => a + (l.remaining || 0), 0))), R("loan.pending", "طلبات قروض معلّقة", ls.filter(l => l.status === "pending").length));
    } else if (cat === "flash") {
        const fl = await FlashLink.findOne({ uid }).lean();
        if (!fl) return [R("flash.name", "فلاش", "ما فيه بيانات")].filter(r => !only || only.has(r.k));
        rows.push(R("flash.name", "الاسم في فلاش", fl.name), R("flash.rank", "الرتبة", fl.rank), R("flash.unit", "اليونت", fl.unit));
    } else if (cat === "log") {
        if (!acc) return [];
        const ids = only ? Array.from(only).filter(k => SUPPORT_DYN_KEY.test(k)).map(k => k.slice(3)) : null;
        const q = { $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] };
        const txs = await Transaction.find(ids ? { $and: [q, { _id: { $in: ids } }] } : q).sort({ createdAt: -1 }).limit(ids ? 400 : 60).lean();
        txs.forEach(x => {
            const out = x.fromAccount === acc.accountNumber;
            rows.push({ k: "tx:" + x._id, l: (TX_LABELS[x.type] || x.type) + (out ? " (صادر)" : " (وارد)"), v: (money(x.amount) + (x.note ? " — " + x.note : "")).slice(0, 200), at: new Date(x.createdAt).toISOString() });
        });
        return rows;
    }
    return rows.filter(r => !only || only.has(r.k));
}


const supportPeerMap = new Map();
function supportPeersFor(t, req) {
    const pm = supportPeerMap.get(String(t._id)); if (!pm) return [];
    const now = Date.now(), uid = req.user ? String(req.user.id) : null, gt = supportGuestToken(req);
    const arr = [];
    for (const [k, v] of pm) {
        if (now - v.at > 5000) { pm.delete(k); continue; }
        if ((uid && v.uid === uid) || (gt && v.gt === gt)) continue;
        arr.push({ id: v.id, name: v.name, tag: v.tag, kind: v.kind });
    }
    return arr;
}

app.get("/api/support/admin/tickets/:id/inspect/:cat", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    const cat = req.params.cat;
    if (!SUPPORT_CATS[cat]) return res.status(400).json({ error: "قسم غير معروف" });
    const x = await supportLoad(req, res); if (!x) return;
    const { t } = x;
    if (!supportCanInspect(t, req.user.id)) return res.status(403).json({ error: "الفحص للإداري المستلم وكبار المسؤولين فقط" });
    if (!t.uid) return res.status(400).json({ error: "هذا التكت لزائر، ما له حساب بالموقع" });
    const rows = await supportCatRows(cat, t.uid, { staffUid: req.user.id });
    const sh = new Set(t.shared || []);
    res.json({ cat, title: SUPPORT_CATS[cat].title, rows: rows.map(r => Object.assign(r, { shown: sh.has(r.k) })) });
});

// اللي ظاهر للعضو حالياً (يشوفه العضو + الإداري المستلم + كبار المسؤولين فقط)
app.get("/api/support/tickets/:id/info", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (role === "owner") {
        if (!uid || uid !== t.uid) return res.status(403).json({ error: "سجّل دخولك بحسابك عشان تشوف المعلومات" });
    } else if (!supportCanInspect(t, uid)) return res.status(403).json({ error: "هذي المعلومات للإداري المستلم وكبار المسؤولين فقط" });
    if (!t.uid || !(t.shared || []).length) return res.json({ items: [] });
    const only = new Set(t.shared);
    const items = [];
    for (const cat of Object.keys(SUPPORT_CATS)) {
        const rows = await supportCatRows(cat, t.uid, { only });
        if (rows.length) items.push({ cat, title: SUPPORT_CATS[cat].title, rows });
    }
    res.json({ items });
});

// إظهار / إخفاء خانات للعضو: body = { show: [keys], hide: [keys] }
app.post("/api/support/admin/tickets/:id/share", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    const x = await supportLoad(req, res); if (!x) return;
    const { t } = x;
    if (!supportCanInspect(t, req.user.id)) return res.status(403).json({ error: "الفحص للإداري المستلم وكبار المسؤولين فقط" });
    if (t.status === "closed") return res.status(400).json({ error: "التكت مغلق" });
    if (!t.uid) return res.status(400).json({ error: "هذا التكت لزائر، ما له حساب بالموقع" });
    const arr = v => Array.isArray(v) ? v.map(String).slice(0, 500) : [];
    const show = arr((req.body || {}).show), hide = arr((req.body || {}).hide);
    const fixed = new Set(SUPPORT_FIXED_KEYS);
    const okShow = show.filter(k => fixed.has(k));
    const dyn = show.filter(k => SUPPORT_DYN_KEY.test(k));
    const txIds = Array.from(new Set(dyn.map(k => k.slice(3))));
    if (txIds.length) {
        const ac = await Account.findOne({ discord: String(t.uid) }, { accountNumber: 1 }).lean();
        if (!ac || await Transaction.countDocuments({ _id: { $in: txIds }, $or: [{ fromAccount: ac.accountNumber }, { toAccount: ac.accountNumber }] }) !== txIds.length) return res.status(400).json({ error: "سجل غير صالح" });
    }
    const before = (t.shared || []).slice();
    const cur = new Set(before);
    hide.forEach(k => cur.delete(k));
    okShow.concat(dyn).forEach(k => cur.add(k));
    if (cur.size > 400) return res.status(400).json({ error: "كثير، خفّ بعض اللي ظاهر أول" });
    const next = Array.from(cur);
    if (next.join(",") === before.join(",")) return res.json({ ok: true, shared: next });
    t.shared = next;
    if (!before.length && next.length) {
        supportAddMsg(t, { sender: "system", name: "النظام", text: "🔎 " + req.user.username + " عرض لك معلومات، تلقاها بأعلى التكت" });
        t.unreadUser += 1;
    }
    await t.save();
    res.json({ ok: true, shared: next });
    supportEvent(t, "system", { kind: "share" });
});

// "فلان يكتب..." بين أطراف التكت (العضو والإداري المستلم وكبار المسؤولين)
const supportPeerTypingThrottle = new Map();
app.post("/api/support/tickets/:id/typing", async (req, res) => {
    const x = await supportLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (t.status === "closed") return res.json({ ok: true });
    const gt = supportGuestToken(req);
    const key = String(t._id) + ":" + (uid || gt || "x");
    const now = Date.now();
    if (now - (supportPeerTypingThrottle.get(key) || 0) < 1500) return res.json({ ok: true });
    supportPeerTypingThrottle.set(key, now);
    if (supportPeerTypingThrottle.size > 3000) for (const [k, v] of supportPeerTypingThrottle) if (now - v > 60000) supportPeerTypingThrottle.delete(k);
    const senior = role === "admin" && isSeniorAdmin(uid);
    const payload = role === "owner"
        ? { id: String(t._id), name: t.name || "عضو", tag: t.uid ? "عضو" : "زائر", kind: "owner" }
        : { id: String(t._id), name: req.user.username, tag: senior ? "كبار المسؤولين" : "إدارة", kind: senior ? "senior" : "admin" };
    let pm = supportPeerMap.get(String(t._id)); if (!pm) { pm = new Map(); supportPeerMap.set(String(t._id), pm); }
    pm.set(String(uid || gt || "x"), Object.assign({}, payload, { at: now, uid: uid || null, gt: gt || null }));
    res.json({ ok: true });
});

app.get("/api/support/admin/tickets", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    const q = isSeniorAdmin(req.user.id)
        ? { status: ["ai", "waiting", "active", "closed"].includes(req.query.status) ? req.query.status : "waiting" }
        : { $or: [{ status: "waiting" }, { status: "active", adminUid: req.user.id }] };
    const hid = hiddenOwnerIds(req);
    const list = await SupportTicket.find(hid.length ? { $and: [q, { uid: { $nin: hid } }] } : q).sort({ updatedAt: -1 }).limit(100).select("-messages.image -messages.audio").lean();
    res.json({ tickets: list.map(t => Object.assign(supportPubTicket(t), { unread: t.unreadAdmin || 0, last: supportLastPreview(t) })) });
});


app.get("/api/support/admin/tickets/:id/person", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "التعديل لكبار المسؤولين فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const t = await SupportTicket.findById(req.params.id).select("uid no").lean();
    if (!t) return res.status(404).json({ error: "التكت غير موجود" });
    if (!t.uid) return res.status(400).json({ error: "هذا التكت لزائر، ما له حساب بنكي" });
    if (isOwnerUid(t.uid) && !isOwnerUid(req.user.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const a = await Account.findOne({ discord: String(t.uid) }).lean();
    if (!a) return res.status(404).json({ error: "هذا الشخص ما عنده حساب بنكي" });
    res.json({ name: a.discordTag || "", accountNumber: a.accountNumber, frozen: !!a.isFrozen, cardLimit: a.cardLimit, supportBanned: !!a.supportBanned });
});
app.post("/api/support/admin/tickets/:id/person", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "التعديل لكبار المسؤولين فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const t = await SupportTicket.findById(req.params.id).select("uid no").lean();
    if (!t) return res.status(404).json({ error: "التكت غير موجود" });
    if (!t.uid) return res.status(400).json({ error: "هذا التكت لزائر، ما له حساب بنكي" });
    if (isOwnerUid(t.uid) && !isOwnerUid(req.user.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const a = await Account.findOne({ discord: String(t.uid) });
    if (!a) return res.status(404).json({ error: "هذا الشخص ما عنده حساب بنكي" });
    const b = req.body || {};
    const upd = {};
    if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== a.discordTag) upd.discordTag = b.name.trim().slice(0, 60);
    if (typeof b.frozen === "boolean" && b.frozen !== !!a.isFrozen) upd.isFrozen = b.frozen;
    if (b.cardLimit !== undefined && b.cardLimit !== null && b.cardLimit !== "") {
        const n = parseInt(b.cardLimit, 10);
        if (!(n >= -1 && n <= 50)) return res.status(400).json({ error: "حد البطاقات غير صحيح (-1 = حسب الإعداد العام)" });
        if (n !== a.cardLimit) upd.cardLimit = n;
    }
    if (!Object.keys(upd).length) return res.status(400).json({ error: "ما تغيّر شي" });
    await Account.updateOne({ _id: a._id }, { $set: upd });
    if (upd.discordTag) await SupportTicket.updateOne({ _id: t._id }, { $set: { name: upd.discordTag } });
    if (upd.isFrozen !== undefined) await Notification.create({ discord: a.discord, message: upd.isFrozen ? "🔒 تم تجميد حسابك البنكي من الإدارة." : "🔓 تم فك تجميد حسابك البنكي.", type: upd.isFrozen ? "warning" : "success" });
    await logEvent({ action: "تعديل حساب من تكت", discordId: a.discord, discordTag: a.discordTag, actorId: req.user.id, actorTag: req.user.username, details: JSON.stringify(upd) + " — من تكت خدمة العملاء #" + t.no });
    bumpActivity();
    const f = await Account.findOne({ discord: String(t.uid) }).lean();
    res.json({ ok: true, name: f.discordTag, frozen: !!f.isFrozen, cardLimit: f.cardLimit });
});

app.post("/api/support/admin/tickets/:id/ban", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "الحظر لكبار المسؤولين فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const t = await SupportTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "التكت غير موجود" });
    if (t.uid && await isSupportAdmin(t.uid)) return res.status(400).json({ error: "ما تقدر تحظر إداري" });
    if (isOwnerUid(t.uid)) return res.status(400).json({ error: "ما تقدر تحظر هذا الحساب" });
    const reason = String((req.body || {}).reason || "").trim().slice(0, 200);
    const devs = new Set();
    if (t.deviceToken) devs.add(t.deviceToken);
    if (t.guestToken) devs.add(t.guestToken);
    if (t.uid) (await SupportTicket.distinct("deviceToken", { uid: t.uid })).forEach(d => d && devs.add(d));
    const deviceTokens = [...devs];
    const or = [];
    if (t.uid) or.push({ uid: t.uid });
    if (deviceTokens.length) or.push({ deviceTokens: { $in: deviceTokens } });
    if (!or.length) return res.status(400).json({ error: "تعذر تحديد المستخدم" });
    let ban = await SupportBan.findOne({ $or: or });
    if (ban) {
        ban.deviceTokens = [...new Set([...(ban.deviceTokens || []), ...deviceTokens])];
        if (!ban.uid && t.uid) ban.uid = t.uid;
        await ban.save();
    } else {
        ban = await SupportBan.create({ uid: t.uid || null, deviceTokens, name: t.name, reason, bannedBy: req.user.id, bannedByName: req.user.username });
    }
    const q = { status: { $ne: "closed" }, $or: [...(t.uid ? [{ uid: t.uid }] : []), { deviceToken: { $in: deviceTokens } }, { guestToken: { $in: deviceTokens } }] };
    const opens = await SupportTicket.find(q);
    for (const o of opens) {
        o.status = "closed";
        supportAddMsg(o, { sender: "system", name: "النظام", text: "🚫 " + SUPPORT_BANNED_MSG });
        o.unreadUser += 1;
        await o.save();
        supportEvent(o, "system", { kind: "close" });
    }
    if (t.uid) await Account.updateOne({ discord: String(t.uid) }, { $set: { supportBanned: true } });
    await logEvent({ action: "حظر من الدعم الفني", discordId: t.uid || null, actorId: req.user.id, actorTag: req.user.username, details: (t.name || "-") + (reason ? " — السبب: " + reason : "") });
    res.json({ ok: true });
});
app.get("/api/support/admin/bans", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    const list = await SupportBan.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ bans: list.map(b => ({ id: String(b._id), name: b.name, reason: b.reason, by: b.bannedByName, at: b.createdAt, guest: !b.uid })) });
});
app.delete("/api/support/admin/bans/:id", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "لكبار المسؤولين فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "غير موجود" });
    const b = await SupportBan.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ error: "غير موجود" });
    if (b.uid) await Account.updateOne({ discord: String(b.uid) }, { $set: { supportBanned: false } });
    await logEvent({ action: "فك حظر من الدعم الفني", discordId: b.uid || null, actorId: req.user.id, actorTag: req.user.username, details: b.name || "-" });
    res.json({ ok: true });
});

app.delete("/api/support/admin/tickets/:id", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "هذا الإجراء لكبار المسؤولين فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "التكت غير موجود" });
    const t = await SupportTicket.findById(req.params.id).select("no name status uid guestToken deviceToken");
    if (!t) return res.status(404).json({ error: "التكت غير موجود" });
    if (t.status !== "closed") return res.status(400).json({ error: "تقدر تحذف التكتات المغلقة فقط" });
    await SupportTicket.deleteOne({ _id: t._id, status: "closed" });
    await logEvent({ action: "حذف تكت دعم", actorId: req.user.id, actorTag: req.user.username, details: "#" + t.no + " — " + (t.name || "-") });
    res.json({ ok: true });
    sseBroadcast("ticket", { id: String(t._id), status: "closed", n: 0, from: "system", kind: "deleted" },
        c => c.isAdmin || (c.uid && t.uid === c.uid) || (c.gt && !t.uid && t.guestToken === c.gt) || (c.gt && t.deviceToken && t.deviceToken === c.gt));
});
app.delete("/api/support/admin/closed", async (req, res) => {
    if (!req.isAuthenticated() || !isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "هذا الإجراء لكبار المسؤولين فقط" });
    const r = await SupportTicket.deleteMany({ status: "closed" });
    await logEvent({ action: "حذف التكتات المغلقة", actorId: req.user.id, actorTag: req.user.username, details: "عدد المحذوف: " + (r.deletedCount || 0) });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
    sseBroadcast("ticket", { id: "", status: "closed", n: 0, from: "system", kind: "deleted" }, c => c.isAdmin);
});

// إشعار العضو من التكت (للإدارة والكبار): "رد عليك الإداري على تكتك"
const ticketNotifyThrottle = new Map();
app.post("/api/support/admin/tickets/:id/notify", async (req, res) => {
    if (!req.isAuthenticated() || !(await isSupportAdmin(req.user.id))) return res.status(403).json({ error: "للإدارة فقط" });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "رقم غير صحيح" });
    const t = await SupportTicket.findById(req.params.id, { uid: 1, no: 1 }).lean();
    if (!t) return res.status(404).json({ error: "التكت غير موجود" });
    if (!t.uid) return res.status(400).json({ error: "هذا التكت لزائر بدون حساب، ما نقدر نرسل له إشعار" });
    const k = String(t._id);
    if (Date.now() - (ticketNotifyThrottle.get(k) || 0) < 15000) return res.status(429).json({ error: "تم إرسال إشعار قبل شوي" });
    ticketNotifyThrottle.set(k, Date.now());
    await Notification.create({ discord: String(t.uid), message: "🎧 رد عليك الإداري على تكتك #" + t.no + " ⚡", type: "info" });
    res.json({ ok: true, sent: 1 });
});


// ═══════════════════════════════════════════════════════════════════════════
// 🔐 الرقم السري للبطاقة: يُخزَّن مشفّر (hash) ولا أحد يشوفه — لا العضو ولا الإدارة ولا المالك. العضو لازم يحفظه.
// ═══════════════════════════════════════════════════════════════════════════
const PIN_PEPPER = crypto.createHash('sha256').update('flash-bank-pin-v1|' + (process.env.PIN_PEPPER || 'norv-bank-pin-pepper')).digest();
function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const h = crypto.scryptSync(String(pin), Buffer.concat([salt, PIN_PEPPER]), 32);
    return salt.toString('hex') + ':' + h.toString('hex');
}
function verifyPin(pin, stored) {
    try {
        if (!stored || typeof stored !== 'string') return false;
        const [s, h] = stored.split(':');
        if (!s || !h) return false;
        const calc = crypto.scryptSync(String(pin), Buffer.concat([Buffer.from(s, 'hex'), PIN_PEPPER]), 32);
        const exp = Buffer.from(h, 'hex');
        return calc.length === exp.length && crypto.timingSafeEqual(calc, exp);
    } catch (e) { return false; }
}
// نسخة آمنة من البطاقة للإرسال: بدون الرقم السري أبداً (والـ CVV يُحذف عن الإدارة)
function cardSafe(c, forStaff) {
    const o = (c && c.toObject) ? c.toObject() : Object.assign({}, c);
    delete o.cardPIN; delete o.cardPINHash;
    if (forStaff) delete o.cardCVV;
    return o;
}
// ترحيل: أي رقم سري قديم مخزّن كنص عادي يتحول لهاش
async function migratePins() {
    try {
        const docs = await CardRequest.find({ cardPIN: { $nin: [null, ''] } });
        for (const d of docs) await CardRequest.updateOne({ _id: d._id }, { $set: { cardPINHash: hashPin(d.cardPIN), cardPIN: null } });
        if (docs.length) console.log('🔐 تم تشفير ' + docs.length + ' رقم سري قديم');
    } catch (e) { console.log('❌ migratePins:', e.message); }
}
setTimeout(migratePins, 6000);

// ═══════════════════════════════════════════════════════════════════════════
// 📜 سجل البنك: زر حذف اللوق الشامل لكبار المسؤولين (مرة وحدة ويختفي) + المالك يحذف سجل سجل بالسحب لليمين
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/superadmin/logs', isBankSuperAdmin, async (req, res) => {
    try {
        const hid = hiddenOwnerIds(req);
        const logs = await BankLog.find(hid.length ? { targetDiscord: { $nin: hid } } : {}).sort({ createdAt: -1 }).limit(200).lean();
        if (hid.length) logs.forEach(l => { if (l.performedBy && hid.includes(String(l.performedBy))) { l.performedByTag = 'كبار المسؤولين'; l.performedBy = null; } });
        const s = await BankSettings.findOne();
        res.json({ list: logs, logClearAvailable: !(s && s.logClearUsed), canDeleteEach: isOwnerUid(req.user.id) });
    } catch (e) { res.json({ list: [], logClearAvailable: false, canDeleteEach: false }); }
});
app.post('/api/superadmin/logs/clear', isBankSuperAdmin, async (req, res) => {
    try {
        const r = await BankSettings.updateOne({ logClearUsed: { $ne: true } }, { $set: { logClearUsed: true } });
        if (!(r.modifiedCount ?? r.nModified)) return res.json({ success: false, msg: 'تم استخدام زر حذف اللوق من قبل' });
        await BankLog.deleteMany({});
        await BankLog.create({ action: 'clear_log', description: 'حذف اللوق الشامل — تم حذف كل سجلات اللوق', performedBy: req.user.id, performedByTag: req.user.username });
        bumpActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});
app.delete('/api/superadmin/logs/:id', isBankSuperAdmin, async (req, res) => {
    if (!isOwnerUid(req.user.id)) return res.status(403).json({ success: false, msg: 'غير مصرح' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, msg: 'معرف غير صالح' });
    await BankLog.deleteOne({ _id: req.params.id });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🗂️ الملفات البنكية (كبار المسؤولين): ابحث باسم → بطاقته، معلومات بطاقته، حوالاته، آخر وارد وصادر، حسابه الحين
// ═══════════════════════════════════════════════════════════════════════════
function escRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
app.get('/api/senior/profiles', isBankSuperAdmin, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 40);
        if (q.length < 2) return res.json([]);
        const hid = hiddenOwnerIds(req);
        const rx = new RegExp(escRx(q), 'i');
        const digits = q.replace(/[\s-]/g, '');
        const uids = new Set();
        const or = [{ discordTag: rx }, { accountNumber: rx }, { discord: rx }];
        const fls = await FlashLink.find({ $or: [{ name: rx }, { rank: rx }, { unit: rx }] }, { uid: 1 }).limit(20).lean();
        fls.forEach(f => uids.add(String(f.uid)));
        if (/^\d{3,16}$/.test(digits)) {
            const pat = digits.length > 4 ? digits.replace(/(\d{4})(?=\d)/g, '$1 ') : digits;
            const cs = await CardRequest.find({ $or: [{ cardNumber: new RegExp(escRx(pat)) }, { militaryCardNumber: digits }] }, { discord: 1 }).limit(20).lean();
            cs.forEach(c => uids.add(String(c.discord)));
        }
        if (uids.size) or.push({ discord: { $in: Array.from(uids) } });
        const accs = await Account.find({ $and: [{ $or: or }, hid.length ? { discord: { $nin: hid } } : {}] }).limit(15).lean();
        const links = await FlashLink.find({ uid: { $in: accs.map(a => a.discord) } }).lean();
        const lm = {}; links.forEach(l => { lm[l.uid] = l; });
        const cnt = await CardRequest.aggregate([{ $match: { discord: { $in: accs.map(a => a.discord) }, status: { $in: ['approved', 'disabled'] } } }, { $group: { _id: '$discord', n: { $sum: 1 } } }]);
        const cm = {}; cnt.forEach(c => { cm[c._id] = c.n; });
        res.json(accs.map(a => ({ uid: a.discord, name: a.discordTag, accountNumber: a.accountNumber, balance: a.balance, frozen: !!a.isFrozen, rank: (lm[a.discord] || {}).rank || '', unit: (lm[a.discord] || {}).unit || '', cards: cm[a.discord] || 0 })));
    } catch (e) { res.json([]); }
});
app.get('/api/senior/profile/:uid', isBankSuperAdmin, async (req, res) => {
    try {
        const uid = String(req.params.uid);
        if (ownerUids.has(uid) && !isOwnerUid(req.user.id)) return res.status(404).json({ success: false, msg: 'غير موجود' });
        const acc = await Account.findOne({ discord: uid }).lean();
        if (!acc) return res.status(404).json({ success: false, msg: 'ما له حساب بنكي' });
        const hid = hiddenOwnerIds(req);
        const [fl, cards, txs, loans, tAll, tOpen, unread, role, settings] = await Promise.all([
            FlashLink.findOne({ uid }).lean(),
            CardRequest.find({ discord: uid }).sort({ requestedAt: -1 }).lean(),
            Transaction.find({ $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] }).sort({ createdAt: -1 }).limit(60).lean(),
            Loan.find({ discord: uid, status: { $in: ['pending', 'approved'] } }).sort({ requestedAt: -1 }).lean(),
            SupportTicket.countDocuments({ uid }),
            SupportTicket.countDocuments({ uid, status: { $ne: 'closed' } }),
            Notification.countDocuments({ discord: uid, read: false }),
            getBankRole(uid),
            BankSettings.findOne().lean(),
        ]);
        const nums = new Set(); txs.forEach(t => { if (t.fromAccount) nums.add(t.fromAccount); if (t.toAccount) nums.add(t.toAccount); });
        const peers = await Account.find({ accountNumber: { $in: Array.from(nums) } }, { accountNumber: 1, discordTag: 1, discord: 1 }).lean();
        const pm = {}; peers.forEach(p => { pm[p.accountNumber] = hid.includes(String(p.discord)) ? 'حساب محمي' : p.discordTag; });
        const mapTx = t => {
            const out = t.fromAccount === acc.accountNumber, other = out ? t.toAccount : t.fromAccount;
            return { id: String(t._id), type: t.type, dir: out ? 'out' : 'in', amount: t.amount, note: t.note || '', at: t.createdAt, otherAccount: other || '', otherName: other ? (pm[other] || '') : '' };
        };
        const list = txs.map(mapTx);
        const lastIn = list.find(t => t.dir === 'in' && t.type === 'transfer') || null;
        const lastOut = list.find(t => t.dir === 'out' && t.type === 'transfer') || null;
        const agg = await Transaction.aggregate([{ $match: { type: 'transfer', $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] } }, { $group: { _id: { $cond: [{ $eq: ['$fromAccount', acc.accountNumber] }, 'out', 'in'] }, total: { $sum: '$amount' }, n: { $sum: 1 } } }]);
        const tot = { in: { total: 0, n: 0 }, out: { total: 0, n: 0 } };
        agg.forEach(a => { tot[a._id] = { total: a.total, n: a.n }; });
        const lim = acc.cardLimit !== -1 ? acc.cardLimit : (settings?.globalCardLimit ?? 1);
        res.json({
            success: true,
            account: { uid, name: acc.discordTag, accountNumber: acc.accountNumber, balance: acc.balance, savings: acc.savingsBalance, frozen: !!acc.isFrozen, supportBanned: !!acc.supportBanned, cardLimit: acc.cardLimit, cardLimitEffective: lim, createdAt: acc.createdAt, role, unread },
            flash: fl ? { name: fl.name, rank: fl.rank, unit: fl.unit, senior: !!fl.isSenior, updatedAt: fl.updatedAt } : null,
            cards: cards.map(c => cardSafe(c, true)),
            transfers: list, lastIn, lastOut, totals: tot,
            loans: loans.map(l => ({ id: String(l._id), amount: l.amount, remaining: l.remaining, status: l.status, at: l.requestedAt, expiresAt: l.expiresAt || null })),
            tickets: { total: tAll, open: tOpen }
        });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

// 🧹 مسح سجل الإشعارات كامل مرة وحدة (عند هذا التحديث) — بعدها صفحة الإشعارات فاضية عند الكل
async function wipeNotificationsOnce() {
    try {
        const s = await BankSettings.findOne();
        if (!s) return setTimeout(wipeNotificationsOnce, 5000);
        if (s.notifWipeDone) return;
        const r = await Notification.deleteMany({});
        await BankSettings.updateOne({}, { $set: { notifWipeDone: true } });
        bumpActivity();
        console.log('🧹 تم مسح سجل الإشعارات كامل (' + (r.deletedCount || 0) + ')');
    } catch (e) { console.log('❌ wipeNotificationsOnce:', e.message); }
}
setTimeout(wipeNotificationsOnce, 8000);



app.delete('/api/superadmin/accounts/:id', isBankSuperAdmin, async (req, res) => {
    try {
        const account = await Account.findById(req.params.id);
        if (!account) return res.json({ success: false, msg: "الحساب غير موجود مسبقاً" });

        const userDiscordId = account.discord;

        // مسح بيانات الشخص نهائياً من جداول البنك لكي يبدأ من الصفر
        await Account.findByIdAndDelete(req.params.id);
        await Loan.deleteMany({ discord: userDiscordId });
        await Notification.deleteMany({ discord: userDiscordId });
        await CardRequest.deleteMany({ discord: userDiscordId });
        await SupportTicket.deleteMany({ uid: userDiscordId });
        await Transaction.deleteMany({ $or: [{ fromDiscord: userDiscordId }, { toDiscord: userDiscordId }] });

        bumpActivity();
        res.json({ success: true, msg: "تم حذف الحساب بالكامل وتصفير بياناته. إذا دخل البنك من فلاش مرة ثانية يتفتح له حساب جديد من الصفر." });
    } catch (e) {
        res.json({ success: false, msg: "خطأ أثناء عملية الحذف: " + e.message });
    }
});

app.get('/api/superadmin/settings', isBankSuperAdmin, async (req, res) => {
    const s = await BankSettings.findOne();
    const out = s ? s.toObject() : {};
    out.adminNames = {};
    try {
        const ids = (out.adminList || []).map(String);
        const accs = await Account.find({ discord: { $in: ids } }, { discord: 1, discordTag: 1, accountNumber: 1 }).lean();
        accs.forEach(a => { out.adminNames[a.discord] = { name: a.discordTag, accountNumber: a.accountNumber }; });
        const missing = ids.filter(i => !out.adminNames[i]);
        if (missing.length) {
            const links = await FlashLink.find({ uid: { $in: missing } }, { uid: 1, name: 1 }).lean();
            links.forEach(l => { out.adminNames[l.uid] = { name: l.name }; });
        }
    } catch (e) {}
    res.json(out);
});

app.get('/api/admin/account-search', isBankAdmin, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 40);
        if (q.length < 2) return res.json([]);
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const hid = hiddenOwnerIds(req);
        const accs = await Account.find({ $and: [{ $or: [{ discordTag: rx }, { accountNumber: rx }] }, hid.length ? { discord: { $nin: hid } } : {}] }, { discord: 1, discordTag: 1, accountNumber: 1 }).limit(8).lean();
        res.json(accs.map(a => ({ uid: a.discord, name: a.discordTag, accountNumber: a.accountNumber })));
    } catch (e) { res.json([]); }
});

app.post('/api/superadmin/settings', isBankSuperAdmin, async (req, res) => {
    const { interestRate } = req.body;
    await BankSettings.updateOne({}, { interestRate });
    res.json({ success: true });
});

app.post('/api/superadmin/admin/add', isBankSuperAdmin, async (req, res) => {
    const uid = String(req.body.accountUid || req.body.discordId || '').trim();
    if (!uid) return res.json({ success: false, msg: "اختر الحساب أولاً" });
    const acc = await Account.findOne({ discord: uid });
    if (!acc) return res.json({ success: false, msg: "هذا الحساب غير موجود — لازم يكون دخل البنك من فلاش مرة وحدة على الأقل" });
    await BankSettings.updateOne({}, { $addToSet: { adminList: uid } });
    await BankLog.create({ action: 'add_admin', description: `تم تعيين ${acc.discordTag} مسؤول للبنك`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: uid, targetTag: acc.discordTag });
    res.json({ success: true, msg: `تم تعيين ${acc.discordTag} مسؤول للبنك` });
});

app.post('/api/superadmin/admin/remove', isBankSuperAdmin, async (req, res) => {
    const uid = String(req.body.accountUid || req.body.discordId || '').trim();
    await BankSettings.updateOne({}, { $pull: { adminList: uid } });
    res.json({ success: true, msg: "تم إزالة المسؤول" });
});

app.get('/api/admin/stats', isBankAdmin, async (req, res) => {
    try {
        const totalAccounts = await Account.countDocuments();
        const totalBalance = await Account.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]);
        const totalSavings = await Account.aggregate([{ $group: { _id: null, total: { $sum: '$savingsBalance' } } }]);
        const pendingLoans = await Loan.countDocuments({ status: 'pending' });
        const totalTransactions = await Transaction.countDocuments();
        res.json({
            totalAccounts,
            totalBalance: totalBalance[0]?.total || 0,
            totalSavings: totalSavings[0]?.total || 0,
            pendingLoans,
            totalTransactions
        });
    } catch (e) { res.json({}); }
});

// (سجل البنك: الـ API الجديد في قسم خدمة العملاء/السجل أسفل)

// ── APIs الموظفين ─────────────────────────────────────────────────────────
// توظيف موظف أو إدارة (super_admin يوظف كليهما، admin يوظف staff فقط)
app.post('/api/staff/hire', isBankAdmin, async (req, res) => {
    try {
        const { staffRole } = req.body;
        const discordId = String(req.body.accountUid || req.body.discordId || '').trim();
        const myRole = await getBankRole(req.user.id);
        if (staffRole === 'management' && myRole !== 'super_admin')
            return res.json({ success: false, msg: "فقط كبار المسؤولين يمكنهم تعيين الإدارة" });
        if (!discordId) return res.json({ success: false, msg: "اختر الحساب أولاً" });
        const targetAcc = await Account.findOne({ discord: discordId });
        if (!targetAcc) return res.json({ success: false, msg: "هذا الحساب غير موجود — لازم يكون دخل البنك من فلاش مرة وحدة على الأقل" });
        const discordTag = targetAcc.discordTag;
        const existing = await Staff.findOne({ discord: discordId });
        if (existing && existing.isActive) return res.json({ success: false, msg: "هذا الشخص موظف مسبقاً" });
        await Staff.findOneAndUpdate({ discord: discordId }, {
            discord: discordId, discordTag, role: staffRole || 'staff',
            hiredBy: req.user.id, hiredByTag: req.user.username, isActive: true, hiredAt: new Date()
        }, { upsert: true });
        await BankLog.create({ action: 'hire_staff', description: `تم توظيف ${discordTag} كـ ${staffRole === 'management' ? 'إدارة' : 'موظف'}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: discordId, targetTag: discordTag });
        res.json({ success: true, msg: `تم توظيف ${discordTag} بنجاح` });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.put('/api/staff/:id/fire', isBankAdmin, async (req, res) => {
    try {
        const staff = await Staff.findById(req.params.id);
        if (!staff) return res.json({ success: false, msg: "الموظف غير موجود" });
        const myRole = await getBankRole(req.user.id);
        if (staff.role === 'management' && myRole !== 'super_admin')
            return res.json({ success: false, msg: "فقط كبار المسؤولين يمكنهم فصل الإدارة" });
        await Staff.findByIdAndUpdate(req.params.id, { isActive: false });
        await BankLog.create({ action: 'fire_staff', description: `تم فصل الموظف ${staff.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: staff.discord, targetTag: staff.discordTag });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.get('/api/staff', isBankAdmin, async (req, res) => {
    try {
        const staff = await Staff.find({ isActive: true }).sort({ hiredAt: -1 });
        res.json(staff);
    } catch (e) { res.json([]); }
});

// ── APIs البطاقة: تجديد ──────────────────────────────────────────────────
app.post('/api/account/card/:id/renew', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    try {
        const card = await CardRequest.findOne({ _id: req.params.id, discord: req.user.id });
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        const expiredByDate = card.status === 'approved' && card.cardExpiry && new Date(card.cardExpiry) < new Date();
        if (card.status !== 'expired' && !expiredByDate) return res.json({ success: false, msg: "البطاقة لم تنته بعد" });
        const settings = await BankSettings.findOne();
        const fee = settings?.cardRenewalFee || 0;
        const acc = await Account.findOne({ discord: req.user.id });
        if (!acc) return res.json({ success: false, msg: "ليس لديك حساب" });
        if (fee > 0 && acc.balance < fee) return res.json({ success: false, msg: `رصيدك غير كافٍ لرسوم التجديد (${fee.toLocaleString()} $)` });
        if (fee > 0) {
            await Account.findByIdAndUpdate(acc._id, { $inc: { balance: -fee } });
            await Transaction.create({ fromAccount: acc.accountNumber, amount: fee, type: 'card_renewal_fee', note: 'رسوم تجديد بطاقة' });
        }
        // تحديث حالة البطاقة لـ pending مجدداً
        await CardRequest.findByIdAndUpdate(req.params.id, { status: 'pending', reviewedAt: null, adminNote: 'طلب تجديد' });
        await BankLog.create({ action: 'card_renew_request', description: `${acc.discordTag} طلب تجديد بطاقته${fee > 0 ? ` (رسوم ${fee} $)` : ''}`, performedBy: acc.discord, performedByTag: acc.discordTag });
        res.json({ success: true, msg: `تم إرسال طلب التجديد${fee > 0 ? ` (خُصمت رسوم ${fee.toLocaleString()} $)` : ''}` });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── API: تحديث رسوم التحويل والتجديد (كبار المسؤولين) ───────────────────
app.post('/api/superadmin/fees', isBankSuperAdmin, async (req, res) => {
    try {
        const { transferFee, transferFeeRecipient, cardRenewalFee } = req.body;
        const update = {};
        if (transferFee !== undefined) update.transferFee = parseFloat(transferFee) || 0;
        if (transferFeeRecipient !== undefined) update.transferFeeRecipient = transferFeeRecipient.trim();
        if (cardRenewalFee !== undefined) update.cardRenewalFee = parseFloat(cardRenewalFee) || 0;
        await BankSettings.updateOne({}, update);
        await BankLog.create({ action: 'update_fees', description: `تم تحديث الرسوم: تحويل=${transferFee||'-'}, تجديد=${cardRenewalFee||'-'}, حساب المستفيد=${transferFeeRecipient||'-'}`, performedBy: req.user.id, performedByTag: req.user.username });
        res.json({ success: true, msg: "تم حفظ الرسوم" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── API: إعدادات انتهاء القروض (كبار المسؤولين) ────────────────────────
app.post('/api/superadmin/loan-expiry', isBankSuperAdmin, async (req, res) => {
    try {
        const { loanExpiryDays, loanExpiryApplyTo } = req.body;
        const days = parseInt(loanExpiryDays) || 0;
        await BankSettings.updateOne({}, { loanExpiryDays: days, loanExpiryApplyTo: loanExpiryApplyTo || 'new' });
        // إذا يطبق على القروض الحالية
        if (days > 0 && (loanExpiryApplyTo === 'existing' || loanExpiryApplyTo === 'both')) {
            const expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            await Loan.updateMany({ status: 'approved', expiresAt: { $exists: false } }, { expiresAt: expiryDate });
        }
        await BankLog.create({ action: 'update_loan_expiry', description: `تم تحديث انتهاء القروض: ${days} يوم — يطبق على: ${loanExpiryApplyTo}`, performedBy: req.user.id, performedByTag: req.user.username });
        res.json({ success: true, msg: "تم حفظ إعدادات انتهاء القروض" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── API: تحديد تاريخ انتهاء بطاقة معينة (كبار المسؤولين فقط) ─────────────
app.put('/api/superadmin/cards/:id/set-expiry', isBankSuperAdmin, async (req, res) => {
    try {
        const { expiryDate } = req.body;
        if (!expiryDate) return res.json({ success: false, msg: "التاريخ مطلوب" });
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        await CardRequest.findByIdAndUpdate(req.params.id, { cardExpiry: new Date(expiryDate) });
        await BankLog.create({ action: 'set_card_expiry', description: `تم تحديد انتهاء بطاقة ${card.discordTag} بتاريخ ${expiryDate}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true, msg: "تم تحديد تاريخ الانتهاء" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});


// ── API: polling للمستخدم (تحديث تلقائي) ──────────────────────────────
app.get('/api/poll/user', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({});
    try {
        const acc = await Account.findOne({ discord: req.user.id });
        const unreadCount = await Notification.countDocuments({ discord: req.user.id, read: false });
        const latestUnread = await Notification.findOne({ discord: req.user.id, read: false }).sort({ createdAt: -1 }).select('_id');
        res.json({ balance: acc?.balance, savingsBalance: acc?.savingsBalance, isFrozen: acc?.isFrozen, unreadCount, latestUnreadId: latestUnread ? String(latestUnread._id) : null, lastActivity: lastBankActivity, lastTicketActivity });
    } catch (e) { res.json({}); }
});

// ── API: polling للأدمن (تحديث تلقائي) ─────────────────────────────────
app.get('/api/poll/admin', isStaffOrAbove, async (req, res) => {
    try {
        const openTickets = await SupportTicket.countDocuments({ status: 'waiting' });
        const pendingLoans = await Loan.countDocuments({ status: 'pending' });
        const pendingCards = await CardRequest.countDocuments({ status: 'pending' });
        res.json({ openTickets, pendingLoans, pendingCards, lastActivity: lastBankActivity, lastTicketActivity });
    } catch (e) { res.json({}); }
});

// ── الصفحة الرئيسية ─────────────────────────────────────────────────────────
app.use(async (req, res) => {
    const FLASH_HOME = flashHome(req);
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script>
        // لو البنك مفتوح داخل فلاش (المسار /bank) نضيف المسار لكل طلبات الـ API تلقائياً
        window.BANK_BASE = ${JSON.stringify(pfx(req))};
        (function () {
            var B = window.BANK_BASE || '';
            if (!B) return;
            var f = window.fetch;
            window.fetch = function (u, o) {
                if (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf(B + '/') !== 0) u = B + u;
                return f.call(this, u, o);
            };
        })();
    </script>
    <title>بنك فلاش — Flash Bank</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Crect%20width%3D%22100%22%20height%3D%22100%22%20rx%3D%2222%22%20fill%3D%22%230a1628%22/%3E%3Cpath%20fill%3D%22%2360a5fa%22%20transform%3D%22translate%2810%2010%29%20scale%280.8%29%22%20d%3D%22M50%206%20L92%2030%20H8%20Z%20M16%2038%20h14%20v38%20h-14%20Z%20M43%2038%20h14%20v38%20h-14%20Z%20M70%2038%20h14%20v38%20h-14%20Z%20M8%2082%20H92%20V94%20H8%20Z%22/%3E%3C/svg%3E">
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { min-height: 100vh; background: linear-gradient(135deg, #0a1628 0%, #0d1f3c 40%, #0a2744 70%, #0d3060 100%); font-family: 'Tajawal', sans-serif; color: #e2e8f0; direction: rtl; }
        
        nav { background: rgba(5,15,30,0.95); backdrop-filter: blur(15px); border-bottom: 1px solid rgba(59,130,246,0.3); padding: 0 1.5rem; display: flex; align-items: center; justify-content: space-between; height: 65px; position: sticky; top: 0; z-index: 100; }
        .logo { font-size: 1.5rem; font-weight: 900; background: linear-gradient(90deg, #3b82f6, #60a5fa, #93c5fd); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: 3px; }
        .logo svg { width: 26px; height: 26px; vertical-align: -6px; margin-inline-end: 7px; }
        .logo-sub { font-size: 0.7rem; color: #64748b; display: block; letter-spacing: 1px; }
        .nav-links { display: flex; gap: 0.3rem; list-style: none; flex-wrap: wrap; }
        .nav-links button { background: transparent; border: 1px solid transparent; color: #94a3b8; padding: 0.35rem 0.75rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 0.82rem; transition: all 0.2s; }
        .nav-links button.active, .nav-links button:hover { background: rgba(59,130,246,0.2); border-color: #3b82f6; color: #60a5fa; }
        .login-btn { background: #5865F2; color: white; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; font-family: inherit; font-size: 0.9rem; }
        
        .page { display: none; max-width: 950px; margin: 0 auto; padding: 2rem 1rem; }
        .page.active { display: block; }
        
        .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(59,130,246,0.2); border-radius: 16px; padding: 1.5rem; margin-bottom: 1.2rem; }
        .card-blue { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
        .card-green { border-color: #22c55e; background: rgba(34,197,94,0.05); }
        .card-yellow { border-color: #eab308; background: rgba(234,179,8,0.05); }
        .card-red { border-color: #ef4444; background: rgba(239,68,68,0.05); }
        
        h1 { color: #60a5fa; margin-bottom: 1.2rem; font-size: 1.6rem; }
        h2 { color: #60a5fa; margin-bottom: 1rem; font-size: 1.1rem; border-bottom: 1px solid rgba(59,130,246,0.2); padding-bottom: 0.6rem; }
        
        input, select, textarea { width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(59,130,246,0.3); border-radius: 8px; color: #e2e8f0; padding: 0.65rem 1rem; font-size: 0.9rem; font-family: inherit; outline: none; margin-bottom: 0.9rem; }
        input:focus, select:focus { border-color: #3b82f6; }
        /* قوائم الاختيار المخصصة (بدل قائمة الآيفون الأصلية) */
        .cs-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: right; background: rgba(255,255,255,0.06); border: 1px solid rgba(59,130,246,0.3); border-radius: 8px; color: #e2e8f0; padding: 0.65rem 1rem; font-size: 0.9rem; font-family: inherit; outline: none; margin-bottom: 0.9rem; cursor: pointer; }
        .cs-btn:focus, .cs-btn:hover { border-color: #3b82f6; }
        .cs-btn .cs-arrow { color: #60a5fa; font-size: 0.8rem; }
        .cs-ov { position: fixed; inset: 0; z-index: 100010; background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); display: flex; align-items: flex-end; justify-content: center; }
        .cs-box { width: 100%; max-width: 480px; max-height: 72vh; overflow-y: auto; background: #07162b; border: 1px solid rgba(59,130,246,0.35); border-radius: 18px 18px 0 0; padding: 14px 14px 22px; direction: rtl; -webkit-overflow-scrolling: touch; }
        .cs-title { color: #60a5fa; font-weight: 800; font-size: 0.95rem; text-align: center; padding: 4px 0 12px; }
        .cs-opt { display: block; width: 100%; text-align: right; background: rgba(255,255,255,0.05); border: 1px solid transparent; border-radius: 10px; color: #e2e8f0; padding: 13px 14px; margin-bottom: 7px; font-family: inherit; font-size: 0.95rem; cursor: pointer; }
        .cs-opt:hover { background: rgba(59,130,246,0.18); }
        .cs-opt.on { border-color: #3b82f6; background: rgba(59,130,246,0.25); font-weight: 800; }
        /* قفل تمرير الخلفية لما تنفتح أي قائمة كبيرة أو نافذة */
        html.modal-open, html.modal-open body { overflow: hidden; }
        .custom-modal, .ui-ov, .cs-ov, .dg-ov, .modal-content, .cs-box, .ui-box { overscroll-behavior: contain; }
        .ms-pick-list { max-height: 42vh; overflow-y: auto; -webkit-overflow-scrolling: touch; margin: 8px 0 10px; text-align: right; }
        .ms-pick-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; background: rgba(255,255,255,0.05); margin-bottom: 6px; cursor: pointer; }
        .ms-pick-row.on { background: rgba(34,197,94,0.18); outline: 1px solid #22c55e; }
        .ms-pick-row input { width: auto; margin: 0; }
        .ms-pick-row .nm { flex: 1; color: #e2e8f0; font-size: 0.9rem; }
        .ms-pick-row .rk { color: #94a3b8; font-size: 0.78rem; }
        
        .btn { border: none; color: #fff; padding: 0.6rem 1.3rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 0.88rem; transition: all 0.2s; }
        .btn:hover { opacity: 0.85; transform: translateY(-1px); }
        .btn-blue { background: linear-gradient(135deg, #1d4ed8, #3b82f6); }
        .btn-green { background: linear-gradient(135deg, #15803d, #22c55e); }
        .btn-red { background: #ef4444; }
        .btn-yellow { background: #eab308; color: #000; }
        .btn-full { width: 100%; padding: 0.75rem; margin-top: 0.3rem; }

        .account-card { background: linear-gradient(135deg, #1e3a5f, #0f2848); border: 2px solid #3b82f6; border-radius: 20px; padding: 2rem; margin-bottom: 1.5rem; position: relative; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .account-card::before { content: 'FLASH BANK'; position: absolute; left: -20px; bottom: -15px; font-size: 5rem; font-weight: 900; color: rgba(255,255,255,0.03); pointer-events: none; }
        .pick-box { position: relative; }
        .pick-item { padding: 9px 12px; background: #0f1f3a; border: 1px solid #1e3a5f; border-radius: 8px; margin-top: 4px; cursor: pointer; font-size: 0.9rem; }
        .pick-item:hover { background: #1e3a5f; }
        .pick-item small { color: #64748b; margin-right: 8px; }
        .pick-chosen { margin-top: 6px; color: #4ade80; font-weight: bold; font-size: 0.9rem; }
        .account-number { font-size: 2rem; font-weight: 900; letter-spacing: 4px; color: #93c5fd; margin: 0.5rem 0; }
        .balance-display { font-size: 2.5rem; font-weight: 900; color: #4ade80; margin: 0.5rem 0; }
        .savings-display { font-size: 1.3rem; font-weight: 700; color: #fde047; }

        .tx-item { padding: 12px 15px; border-radius: 10px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); border: 1px solid rgba(59,130,246,0.1); }
        .tx-in { border-right: 3px solid #22c55e; }
        .tx-out { border-right: 3px solid #ef4444; }
        .tx-neutral { border-right: 3px solid #eab308; }

        .notif-item { padding: 10px 15px; border-radius: 8px; margin-bottom: 6px; font-size: 0.88rem; }
        .notif-success { background: rgba(34,197,94,0.1); border: 1px solid #22c55e; }
        .notif-info { background: rgba(59,130,246,0.1); border: 1px solid #3b82f6; }
        .notif-warning { background: rgba(234,179,8,0.1); border: 1px solid #eab308; }
        .notif-danger { background: rgba(239,68,68,0.1); border: 1px solid #ef4444; }

        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
        .stat-box { background: rgba(255,255,255,0.04); border: 1px solid rgba(59,130,246,0.2); border-radius: 12px; padding: 1rem; text-align: center; }
        .stat-val { font-size: 1.6rem; font-weight: 900; color: #60a5fa; }
        .stat-label { font-size: 0.8rem; color: #64748b; margin-top: 4px; }

        .custom-modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 10000; backdrop-filter: blur(8px); }
        .pinpad-btn { width:64px; height:64px; border-radius:50%; border:1px solid #334155; background:rgba(59,130,246,0.08); color:#e2e8f0; font-size:1.4rem; display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none; transition:background 0.15s; }
        .pinpad-btn:active { background:rgba(59,130,246,0.35); }
        .pinpad-dot { width:14px; height:14px; border-radius:50%; border:1.5px solid #64748b; display:inline-block; transition:all 0.15s; }
        .pinpad-dot.filled { background:#3b82f6; border-color:#3b82f6; }
        .modal-content { max-width: 850px; margin: 30px auto; background: #050f1e; border: 2px solid #3b82f6; border-radius: 15px; padding: 25px; max-height: 88vh; overflow-y: auto; }
        .tabs-container { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .tab-btn { background: rgba(255,255,255,0.04); border: 1px solid rgba(59,130,246,0.3); color: #94a3b8; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 0.85rem; }
        .tab-btn.active { background: #3b82f6; color: white; border-color: #3b82f6; }

        .login-screen { text-align: center; padding: 4rem 2rem; }
        .login-screen h1 { font-size: 3.5rem; color: #3b82f6; text-shadow: 0 0 20px rgba(59,130,246,0.5); }

        .notif-dot { background: #ef4444; color: white; border-radius: 50%; width: 18px; height: 18px; font-size: 0.7rem; display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; }

        .admin-fab { position: fixed; bottom: 25px; right: 25px; background: linear-gradient(135deg, #1d4ed8, #3b82f6); color: white; padding: 14px 24px; border-radius: 50px; font-weight: bold; font-family: inherit; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.4); display: none; z-index: 999; border: 2px solid rgba(255,255,255,0.2); transition: 0.3s; }
        .admin-fab:hover { transform: scale(1.05); }

        .frozen-badge { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid #ef4444; padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; }
        
        .toggle-box { background: rgba(255,255,255,0.03); padding: 12px 15px; border-radius: 8px; border: 1px solid rgba(59,130,246,0.15); display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }

        /* ── موبايل همبرجر ───────────────────────── */
        .hamburger-btn {
            display: none;
            background: rgba(59,130,246,0.15);
            border: 1px solid #3b82f6;
            color: #60a5fa;
            padding: 0.4rem 0.7rem;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1.2rem;
            margin-left: 6px;
        }
        .mobile-menu {
            display: none;
            position: fixed;
            top: 65px;
            right: 0;
            width: 230px;
            background: rgba(5,15,30,0.98);
            border: 1px solid rgba(59,130,246,0.35);
            border-radius: 0 0 0 14px;
            z-index: 9999;
            padding: 8px 0;
            box-shadow: -4px 8px 30px rgba(0,0,0,0.7);
        }
        .mobile-menu.open { display: block; }
        .mobile-menu button {
            display: block;
            width: 100%;
            background: transparent;
            border: none;
            border-bottom: 1px solid rgba(59,130,246,0.08);
            color: #94a3b8;
            padding: 12px 20px;
            text-align: right;
            font-family: inherit;
            font-size: 0.95rem;
            cursor: pointer;
            transition: background 0.15s;
        }
        .mobile-menu button:hover, .mobile-menu button.active {
            background: rgba(59,130,246,0.18);
            color: #60a5fa;
        }
        @media (max-width: 1180px) {
            .nav-links { display: none !important; }
            .hamburger-btn { display: inline-flex; }
        }

        /* ── ترتيب الهيدر ───────────────────────── */
        nav { gap: 10px; height: auto; min-height: 65px; padding-top: 6px; padding-bottom: 6px; }
        nav > div:first-child { flex-shrink: 0; line-height: 1.2; }
        .logo { display: inline-block; white-space: nowrap; padding-inline-end: 4px; }
        .logo-sub { white-space: nowrap; }
        #auth-section { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .nav-user { display: inline-flex; align-items: center; gap: 5px; max-width: 130px; height: 36px; background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.3); color: #93c5fd; padding: 0 0.8rem; border-radius: 999px; font-weight: 700; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .nav-back { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; white-space: nowrap; background: #e5b73b; color: #1a1a1a; border: none; border-radius: 10px; padding: 0 0.85rem; font-family: inherit; font-weight: 800; font-size: 0.85rem; cursor: pointer; }
        .nav-back:active { transform: scale(0.97); }
        .hamburger-btn { height: 36px; align-items: center; justify-content: center; margin-left: 0; padding: 0 0.75rem; line-height: 1; }

        /* ── شاشة التحميل (نفس فلاش بشعار البنك) ── */
        html.bk-splash-on, html.bk-splash-on body { overflow: hidden; }
        #bk-splash { position: fixed; inset: 0; z-index: 2147483000; background: radial-gradient(circle at 50% 42%, #12305e 0%, #0a1628 62%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; transition: opacity .45s; }
        #bk-splash.out { opacity: 0; pointer-events: none; }
        #bk-splash svg { width: 120px; height: 120px; filter: drop-shadow(0 0 22px rgba(59,130,246,.55)); }
        #bk-splash path { fill: url(#bkSplashG); fill-opacity: 0; stroke: #60a5fa; stroke-width: 1.6; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: bkDraw 1s ease-out forwards, bkFill .4s .9s ease-out forwards; }
        #bk-splash .bk-name { font-size: 34px; font-weight: 800; letter-spacing: .5px; color: #e2e8f0; opacity: 0; animation: bkFade .4s 1s forwards; }
        @keyframes bkDraw { to { stroke-dashoffset: 0; } }
        @keyframes bkFill { to { fill-opacity: 1; stroke-opacity: 0; } }
        @keyframes bkFade { to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
            #bk-splash path { animation: none; stroke-dashoffset: 0; fill-opacity: 1; stroke-opacity: 0; }
            #bk-splash .bk-name { animation: none; opacity: 1; }
            #bk-splash { transition: none; }
        }

        /* ── قائمة الصفحات (نفس نظام فلاش) ──────── */
        .mobile-menu { right: auto; left: 0; width: min(260px, 82vw); border-radius: 0 0 14px 0; box-shadow: 4px 8px 30px rgba(0,0,0,0.7); max-height: calc(100vh - 130px); max-height: calc(100dvh - 130px); overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
        #menu-backdrop { display: none; position: fixed; inset: 0; z-index: 9990; background: rgba(0,0,0,0.35); touch-action: none; }
        html.menu-open, html.menu-open body { overflow: hidden; }
        html.menu-open #menu-backdrop { display: block; }
        @media (max-width: 768px) {
            nav { padding: 0 12px; }
            .logo { font-size: 1.1rem; letter-spacing: 2px; }
            .logo-sub { font-size: 0.62rem; letter-spacing: 0.5px; }
            .nav-user { max-width: 92px; padding: 0 0.6rem; }
        }
        @media (max-width: 400px) {
            .logo { font-size: 1rem; letter-spacing: 1px; }
            .nav-user { max-width: 66px; font-size: 0.8rem; }
            .nav-back { padding: 0 0.65rem; font-size: 0.8rem; }
        }
        /* ═══ نوافذ الموقع (بديل prompt / confirm / alert) ═══ */
        .ui-ov { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.72); backdrop-filter: blur(6px); z-index: 100000; display: flex; align-items: center; justify-content: center; padding: 16px; animation: uiFade 0.15s ease; }
        .ui-box { width: 100%; max-width: 410px; background: #07162b; border: 1px solid rgba(59,130,246,0.35); border-top: 4px solid var(--c, #3b82f6); border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); animation: uiPop 0.18s ease; max-height: 90vh; overflow-y: auto; }
        .ui-title { font-size: 1.05rem; font-weight: 800; color: var(--c, #60a5fa); margin-bottom: 10px; }
        .ui-msg { font-size: 0.92rem; color: #e2e8f0; line-height: 1.8; white-space: pre-line; word-break: break-word; }
        .ui-detail { font-size: 0.82rem; color: #94a3b8; line-height: 1.7; margin-top: 8px; white-space: pre-line; }
        .ui-field { margin-top: 12px; }
        .ui-field label { display: block; font-size: 0.82rem; color: #94a3b8; margin-bottom: 5px; }
        .ui-field input, .ui-field select, .ui-field textarea { margin-bottom: 0; }
        .ui-field textarea { min-height: 90px; resize: vertical; }
        .ui-hint { font-size: 0.74rem; color: #64748b; margin-top: 4px; }
        .ui-err { font-size: 0.8rem; color: #fca5a5; margin-top: 10px; min-height: 0; }
        .ui-actions { display: flex; gap: 8px; margin-top: 16px; }
        .ui-actions .btn { flex: 1; padding: 0.65rem 0.5rem; }
        .ui-cancel { background: #334155; }
        @keyframes uiFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes uiPop { from { opacity: 0; transform: scale(0.94) translateY(8px); } to { opacity: 1; transform: none; } }

        /* ═══ إشعار منبثق تحت يمين ═══ */
        #notif-toast-wrap { position: fixed; right: 14px; bottom: 14px; z-index: 100001; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
        .ntoast { --c: #3b82f6; pointer-events: auto; cursor: pointer; position: relative; overflow: hidden; width: min(310px, calc(100vw - 28px)); background: #07162b; border: 1px solid var(--c); border-right-width: 4px; border-radius: 12px; padding: 10px 12px 13px; box-shadow: 0 10px 30px rgba(0,0,0,0.55); animation: ntIn 0.3s cubic-bezier(.2,.9,.3,1.2); transition: opacity 0.25s, transform 0.25s; direction: rtl; }
        .ntoast.out { opacity: 0; transform: translateX(40px); }
        .ntoast-info { --c: #3b82f6; background: linear-gradient(135deg, #07162b, #0b2447); }
        .ntoast-success { --c: #22c55e; background: linear-gradient(135deg, #07162b, #0a2a1c); }
        .ntoast-warning { --c: #eab308; background: linear-gradient(135deg, #07162b, #2a2408); }
        .ntoast-danger { --c: #ef4444; background: linear-gradient(135deg, #07162b, #2b0d12); }
        .ntoast-title { font-size: 0.78rem; font-weight: 800; color: var(--c); margin-bottom: 3px; }
        .ntoast-text { font-size: 0.84rem; color: #e2e8f0; line-height: 1.6; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .ntoast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,0.08); }
        .ntoast-bar i { display: block; height: 100%; width: 100%; background: var(--c); transform-origin: right center; animation-name: ntBar; animation-timing-function: linear; animation-fill-mode: forwards; }
        @keyframes ntBar { to { transform: scaleX(0); } }
        .dg-ov { position: fixed; inset: 0; z-index: 100005; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(60,0,0,0.38); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); animation: dgFade 0.2s ease; touch-action: none; }
        .dg-box { width: 100%; max-width: 400px; max-height: 85vh; overflow-y: auto; text-align: center; direction: rtl; background: linear-gradient(160deg, #1a0709, #07162b); border: 2px solid #ef4444; border-radius: 16px; padding: 22px 20px 20px; box-shadow: 0 0 0 0 rgba(239,68,68,0.6), 0 20px 60px rgba(0,0,0,0.7); animation: dgPop 0.25s cubic-bezier(.2,.9,.3,1.2), dgPulse 1.1s ease-in-out infinite 0.25s; }
        .dg-icon { font-size: 3rem; line-height: 1; margin-bottom: 6px; animation: dgShake 0.6s ease-in-out infinite; }
        .dg-title { font-size: 1.15rem; font-weight: 800; color: #fca5a5; margin-bottom: 12px; }
        .dg-msg { font-size: 1rem; color: #f1f5f9; line-height: 1.8; word-break: break-word; padding: 8px 4px; }
        .dg-extra { border-top: 1px solid rgba(239,68,68,0.3); margin-top: 6px; }
        .dg-hint { font-size: 0.82rem; color: #fbbf24; margin-top: 8px; }
        .dg-btn { width: 100%; margin-top: 14px; padding: 12px; font-size: 1rem; }
        @keyframes dgFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dgPop { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: none; } }
        @keyframes dgPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.55), 0 20px 60px rgba(0,0,0,0.7); } 50% { box-shadow: 0 0 0 14px rgba(239,68,68,0), 0 20px 60px rgba(0,0,0,0.7); } }
        @keyframes dgShake { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-9deg); } 75% { transform: rotate(9deg); } }
        @keyframes ntIn { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: none; } }

            /* ═══ خدمة العملاء (من فلاش) + بطاقة جديدة + ملفات بنكية ═══ */
        :root { --bg1: #0a1628; --bg2: #0d1f3c; --panel: rgba(255,255,255,0.04); --border: rgba(59,130,246,0.25); --gold: #3b82f6; --gold-soft: #60a5fa; --green: #1d4ed8; --green2: #3b82f6; --red: #ef4444; --amber: #eab308; --text: #e2e8f0; --muted: #64748b; }
        .btn.sm { padding: 0.4rem 0.9rem; font-size: 0.8rem; }
        .btn.sm:not(.danger):not(.gray) { background: linear-gradient(135deg, #1d4ed8, #3b82f6); }
        .btn.danger { background: #ef4444; }
        .btn.gray { background: rgba(255,255,255,0.08); border: 1px solid rgba(59,130,246,0.25); color: #94a3b8; }
        #spa-body .sp-msgs { max-height: 52vh; }
        html.sp-lock, html.sp-lock body { overflow: hidden !important; }
        html.sp-lock #sp-fab, html.sp-lock #admin-fab-btn { display: none !important; }
        .prof-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(59,130,246,0.2); border-radius: 10px; padding: 10px 12px; margin-top: 8px; cursor: pointer; }
        .prof-row:hover { border-color: #3b82f6; background: rgba(59,130,246,0.12); }
        .prof-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
        .prof-stat { background: rgba(255,255,255,0.04); border: 1px solid rgba(59,130,246,0.2); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 3px; }
        .prof-stat small { color: #64748b; font-size: 0.72rem; } .prof-stat b { font-size: 1.05rem; } .prof-stat em { color: #64748b; font-size: 0.72rem; font-style: normal; }
        .prof-last { border: 1px solid; border-radius: 12px; padding: 10px; background: rgba(255,255,255,0.03); display: flex; flex-direction: column; gap: 3px; }
        .prof-last small { color: #94a3b8; }
        .prof-tx { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px dashed rgba(59,130,246,0.2); font-size: 0.85rem; }
        .prof-cardinfo { display: flex; flex-direction: column; gap: 3px; font-size: 0.82rem; color: #94a3b8; margin-top: 10px; }
        .prof-cardinfo b { color: #e2e8f0; font-weight: 700; }
        /* بطاقة بنك فلاش */
        .fbc-wrap { perspective: 1100px; max-width: 390px; width: 100%; margin-top: 12px; direction: ltr; font-family: 'Tajawal', sans-serif; }
        .fbc { position: relative; width: 100%; aspect-ratio: 1.586 / 1; transform-style: preserve-3d; transition: transform 0.7s cubic-bezier(.2,.8,.2,1); cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .fbc.flip { transform: rotateY(180deg); }
        .fbc-face { position: absolute; inset: 0; border-radius: 20px; padding: 16px 20px; color: #fff; backface-visibility: hidden; -webkit-backface-visibility: hidden; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 14px 34px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.18); background: radial-gradient(circle at 85% 0%, rgba(255,255,255,0.22), transparent 45%), linear-gradient(135deg, var(--c1), var(--c2)); }
        .fbc-face::before { content: ''; position: absolute; width: 260px; height: 260px; border-radius: 50%; right: -90px; bottom: -130px; background: rgba(255,255,255,0.06); }
        .fbc-face::after { content: ''; position: absolute; width: 200px; height: 200px; border-radius: 50%; left: -80px; top: -110px; background: rgba(255,255,255,0.05); }
        .fbc-shine { position: absolute; inset: 0; background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.14) 48%, transparent 60%); pointer-events: none; }
        .fbc-back { transform: rotateY(180deg); padding: 0 0 14px; }
        .fbc-top { display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 1; }
        .fbc-brand { display: flex; align-items: center; gap: 8px; }
        .fbc-brand b { display: block; letter-spacing: 2px; font-size: 0.9rem; line-height: 1.1; }
        .fbc-brand small { display: block; color: var(--ac); font-size: 0.72rem; }
        .fbc-chip { display: flex; align-items: center; gap: 10px; position: relative; z-index: 1; }
        .fbc-chip span { font-size: 0.6rem; letter-spacing: 2px; color: var(--ac); border: 1px solid var(--ac); border-radius: 5px; padding: 1px 6px; }
        .fbc-num { font-family: 'Courier New', monospace; font-size: 1.28rem; letter-spacing: 3px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); position: relative; z-index: 1; }
        .fbc-bot { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; position: relative; z-index: 1; }
        .fbc-bot small { display: block; font-size: 0.55rem; letter-spacing: 1px; color: var(--ac); }
        .fbc-bot div > div { font-size: 0.86rem; text-transform: uppercase; }
        .fbc-hn { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fbc-frozen { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.65); color: #fca5a5; font-size: 0.7rem; padding: 3px 10px; border-radius: 8px; z-index: 2; }
        .fbc-strip { height: 38px; background: #0b0b0f; margin-top: 18px; position: relative; z-index: 1; }
        .fbc-sign { display: flex; align-items: center; gap: 10px; padding: 0 20px; margin-top: 4px; position: relative; z-index: 1; }
        .fbc-sigbox { flex: 1; height: 34px; border-radius: 6px; background: repeating-linear-gradient(45deg, #f1f5f9, #f1f5f9 6px, #e2e8f0 6px, #e2e8f0 12px); color: #475569; font-size: 0.7rem; display: flex; align-items: center; justify-content: flex-end; padding: 0 10px; letter-spacing: 2px; }
        .fbc-cvv { background: #fff; color: #0f172a; border-radius: 6px; padding: 3px 12px; text-align: center; }
        .fbc-cvv small { display: block; font-size: 0.5rem; color: #64748b; } .fbc-cvv b { font-family: 'Courier New', monospace; font-size: 1rem; }
        .fbc-note { font-size: 0.7rem; line-height: 1.6; padding: 0 20px; color: var(--ac); direction: rtl; text-align: center; position: relative; z-index: 1; }
        .fbc-tap { font-size: 0.6rem; text-align: center; color: rgba(255,255,255,0.45); position: relative; z-index: 1; }

        #wf-overlay { display: none; position: fixed; inset: 0; z-index: 10600; background: rgba(0,0,0,0.75); align-items: center; justify-content: center; padding: 20px; overflow-y: auto; }
        #wf-overlay.open { display: flex; }
        .wf-box { background: #0d1f3c; border: 1px solid var(--gold); border-radius: 14px; padding: 22px; max-width: 380px; width: 100%; text-align: center; max-height: 85vh; overflow-y: auto; margin: auto; }
        .wf-box h3 { margin-bottom: 14px; color: var(--gold-soft); }
        .wf-box.wf-big { max-width: 520px; padding: 28px 24px; }
        .wf-choice-row { display: flex; gap: 10px; margin-top: 6px; }
        .wf-choice-row button { flex: 1; padding: 14px 8px; border-radius: 10px; font-family: inherit; font-size: 14px; cursor: pointer; border: 1px solid var(--border); background: rgba(255,255,255,0.04); color: #fff; }
        .wf-choice-row button.wf-warning:hover { border-color: #f87171; background: rgba(248,113,113,0.12); }
        .wf-choice-row button.wf-notice:hover { border-color: #fbbf24; background: rgba(251,191,36,0.12); }
        .wf-box textarea { width: 100%; min-height: 90px; margin-top: 10px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 8px; color: #fff; padding: 10px; font-family: inherit; font-size: 14px; resize: vertical; }
        .wf-actions { display: flex; gap: 8px; margin-top: 14px; }
        .wf-actions button { flex: 1; }
        #sp-fab { position: fixed; bottom: 22px; left: 22px; z-index: 5300; width: 54px; height: 54px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2); background: linear-gradient(135deg, #1d4ed8, #3b82f6); color: #fff; font-size: 24px; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
        #sp-fab:active { transform: scale(0.94); }
        .sp-badge { background: #ef4444; color: #fff; border-radius: 10px; min-width: 18px; height: 18px; padding: 0 5px; font-size: 11px; font-weight: bold; display: inline-flex; align-items: center; justify-content: center; margin-inline-start: 6px; }
        #sp-fab .sp-badge { position: absolute; top: -4px; right: -4px; margin: 0; }
        #sp-modal { position: fixed; top: 0; left: 0; right: 0; height: 100%; background: #060d1a; z-index: 4000; display: none; align-items: flex-end; justify-content: center; overscroll-behavior: contain; }
        #sp-modal.kb { align-items: stretch; }
        #sp-modal.kb #sp-box { height: 100%; border-radius: 0; }
        #sp-modal.open { display: flex; }
        #sp-box { background-color: #0a1628; background-image: linear-gradient(160deg, #0d1f3c, #0a1628); transform: translateZ(0); -webkit-transform: translateZ(0); isolation: isolate; border: 1px solid var(--border); border-radius: 16px 16px 0 0; width: 100%; max-width: 560px; height: min(86%, 720px); display: flex; flex-direction: column; box-shadow: 0 -10px 40px rgba(0,0,0,0.6); padding-bottom: env(safe-area-inset-bottom, 0px); }
        @media (min-width: 700px) { #sp-modal { align-items: center; } #sp-box { border-radius: 16px; } }
        #sp-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); font-weight: bold; color: var(--gold-soft); }
        #sp-head button { background: rgba(255,255,255,0.08); border: none; color: var(--text); width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 16px; }
        #sp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; overscroll-behavior: contain; }
        .sp-btn { background: linear-gradient(135deg, var(--green), var(--green2)); color: #fff; border: none; border-radius: 8px; padding: 10px 16px; font-size: 14px; font-weight: bold; cursor: pointer; font-family: inherit; }
        .sp-btn.alt { background: rgba(255,255,255,0.08); color: var(--text); }
        .sp-btn.warn { background: linear-gradient(135deg, #b45309, #f59e0b); }
        .sp-btn.red { background: rgba(239,68,68,0.18); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
        .sp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .sp-btn.pulse { animation: spPulse 1.4s infinite; }
        @keyframes spPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.6); } 50% { box-shadow: 0 0 0 8px rgba(245,158,11,0); } }
        .sp-field { width: 100%; background: #14223d; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 10px 12px; font-size: 16px; margin-bottom: 10px; font-family: inherit; }
        .sp-field:focus { outline: none; border-color: var(--gold-soft); }
        .sp-lbl { display: block; font-size: 13px; color: var(--muted); margin-bottom: 5px; }
        .sp-row { background: #101d36; border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 10px; cursor: pointer; }
        .sp-row:hover { border-color: var(--gold-soft); }
        .sp-row .t1 { display: flex; justify-content: space-between; gap: 8px; font-weight: bold; font-size: 14px; }
        .sp-row .t2 { color: var(--muted); font-size: 12px; margin-top: 4px; }
        .sp-chip { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: bold; white-space: nowrap; }
        .sp-chip.ai { background: rgba(59,130,246,0.2); color: #93c5fd; }
        .sp-chip.waiting { background: rgba(245,158,11,0.2); color: #fcd34d; }
        .sp-chip.active { background: rgba(34,197,94,0.2); color: #86efac; }
        .sp-chip.closed { background: rgba(148,163,184,0.2); color: #cbd5e1; }
        .sp-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .sp-tab { background: #16243f; border: 1px solid var(--border); color: var(--text); border-radius: 18px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit; }
        .sp-tab.on { background: var(--green2); border-color: var(--green2); color: #fff; font-weight: bold; }
        .sp-chat { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        .sp-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .sp-link { background: none; border: none; color: var(--gold-soft); cursor: pointer; font-size: 14px; font-family: inherit; padding: 4px; }
        .sp-title { font-weight: bold; font-size: 14px; text-align: center; flex: 1; }
        .sp-state { background: #121f38; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 13px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .sp-msgs { flex: 1; min-height: 120px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
        .sp-msg { display: flex; flex-direction: column; max-width: 82%; }
        .sp-msg.me { align-self: flex-start; }
        .sp-msg.other { align-self: flex-end; }
        .sp-msg.sys { align-self: center; max-width: 94%; }
        .sp-who { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
        .sp-b { padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
        .sp-msg.me .sp-b { background: linear-gradient(135deg, var(--green), var(--green2)); color: #fff; border-top-right-radius: 4px; }
        .sp-msg.other .sp-b { background: #1c2b48; border-top-left-radius: 4px; }
        .sp-msg.ai .sp-b { background: #2a1f52; border: 1px solid #5b4a99; }
        .sp-msg.admin .sp-b { background: #12402c; border: 1px solid #1f7a4d; }
        .sp-msg.sys .sp-b { background: #33290f; color: #fcd34d; font-size: 12.5px; text-align: center; border-radius: 10px; }
        .sp-time { font-size: 10px; color: var(--muted); margin-top: 2px; }
        .sp-role { display: inline-block; font-size: 10px; font-weight: bold; padding: 1px 7px; border-radius: 8px; margin-inline-start: 6px; vertical-align: middle; }
        .sp-role.senior { background: #3d3410; color: #fde047; border: 1px solid #8a7414; }
        .sp-role.admin { background: #12294d; color: #93c5fd; border: 1px solid #2b5aa8; }
        .sp-role.member { background: #123524; color: #86efac; border: 1px solid #2f7a4d; }
        .sp-peers { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px; }
        .sp-peer { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
        .sp-peer-n { color: var(--text); font-weight: bold; }
        .sp-peer .sp-dots { display: inline-flex; align-items: center; }
        .sp-info { background: #0f1a30; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; max-height: 34vh; overflow-y: auto; }
        .sp-info-h { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
        .sp-info-c { border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 6px; }
        .sp-info-t { font-size: 12px; color: var(--gold-soft); font-weight: bold; margin-bottom: 4px; }
        .sp-info-r { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; padding: 2px 0; }
        .sp-info-r b { font-weight: normal; text-align: left; word-break: break-word; }
        .sp-ins-list { max-height: 46vh; overflow-y: auto; }
        .sp-ins-r { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 0; border-top: 1px dashed var(--border); }
        .sp-ins-r.on { background: rgba(34,197,94,0.07); }
        .sp-img { max-width: 220px; max-height: 220px; border-radius: 10px; margin-top: 6px; display: block; cursor: zoom-in; background: rgba(255,255,255,0.05); }
        .sp-dots span { display: inline-block; width: 6px; height: 6px; margin: 0 2px; border-radius: 50%; background: #a78bfa; animation: spDot 1s infinite; }
        .sp-dots span:nth-child(2) { animation-delay: 0.15s; } .sp-dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes spDot { 0%,60%,100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
        .sp-compose { display: flex; align-items: flex-end; gap: 8px; margin-top: 10px; }
        .sp-compose textarea { flex: 1; resize: none; max-height: 110px; margin: 0; }
        .sp-attach { background: #1c2b48; border-radius: 8px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; flex-shrink: 0; }
        .sp-cin { display: flex; align-items: flex-end; gap: 8px; flex: 1; min-width: 0; }
        .sp-mic { background: #1c2b48; border: none; color: inherit; border-radius: 8px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; flex-shrink: 0; }
        .sp-mic:hover { background: #26395e; }
        .sp-vbar { display: none; align-items: center; gap: 10px; flex: 1; min-width: 0; background: #1c2b48; border-radius: 24px; padding: 4px 6px; direction: ltr; }
        .sp-vb-ic { background: transparent; border: none; color: #fca5a5; font-size: 18px; cursor: pointer; width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }
        .sp-vb-ic:hover { background: rgba(239,68,68,0.18); }
        .sp-vb-stop { background: #ef4444; border: none; color: #fff; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 14px; flex-shrink: 0; }
        .sp-rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; flex-shrink: 0; animation: spRecPulse 1s infinite; }
        @keyframes spRecPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
        .sp-rec-time { font-size: 13px; min-width: 34px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .sp-wave { display: flex; align-items: center; gap: 2px; height: 32px; flex: 1; min-width: 0; overflow: hidden; direction: ltr; }
        .sp-wave i { display: block; flex: 1; max-width: 4px; min-width: 2px; min-height: 4px; border-radius: 2px; background: rgba(255,255,255,0.4); }
        .sp-wave i.on { background: #fff; }
        .sp-vbar .sp-wave i { background: #7c8db0; }
        .sp-vbar .sp-wave i.on { background: #fff; }
        .sp-vm { display: flex; align-items: center; gap: 8px; width: 270px; max-width: 100%; direction: ltr; }
        .sp-vm-play { width: 36px; height: 36px; border-radius: 50%; border: none; background: #fff; color: #0a1628; cursor: pointer; flex-shrink: 0; font-size: 13px; display: flex; align-items: center; justify-content: center; padding: 0; }
        .sp-vm-wave { cursor: pointer; }
        .sp-vm-dur { font-size: 12px; min-width: 32px; text-align: center; font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .sp-vm-speed { background: rgba(255,255,255,0.18); border: none; color: inherit; border-radius: 10px; padding: 3px 7px; font-size: 11px; cursor: pointer; flex-shrink: 0; font-family: inherit; }
        .sp-mic.on { background: #92400e; }
        #sp-in.note-mode { border-color: #f59e0b; background: #2a2310; }
        .sp-msg.note { align-self: center; max-width: 94%; }
        .sp-msg.note .sp-b { background: #2a2310; border: 1px dashed #f59e0b; color: #fde68a; }
        .sp-msg[data-i] .sp-b { -webkit-touch-callout: none; }
        .sp-msg[data-i] img { -webkit-touch-callout: none; }
        .sp-msg.del .sp-b { background: rgba(127,29,29,0.55) !important; border: 1px solid #ef4444 !important; color: #fecaca !important; }
        .sp-del-tag { font-size: 11px; color: #fca5a5; font-weight: 800; margin-bottom: 4px; }
        .sp-quote { border-right: 3px solid #60a5fa; background: rgba(255,255,255,0.08); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; font-size: 12px; color: #cbd5e1; cursor: pointer; white-space: normal; overflow: hidden; max-height: 48px; }
        .sp-quote b { display: block; color: #93c5fd; font-size: 11px; }
        .sp-ed { font-size: 10px; color: var(--muted); margin-inline-start: 5px; }
        .sp-msg.sp-flash .sp-b { outline: 2px solid #60a5fa; transition: outline 0.2s; }
        .sp-ctxbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(59,130,246,0.14); border-right: 3px solid #60a5fa; border-radius: 8px; padding: 6px 10px; margin: 0 2px 6px; font-size: 12.5px; color: #cbd5e1; }
        .sp-ctxbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #sp-mm-ov { position: fixed; inset: 0; z-index: 7200; background: rgba(2,6,15,0.62); display: flex; align-items: flex-end; justify-content: center; }
        #sp-mm-sheet { width: 100%; background: #0d1f3c; border-top: 1px solid rgba(59,130,246,0.45); border-radius: 20px 20px 0 0; padding: 8px 14px calc(14px + env(safe-area-inset-bottom, 0px)); box-shadow: 0 -12px 40px rgba(0,0,0,0.6); animation: spMmUp 0.18s ease-out; max-height: 78%; overflow-y: auto; }
        @keyframes spMmUp { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
        .sp-mm-grip { width: 44px; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.25); margin: 4px auto 10px; }
        .sp-mm-prev { font-size: 12.5px; color: var(--muted); background: rgba(255,255,255,0.05); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; max-height: 64px; overflow: hidden; }
        .sp-mm-it { display: flex; align-items: center; gap: 12px; width: 100%; background: transparent; border: none; border-top: 1px solid rgba(255,255,255,0.07); color: #e5edff; font-family: inherit; font-size: 15px; padding: 13px 6px; cursor: pointer; text-align: right; }
        .sp-mm-it span { font-size: 19px; width: 26px; text-align: center; }
        .sp-mm-it.danger { color: #fca5a5; }
        .sp-mm-it.cancel { justify-content: center; color: var(--muted); }
        .sp-mm-info { font-size: 13px; line-height: 1.9; color: #cbd5e1; }
        .sp-mm-info b { color: #e5edff; }
        .sp-mm-info .ed { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 5px 8px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
        .sp-canned { background: #0f1a30; border: 1px solid var(--border); border-radius: 10px; margin-top: 8px; max-height: 40vh; overflow-y: auto; }
        .sp-canned-h { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; }
        .sp-canned-r { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px dashed var(--border); cursor: pointer; }
        .sp-canned-r:hover { background: rgba(59,130,246,0.12); }
        .sp-rate { background: #0f1a30; border: 1px solid var(--gold-soft); border-radius: 12px; padding: 12px; margin-top: 10px; text-align: center; }
        .sp-stars { display: flex; justify-content: center; gap: 6px; margin: 8px 0; direction: ltr; }
        .sp-stars button { background: none; border: none; font-size: 32px; cursor: pointer; color: #475569; padding: 0 2px; }
        .sp-stars button.on { color: #facc15; }
        .sp-prev { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--muted); }
        .sp-prev img { height: 46px; border-radius: 6px; }
        #sp-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 6000; display: none; align-items: center; justify-content: center; padding: 14px; }
        #sp-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }
    </style>
</head>
<body>

    <div id="bk-splash">
        <svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="bkSplashG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path pathLength="1" d="M50 6 L92 30 H8 Z M16 38 h14 v38 h-14 Z M43 38 h14 v38 h-14 Z M70 38 h14 v38 h-14 Z M8 82 H92 V94 H8 Z"/></svg>
        <div class="bk-name">بنك فلاش</div>
    </div>
    <script>
    (function () {
        var d = document.documentElement;
        d.classList.add('bk-splash-on');
        setTimeout(function () {
            var s = document.getElementById('bk-splash');
            if (!s) { d.classList.remove('bk-splash-on'); return; }
            s.classList.add('out');
            setTimeout(function () { s.remove(); d.classList.remove('bk-splash-on'); }, 450);
        }, 2000);
    })();
    </script>

    <div id="sim-warning-banner" style="position:sticky; top:0; left:0; width:100%; z-index:100000; background:linear-gradient(180deg,#7f1d1d,#5f1414); color:#fef2f2; text-align:center; padding:10px 16px; font-weight:800; font-size:0.95rem; line-height:1.5; border-bottom:2px solid #991b1b; box-shadow:0 2px 12px rgba(0,0,0,0.5);">
        ⚠️ تنبيه: هذا الموقع مخصص للمحاكاة واللعب فقط، ولا يمت للواقع بصلة.
    </div>
    <script>
        (function(){
            function adjustForSimBanner(){
                var banner = document.getElementById('sim-warning-banner');
                if(!banner) return;
                var h = banner.offsetHeight;
                document.querySelectorAll('nav').forEach(function(n){ n.style.top = h + 'px'; });
                var menu = document.querySelector('.mobile-menu');
                var nv = document.querySelector('nav');
                if(menu) menu.style.top = (h + (nv ? nv.offsetHeight : 65)) + 'px';
            }
            window.addEventListener('load', adjustForSimBanner);
            window.addEventListener('resize', adjustForSimBanner);
        })();
    </script>

    <div id="maintenance-screen" style="display:none; text-align:center; padding:10rem 2rem;">
        <h1 style="font-size:3rem; color:#ef4444; margin-bottom:1rem;">🚨 البنك مغلق للصيانة</h1>
        <p style="color:#94a3b8; font-size:1.2rem; margin-bottom:2rem;">يقوم فريق الإدارة العليا حالياً بتحديث النظام. يرجى العودة لاحقاً.</p>
        <button class="login-btn" onclick="location.href='${FLASH_HOME}'">↩️ الرجوع لفلاش</button>
    </div>

    <div id="not-member-screen" style="display:none; text-align:center; padding:10rem 2rem;">
        <h1 style="font-size:3rem; color:#ef4444; margin-bottom:1rem;">🚫 غير مصرح بالدخول</h1>
        <p style="color:#94a3b8; font-size:1.2rem; margin-bottom:2rem;">هذا البنك مخصص لمنسوبي فلاش فقط. ادخل عن طريق زر «🏦 بنك فلاش» داخل تطبيق فلاش.</p>
        <button class="login-btn" onclick="location.href=(window.BANK_BASE||'')+'/logout'">↩️ الرجوع لفلاش</button>
    </div>

    <div id="login-screen" style="display:none;">
        <div style="text-align:center; padding: 8rem 2rem;">
            <div style="width:84px;height:84px;margin:0 auto 14px;"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="bnkLogoLogin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path fill="url(#bnkLogoLogin)" d="M50 6 L92 30 H8 Z M16 38 h14 v38 h-14 Z M43 38 h14 v38 h-14 Z M70 38 h14 v38 h-14 Z M8 82 H92 V94 H8 Z"/></svg></div><h1 style="font-size:3.5rem; font-weight:900; background: linear-gradient(90deg,#3b82f6,#60a5fa,#93c5fd); -webkit-background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:1rem;">بنك فلاش</h1>
            <p style="color:#64748b; margin-bottom:2rem; font-size:1.1rem;">Flash Bank — النظام المصرفي الرسمي</p>
            <p style="color:#94a3b8; margin-bottom:1.6rem; font-size:1rem; line-height:1.9;">الدخول للبنك يتم من داخل تطبيق فلاش.<br>افتح فلاش واضغط زر <b style="color:#fde047;">🏦 بنك فلاش</b> وبيفتح لك حسابك تلقائياً.</p>
            <button class="login-btn" style="padding:1rem 2.5rem; font-size:1.1rem; border-radius:12px;" onclick="location.href='${FLASH_HOME}'">
                ↩️ الذهاب إلى فلاش
            </button>
        </div>
    </div>

    <div id="main-site" style="display:none;">
        <nav>
            <div>
                <span class="logo"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="bnkLogoNav" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path fill="url(#bnkLogoNav)" d="M50 6 L92 30 H8 Z M16 38 h14 v38 h-14 Z M43 38 h14 v38 h-14 Z M70 38 h14 v38 h-14 Z M8 82 H92 V94 H8 Z"/></svg>FLASH BANK</span>
                <span class="logo-sub">النظام المصرفي الرسمي</span>
            </div>
            <ul class="nav-links">
                <li><button onclick="goPage('dashboard')" id="nav-dashboard" class="active">🏠 الرئيسية</button></li>
                <li><button onclick="goPage('transfer')" id="nav-transfer">💸 تحويل</button></li>
                <li><button onclick="goPage('savings')" id="nav-savings">💰 التوفير</button></li>
                <li><button onclick="goPage('loans')" id="nav-loans">📋 القروض</button></li>
                <li><button onclick="goPage('history')" id="nav-history">📜 كشف حساب</button></li>
                <li><button onclick="goPage('notifications')" id="nav-notifications">🔔 <span id="notif-count"></span>إشعارات</button></li>
                <li><button onclick="goPage('cards')" id="nav-cards">💳 بطاقاتي</button></li>
                <li><button onclick="spOpen()" id="nav-support" class="sp-nav-user">🎧 خدمة العملاء</button></li>
            </ul>
            <div id="auth-section"></div>
        </nav>

        <!-- قائمة الموبايل المنسدلة -->
        <div id="menu-backdrop" onclick="closeMobileMenu()"></div>
        <div class="mobile-menu" id="mobile-menu">
            <button onclick="mobileGoPage('dashboard')" id="mnav-dashboard">🏠 الرئيسية</button>
            <button onclick="mobileGoPage('transfer')" id="mnav-transfer">💸 تحويل</button>
            <button onclick="mobileGoPage('savings')" id="mnav-savings">💰 التوفير</button>
            <button onclick="mobileGoPage('loans')" id="mnav-loans">📋 القروض</button>
            <button onclick="mobileGoPage('history')" id="mnav-history">📜 كشف حساب</button>
            <button onclick="mobileGoPage('notifications')" id="mnav-notifications">🔔 <span id="mnav-notif-count"></span>إشعارات</button>
            <button onclick="mobileGoPage('cards')" id="mnav-cards">💳 بطاقاتي</button>
            <button class="sp-nav-user" onclick="spOpen(); closeMobileMenu()">🎧 خدمة العملاء</button>
        </div>

        <div id="page-dashboard" class="page active">
            <div id="account-card-container"></div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem;">
                <div class="card card-blue" style="cursor:pointer;" onclick="goPage('transfer')">
                    <div style="font-size:2rem; text-align:center;">💸</div>
                    <p style="text-align:center; font-weight:bold; margin-top:8px;">تحويل أموال</p>
                </div>
                <div class="card card-green" style="cursor:pointer;" onclick="goPage('savings')">
                    <div style="font-size:2rem; text-align:center;">💰</div>
                    <p style="text-align:center; font-weight:bold; margin-top:8px;">حساب التوفير</p>
                </div>
                <div class="card card-yellow" style="cursor:pointer;" onclick="goPage('loans')">
                    <div style="font-size:2rem; text-align:center;">📋</div>
                    <p style="text-align:center; font-weight:bold; margin-top:8px;">طلب قرض</p>
                </div>
                <div class="card" style="cursor:pointer;" onclick="goPage('history')">
                    <div style="font-size:2rem; text-align:center;">📜</div>
                    <p style="text-align:center; font-weight:bold; margin-top:8px;">كشف الحساب</p>
                </div>
            </div>
        </div>

        <div id="page-transfer" class="page">
            <h1>💸 تحويل أموال</h1>
            <div class="card card-blue">
                <div id="transfer-msg"></div>
                <label>رقم الحساب المستهدف (6 أرقام):</label>
                <input id="t-to" placeholder="مثال: 123456" maxlength="6" />
                <label>المبلغ ($):</label>
                <input id="t-amount" type="number" placeholder="مثال: 5000" min="1" />
                <label>ملاحظة (اختياري):</label>
                <input id="t-note" placeholder="سبب التحويل..." />
                <button class="btn btn-blue btn-full" onclick="doTransfer()">إرسال التحويل ✈️</button>
            </div>
        </div>

        <div id="page-savings" class="page">
            <h1>💰 حساب التوفير</h1>
            <div id="savings-info" class="card card-green"></div>
            <div class="card">
                <h2>إيداع في التوفير</h2>
                <input id="s-deposit" type="number" placeholder="المبلغ المراد إيداعه" min="1" />
                <button class="btn btn-green btn-full" onclick="doSavingsDeposit()">إيداع 💰</button>
                <div id="s-deposit-msg" style="margin-top:8px;"></div>
            </div>
            <div class="card">
                <h2>سحب من التوفير</h2>
                <input id="s-withdraw" type="number" placeholder="المبلغ المراد سحبه" min="1" />
                <button class="btn btn-red btn-full" onclick="doSavingsWithdraw()">سحب 📤</button>
                <div id="s-withdraw-msg" style="margin-top:8px;"></div>
            </div>
        </div>

        <div id="page-loans" class="page">
            <h1>📋 القروض البنكية</h1>
            <div id="loan-status-container"></div>
            <div class="card card-yellow">
                <h2>طلب قرض جديد</h2>
                <p style="color:#94a3b8; font-size:0.88rem; margin-bottom:1rem;">الحد الأقصى 1,000,000 $ — تتم المراجعة من قبل إدارة البنك</p>
                <input id="loan-amount" type="number" placeholder="المبلغ المطلوب" min="1" max="1000000" />
                <button class="btn btn-yellow btn-full" onclick="requestLoan()">إرسال طلب القرض</button>
                <div id="loan-msg" style="margin-top:8px;"></div>
            </div>
            <div class="card" id="loan-pay-section" style="display:none;">
                <h2>سداد القرض</h2>
                <div id="loan-remaining-info"></div>
                <input id="loan-pay-amount" type="number" placeholder="مبلغ السداد" min="1" style="margin-top:10px;" />
                <button class="btn btn-green btn-full" onclick="payLoan()">سداد ✅</button>
                <div id="loan-pay-msg" style="margin-top:8px;"></div>
            </div>
        </div>

        <div id="page-history" class="page">
            <h1>📜 كشف الحساب</h1>
            <div id="history-container"></div>
        </div>

        <div id="page-notifications" class="page">
            <h1>🔔 الإشعارات</h1>
            <button class="btn btn-blue" style="margin-bottom:1rem;" onclick="markAllRead()">تحديد الكل كمقروء</button>
            <div id="notifications-container"></div>
        </div>

        <div id="page-cards" class="page">
            <h1>💳 البطاقات البنكية</h1>
            <div id="cards-list-container"></div>
            <div class="card card-blue" id="card-request-form">
                <h2>📤 تقديم طلب بطاقة جديدة</h2>
                <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:1rem;">يُرسل الطلب لمراجعة الإدارة ولا يُفعَّل تلقائياً</p>
                <div id="card-req-msg"></div>
                <label>🪪 بطاقتك العسكرية (رقم بطاقتك من فلاش):</label>
                <input id="card-mil-number" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="ضع رقم بطاقتك العسكرية (8 أرقام)" />
                <label>🛡️ قطاعك العسكري:</label>
                <select id="card-mil-sector">
                    <option value="">— اختر القطاع —</option>
                    <option value="الدوريات">الدوريات</option>
                    <option value="أمن الطرق">أمن الطرق</option>
                    <option value="مكافحة المخدرات">مكافحة المخدرات</option>
                    <option value="الأمن السيبراني">الأمن السيبراني</option>
                    <option value="الشرطة العسكرية">الشرطة العسكرية</option>
                </select>
                <label>🎖️ رتبتك العسكرية:</label>
                <select id="card-mil-rank"><option value="">— اختر الرتبة —</option></select>
                <label>🧩 يونتك العسكري:</label>
                <input id="card-mil-unit" autocomplete="off" placeholder="اكتب اسم اليونت" />
                <label>سبب طلب البطاقة:</label>
                <textarea id="card-reason" rows="3" maxlength="500" placeholder="اشرح سبب حاجتك للبطاقة..."></textarea>
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:1rem;">
                    <input type="checkbox" id="card-pledge" style="width:auto; margin:0;" />
                    <span>أتعهد باستخدام البطاقة بالشكل الصحيح وعدم مشاركتها مع أحد</span>
                </label>
                <button class="btn btn-blue btn-full" onclick="submitCardRequest()">📤 إرسال الطلب للمراجعة</button>
            </div>
        </div>

        <button id="admin-fab-btn" class="admin-fab" onclick="openAdminPanel()">⚙️ إدارة البنك</button>
    </div>

    <div id="pinPadModal" class="custom-modal">
        <div class="modal-content" style="max-width:340px; text-align:center;">
            <p style="color:#e2e8f0; font-weight:bold; margin-bottom:6px;">🔐 أدخل الرقم السري</p>
            <p style="color:#64748b; font-size:0.8rem; margin-bottom:16px;">4 أرقام — احفظه في ذاكرتك، ما يظهر على البطاقة ولا يعرفه أحد</p>
            <div id="pinpad-dots" style="display:flex; justify-content:center; gap:14px; margin-bottom:22px;">
                <span class="pinpad-dot" data-i="0"></span>
                <span class="pinpad-dot" data-i="1"></span>
                <span class="pinpad-dot" data-i="2"></span>
                <span class="pinpad-dot" data-i="3"></span>
            </div>
            <div id="pinpad-msg" style="margin-bottom:10px;"></div>
            <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; justify-items:center; margin-bottom:16px; direction:ltr;">
                <div class="pinpad-btn" onclick="pinPadPress('1')">1</div>
                <div class="pinpad-btn" onclick="pinPadPress('2')">2</div>
                <div class="pinpad-btn" onclick="pinPadPress('3')">3</div>
                <div class="pinpad-btn" onclick="pinPadPress('4')">4</div>
                <div class="pinpad-btn" onclick="pinPadPress('5')">5</div>
                <div class="pinpad-btn" onclick="pinPadPress('6')">6</div>
                <div class="pinpad-btn" onclick="pinPadPress('7')">7</div>
                <div class="pinpad-btn" onclick="pinPadPress('8')">8</div>
                <div class="pinpad-btn" onclick="pinPadPress('9')">9</div>
                <div class="pinpad-btn" style="visibility:hidden;">0</div>
                <div class="pinpad-btn" onclick="pinPadPress('0')">0</div>
                <div class="pinpad-btn" style="border:none; font-size:1.3rem;" onclick="pinPadBackspace()">⌫</div>
            </div>
            <button class="btn" style="background:transparent; color:#94a3b8; border:1px solid #334155; width:100%;" onclick="closePinPad()">إلغاء</button>
        </div>
    </div>

    <button id="sp-fab" onclick="spOpen()" title="خدمة العملاء">🎧<span class="sp-badge" id="sp-fab-badge" style="display:none;"></span></button>
    <div id="sp-modal" onclick="if(event.target===this) spClose()">
        <div id="sp-box">
            <div id="sp-head"><span>🎧 خدمة العملاء</span><button onclick="spClose()">✕</button></div>
            <div id="sp-body"></div>
        </div>
    </div>
    <div id="sp-lightbox" onclick="this.style.display='none'"><img id="sp-lightbox-img" src=""></div>
    <div id="wf-overlay"><div class="wf-box" id="wf-box"></div></div>

    <div id="adminModal" class="custom-modal">
        <div class="modal-content">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:2px solid #3b82f6; padding-bottom:10px;">
                <h2 id="admin-panel-title" style="color:#60a5fa;">لوحة إدارة البنك ⚙️</h2>
                <button onclick="closeAdminModal()" style="background:none; border:none; color:white; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div class="tabs-container">
                <button id="atab-stats" class="tab-btn active" onclick="switchAdminTab('stats')">📊 إحصائيات</button>
                <button id="atab-accounts" class="tab-btn" onclick="switchAdminTab('accounts')">👥 الحسابات</button>
                <button id="atab-loans" class="tab-btn" onclick="switchAdminTab('loans')">📋 القروض</button>
                <button id="atab-cards" class="tab-btn" onclick="switchAdminTab('cards')">💳 البطاقات</button>
                <button id="atab-card-control" class="tab-btn" style="display:none;" onclick="switchAdminTab('card-control')">🕹️ تحكم البطاقات</button>
                <button id="atab-support" class="tab-btn sp-nav-admin" onclick="switchAdminTab('support')">🎧 الدعم</button>
                <button id="atab-staff" class="tab-btn" onclick="switchAdminTab('staff')">👔 الموظفون</button>
                <button id="atab-locks" class="tab-btn" onclick="switchAdminTab('locks')">🔒 إيقاف الميزات</button>
                <button id="atab-settings" class="tab-btn" style="display:none;" onclick="switchAdminTab('settings')">👑 إعدادات كبار المسؤولين</button>
                <button id="atab-military-salary" class="tab-btn" style="display:none;" onclick="switchAdminTab('military-salary')">🎖️ رواتب العساكر</button>
                <button id="atab-profiles" class="tab-btn" style="display:none;" onclick="switchAdminTab('profiles')">🗂️ الملفات البنكية</button>
                <button id="atab-bank-log" class="tab-btn" style="display:none;" onclick="switchAdminTab('bank-log')">📜 سجل البنك</button>
            </div>
            
            <div id="atab-stats-section">
                <div id="admin-stats-container"></div>
            </div>
            
            <div id="atab-accounts-section" style="display:none;">
                <div id="admin-accounts-container">جاري التحميل...</div>
            </div>
            
            <div id="atab-loans-section" style="display:none;">
                <div id="admin-loans-container">جاري التحميل...</div>
            </div>

            <div id="atab-cards-section" style="display:none;">
                <div id="admin-cards-container">جاري التحميل...</div>
            </div>

            <div id="atab-card-control-section" style="display:none;">
                <div id="card-control-container">جاري التحميل...</div>
            </div>

            <div id="atab-profiles-section" style="display:none;">
                <div id="profiles-container">جاري التحميل...</div>
            </div>

            <div id="atab-staff-section" style="display:none;">
                <div class="card card-blue" style="margin-bottom:14px;">
                    <h2>👔 توظيف موظف جديد</h2>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
                        <div style="flex:2; min-width:200px;">
                            <label>الحساب (ابحث بالاسم أو برقم الحساب):</label>
                            <input id="hire-search" placeholder="اكتب اسم العضو أو رقم حسابه" autocomplete="off" style="margin-bottom:0;" />
                            <input type="hidden" id="hire-uid" />
                            <div id="hire-pick-box" class="pick-box"></div>
                            <div id="hire-chosen" class="pick-chosen"></div>
                        </div>
                        <div>
                            <label>الرتبة:</label>
                            <select id="hire-role" style="margin-bottom:0; width:auto;">
                                <option value="staff">موظف</option>
                                <option value="management">إدارة</option>
                            </select>
                        </div>
                        <button class="btn btn-green" onclick="hireStaff()">✅ توظيف</button>
                    </div>
                    <div id="hire-msg" style="margin-top:8px;"></div>
                </div>
                <div id="staff-list-container">جاري التحميل...</div>
            </div>

            <div id="atab-bank-log-section" style="display:none;">
                <div id="bank-log-container">جاري التحميل...</div>
            </div>

            <div id="atab-support-section" style="display:none;">
                <div id="admin-support-container">جاري التحميل...</div>
            </div>

            <div id="atab-locks-section" style="display:none;">
                <div class="card card-blue">
                    <h2>🔒 التحكم في قفل ميزات النظام المصرفي</h2>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:1.5rem;">يمكنك قفل أو فتح الميزات المالية أدناه مباشرة.</p>
                    
                    <div id="superadmin-only-locks" style="display:none; border-bottom:2px dashed rgba(239,68,68,0.3); padding-bottom:15px; margin-bottom:15px;">
                        <h4 style="color:#ef4444; margin-bottom:10px;">👑 صلاحيات كبار المسؤولين فقط:</h4>
                        <div class="toggle-box">
                            <span>🚨 قفل البنك بالكامل (صيانة عامة)</span>
                            <button id="btn-lock-maintenance" class="btn" onclick="toggleFeature('isMaintenance')">فحص...</button>
                        </div>
                        <div class="toggle-box">
                            <span>💳 قفل إنشاء حساب جديد</span>
                            <button id="btn-lock-register" class="btn" onclick="toggleFeature('disableRegister')">فحص...</button>
                        </div>
                    </div>

                    <h4 style="color:#3b82f6; margin-bottom:10px;">💸 صلاحيات رئيس البنك وكبار المسؤولين:</h4>
                    <div class="toggle-box">
                        <span>💸 قفل تحويل الأموال</span>
                        <button id="btn-lock-transfer" class="btn" onclick="toggleFeature('disableTransfer')">فحص...</button>
                    </div>
                    <div class="toggle-box">
                        <span>📋 قفل استقبال القروض</span>
                        <button id="btn-lock-loans" class="btn" onclick="toggleFeature('disableLoans')">فحص...</button>
                    </div>
                    <div class="toggle-box">
                        <span>💳 قفل طلب البطاقات</span>
                        <button id="btn-lock-cards" class="btn" onclick="toggleFeature('disableCards')">فحص...</button>
                    </div>
                    <div class="toggle-box">
                        <span>🎧 قفل خدمة العملاء (السبب إجباري)</span>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <input id="support-lock-reason" placeholder="سبب القفل..." style="width:180px; margin-bottom:0; font-size:0.8rem; padding:6px 8px;" />
                            <button id="btn-lock-support" class="btn" onclick="toggleSupportLock()">فحص...</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div id="atab-settings-section" style="display:none;">
                <div class="card card-red">
                    <h3>⚙️ نسبة الفائدة</h3><br>
                    <label>نسبة فائدة التوفير (%):</label>
                    <input id="interest-rate-input" type="number" placeholder="2" min="0" max="100" />
                    <button class="btn btn-blue" onclick="saveBankSettings()">حفظ نسبة الفائدة</button>
                </div>
                <div class="card card-yellow">
                    <h3>💸 رسوم التحويل (لرئيس البنك)</h3><br>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">تُخصم من المحوِّل إضافةً للمبلغ المحوَّل وتُضاف لحساب رئيس البنك.</p>
                    <label>مبلغ رسوم التحويل ($):</label>
                    <input id="transfer-fee-input" type="number" placeholder="مثال: 10" min="0" />
                    <label>رقم حساب رئيس البنك (مستلم الرسوم):</label>
                    <input id="transfer-fee-recipient" placeholder="6 أرقام" maxlength="6" />
                    <button class="btn btn-yellow" onclick="saveTransferFee()">💾 حفظ رسوم التحويل</button>
                    <div id="transfer-fee-msg" style="margin-top:8px;"></div>
                </div>
                <div class="card card-blue">
                    <h3>🔄 رسوم تجديد البطاقة</h3><br>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">تُخصم من المستخدم عند طلب تجديد بطاقة منتهية الصلاحية.</p>
                    <label>مبلغ رسوم التجديد ($):</label>
                    <input id="card-renewal-fee-input" type="number" placeholder="مثال: 50" min="0" />
                    <button class="btn btn-blue" onclick="saveRenewalFee()">💾 حفظ رسوم التجديد</button>
                    <div id="renewal-fee-msg" style="margin-top:8px;"></div>
                </div>
                <div class="card" style="border-color:#a78bfa;">
                    <h3>⏳ انتهاء صلاحية القروض</h3><br>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">بعد كم يوم تنتهي صلاحية القرض؟ (0 = بدون انتهاء)</p>
                    <label>مدة القرض (بالأيام):</label>
                    <input id="loan-expiry-days" type="number" placeholder="مثال: 30" min="0" />
                    <label>تطبيق على:</label>
                    <select id="loan-expiry-apply">
                        <option value="new">القروض الجديدة فقط</option>
                        <option value="existing">القروض الحالية فقط</option>
                        <option value="both">الحالية والجديدة</option>
                    </select>
                    <button class="btn btn-blue" onclick="saveLoanExpiry()" style="background:#7c3aed;">💾 حفظ إعدادات القروض</button>
                    <div id="loan-expiry-msg" style="margin-top:8px;"></div>
                </div>
                <div class="card card-blue">
                    <h3>👥 إدارة مسؤولي البنك (رئيس بنك جديد)</h3><br>
                    <div style="display:flex; gap:10px; margin-bottom:10px;">
                        <div style="flex:1;">
                            <input id="new-admin-search" placeholder="ابحث بالاسم أو برقم الحساب" autocomplete="off" style="margin-bottom:0;" />
                            <input type="hidden" id="new-admin-id" />
                            <div id="new-admin-pick-box" class="pick-box"></div>
                            <div id="new-admin-chosen" class="pick-chosen"></div>
                        </div>
                        <button class="btn btn-green" onclick="addBankAdmin()">تعيين</button>
                    </div>
                    <div id="admin-list-container"></div>
                </div>
            </div>

            <div id="atab-military-salary-section" style="display:none;">
                <div class="card card-blue">
                    <h2>🎖️ رواتب العساكر (ربط مع موقع فلاش)</h2>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:1rem;">حدد كل كم مدة تنزل رواتب العساكر، وحدد راتب كل رتبة. الراتب ينزل تلقائياً على الحساب البنكي المسجل لكل عسكري حسب رتبته في موقع فلاش.</p>

                    <div id="military-salary-status" style="margin-bottom:14px;"></div>

                    <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px;">
                        <div>
                            <label>كل:</label>
                            <input id="ms-period-value" type="number" min="1" placeholder="مثال: 7" style="width:100px;" />
                        </div>
                        <div>
                            <label>الوحدة:</label>
                            <select id="ms-period-unit">
                                <option value="days">يوم</option>
                                <option value="weeks">أسبوع</option>
                                <option value="months">شهر</option>
                            </select>
                        </div>
                        <button class="btn" id="ms-toggle-btn" onclick="toggleMilitarySalary()">فحص...</button>
                        <button class="btn btn-blue" onclick="runMilitarySalaryNow()">💸 صرف الآن يدوياً</button>
                    </div>

                    <h4 style="color:#3b82f6; margin-bottom:10px;">🎖️ رواتب الرتب العسكرية:</h4>
                    <div id="military-salary-ranks-container">جاري التحميل...</div>

                    <button class="btn btn-green" style="margin-top:14px;" onclick="saveMilitarySalary()">💾 حفظ الإعدادات</button>
                    <div id="military-salary-msg" style="margin-top:8px;"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentRole = 'user', currentIsOwner = false;
        let currentAccount = null;
        let bankSettingsCache = null;

        // ═══════════ نوافذ الموقع: تنبيه / تأكيد / فورم ═══════════
        const UI_COLORS = { info: '#3b82f6', success: '#22c55e', warning: '#eab308', danger: '#ef4444' };
        const UI_BTN = { info: 'btn-blue', success: 'btn-green', warning: 'btn-yellow', danger: 'btn-red' };
        function uiEl(tag, cls, text) {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text !== undefined && text !== null) e.textContent = text;
            return e;
        }
        function uiShell(type, title) {
            const ov = uiEl('div', 'ui-ov');
            const box = uiEl('div', 'ui-box');
            box.style.setProperty('--c', UI_COLORS[type] || UI_COLORS.info);
            if (title) box.appendChild(uiEl('div', 'ui-title', title));
            ov.appendChild(box);
            document.body.appendChild(ov);
            return { ov: ov, box: box };
        }
        // ── قوائم اختيار مخصصة: تخفي select الأصلي (قائمة الآيفون) وتفتح قائمة داخل الموقع ──
        function csRefresh(el) {
            const sel = typeof el === 'string' ? document.getElementById(el) : el;
            if (!sel || !sel._cs) return;
            const o = sel.options[sel.selectedIndex];
            sel._cs.querySelector('.cs-lbl').textContent = o ? o.textContent : '';
        }
        function csOpen(sel) {
            const ov = document.createElement('div'); ov.className = 'cs-ov';
            const box = document.createElement('div'); box.className = 'cs-box';
            const prev = sel.previousElementSibling;
            const t = document.createElement('div'); t.className = 'cs-title';
            t.textContent = (prev && prev.tagName === 'LABEL') ? prev.textContent.replace(/[:：]\\s*$/, '') : 'اختر';
            box.appendChild(t);
            function close() { ov.remove(); }
            Array.from(sel.options).forEach(function (o) {
                const b = document.createElement('button'); b.type = 'button';
                b.className = 'cs-opt' + (o.value === sel.value ? ' on' : '');
                b.textContent = o.textContent;
                b.onclick = function () { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); csRefresh(sel); close(); };
                box.appendChild(b);
            });
            ov.appendChild(box);
            ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
            document.body.appendChild(ov);
        }
        function csEnhance(sel) {
            if (!sel || sel._cs) return;
            const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cs-btn';
            const st = sel.getAttribute('style'); if (st) btn.style.cssText = st;
            btn.innerHTML = '<span class="cs-lbl"></span><span class="cs-arrow">▾</span>';
            btn.addEventListener('click', function () { csOpen(sel); });
            sel.parentNode.insertBefore(btn, sel.nextSibling);
            sel.style.display = 'none';
            sel._cs = btn;
            csRefresh(sel);
        }
        function csEnhanceAll() { document.querySelectorAll('select[id]').forEach(csEnhance); }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', csEnhanceAll); else csEnhanceAll();

        // ── قفل تمرير الخلفية لما تنفتح أي قائمة كبيرة (لوحة الإدارة، نوافذ، قوائم) ──
        function uiModalOpen() {
            if (document.querySelector('.ui-ov, .cs-ov, .dg-ov')) return true;
            const ms = document.querySelectorAll('.custom-modal');
            for (let i = 0; i < ms.length; i++) { const d = ms[i].style.display; if (d && d !== 'none') return true; }
            return false;
        }
        let uiLockRaf = 0;
        function uiSyncLock() {
            if (uiLockRaf) return;
            uiLockRaf = requestAnimationFrame(function () {
                uiLockRaf = 0;
                document.documentElement.classList.toggle('modal-open', uiModalOpen());
            });
        }
        new MutationObserver(uiSyncLock).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
        // آيفون: نمنع سحب الخلفية إلا إذا كان الإصبع داخل عنصر قابل للتمرير في النافذة نفسها
        document.addEventListener('touchmove', function (e) {
            if (!document.documentElement.classList.contains('modal-open')) return;
            let n = e.target;
            while (n && n !== document.body && n.nodeType === 1) {
                const oy = getComputedStyle(n).overflowY;
                if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return;
                n = n.parentElement;
            }
            e.preventDefault();
        }, { passive: false });

        // ── إشعار منبثق عام (تحت يمين) يستخدمه كل الموقع بدل الرسائل داخل الصفحة ──
        function uiToast(msg, type, ms) {
            type = UI_COLORS[type] ? type : 'info';
            const clean = String(msg === undefined || msg === null ? '' : msg).replace(/^(✅|❌|⚠️?)[ ]*/, '').trim();
            if (!clean) return;
            let wrap = document.getElementById('notif-toast-wrap');
            if (!wrap) { wrap = uiEl('div'); wrap.id = 'notif-toast-wrap'; document.body.appendChild(wrap); }
            const dup = Array.from(wrap.children).some(function (c) { return c._msg === clean; });
            if (dup) return;
            const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', danger: '❌' };
            const titles = { info: 'معلومة', success: 'تمت العملية', warning: 'تنبيه', danger: 'تعذّر التنفيذ' };
            const dur = ms || NOTIF_TOAST_MS;
            const t = uiEl('div', 'ntoast ntoast-' + type);
            t._msg = clean;
            t.appendChild(uiEl('div', 'ntoast-title', icons[type] + ' ' + titles[type]));
            t.appendChild(uiEl('div', 'ntoast-text', clean));
            const bar = uiEl('div', 'ntoast-bar');
            const fill = document.createElement('i');
            fill.style.animationDuration = dur + 'ms';
            bar.appendChild(fill); t.appendChild(bar);
            wrap.appendChild(t);
            function closeIt() { t.classList.add('out'); setTimeout(function () { t.remove(); }, 280); }
            setTimeout(closeIt, dur);
            t.onclick = closeIt;
        }

        function uiAlert(msg, type) {
            msg = String(msg === undefined || msg === null || msg === '' ? 'تمت العملية' : msg);
            if (!type) type = msg.indexOf('✅') === 0 ? 'success' : msg.indexOf('❌') === 0 ? 'danger' : msg.indexOf('⚠') === 0 ? 'warning' : 'info';
            const clean = msg.replace(/^(✅|❌|⚠️?)[ ]*/, '');
            const titles = { success: '✅ تمت العملية', danger: '❌ تعذّر التنفيذ', warning: '⚠️ تنبيه', info: 'ℹ️ معلومة' };
            return new Promise(function (resolve) {
                const s = uiShell(type, titles[type]);
                s.box.appendChild(uiEl('div', 'ui-msg', clean));
                const actions = uiEl('div', 'ui-actions');
                const ok = uiEl('button', 'btn ' + (UI_BTN[type] || 'btn-blue'), 'حسناً');
                actions.appendChild(ok);
                s.box.appendChild(actions);
                function done() { document.removeEventListener('keydown', onKey, true); s.ov.remove(); resolve(true); }
                function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } }
                document.addEventListener('keydown', onKey, true);
                ok.onclick = done;
                s.ov.addEventListener('mousedown', function (e) { if (e.target === s.ov) done(); });
                ok.focus();
            });
        }
        function uiConfirm(msg, o) {
            o = o || {};
            const type = o.danger ? 'danger' : 'warning';
            return new Promise(function (resolve) {
                const s = uiShell(type, o.title || (o.danger ? '⚠️ تأكيد مهم' : '❓ تأكيد'));
                s.box.appendChild(uiEl('div', 'ui-msg', msg));
                if (o.detail) s.box.appendChild(uiEl('div', 'ui-detail', o.detail));
                const actions = uiEl('div', 'ui-actions');
                const ok = uiEl('button', 'btn ' + (o.danger ? 'btn-red' : 'btn-blue'), o.okText || 'نعم');
                const no = uiEl('button', 'btn ui-cancel', o.cancelText || 'لا');
                actions.appendChild(ok); actions.appendChild(no);
                s.box.appendChild(actions);
                function done(v) { document.removeEventListener('keydown', onKey, true); s.ov.remove(); resolve(v); }
                function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } }
                document.addEventListener('keydown', onKey, true);
                ok.onclick = function () { done(true); };
                no.onclick = function () { done(false); };
                s.ov.addEventListener('mousedown', function (e) { if (e.target === s.ov) done(false); });
                no.focus();
            });
        }
        // fields: [{ name, label, type: text|number|textarea|select, value, placeholder, min, step, required, hint, options: [{v, l}] }]
        function uiForm(o) {
            return new Promise(function (resolve) {
                const s = uiShell(o.type || 'info', o.title || '');
                if (o.desc) s.box.appendChild(uiEl('div', 'ui-msg', o.desc));
                const inputs = {};
                (o.fields || []).forEach(function (f) {
                    const wrap = uiEl('div', 'ui-field');
                    wrap.appendChild(uiEl('label', '', f.label + (f.required ? ' *' : '')));
                    let inp;
                    if (f.type === 'select') {
                        inp = document.createElement('select');
                        (f.options || []).forEach(function (op) {
                            const oe = document.createElement('option');
                            oe.value = op.v; oe.textContent = op.l;
                            if (String(op.v) === String(f.value)) oe.selected = true;
                            inp.appendChild(oe);
                        });
                    } else if (f.type === 'textarea') {
                        inp = document.createElement('textarea');
                        if (f.value !== undefined && f.value !== null) inp.value = f.value;
                    } else {
                        inp = document.createElement('input');
                        inp.type = f.type === 'number' ? 'number' : 'text';
                        if (f.type === 'number') { inp.inputMode = 'decimal'; inp.step = f.step || 'any'; }
                        if (f.value !== undefined && f.value !== null) inp.value = f.value;
                    }
                    if (f.placeholder) inp.placeholder = f.placeholder;
                    inputs[f.name] = { el: inp, f: f };
                    wrap.appendChild(inp);
                    if (f.hint) wrap.appendChild(uiEl('div', 'ui-hint', f.hint));
                    s.box.appendChild(wrap);
                    if (f.type === 'select') csEnhance(inp);
                });
                const err = uiEl('div', 'ui-err');
                s.box.appendChild(err);
                const actions = uiEl('div', 'ui-actions');
                const ok = uiEl('button', 'btn btn-blue', o.okText || 'حفظ');
                const no = uiEl('button', 'btn ui-cancel', 'إلغاء');
                actions.appendChild(ok); actions.appendChild(no);
                s.box.appendChild(actions);
                function done(v) { document.removeEventListener('keydown', onKey, true); s.ov.remove(); resolve(v); }
                function submit() {
                    const out = {};
                    for (const name in inputs) {
                        const f = inputs[name].f;
                        const v = String(inputs[name].el.value).trim();
                        if (f.required && v === '') { err.textContent = '⚠️ ' + f.label + ' مطلوب'; inputs[name].el.focus(); return; }
                        if (f.type === 'number' && v !== '') {
                            const num = Number(v);
                            if (!isFinite(num)) { err.textContent = '⚠️ ' + f.label + ' لازم يكون رقم'; inputs[name].el.focus(); return; }
                            if (f.min !== undefined && num < f.min) { err.textContent = '⚠️ ' + f.label + ' لا يقل عن ' + f.min; inputs[name].el.focus(); return; }
                        }
                        out[name] = v;
                    }
                    done(out);
                }
                function onKey(e) {
                    if (e.key === 'Escape') { e.preventDefault(); done(null); }
                    else if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit(); }
                }
                document.addEventListener('keydown', onKey, true);
                ok.onclick = submit;
                no.onclick = function () { done(null); };
                s.ov.addEventListener('mousedown', function (e) { if (e.target === s.ov) done(null); });
                const first = Object.keys(inputs)[0];
                if (first) inputs[first].el.focus();
            });
        }

        // ═══════════ إشعار منبثق (تحت يمين) ═══════════
        const NOTIF_TOAST_MS = 5000;           // مدة بقاء الإشعار (بالملي ثانية)
        const NOTIF_ADMIN_PREFIX = '📢 رسالة من الإدارة:';
        let notifBaseline = false, lastLatestUnread = null, notifBusy = false;
        const toastedNotifIds = new Set();
        function showNotifToast(n) {
            let wrap = document.getElementById('notif-toast-wrap');
            if (!wrap) { wrap = uiEl('div'); wrap.id = 'notif-toast-wrap'; document.body.appendChild(wrap); }
            const type = UI_COLORS[n.type] ? n.type : 'info';
            const icons = { info: '🏦', success: '✅', warning: '⚠️', danger: '🚨' };
            let title = icons[type] + ' إشعار جديد';
            let text = String(n.message || '');
            if (text.indexOf(NOTIF_ADMIN_PREFIX) === 0) {
                title = icons[type] + ' إشعار من الإدارة';
                text = text.substring(NOTIF_ADMIN_PREFIX.length).trim();
            }
            if (type === 'danger') { showDangerModal(title, text); return; }
            const t = uiEl('div', 'ntoast ntoast-' + type);
            t.appendChild(uiEl('div', 'ntoast-title', title));
            t.appendChild(uiEl('div', 'ntoast-text', text));
            const bar = uiEl('div', 'ntoast-bar');
            const fill = document.createElement('i');
            fill.style.animationDuration = NOTIF_TOAST_MS + 'ms';
            bar.appendChild(fill);
            t.appendChild(bar);
            wrap.appendChild(t);
            let closed = false;
            function closeToast() {
                if (closed) return; closed = true;
                t.classList.add('out');
                setTimeout(function () { t.remove(); }, 280);
            }
            setTimeout(closeToast, NOTIF_TOAST_MS);
            t.onclick = function () {
                closeToast();
                try {
                    const am = document.getElementById('adminModal');
                    if (am && am.style.display !== 'none' && typeof closeAdminModal === 'function') closeAdminModal();
                    goPage('notifications');
                    window.scrollTo(0, 0);
                } catch (e) {}
            };
            // الاهتزاز والصوت حسب نوع الإشعار
            if (type === 'info') notifVibrate([40]);                         // معلومة: هزّة خفيفة
            else if (type === 'success') { notifVibrate([30, 60, 30]); playSuccessSound(); }  // نجاح: هزّة خفيفة + صوت «صح»
            else if (type === 'warning') notifVibrate(VIB_WARNING);           // تحذير: هزّ ثقيل وطويل
        }
        // ═══════════ أنماط الاهتزاز (هزّ / وقفة / هزّ ...) بالملي ثانية ═══════════
        const VIB_WARNING = [700, 150, 700, 150, 600, 150, 400, 150, 200];                         // أصفر: هززززز هززززز هزززز هزز
        const VIB_DANGER  = [1000, 120, 1000, 120, 900, 120, 800, 120, 500, 120, 300];             // أحمر: أثقل وأطول
        function notifVibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }
        // صوت «صح» للنجاح: نغمتين صاعدتين قصيرتين
        function playSuccessSound() {
            try {
                const c = getDangerCtx();
                if (!c || c.state !== 'running') return;
                const now = c.currentTime;
                [[880, 0], [1320, 0.13]].forEach(function (n) {
                    const o = c.createOscillator(), g = c.createGain();
                    o.type = 'sine'; o.frequency.value = n[0];
                    g.gain.setValueAtTime(0.0001, now + n[1]);
                    g.gain.exponentialRampToValueAtTime(0.25, now + n[1] + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.0001, now + n[1] + 0.25);
                    o.connect(g); g.connect(c.destination);
                    o.start(now + n[1]); o.stop(now + n[1] + 0.27);
                });
            } catch (e) {}
        }
        // ═══════════ صوت إنذار الخطر (مولَّد بالكود، ما يحتاج ملف صوت) ═══════════
        let dangerAudioCtx = null, dangerLoop = null, dangerOv = null;
        function getDangerCtx() {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                if (!dangerAudioCtx) dangerAudioCtx = new AC();
                return dangerAudioCtx;
            } catch (e) { return null; }
        }
        getDangerCtx(); // نجهّزه من أول تحميل للصفحة عشان ما يتأخر الصوت
        // المتصفح يمنع الصوت قبل أول لمسة، فنفتحه مع أول ضغطة بالموقع (وإذا الإنذار طالع نشغّل الصوت فوراً)
        ['click', 'touchend', 'pointerdown', 'keydown'].forEach(function (ev) {
            document.addEventListener(ev, function () {
                const c = getDangerCtx();
                if (!c) return;
                try { const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource(); src.buffer = b; src.connect(c.destination); src.start(0); } catch (e) {}
                if (c.state !== 'running') {
                    c.resume().then(function () { if (dangerLoop) dangerBeep(); }).catch(function () {});
                }
            }, { passive: true, capture: true });
        });
        // يشغّل دورة صفارة وحدة (ثانيتين). يرجّع true إذا الصوت شغّال، false إذا المتصفح لسا يمنعه
        function dangerBeep() {
            try {
                const c = getDangerCtx();
                if (!c) return false;
                if (c.state !== 'running') { c.resume().catch(function () {}); return false; }
                const now = c.currentTime;
                const gain = c.createGain();
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.4, now + 0.03);
                gain.gain.setValueAtTime(0.4, now + 1.9);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
                gain.connect(c.destination);
                const osc = c.createOscillator();
                osc.type = 'square';
                for (let i = 0; i < 4; i++) {
                    osc.frequency.setValueAtTime(880, now + i * 0.5);
                    osc.frequency.setValueAtTime(660, now + i * 0.5 + 0.25);
                }
                osc.connect(gain);
                osc.start(now);
                osc.stop(now + 2.0);
                return true;
            } catch (e) { return false; }
        }
        function stopDangerSound() {
            if (dangerLoop) { clearInterval(dangerLoop.timer); clearTimeout(dangerLoop.cap); dangerLoop = null; }
            notifVibrate(0);
        }
        function startDangerSound(hintEl) {
            if (dangerLoop) return;
            let n = 0;
            function tick() {
                const ok = dangerBeep();
                if (hintEl) hintEl.style.display = ok ? 'none' : 'block';
                if (n++ % 3 === 0) notifVibrate(VIB_DANGER);   // اهتزاز ثقيل يتكرر كل ~7 ثواني
            }
            dangerLoop = { timer: setInterval(tick, 2300), cap: setTimeout(stopDangerSound, 120000) };
            tick();
        }
        // ═══════════ نافذة الخطر: الخلفية تتغبش شوي وتتوقف، والصوت يشتغل لين يضغط «فهمت» ═══════════
        function showDangerModal(title, text) {
            if (dangerOv) {
                const extra = uiEl('div', 'dg-msg dg-extra', text);
                dangerOv.querySelector('.dg-list').appendChild(extra);
                return;
            }
            const ov = uiEl('div', 'dg-ov');
            const box = uiEl('div', 'dg-box');
            box.appendChild(uiEl('div', 'dg-icon', '🚨'));
            box.appendChild(uiEl('div', 'dg-title', title.replace(/^🚨\s*/, '')));
            const list = uiEl('div', 'dg-list');
            list.appendChild(uiEl('div', 'dg-msg', text));
            box.appendChild(list);
            const hint = uiEl('div', 'dg-hint', '🔊 المس الشاشة لتشغيل صوت الإنذار');
            hint.style.display = 'none';
            box.appendChild(hint);
            const ok = uiEl('button', 'btn btn-red dg-btn', 'فهمت');
            box.appendChild(ok);
            ov.appendChild(box);
            document.body.appendChild(ov);
            dangerOv = ov;
            document.body.style.overflow = 'hidden';
            function close() {
                stopDangerSound();
                ov.remove();
                dangerOv = null;
                document.body.style.overflow = '';
                document.removeEventListener('keydown', blockKeys, true);
            }
            function blockKeys(e) {
                if (e.key === 'Enter' && document.activeElement === ok) return;
                if (e.key === 'Tab') return;
                e.preventDefault(); e.stopPropagation();
            }
            document.addEventListener('keydown', blockKeys, true);
            ok.onclick = close;
            startDangerSound(hint);
            try { ok.focus(); } catch (e) {}
        }
        async function handleNotifPush(latestId) {
            if (notifBusy) return;
            if (notifBaseline && latestId === lastLatestUnread) return;
            notifBusy = true;
            try {
                const res = await fetch('/api/notifications');
                const list = await res.json();
                if (!Array.isArray(list)) return;
                lastLatestUnread = latestId;
                if (!notifBaseline) {
                    notifBaseline = true;
                    list.forEach(function (n) { toastedNotifIds.add(n._id); });
                    return;
                }
                const fresh = list.filter(function (n) { return !n.read && !toastedNotifIds.has(n._id); }).reverse();
                fresh.forEach(function (n) { toastedNotifIds.add(n._id); });
                fresh.slice(-3).forEach(showNotifToast);
            } catch (e) {} finally { notifBusy = false; }
        }

        async function init() {
            const res = await fetch('/api/auth/me');
            const data = await res.json();

            // فحص الصيانة العامة للبنك
            if (data.maintenance && data.role !== 'super_admin' && data.role !== 'admin') {
                document.getElementById('maintenance-screen').style.display = 'block';
                document.getElementById('login-screen').style.display = 'none';
                return;
            }

            if (!data.loggedIn) {
                document.getElementById('login-screen').style.display = 'block';
                return;
            }

            if (!data.flashRegistered) {
                document.getElementById('not-member-screen').style.display = 'block';
                return;
            }

            currentUser = data.user;
            currentRole = data.role;
            currentIsOwner = !!data.isOwner;
            currentRealOwner = !!data.realOwner;
            ME = { isSeniorAdmin: data.role === 'super_admin', isAdmin: ['staff','management','admin','super_admin'].indexOf(data.role) >= 0, isOwner: !!data.realOwner };

            if (!data.hasAccount) {
                // ما فيه حساب = ما دخل من فلاش (الحساب يتفتح تلقائياً عند الدخول من زر البنك في فلاش)
                document.getElementById('login-screen').style.display = 'block';
                return;
            }
            showMainSite();
        }

        async function showMainSite() {
            document.getElementById('main-site').style.display = 'block';
            document.getElementById('auth-section').innerHTML = \`
                <span class="nav-user">👤 \${currentUser.username}</span>
                <button class="nav-back" onclick="location.href=(window.BANK_BASE||'')+'/logout'">↩️ فلاش</button>
                <button class="hamburger-btn" id="hamburger-btn" onclick="toggleMobileMenu()">☰</button>
            \`;
            if(['staff','management','admin','super_admin'].includes(currentRole)) {
                document.getElementById('admin-fab-btn').style.display = 'block';

                if (currentRole === 'staff') {
                    // موظف: القروض + البطاقات + الدعم فقط
                    document.getElementById('admin-fab-btn').innerText = '⚙️ لوحة الموظف';
                    document.getElementById('admin-panel-title').innerText = "لوحة الموظف 👤";
                    ['atab-stats','atab-accounts','atab-card-control','atab-tickets-log','atab-staff','atab-locks'].forEach(id => {
                        const b = document.getElementById(id); if (b) b.style.display = 'none';
                    });
                } else if (currentRole === 'management') {
                    // إداري: القروض + البطاقات + الدعم + الحسابات
                    document.getElementById('admin-fab-btn').innerText = '⚙️ لوحة الإداري';
                    document.getElementById('admin-panel-title').innerText = "لوحة الإداري 🏢";
                    ['atab-stats','atab-card-control','atab-tickets-log','atab-staff','atab-locks'].forEach(id => {
                        const b = document.getElementById(id); if (b) b.style.display = 'none';
                    });
                }

                if(currentRole === 'super_admin') {
                    document.getElementById('atab-settings').style.display = 'block';
                    document.getElementById('atab-bank-log').style.display = 'block';
                    document.getElementById('atab-profiles').style.display = 'block';
                    document.getElementById('atab-card-control').style.display = 'block';
                    document.getElementById('atab-military-salary').style.display = 'block';
                    document.getElementById('superadmin-only-locks').style.display = 'block';
                    document.getElementById('admin-panel-title').innerText = "لوحة كبار مسؤولي البنك 👑";
                }
            }
            await loadDashboard();
            loadNotifCount();
            spBadges();
            spDeepLink();
            startUserPolling();
            if (['staff','management','admin','super_admin'].includes(currentRole)) startAdminPolling();
        }

        async function loadDashboard() {
            const res = await fetch('/api/account');
            currentAccount = await res.json();
            if (!currentAccount) return;

            const frozenBadge = currentAccount.isFrozen ? '<span class="frozen-badge">🔒 الحساب مجمد</span>' : '';
            document.getElementById('account-card-container').innerHTML = \`
                <div class="account-card">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
                        <div>
                            <p style="color:#64748b; font-size:0.85rem;">رقم الحساب</p>
                            <p class="account-number">\${currentAccount.accountNumber}</p>
                            <p style="color:#94a3b8;">\${currentAccount.discordTag}</p>
                            \${frozenBadge}
                        </div>
                        <div style="text-align:left;">
                            <p style="color:#64748b; font-size:0.85rem;">الرصيد الجاري</p>
                            <p class="balance-display">\${currentAccount.balance.toLocaleString()} $</p>
                            <p style="color:#64748b; font-size:0.82rem;">التوفير</p>
                            <p class="savings-display">\${currentAccount.savingsBalance.toLocaleString()} $</p>
                        </div>
                    </div>
                </div>
            \`;

            document.getElementById('savings-info').innerHTML = \`
                <p style="font-size:1.2rem; font-weight:bold;">رصيد التوفير: <span style="color:#4ade80;">\${currentAccount.savingsBalance.toLocaleString()} $</span></p>
                <p style="color:#64748b; font-size:0.85rem; margin-top:5px;">الرصيد الجاري: \${currentAccount.balance.toLocaleString()} $</p>
            \`;

            loadLoanInfo();
        }

        async function loadLoanInfo() {
            const res = await fetch('/api/account/loan');
            const loan = await res.json();
            const container = document.getElementById('loan-status-container');
            if (!loan) {
                container.innerHTML = '<div class="card" style="text-align:center; color:#64748b;">لا يوجد قرض نشط حالياً.</div>';
                document.getElementById('loan-pay-section').style.display = 'none';
                return;
            }
            const color = loan.status === 'approved' ? '#4ade80' : loan.status === 'pending' ? '#fde047' : '#fca5a5';
            const statusText = loan.status === 'approved' ? 'نشط ✅' : loan.status === 'pending' ? 'قيد المراجعة ⏳' : 'مرفوض ❌';
            container.innerHTML = \`
                <div class="card card-yellow">
                    <p style="font-weight:bold; color:\${color};">القرض الحالي: \${statusText}</p>
                    <p style="margin-top:8px;">المبلغ الأصلي: <b>\${loan.amount.toLocaleString()} $</b></p>
                    \${loan.status === 'approved' ? \`<p>المتبقي للسداد: <b style="color:#fca5a5;">\${loan.remaining.toLocaleString()} $</b></p>\` : ''}
                </div>
            \`;
            if (loan.status === 'approved') {
                document.getElementById('loan-pay-section').style.display = 'block';
                document.getElementById('loan-remaining-info').innerHTML = \`المتبقي: <b style="color:#fca5a5;">\${loan.remaining.toLocaleString()} $</b>\`;
            }
        }

        async function doTransfer() {
            const toAcc = document.getElementById('t-to').value.trim();
            const amount = document.getElementById('t-amount').value;
            const note = document.getElementById('t-note').value.trim();
            showMsg('transfer-msg', 'جاري التحويل...', 'info');
            const res = await fetch('/api/account/transfer', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ toAccountNumber: toAcc, amount, note })
            });
            const data = await res.json();
            showMsg('transfer-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if(data.success) { loadDashboard(); document.getElementById('t-to').value=''; document.getElementById('t-amount').value=''; document.getElementById('t-note').value=''; }
        }

        async function doSavingsDeposit() {
            const amount = document.getElementById('s-deposit').value;
            const res = await fetch('/api/account/savings/deposit', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ amount })
            });
            const data = await res.json();
            showMsg('s-deposit-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if(data.success) { loadDashboard(); document.getElementById('s-deposit').value=''; }
        }

        async function doSavingsWithdraw() {
            const amount = document.getElementById('s-withdraw').value;
            const res = await fetch('/api/account/savings/withdraw', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ amount })
            });
            const data = await res.json();
            showMsg('s-withdraw-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if(data.success) { loadDashboard(); document.getElementById('s-withdraw').value=''; }
        }

        async function requestLoan() {
            const amount = document.getElementById('loan-amount').value;
            const res = await fetch('/api/account/loan/request', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ amount })
            });
            const data = await res.json();
            showMsg('loan-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if(data.success) { loadLoanInfo(); document.getElementById('loan-amount').value=''; }
        }

        async function payLoan() {
            const amount = document.getElementById('loan-pay-amount').value;
            const res = await fetch('/api/account/loan/pay', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ amount })
            });
            const data = await res.json();
            showMsg('loan-pay-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if(data.success) { loadDashboard(); document.getElementById('loan-pay-amount').value=''; }
        }

        async function loadHistory() {
            const res = await fetch('/api/account/transactions');
            const txs = await res.json();
            const container = document.getElementById('history-container');
            if(txs.length === 0) {
                container.innerHTML = '<div class="card" style="text-align:center; color:#64748b;">لا توجد معاملات بعد.</div>';
                return;
            }
            const typeLabel = { transfer: 'تحويل', deposit: 'إيداع', withdraw: 'سحب', loan_receive: 'قرض', loan_pay: 'سداد قرض', savings_deposit: 'إيداع توفير', savings_withdraw: 'سحب توفير', interest: 'فائدة توفير' };
            container.innerHTML = txs.map(tx => {
                const isIn = tx.toAccount === currentAccount?.accountNumber && tx.type !== 'savings_deposit' && tx.type !== 'loan_pay';
                const cls = tx.type === 'savings_deposit' || tx.type === 'savings_withdraw' ? 'tx-neutral' : (isIn ? 'tx-in' : 'tx-out');
                const sign = isIn ? '+' : '-';
                const color = isIn ? '#4ade80' : '#fca5a5';
                return \`
                    <div class="tx-item \${cls}">
                        <div>
                            <b>\${typeLabel[tx.type] || tx.type}</b>
                            <p style="font-size:0.8rem; color:#64748b;">\${tx.note || ''}</p>
                            <p style="font-size:0.75rem; color:#475569;">\${new Date(tx.createdAt).toLocaleString('ar-SA')}</p>
                        </div>
                        <b style="color:\${color}; font-size:1.1rem;">\${sign}\${tx.amount.toLocaleString()} $</b>
                    </div>
                \`;
            }).join('');
        }

        async function loadNotifCount() {
            const res = await fetch('/api/notifications');
            const notifs = await res.json();
            const unread = notifs.filter(n => !n.read).length;
            const el = document.getElementById('notif-count');
            if(el) el.innerHTML = unread > 0 ? \`<span class="notif-dot">\${unread}</span>\` : '';
        }

        async function loadNotifications() {
            const res = await fetch('/api/notifications');
            const notifs = await res.json();
            const container = document.getElementById('notifications-container');
            if(notifs.length === 0) {
                container.innerHTML = '<div class="card" style="text-align:center; color:#64748b;">لا توجد إشعارات.</div>';
                return;
            }
            container.innerHTML = notifs.map(n => \`
                <div class="notif-item notif-\${n.type}" style="\${!n.read ? 'font-weight:bold;' : 'opacity:0.7;'}">
                    <span>\${n.message}</span>
                    <span style="font-size:0.75rem; color:#64748b; display:block; margin-top:3px;">\${new Date(n.createdAt).toLocaleString('ar-SA')}</span>
                </div>
            \`).join('');
        }

        async function markAllRead() {
            await fetch('/api/notifications/read', { method: 'PUT' });
            loadNotifCount();
            loadNotifications();
        }

        function openAdminPanel() {
            document.getElementById('adminModal').style.display = 'block';
            // موظف/إداري ما عندهم تبويب إحصائيات، فنفتح لهم على القروض افتراضياً
            const defaultTab = (currentRole === 'staff' || currentRole === 'management') ? 'loans' : 'stats';
            switchAdminTab(defaultTab);
        }
        function closeAdminModal() {
            document.getElementById('adminModal').style.display = 'none';
        }

        function switchAdminTab(tab) {
            ['stats','accounts','loans','cards','support','staff','locks','settings','card-control','bank-log','military-salary','profiles'].forEach(t => {
                const btn = document.getElementById(\`atab-\${t}\`);
                const sec = document.getElementById(\`atab-\${t}-section\`);
                if(btn) btn.classList.remove('active');
                if(sec) sec.style.display = 'none';
            });
            const activeBtn = document.getElementById(\`atab-\${tab}\`);
            const activeSec = document.getElementById(\`atab-\${tab}-section\`);
            if(activeBtn) activeBtn.classList.add('active');
            if(activeSec) activeSec.style.display = 'block';

            if(tab === 'stats') loadAdminStats();
            if(tab === 'accounts') loadAdminAccounts();
            if(tab === 'loans') loadAdminLoans();
            if(tab === 'cards') loadAdminCards();
            if(tab === 'support') loadAdminSupport();
            if(tab === 'profiles') loadProfilesPanel();
            if(tab === 'staff') loadStaff();
            if(tab === 'locks') loadLockSettingsPanel();
            if(tab === 'settings') { loadBankSettingsPanel(); loadFeesPanel(); }
            if(tab === 'card-control') loadCardControlPanel();
            if(tab === 'bank-log') loadBankLog();
            if(tab === 'military-salary') loadMilitarySalaryPanel();
        }

        async function loadAdminStats() {
            const res = await fetch('/api/admin/stats');
            const s = await res.json();
            document.getElementById('admin-stats-container').innerHTML = \`
                <div class="stats-grid">
                    <div class="stat-box"><div class="stat-val">\${s.totalAccounts}</div><div class="stat-label">إجمالي الحسابات</div></div>
                    <div class="stat-box"><div class="stat-val">\${(s.totalBalance||0).toLocaleString()} $</div><div class="stat-label">إجمالي الأرصدة</div></div>
                    <div class="stat-box"><div class="stat-val">\${(s.totalSavings||0).toLocaleString()} $</div><div class="stat-label">إجمالي التوفير</div></div>
                    <div class="stat-box"><div class="stat-val">\${s.pendingLoans}</div><div class="stat-label">طلبات قروض معلقة</div></div>
                    <div class="stat-box"><div class="stat-val">\${s.totalTransactions}</div><div class="stat-label">إجمالي المعاملات</div></div>
                </div>
            \`;
        }

        async function loadLockSettingsPanel() {
            const res = await fetch('/api/admin/settings');
            const s = await res.json();
            bankSettingsCache = s;

            updateLockBtn('btn-lock-maintenance', s.isMaintenance, '🚨 مغلق صيانة', '✅ مفتوح وشغال');
            updateLockBtn('btn-lock-register', s.disableRegister, '🔒 الحسابات مقفلة', '✅ استقبال حسابات جديدة');
            updateLockBtn('btn-lock-transfer', s.disableTransfer, '🔒 التحويل مقفل', '✅ التحويل مفتوح');
            updateLockBtn('btn-lock-loans', s.disableLoans, '🔒 القروض مقفلة', '✅ طلب القروض مفتوح');
            updateLockBtn('btn-lock-cards', s.disableCards, '🔒 البطاقات مقفلة', '✅ طلب البطاقات مفتوح');
            updateLockBtn('btn-lock-support', s.disableSupport, '🔒 الدعم مقفل', '✅ خدمة العملاء مفتوحة');
            if (s.disableSupportReason) document.getElementById('support-lock-reason').placeholder = 'السبب: ' + s.disableSupportReason;
        }

        async function toggleSupportLock() {
            if(!bankSettingsCache) return;
            const isLocked = bankSettingsCache['disableSupport'];
            const newValue = !isLocked;
            let reason = '';
            if (newValue) {
                reason = document.getElementById('support-lock-reason').value.trim();
                if (!reason) { uiAlert('⚠️ يجب إدخال سبب قفل خدمة العملاء'); return; }
            }
            const res = await fetch('/api/admin/toggle-feature', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ feature: 'disableSupport', value: newValue, reason })
            });
            const data = await res.json();
            uiAlert(data.msg, data.success ? 'success' : 'danger');
            if(data.success) loadLockSettingsPanel();
        }

        function updateLockBtn(btnId, isLocked, lockedText, unlockedText) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            if (isLocked) {
                btn.innerText = lockedText;
                btn.className = "btn btn-red";
            } else {
                btn.innerText = unlockedText;
                btn.className = "btn btn-green";
            }
        }

        async function toggleFeature(featureName) {
            if(!bankSettingsCache) return;
            const currentValue = bankSettingsCache[featureName];
            const newValue = !currentValue;

            const res = await fetch('/api/admin/toggle-feature', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ feature: featureName, value: newValue })
            });
            const data = await res.json();
            uiAlert(data.msg, data.success ? 'success' : 'danger');
            if(data.success) {
                loadLockSettingsPanel();
            }
        }

        async function loadAdminAccounts() {
            const res = await fetch('/api/admin/accounts');
            const accounts = await res.json();
            const container = document.getElementById('admin-accounts-container');
            if(accounts.length === 0) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد حسابات.</p>'; return; }
            container.innerHTML = accounts.map(acc => {
                const deleteButton = currentRole === 'super_admin' 
                    ? \`<button class="btn btn-red" style="padding:4px 10px; font-size:0.78rem; background:#dc2626;" onclick="deleteAccountEntirely('\${acc._id}', '\${acc.discordTag}')">🗑️ حذف كامل</button>\` 
                    : '';
                // الإداري (management) ما يجيه زر حظر الدعم
                const supportBanButton = currentRole === 'management' ? '' : \`<button class="btn \${acc.supportBanned ? 'btn-green' : 'btn-red'}" style="padding:4px 10px; font-size:0.78rem;" onclick="toggleSupportBan('\${acc._id}', '\${acc.supportBanned}')">\${acc.supportBanned ? '✅ رفع حظر الدعم' : '🚫 حظر من الدعم'}</button>\`;

                return \`
                <div class="card" style="margin-bottom:10px; \${acc.isFrozen ? 'border-color:#ef4444;' : ''}">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${acc.discordTag}</b>
                            \${acc.isFrozen ? '<span class="frozen-badge">مجمد</span>' : ''}
                            \${acc.supportBanned ? '<span style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid #ef4444; padding:2px 8px; border-radius:20px; font-size:0.73rem; font-weight:bold; margin-right:4px;">محظور دعم</span>' : ''}
                            <p style="color:#4ade80; font-weight:bold; margin-top:4px;">رقم الحساب: \${acc.accountNumber} | الرصيد: \${acc.balance.toLocaleString()} $ | التوفير: \${acc.savingsBalance.toLocaleString()} $</p>
                            <p style="color:#64748b; font-size:0.78rem; margin-top:2px;">حد البطاقات: \${acc.cardLimit === -1 ? 'حسب الإعداد العام' : acc.cardLimit}</p>
                        </div>
                        <div style="display:flex; gap:6px; flex-wrap:wrap;">
                            <button class="btn \${acc.isFrozen ? 'btn-green' : 'btn-red'}" style="padding:4px 10px; font-size:0.78rem;" onclick="toggleFreeze('\${acc._id}', this)">\${acc.isFrozen ? '🔓 رفع تجميد' : '🔒 تجميد'}</button>
                            <button class="btn btn-green" style="padding:4px 10px; font-size:0.78rem;" onclick="manualBalance('\${acc._id}', 'add')">+ إيداع</button>
                            <button class="btn btn-red" style="padding:4px 10px; font-size:0.78rem;" onclick="manualBalance('\${acc._id}', 'deduct')">- خصم</button>
                            <button class="btn" style="padding:4px 10px; font-size:0.78rem; background:#7c3aed;" onclick="setCardLimit('\${acc._id}', \${acc.cardLimit})">💳 حد البطاقات</button>
                            <button class="btn" style="padding:4px 10px; font-size:0.78rem; background:#0891b2;" onclick="sendAccountNotif('\${acc._id}')">📢 إشعار</button>
                            \${supportBanButton}
                            \${deleteButton}
                        </div>
                    </div>
                </div>
                \`;
            }).join('');
        }

        async function setCardLimit(id, currentLimit) {
            const f = await uiForm({
                title: '💳 حد البطاقات للحساب',
                desc: 'الحد الحالي: ' + (Number(currentLimit) === -1 ? 'حسب الإعداد العام' : currentLimit),
                okText: 'حفظ الحد',
                fields: [{ name: 'limit', label: 'العدد الجديد', type: 'number', min: -1, step: 1, required: true, value: currentLimit, hint: 'اكتب -1 لاتباع الإعداد العام' }]
            });
            if (!f) return;
            const val = f.limit;
            const res = await fetch(\`/api/admin/accounts/\${id}/card-limit\`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ limit: val })
            });
            const data = await res.json();
            uiAlert(data.success ? '✅ تم تحديث الحد' : '❌ فشل');
            if(data.success) loadAdminAccounts();
        }

        async function sendAccountNotif(id) {
            const fields = [{ name: 'message', label: 'نص الإشعار / الملاحظة', type: 'textarea', required: true, placeholder: 'اكتب الرسالة للمستخدم...' }];
            // الإداري (management) يقدر يرسل إشعار غير مهم فقط (info)، بدون ما يوصل العضو رقم إشعار جديد
            if (currentRole !== 'management') {
                fields.push({ name: 'type', label: 'نوع الإشعار', type: 'select', value: 'info', options: [
                    { v: 'info', l: 'ℹ️ معلومة (أزرق)' },
                    { v: 'success', l: '✅ نجاح (أخضر)' },
                    { v: 'warning', l: '⚠️ تحذير (أصفر + هزّة)' }
                ].concat(currentIsOwner ? [{ v: 'danger', l: '🚨 خطر (أحمر + صوت إنذار)' }] : []) });
            }
            const f = await uiForm({ title: '📢 إرسال إشعار لمستخدم', okText: 'إرسال', fields: fields });
            if (!f) return;
            const message = f.message;
            const type = currentRole === 'management' ? 'info' : (f.type || 'info');
            const res = await fetch(\`/api/admin/accounts/\${id}/notify\`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ message, type })
            });
            const data = await res.json();
            uiAlert(data.success ? '✅ تم إرسال الإشعار' : '❌ فشل: ' + (data.msg||''));
        }

        async function toggleSupportBan(id, currentBanned) {
            const isBanned = currentBanned === 'true' || currentBanned === true;
            if (!(await uiConfirm(isBanned ? 'رفع حظر المستخدم من الدعم؟' : 'حظر هذا المستخدم من خدمة العملاء؟', { title: isBanned ? '✅ رفع الحظر' : '🚫 حظر من الدعم', danger: !isBanned, okText: isBanned ? 'نعم، ارفع الحظر' : 'نعم، احظره' }))) return;
            const res = await fetch(\`/api/admin/accounts/\${id}/support-ban\`, { method: 'PUT' });
            const data = await res.json();
            if(data.success) { uiAlert(data.banned ? 'تم حظر المستخدم من الدعم' : 'تم رفع الحظر', data.banned ? 'warning' : 'success'); loadAdminAccounts(); }
        }

        async function toggleFreeze(id, btn) {
            const res = await fetch(\`/api/admin/accounts/\${id}/freeze\`, { method: 'PUT' });
            const data = await res.json();
            if(data.success) { uiAlert(data.frozen ? 'تم تجميد الحساب' : 'تم رفع التجميد', data.frozen ? 'warning' : 'success'); loadAdminAccounts(); }
        }

        async function manualBalance(id, type) {
            const f = await uiForm({
                title: type === 'add' ? '➕ إيداع يدوي' : '➖ خصم يدوي',
                type: type === 'add' ? 'success' : 'danger',
                okText: type === 'add' ? 'تنفيذ الإيداع' : 'تنفيذ الخصم',
                fields: [
                    { name: 'amount', label: 'المبلغ', type: 'number', min: 1, required: true, placeholder: 'مثال: 5000' },
                    { name: 'note', label: 'ملاحظة (اختياري)', type: 'text', placeholder: 'سبب العملية' }
                ]
            });
            if (!f) return;
            const amount = f.amount;
            const note = f.note || '';
            const res = await fetch(\`/api/admin/accounts/\${id}/balance\`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ amount, type, note })
            });
            const data = await res.json();
            uiAlert(data.success ? '✅ تمت العملية' : '❌ فشل: ' + (data.msg || ''));
            if(data.success) loadAdminAccounts();
        }

        async function deleteAccountEntirely(id, name) {
            if (!(await uiConfirm('هل أنت متأكد تماماً من حذف حساب اللاعب (' + name + ') نهائياً؟', { title: '⚠️ تحذير صارم', danger: true, okText: 'نعم، احذفه نهائياً', detail: 'سيتم تصفير أرصدته وقروضه وحذفه من الأحوال ليعيد التسجيل من جديد.' }))) return;
            
            const res = await fetch(\`/api/superadmin/accounts/\${id}\`, { method: 'DELETE' });
            const data = await res.json();
            
            uiAlert(data.msg, data.success ? 'success' : 'danger');
            if (data.success) {
                loadAdminAccounts();
            }
        }

        async function loadAdminLoans() {
            const res = await fetch('/api/admin/loans');
            const loans = await res.json();
            const container = document.getElementById('admin-loans-container');
            if(loans.length === 0) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد قروض معلقة.</p>'; return; }
            container.innerHTML = loans.map(loan => {
                const expiryInfo = loan.expiresAt 
                    ? \`<p style="color:\${new Date(loan.expiresAt) < new Date() ? '#fca5a5' : '#fde047'}; font-size:0.78rem; margin-top:3px;">⏳ ينتهي: \${new Date(loan.expiresAt).toLocaleDateString('ar-SA')}</p>\` 
                    : '<p style="color:#64748b; font-size:0.78rem; margin-top:3px;">⏳ بدون تاريخ انتهاء</p>';
                return \`
                <div class="card \${loan.status === 'pending' ? 'card-yellow' : 'card-green'}" style="margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${loan.discordTag}</b>
                            <p style="margin-top:5px;">المبلغ: <b style="color:#fde047;">\${loan.amount.toLocaleString()} $</b></p>
                            \${loan.status === 'approved' ? \`<p>المتبقي: <b style="color:#fca5a5;">\${loan.remaining.toLocaleString()} $</b></p>\` : ''}
                            \${expiryInfo}
                            <p style="color:#64748b; font-size:0.8rem;">\${new Date(loan.requestedAt).toLocaleString('ar-SA')}</p>
                        </div>
                        \${loan.status === 'pending' ? \`
                        <div style="display:flex; gap:6px;">
                            <button class="btn btn-green" style="padding:5px 10px;" onclick="actionLoan('\${loan._id}', 'approve')">✅ موافقة</button>
                            <button class="btn btn-red" style="padding:5px 10px;" onclick="actionLoan('\${loan._id}', 'reject')">❌ رفض</button>
                        </div>\` : '<span style="color:#4ade80; font-weight:bold;">نشط ✅</span>'}
                    </div>
                </div>
                \`;
            }).join('');
        }

        async function actionLoan(id, action) {
            const res = await fetch(\`/api/admin/loans/\${id}/\${action}\`, { method: 'PUT' });
            const data = await res.json();
            if(data.success) { uiAlert(action === 'approve' ? 'تمت الموافقة على القرض!' : 'تم رفض القرض', action === 'approve' ? 'success' : 'warning'); loadAdminLoans(); }
        }

        async function loadBankSettingsPanel() {
            const res = await fetch('/api/superadmin/settings');
            const s = await res.json();
            document.getElementById('interest-rate-input').value = s.interestRate || 2;
            const adminContainer = document.getElementById('admin-list-container');
            bindAccountPicker('new-admin-search', 'new-admin-pick-box', 'new-admin-id', 'new-admin-chosen');
            const adminNames = s.adminNames || {};
            adminContainer.innerHTML = s.adminList.length === 0 ? '<p style="color:#64748b;">لا يوجد مسؤولين.</p>' :
                s.adminList.map(uid => \`
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <span>\${adminNames[uid] ? adminNames[uid].name + (adminNames[uid].accountNumber ? ' — ' + adminNames[uid].accountNumber : '') : 'حساب غير معروف'}</span>
                        <button class="btn btn-red" style="padding:3px 10px; font-size:0.78rem;" onclick="removeBankAdmin('\${uid}')">إزالة</button>
                    </div>
                \`).join('');
        }

        async function saveBankSettings() {
            const interestRate = document.getElementById('interest-rate-input').value;
            const res = await fetch('/api/superadmin/settings', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ interestRate: parseFloat(interestRate) })
            });
            const data = await res.json();
            uiAlert(data.success ? '✅ تم الحفظ' : '❌ فشل');
        }

        async function addBankAdmin() {
            const accountUid = document.getElementById('new-admin-id').value.trim();
            if(!accountUid) return uiAlert('ابحث واختر الحساب من القائمة', 'warning');
            const res = await fetch('/api/superadmin/admin/add', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ accountUid })
            });
            const data = await res.json();
            uiAlert(data.msg, data.success ? 'success' : 'danger');
            if(data.success) { document.getElementById('new-admin-id').value=''; document.getElementById('new-admin-search').value=''; document.getElementById('new-admin-chosen').textContent=''; loadBankSettingsPanel(); }
        }

        async function removeBankAdmin(accountUid) {
            if (!(await uiConfirm('إزالة هذا المسؤول؟', { title: '🗑️ إزالة مسؤول بنك', danger: true, okText: 'نعم، أزله' }))) return;
            const res = await fetch('/api/superadmin/admin/remove', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ accountUid })
            });
            const data = await res.json();
            uiAlert(data.msg, data.success ? 'success' : 'danger');
            if(data.success) loadBankSettingsPanel();
        }

        function goPage(p) {
            document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.nav-links button').forEach(el => el.classList.remove('active'));
            document.getElementById('page-'+p).classList.add('active');
            const navBtn = document.getElementById('nav-'+p);
            if(navBtn) navBtn.classList.add('active');
            if(p === 'history') loadHistory();
            if(p === 'notifications') loadNotifications();
            if(p === 'savings') loadDashboard();
            if(p === 'loans') loadLoanInfo();
            if(p === 'cards') loadMyCards();
        }

        function showMsg(id, msg, type) {
            // كل رسائل الموقع صارت إشعار منبثق (تحت يمين) بدل ما تطلع داخل الصفحة
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
            const m = String(msg || '');
            const progress = type === 'info' && /^(جاري|⏳)/.test(m);
            uiToast(m, type, progress ? 2000 : 0);
        }

        async function loadMyCards() {
            loadMilitaryOptions();
            const res = await fetch('/api/account/cards');
            const cards = await res.json();
            const container = document.getElementById('cards-list-container');
            if (!cards.length) { container.innerHTML = '<div class="card" style="text-align:center; color:#64748b;">لا توجد بطاقات بعد.</div>'; return; }
            const statusMap = { pending: '⏳ قيد المراجعة', approved: '✅ مفعّلة', rejected: '❌ مرفوضة', disabled: '🚫 معطّلة من الإدارة', expired: '⌛ منتهية الصلاحية' };
            const colorMap = { pending: '#fde047', approved: '#4ade80', rejected: '#fca5a5', disabled: '#ef4444', expired: '#94a3b8' };
            container.innerHTML = cards.map(c => {
                const isExpired = c.cardExpiry && new Date(c.cardExpiry) < new Date() && c.status === 'approved';
                const status = isExpired ? 'expired' : c.status;
                const expiryStr = c.cardExpiry ? new Date(c.cardExpiry).toLocaleDateString('en-US', { month: '2-digit', year: '2-digit' }) : '--/--';
                const colorThemes = {
                    blue:   { bg: 'linear-gradient(135deg,#1a3a6b,#0f2044)', border: '#3b82f6', accent: '#60a5fa' },
                    green:  { bg: 'linear-gradient(135deg,#14532d,#052e16)', border: '#22c55e', accent: '#4ade80' },
                    red:    { bg: 'linear-gradient(135deg,#7f1d1d,#450a0a)', border: '#ef4444', accent: '#fca5a5' },
                    gold:   { bg: 'linear-gradient(135deg,#78350f,#451a03)', border: '#eab308', accent: '#fde047' },
                    purple: { bg: 'linear-gradient(135deg,#4c1d95,#2e1065)', border: '#a78bfa', accent: '#c4b5fd' },
                    black:  { bg: 'linear-gradient(135deg,#1e293b,#000000)', border: '#475569', accent: '#94a3b8' }
                };
                const theme = colorThemes[c.cardColor] || colorThemes.blue;
                const needsPin = c.status === 'approved' && c.cardNumber && !c.pinSet;
                const realCard = (c.status === 'approved' && c.cardNumber && c.pinSet) ? bankCardHtml(c, { expired: isExpired, expiryStr: expiryStr }) + (isExpired ? '<p style="color:#fca5a5; font-size:0.78rem; margin-top:10px;">⌛ البطاقة منتهية — يمكنك طلب التجديد أدناه</p>' : '') + '<p style="color:#64748b; font-size:0.75rem; margin-top:8px;">🔒 الرقم السري ما يظهر لأحد، لازم تحفظه.</p>' : '';
                const pinSetupCard = needsPin ? \`
                    <div style="background:#0f1420; border:2px solid #ef4444; border-radius:16px; padding:20px 22px; margin-top:12px; position:relative; overflow:hidden; min-width:280px; max-width:380px; text-align:center;">
                        <div style="font-size:3.5rem; color:#ef4444; line-height:1; margin-bottom:10px;">✕</div>
                        <p style="color:#fca5a5; font-weight:bold; margin-bottom:6px;">🔐 عيّن رقمك السري لتفعيل البطاقة</p><p style="color:#94a3b8; font-size:0.78rem; margin-bottom:10px;">⚠️ احفظه في ذاكرتك: ما يظهر بعدها لأحد، ولا تقدر ترجع تشوفه.</p>
                        <input id="pin-input-\${c._id}" type="text" autocomplete="off" readonly maxlength="4" inputmode="numeric" placeholder="ضع رقم سري مكون من 4 أرقام" style="text-align:center; letter-spacing:6px; font-size:1.1rem; margin-bottom:8px; cursor:pointer; -webkit-text-security:disc; text-security:disc;" onclick="openPinPad('\${c._id}')" />
                        <button class="btn btn-red" style="width:100%;" onclick="openPinPad('\${c._id}')">✅ حفظ الرقم السري</button>
                        <div id="pin-msg-\${c._id}" style="margin-top:8px;"></div>
                    </div>
                \` : '';
                return \`
                    <div class="card" style="margin-bottom:14px; border-color:\${colorMap[status] || '#3b82f6'};">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                            <div>
                                <b style="color:\${colorMap[status]};">\${statusMap[status] || status}</b>
                                <p style="color:#94a3b8; font-size:0.85rem; margin-top:4px;">\${c.militaryRank ? ('الرتبة: ' + c.militaryRank + ' | القطاع: ' + (c.militarySector || '—') + ' | اليونت: ' + (c.militaryUnit || '—')) : ('المسمى: ' + (c.jobTitle || '—') + ' | جهة العمل: ' + (c.employerName || '—'))}</p>
                                \${c.adminNote ? \`<p style="color:#60a5fa; font-size:0.83rem; margin-top:4px;">ملاحظة الإدارة: \${c.adminNote}</p>\` : ''}
                                \${c.cardExpiry && !isExpired && c.status === 'approved' ? \`<p style="color:#94a3b8; font-size:0.78rem; margin-top:3px;">⏳ تنتهي في: \${new Date(c.cardExpiry).toLocaleDateString('ar-SA')}</p>\` : ''}
                            </div>
                        </div>
                        \${realCard}\${pinSetupCard}
                        \${status === 'disabled' ? '<p style="color:#ef4444; font-size:0.82rem; margin-top:8px;">⚠️ تم تعطيل هذه البطاقة من الإدارة. تواصل مع خدمة العملاء.</p>' : ''}
                        \${isExpired ? \`<button class="btn btn-yellow" style="margin-top:10px;" onclick="renewCard('\${c._id}')">🔄 تجديد البطاقة</button>\` : ''}
                    </div>
                \`;
            }).join('');
        }

        let pinPadValue = '';
        let pinPadCardId = null;

        function openPinPad(cardId) {
            pinPadCardId = cardId;
            pinPadValue = '';
            document.getElementById('pinpad-msg').innerHTML = '';
            renderPinPadDots();
            document.getElementById('pinPadModal').style.display = 'block';
        }

        function closePinPad() {
            document.getElementById('pinPadModal').style.display = 'none';
            pinPadValue = '';
            pinPadCardId = null;
        }

        function renderPinPadDots() {
            document.querySelectorAll('.pinpad-dot').forEach((dot, i) => {
                dot.classList.toggle('filled', i < pinPadValue.length);
            });
        }

        function pinPadBackspace() {
            pinPadValue = pinPadValue.slice(0, -1);
            renderPinPadDots();
        }

        async function pinPadPress(digit) {
            if (pinPadValue.length >= 4) return;
            pinPadValue += digit;
            renderPinPadDots();
            if (pinPadValue.length === 4) {
                await setCardPin(pinPadCardId, pinPadValue);
            }
        }

        async function setCardPin(cardId, pinFromPad) {
            const pin = pinFromPad || document.getElementById(\`pin-input-\${cardId}\`)?.value.trim();
            if (!pin || !/^\\d{4}$/.test(pin)) {
                if (pinFromPad) { document.getElementById('pinpad-msg').innerHTML = '<p style="color:#fca5a5; font-size:0.85rem;">يجب أن يتكون الرقم السري من 4 أرقام بالضبط</p>'; pinPadValue=''; renderPinPadDots(); return; }
                return showMsg(\`pin-msg-\${cardId}\`, 'يجب أن يتكون الرقم السري من 4 أرقام بالضبط', 'danger');
            }
            const res = await fetch(\`/api/account/card/\${cardId}/set-pin\`, {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ pin })
            });
            const data = await res.json();
            if (pinFromPad) {
                if (data.success) { closePinPad(); loadMyCards(); }
                else { document.getElementById('pinpad-msg').innerHTML = \`<p style="color:#fca5a5; font-size:0.85rem;">\${data.msg}</p>\`; pinPadValue=''; renderPinPadDots(); }
            } else {
                showMsg(\`pin-msg-\${cardId}\`, data.msg, data.success ? 'success' : 'danger');
                if (data.success) loadMyCards();
            }
        }

        async function renewCard(cardId) {
            if (!(await uiConfirm('هل تريد تجديد هذه البطاقة؟', { title: '🔄 تجديد البطاقة', okText: 'نعم، جدّد' }))) return;
            const res = await fetch(\`/api/account/card/\${cardId}/renew\`, { method: 'POST' });
            const data = await res.json();
            uiAlert((data.success ? '✅ ' : '❌ ') + data.msg);
            if (data.success) loadMyCards();
        }

        async function loadMilitaryOptions() {
            const sel = document.getElementById('card-mil-rank');
            if (!sel || sel.options.length > 1) return;
            let ranks = [];
            try { const r = await fetch('/api/account/card/military-options'); const d = await r.json(); ranks = d.ranks || []; } catch (e) {}
            if (!ranks.length) ranks = ["جندي","جندي اول","عريف","وكيل رقيب","رقيب","رقيب اول","رئيس رقباء","ملازم","ملازم اول","نقيب","رائد","مقدم","عقيد","عميد","لواء","فريق","فريق اول"];
            ranks.forEach(function(r) { const o = document.createElement('option'); o.value = r; o.textContent = r; sel.appendChild(o); });
            csRefresh(sel);
        }

        async function submitCardRequest() {
            const num = document.getElementById('card-mil-number').value.trim();
            const sector = document.getElementById('card-mil-sector').value;
            const rank = document.getElementById('card-mil-rank').value;
            const unit = document.getElementById('card-mil-unit').value.trim();
            const reason = document.getElementById('card-reason').value.trim();
            const pledge = document.getElementById('card-pledge').checked;
            if (!sector || !rank || !unit) return showMsg('card-req-msg', 'عبّي القطاع والرتبة واليونت', 'danger');
            if (!reason) return showMsg('card-req-msg', 'اكتب سبب طلب البطاقة', 'danger');
            if (!pledge) return showMsg('card-req-msg', 'يجب الموافقة على التعهد', 'danger');
            showMsg('card-req-msg', 'جاري التحقق من بطاقتك العسكرية...', 'info');
            const res = await fetch('/api/account/card/request', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ militaryCardNumber: num, militarySector: sector, militaryRank: rank, militaryUnit: unit, requestReason: reason, pledge: pledge })
            });
            const data = await res.json();
            showMsg('card-req-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            loadMyCards();
            if (data.success) { ['card-mil-number','card-mil-unit','card-reason'].forEach(function(id){ document.getElementById(id).value = ''; }); document.getElementById('card-mil-sector').value = ''; document.getElementById('card-mil-rank').value = ''; csRefresh('card-mil-sector'); csRefresh('card-mil-rank'); document.getElementById('card-pledge').checked = false; }
        }

        // ─── دوال أدمن البطاقات ────────────────────────────────────────────────

        async function loadAdminCards() {
            const res = await fetch('/api/admin/cards');
            const cards = await res.json();
            const container = document.getElementById('admin-cards-container');

            // إعداد الحد العام
            const sRes = await fetch('/api/admin/settings');
            const s = await sRes.json();
            
            let html = \`<div class="card card-blue" style="margin-bottom:15px;">
                <h2>⚙️ الإعداد العام لعدد البطاقات</h2>
                <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">عدد البطاقات المسموح لكل مستخدم (ما لم يُعيَّن له حد خاص في صفحة الحسابات)</p>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <input id="global-card-limit-input" type="number" value="\${s.globalCardLimit||1}" min="0" max="99" style="width:80px; margin-bottom:0;" />
                    <button class="btn btn-blue" onclick="saveGlobalCardLimit()">💾 حفظ</button>
                    <button class="btn btn-green" onclick="allowAllCards()">✅ السماح للكل بتقديم بطاقات</button>
                </div>
            </div>\`;

            if (!cards.length) { 
                container.innerHTML = html + '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد طلبات بطاقات معلقة.</p>'; 
                return; 
            }

            html += cards.map(c => \`
                <div class="card card-yellow" style="margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${c.discordTag}</b> <span style="color:#64748b; font-size:0.8rem;">\${c.discord}</span>
                            <p style="margin-top:5px; color:#94a3b8; font-size:0.85rem;">🎖️ الرتبة: \${c.militaryRank || '—'} | 🛡️ القطاع: \${c.militarySector || '—'} | 🧩 اليونت: \${c.militaryUnit || '—'}</p>
                            \${(c.flashRank && (c.flashRank !== c.militaryRank || c.flashSector !== c.militarySector)) ? ('<p style="color:#fbbf24; font-size:0.8rem;">⚠️ المسجّل في فلاش: ' + c.flashRank + ' — ' + (c.flashSector || '—') + ' — ' + (c.flashUnit || '—') + '</p>') : ''}
                            <p style="color:#4ade80; font-size:0.85rem;">🪪 البطاقة العسكرية: \${c.militaryCardNumber || '—'}</p>
                            <p style="color:#94a3b8; font-size:0.83rem;">السبب: \${c.requestReason}</p>
                            <p style="color:#64748b; font-size:0.78rem;">\${new Date(c.requestedAt).toLocaleString('ar-SA')}</p>
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; min-width:220px;">
                            <input id="card-note-\${c._id}" placeholder="ملاحظة للمستخدم (اختياري)" style="padding:5px 8px; font-size:0.8rem; margin-bottom:4px;" />
                            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                                <label style="font-size:0.78rem; color:#60a5fa; margin-bottom:0;">📅 تاريخ انتهاء البطاقة:</label>
                                <input type="date" id="card-expiry-\${c._id}" style="padding:4px 6px; font-size:0.78rem; margin-bottom:0; width:auto;" />
                            </div>
                            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                                <label style="font-size:0.78rem; color:#60a5fa; margin-bottom:0;">🎨 لون البطاقة:</label>
                                <select id="card-color-\${c._id}" style="padding:4px 6px; font-size:0.78rem; margin-bottom:0; width:auto;">
                                    <option value="blue">أزرق</option>
                                    <option value="green">أخضر</option>
                                    <option value="red">أحمر</option>
                                    <option value="gold">ذهبي</option>
                                    <option value="purple">بنفسجي</option>
                                    <option value="black">أسود</option>
                                </select>
                            </div>
                            <div style="display:flex; gap:6px; margin-top:4px;">
                                <button class="btn btn-green" style="padding:5px 10px; flex:1;" onclick="actionCard('\${c._id}', 'approve')">✅ قبول</button>
                                <button class="btn btn-red" style="padding:5px 10px;" onclick="actionCard('\${c._id}', 'reject')">❌ رفض</button>
                            </div>
                        </div>
                    </div>
                </div>
            \`).join('');
            container.innerHTML = html;
        }

        async function actionCard(id, action) {
            const adminNote = document.getElementById(\`card-note-\${id}\`)?.value || '';
            const expiryInput = document.getElementById(\`card-expiry-\${id}\`);
            const colorInput = document.getElementById(\`card-color-\${id}\`);
            const res = await fetch(\`/api/admin/cards/\${id}/\${action}\`, {
                method: 'PUT', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ adminNote, cardColor: action === 'approve' ? colorInput?.value : undefined })
            });
            const data = await res.json();
            if(data.success) {
                // إذا عين تاريخ انتهاء وكان القبول، احفظه
                if (action === 'approve' && expiryInput && expiryInput.value) {
                    await fetch(\`/api/superadmin/cards/\${id}/set-expiry\`, {
                        method: 'PUT', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ expiryDate: expiryInput.value })
                    });
                }
                uiAlert(action==='approve'?'✅ تمت الموافقة!':'❌ تم الرفض');
                loadAdminCards();
            }
        }

        // ─── دوال الموظفين ──────────────────────────────────────────────────
        const _pickTimers = {};
        const _pickBound = {};
        function bindAccountPicker(inputId, boxId, uidId, chosenId) {
            if (_pickBound[inputId]) return;
            const inp = document.getElementById(inputId);
            if (!inp) return;
            _pickBound[inputId] = true;
            inp.addEventListener('input', function() {
                clearTimeout(_pickTimers[inputId]);
                const box = document.getElementById(boxId);
                document.getElementById(uidId).value = '';
                document.getElementById(chosenId).textContent = '';
                const q = inp.value.trim();
                if (q.length < 2) { box.innerHTML = ''; return; }
                _pickTimers[inputId] = setTimeout(async function() {
                    try {
                        const r = await fetch('/api/admin/account-search?q=' + encodeURIComponent(q));
                        const list = await r.json();
                        box.innerHTML = '';
                        if (!list.length) { const e = document.createElement('div'); e.className = 'pick-item'; e.style.cursor = 'default'; e.textContent = 'ما لقيت حساب بهذا الاسم'; box.appendChild(e); return; }
                        list.forEach(function(a) {
                            const d = document.createElement('div');
                            d.className = 'pick-item';
                            d.textContent = a.name;
                            const sm = document.createElement('small');
                            sm.textContent = a.accountNumber;
                            d.appendChild(sm);
                            d.addEventListener('click', function() {
                                document.getElementById(uidId).value = a.uid;
                                inp.value = a.name;
                                document.getElementById(chosenId).textContent = '✅ ' + a.name + ' — ' + a.accountNumber;
                                box.innerHTML = '';
                            });
                            box.appendChild(d);
                        });
                    } catch (e) { box.innerHTML = ''; }
                }, 300);
            });
        }

        async function loadStaff() {
            bindAccountPicker('hire-search', 'hire-pick-box', 'hire-uid', 'hire-chosen');
            const res = await fetch('/api/staff');
            const staff = await res.json();
            const container = document.getElementById('staff-list-container');
            if (!staff.length) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا يوجد موظفون.</p>'; return; }
            const roleMap = { staff: '👤 موظف', management: '🏢 إدارة' };
            container.innerHTML = staff.map(s => \`
                <div class="card" style="margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${s.discordTag}</b>
                            <span style="color:#60a5fa; font-size:0.82rem; margin-right:8px;">\${roleMap[s.role] || s.role}</span>
                            <p style="color:#64748b; font-size:0.78rem; margin-top:3px;">وظّفه: \${s.hiredByTag} — \${new Date(s.hiredAt).toLocaleDateString('ar-SA')}</p>
                        </div>
                        <button class="btn btn-red" style="padding:4px 12px; font-size:0.8rem;" onclick="fireStaff('\${s._id}', '\${s.discordTag}')">🔴 فصل</button>
                    </div>
                </div>
            \`).join('');
        }

        async function hireStaff() {
            const accountUid = document.getElementById('hire-uid').value.trim();
            const staffRole = document.getElementById('hire-role').value;
            if (!accountUid) return showMsg('hire-msg', 'ابحث واختر الحساب من القائمة', 'danger');
            const res = await fetch('/api/staff/hire', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ accountUid, staffRole })
            });
            const data = await res.json();
            showMsg('hire-msg', (data.success ? '✅ ' : '❌ ') + data.msg, data.success ? 'success' : 'danger');
            if (data.success) { document.getElementById('hire-uid').value=''; document.getElementById('hire-search').value=''; document.getElementById('hire-chosen').textContent=''; loadStaff(); }
        }

        async function fireStaff(id, name) {
            if (!(await uiConfirm('فصل ' + name + '؟', { title: '🚪 فصل موظف', danger: true, okText: 'نعم، افصله' }))) return;
            const res = await fetch(\`/api/staff/\${id}/fire\`, { method: 'PUT' });
            const data = await res.json();
            if (data.success) { uiAlert('تم فصل الموظف', 'success'); loadStaff(); }
        }

        // ─── سجل التذاكر المغلقة ────────────────────────────────────────────


        // ─── سجل البنك ──────────────────────────────────────────────────────

        // ─── دوال رواتب العساكر (ربط مع موقع فلاش) ──────────────────────────
        let msRanksCache = [];
        async function loadMilitarySalaryPanel() {
            const [ranksRes, statusRes] = await Promise.all([
                fetch('/api/superadmin/military-salary/ranks'),
                fetch('/api/superadmin/military-salary/status')
            ]);
            const ranksData = await ranksRes.json();
            const status = await statusRes.json();

            const container = document.getElementById('military-salary-ranks-container');
            if (!ranksData.success) {
                container.innerHTML = \`<p style="color:#fca5a5;">❌ \${ranksData.msg}</p>\`;
                document.getElementById('ms-toggle-btn').innerText = 'غير متاح';
                document.getElementById('ms-toggle-btn').disabled = true;
                return;
            }

            msRanksCache = ranksData.ranks;
            container.innerHTML = ranksData.ranks.map(r => \`
                <div class="toggle-box">
                    <span>🎖️ \${r}</span>
                    <input type="number" min="0" class="ms-rank-input" data-rank="\${r}" value="\${status.ranksSalaries?.[r] ?? ranksData.salaries[r] ?? 0}" style="width:120px; margin-bottom:0;" />
                </div>
            \`).join('');

            document.getElementById('ms-period-value').value = status.periodValue || 7;
            document.getElementById('ms-period-unit').value = status.periodUnit || 'days';

            const statusBox = document.getElementById('military-salary-status');
            const toggleBtn = document.getElementById('ms-toggle-btn');
            toggleBtn.disabled = false;
            if (status.isActive) {
                toggleBtn.innerText = '⏸️ إيقاف الرواتب';
                toggleBtn.className = 'btn btn-red';
                statusBox.innerHTML = \`
                    <div class="toggle-box" style="border-color:#4ade80;">
                        <span style="color:#4ade80;">✅ الرواتب مفعّلة</span>
                        <span style="color:#94a3b8; font-size:0.8rem;">الدفعة القادمة: \${status.nextPayoutAt ? new Date(status.nextPayoutAt).toLocaleString('ar-SA') : '-'}</span>
                    </div>
                \`;
            } else {
                toggleBtn.innerText = '▶️ تفعيل الرواتب';
                toggleBtn.className = 'btn btn-green';
                statusBox.innerHTML = \`<div class="toggle-box"><span style="color:#f87171;">⏹️ الرواتب موقوفة حالياً</span></div>\`;
            }
        }

        async function saveMilitarySalary() {
            const periodValue = document.getElementById('ms-period-value').value;
            const periodUnit = document.getElementById('ms-period-unit').value;
            const ranksSalaries = {};
            document.querySelectorAll('.ms-rank-input').forEach(inp => { ranksSalaries[inp.dataset.rank] = inp.value; });

            const res = await fetch('/api/superadmin/military-salary/save', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ periodValue, periodUnit, ranksSalaries })
            });
            const data = await res.json();
            showMsg('military-salary-msg', (data.success?'✅ ':'❌ ')+data.msg, data.success?'success':'danger');
        }

        async function toggleMilitarySalary() {
            const res = await fetch('/api/superadmin/military-salary/toggle', { method: 'POST' });
            const data = await res.json();
            if (!data.success) { showMsg('military-salary-msg', '❌ '+data.msg, 'danger'); return; }
            loadMilitarySalaryPanel();
        }

        async function msPayAll() {
            if (!(await uiConfirm('متأكد تبي تصرف الرواتب الآن يدوياً لكل العساكر المستحقين؟', { title: '💰 صرف الرواتب للجميع', okText: 'نعم، اصرف' }))) return;
            showMsg('military-salary-msg', 'جاري الصرف...', 'info');
            const res = await fetch('/api/superadmin/military-salary/run-now', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showMsg('military-salary-msg', '✅ تم صرف الرواتب لـ ' + data.paidCount + ' حساب بإجمالي ' + data.totalPaid.toLocaleString() + ' $', 'success');
                loadMilitarySalaryPanel();
            } else {
                showMsg('military-salary-msg', '❌ ' + data.msg, 'danger');
            }
        }

        // فورم الصرف اليدوي: زرين (الجميع / محدد)
        function runMilitarySalaryNow() {
            const s = uiShell('info', '💰 صرف الرواتب يدوياً');
            s.box.appendChild(uiEl('div', 'ui-msg', 'لمن تبي تصرف الراتب؟'));
            const actions = uiEl('div', 'ui-actions');
            const all = uiEl('button', 'btn btn-blue', '👥 الجميع');
            const sel = uiEl('button', 'btn btn-green', '🎯 محدد');
            const no = uiEl('button', 'btn ui-cancel', 'إلغاء');
            actions.appendChild(all); actions.appendChild(sel); actions.appendChild(no);
            s.box.appendChild(actions);
            all.onclick = function () { s.ov.remove(); msPayAll(); };
            sel.onclick = function () { s.ov.remove(); msPickPeople(); };
            no.onclick = function () { s.ov.remove(); };
            s.ov.addEventListener('mousedown', function (e) { if (e.target === s.ov) s.ov.remove(); });
        }

        // اختيار شخص أو أكثر ويجيهم الراتب مسبق
        async function msPickPeople() {
            let data;
            try { const r = await fetch('/api/superadmin/military-salary/personnel'); data = await r.json(); } catch (e) { data = null; }
            if (!data || !data.success) { uiToast('❌ ' + ((data && data.msg) || 'تعذر جلب العساكر'), 'danger'); return; }
            if (!data.list.length) { uiToast('ما فيه عساكر مستحقين (لازم يكون لهم حساب وراتب لرتبتهم)', 'warning'); return; }
            const s = uiShell('success', '🎯 اختر من يجيه الراتب مسبق');
            const search = document.createElement('input');
            search.type = 'text'; search.placeholder = '🔍 ابحث بالاسم أو الرتبة...';
            s.box.appendChild(search);
            const listEl = uiEl('div', 'ms-pick-list');
            s.box.appendChild(listEl);
            const counter = uiEl('div', 'ui-hint', 'المختارين: 0');
            s.box.appendChild(counter);
            const chosen = new Set();
            const rows = [];
            data.list.forEach(function (p) {
                const row = uiEl('label', 'ms-pick-row');
                const cb = document.createElement('input'); cb.type = 'checkbox';
                row.appendChild(cb);
                row.appendChild(uiEl('span', 'nm', p.name));
                row.appendChild(uiEl('span', 'rk', p.rank + ' • ' + Number(p.salary).toLocaleString() + ' $'));
                cb.onchange = function () {
                    if (cb.checked) chosen.add(p.discord); else chosen.delete(p.discord);
                    row.classList.toggle('on', cb.checked);
                    counter.textContent = 'المختارين: ' + chosen.size;
                };
                row._txt = (p.name + ' ' + p.rank).toLowerCase();
                listEl.appendChild(row); rows.push(row);
            });
            search.oninput = function () {
                const q = search.value.trim().toLowerCase();
                rows.forEach(function (r) { r.style.display = (!q || r._txt.indexOf(q) !== -1) ? '' : 'none'; });
            };
            const err = uiEl('div', 'ui-err'); s.box.appendChild(err);
            const actions = uiEl('div', 'ui-actions');
            const ok = uiEl('button', 'btn btn-green', '💸 صرف مسبق');
            const no = uiEl('button', 'btn ui-cancel', 'إلغاء');
            actions.appendChild(ok); actions.appendChild(no); s.box.appendChild(actions);
            no.onclick = function () { s.ov.remove(); };
            s.ov.addEventListener('mousedown', function (e) { if (e.target === s.ov) s.ov.remove(); });
            ok.onclick = async function () {
                if (!chosen.size) { err.textContent = '⚠️ اختر شخص واحد على الأقل'; return; }
                ok.disabled = true;
                const res = await fetch('/api/superadmin/military-salary/pay-selected', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uids: Array.from(chosen) })
                });
                const d = await res.json();
                s.ov.remove();
                if (d.success) uiToast('✅ تم صرف الراتب مسبقاً لـ ' + d.paidCount + ' شخص بإجمالي ' + d.totalPaid.toLocaleString() + ' $', 'success');
                else uiToast('❌ ' + d.msg, 'danger');
            };
        }

        // ─── دوال الرسوم (كبار المسؤولين) ──────────────────────────────────
        async function saveTransferFee() {
            const transferFee = document.getElementById('transfer-fee-input').value;
            const transferFeeRecipient = document.getElementById('transfer-fee-recipient').value.trim();
            const res = await fetch('/api/superadmin/fees', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ transferFee, transferFeeRecipient })
            });
            const data = await res.json();
            showMsg('transfer-fee-msg', (data.success?'✅ ':'❌ ')+data.msg, data.success?'success':'danger');
        }

        async function saveRenewalFee() {
            const cardRenewalFee = document.getElementById('card-renewal-fee-input').value;
            const res = await fetch('/api/superadmin/fees', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ cardRenewalFee })
            });
            const data = await res.json();
            showMsg('renewal-fee-msg', (data.success?'✅ ':'❌ ')+data.msg, data.success?'success':'danger');
        }

        async function saveLoanExpiry() {
            const loanExpiryDays = document.getElementById('loan-expiry-days').value;
            const loanExpiryApplyTo = document.getElementById('loan-expiry-apply').value;
            const res = await fetch('/api/superadmin/loan-expiry', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ loanExpiryDays, loanExpiryApplyTo })
            });
            const data = await res.json();
            showMsg('loan-expiry-msg', (data.success?'✅ ':'❌ ')+data.msg, data.success?'success':'danger');
        }

        async function saveGlobalCardLimit() {
            const limit = document.getElementById('global-card-limit-input').value;
            const res = await fetch('/api/admin/global-card-limit', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ limit })
            });
            const data = await res.json();
            uiAlert(data.success ? '✅ تم حفظ الحد العام' : '❌ فشل');
        }

        async function allowAllCards() {
            const f = await uiForm({
                title: '💳 السماح بعدد بطاقات للجميع',
                okText: 'تطبيق على الجميع',
                fields: [{ name: 'limit', label: 'عدد البطاقات المسموح لكل مستخدم', type: 'number', min: 1, step: 1, required: true }]
            });
            if (!f) return;
            const limit = f.limit;
            const res = await fetch('/api/admin/global-card-limit', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ limit })
            });
            const data = await res.json();
            uiAlert(data.success ? \`✅ تم السماح بـ \${limit} بطاقة لكل مستخدم\` : '❌ فشل');
            if(data.success) loadAdminCards();
        }

        // ─── دوال خدمة العملاء (Support) ──────────────────────────────────────

        let currentTicketId = null;
        const botQuestions = [
            { q: '❓ ما نوع مشكلتك؟', options: ['💳 مشكلة في البطاقة', '💸 مشكلة في التحويل', '📋 مشكلة في القرض', '⚙️ مشكلة أخرى'] },
            { q: '⏰ متى بدأت المشكلة؟', options: ['اليوم', 'هذا الأسبوع', 'قبل أسبوع أو أكثر'] },
            { q: '📊 مستوى أهمية المشكلة؟', options: ['🔴 عاجل جداً', '🟡 متوسط', '🟢 غير مستعجل'] }
        ];
        let botAnswers = [];
        let currentBotQ = 0;









        // ─── أدمن: دوال الدعم ──────────────────────────────────────────────────




        // ─── دوال قائمة الموبايل ──────────────────────────────────────────────
        function toggleMobileMenu() {
            const m = document.getElementById('mobile-menu');
            if(!m) return;
            if(m.classList.contains('open')) { closeMobileMenu(); return; }
            m.classList.add('open');
            m.scrollTop = 0;
            document.documentElement.classList.add('menu-open');
        }
        function closeMobileMenu() {
            const m = document.getElementById('mobile-menu');
            if(m) m.classList.remove('open');
            document.documentElement.classList.remove('menu-open');
        }
        document.addEventListener('touchmove', function(e) {
            if(!document.documentElement.classList.contains('menu-open')) return;
            const m = document.getElementById('mobile-menu');
            if(m && m.contains(e.target) && m.scrollHeight > m.clientHeight + 1) return;
            e.preventDefault();
        }, { passive: false });
        window.addEventListener('resize', function() { if(window.innerWidth > 1180) closeMobileMenu(); });
        function mobileGoPage(page) {
            goPage(page);
            closeMobileMenu();
            // تحديث الزر النشط في القائمة
            document.querySelectorAll('.mobile-menu button').forEach(b => b.classList.remove('active'));
            const mb = document.getElementById('mnav-' + page);
            if(mb) mb.classList.add('active');
        }
        // أغلق القائمة عند الضغط خارجها
        document.addEventListener('click', function(e) {
            const menu = document.getElementById('mobile-menu');
            const btn = document.getElementById('hamburger-btn');
            if(menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
                closeMobileMenu();
            }
        });

        async function loadCardControlPanel() {
            const res = await fetch('/api/superadmin/cards/control');
            const cards = await res.json();
            const container = document.getElementById('card-control-container');
            if (!cards.length) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد بطاقات مفعّلة حالياً.</p>'; return; }
            const colorNames = { blue:'أزرق', green:'أخضر', red:'أحمر', gold:'ذهبي', purple:'بنفسجي', black:'أسود' };
            container.innerHTML = cards.map(c => \`
                <div class="card" style="margin-bottom:10px; \${c.cardFrozen ? 'border-color:#475569; opacity:0.85;' : 'border-color:#3b82f6;'}">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${c.discordTag}</b> <span style="color:#64748b; font-size:0.8rem;">\${c.discord}</span>
                            <p style="margin-top:5px; color:#94a3b8; font-size:0.85rem;">رقم البطاقة: \${c.cardNumber || '---'}</p>
                            <p style="color:#94a3b8; font-size:0.85rem;">اللون: \${colorNames[c.cardColor] || c.cardColor}</p>
                            <p style="color:#94a3b8; font-size:0.85rem;">الرقم السري: \${c.pinSet ? '<span style="color:#fde047;">🔒 معيّن — مخفي (ما أحد يعرفه)</span>' : '<span style="color:#64748b;">لم يُعيَّن بعد</span>'}</p>
                            \${c.cardFrozen ? '<p style="color:#fca5a5; font-size:0.82rem;">🔒 البطاقة مجمّدة حالياً</p>' : ''}
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; min-width:220px;">
                            <button class="btn btn-yellow" style="padding:5px 10px;" onclick="ccResetPin('\${c._id}')">🔄 إعادة تعيين الرقم السري</button>
                            <div style="display:flex; gap:6px;">
                                <button class="btn \${c.cardFrozen ? 'btn-green' : 'btn-yellow'}" style="padding:5px 10px; flex:1;" onclick="ccToggleFreeze('\${c._id}')">\${c.cardFrozen ? '🔓 فك التجميد' : '🔒 تجميد'}</button>
                                <button class="btn btn-red" style="padding:5px 10px;" onclick="ccDeleteCard('\${c._id}')">🗑️ حذف</button>
                            </div>
                            <div id="cc-msg-\${c._id}"></div>
                        </div>
                    </div>
                </div>
            \`).join('');
        }


        async function ccToggleFreeze(id) {
            const res = await fetch(\`/api/superadmin/cards/\${id}/freeze\`, { method: 'PUT' });
            const data = await res.json();
            if (data.success) loadCardControlPanel();
        }

        async function ccDeleteCard(id) {
            if (!(await uiConfirm('هل أنت متأكد من حذف هذه البطاقة نهائياً؟', { title: '🗑️ حذف بطاقة', danger: true, okText: 'نعم، احذفها', detail: 'لا يمكن التراجع عن هذا الإجراء.' }))) return;
            const res = await fetch(\`/api/superadmin/cards/\${id}\`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) loadCardControlPanel();
            else uiAlert(data.msg || 'فشل الحذف', 'danger');
        }

        async function loadFeesPanel() {
            const res = await fetch('/api/superadmin/settings');
            const s = await res.json();
            if (!s) return;
            if (document.getElementById('transfer-fee-input')) document.getElementById('transfer-fee-input').value = s.transferFee || 0;
            if (document.getElementById('transfer-fee-recipient')) document.getElementById('transfer-fee-recipient').value = s.transferFeeRecipient || '';
            if (document.getElementById('card-renewal-fee-input')) document.getElementById('card-renewal-fee-input').value = s.cardRenewalFee || 0;
            if (document.getElementById('loan-expiry-days')) document.getElementById('loan-expiry-days').value = s.loanExpiryDays || 0;
            if (document.getElementById('loan-expiry-apply')) document.getElementById('loan-expiry-apply').value = s.loanExpiryApplyTo || 'new';
        }

        // ─── نظام التحديث التلقائي (Real-time Polling) ──────────────────────
        // كل عملية (تحويل، إيداع، قرض، بطاقة، تذكرة...) تبعث "إشارة نشاط" من
        // السيرفر، وكل طرف مفتوح على الموقع (الشخص، الطرف الثاني، الأدمن)
        // يلتقطها بأقرب دورة بولنق (كل ثانيتين) ويحدّث شاشته تلقائياً.
        let pollInterval = null;
        let adminPollInterval = null;
        let lastUnreadCount = 0;
        let lastSeenActivity = 0;      // آخر إشارة نشاط عامة شافها المستخدم
        let lastSeenTicketActivity = 0; // آخر إشارة نشاط خاصة بالتذاكر
        let lastSeenAdminActivity = 0;
        let lastSeenAdminTicketActivity = 0;
        let activePollingTicketId = null; // ID التذكرة المفتوحة حالياً للمستخدم
        let adminActivePollingTicketId = null; // للأدمن


        let pendingSilentRefresh = false;
        document.addEventListener('visibilitychange', function() { if (!document.hidden && pendingSilentRefresh) silentRefreshCurrentPage(); });


        // تغليف openTicketChat لتفعيل polling




        // ═══════════ خدمة العملاء (منقولة من فلاش) — طبقة التوافق مع واجهة البنك ═══════════
        var ME = null;
        var currentRealOwner = false;
        function toast(m) { uiToast(m, 'info'); }
        function confirmModal(msg) { return uiConfirm(msg, { okText: 'متأكد' }); }
        function promptModal(msg, def) {
            return uiForm({ title: msg, fields: [{ name: 'v', label: 'اكتب هنا', type: 'text', value: def || '' }], okText: 'تأكيد' }).then(function (r) { return r ? r.v : null; });
        }
        function _fmOpen(msg, o) { return (o && o.isPrompt) ? promptModal(msg) : confirmModal(msg); }
        function csHtml(id, options, current, opts) {
            opts = opts || {};
            var h = '<select id="' + id + '"' + (opts.onpick ? ' onchange="var value=this.value;' + opts.onpick + '"' : '') + '>';
            options.forEach(function (o) { h += '<option value="' + spEsc(o[0]) + '"' + (o[0] === current ? ' selected' : '') + '>' + spEsc(o[1]) + '</option>'; });
            return h + '</select>';
        }
        function exFull(t) {
            if (!t) return '—';
            try {
                var d = new Date(t);
                var a = d.toLocaleDateString('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
                var b = d.toLocaleTimeString('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', hour: 'numeric', minute: '2-digit', second: '2-digit' });
                return 'يوم ' + a + ' الساعة ' + b;
            } catch (e) { return '—'; }
        }
        function closeWarnForm() {
            document.getElementById('wf-overlay').classList.remove('open');
            document.getElementById('wf-box').innerHTML = '';
        }
        async function spNotifyUser() {
            var c = SP.cur; if (!c) return;
            try { await spApi('/api/support/admin/tickets/' + c.id + '/notify', { method: 'POST', body: '{}' }); toast('🔔 انرسل إشعار للعضو'); }
            catch (e) { toast(e.message); }
        }
        // نفس نوافذ فلاش لكن تشتغل على نوافذ البنك
        function openSupportModal() { spOpen(); }
        function closeSupportModal() { spClose(); }
        function loadAdminSupport() {
            var box = document.getElementById('admin-support-container'); if (!box) return;
            SP.cur = null; SP.img = null;
            box.innerHTML = '<div class="sp-tabs" id="spa-tabs"></div><div id="spa-body" style="display:flex;flex-direction:column;min-height:420px;"></div>';
            spaShowList();
        }
        // التحديث اللحظي (بولنق): المحادثة المفتوحة كل ثانيتين ونص، والقوائم والعدادات كل ٦ ثواني
        setInterval(function () { if (ME && SP.cur) spLoadNew(); }, 2500);
        setInterval(function () {
            if (!ME) return;
            spBadges();
            if (!SP.cur) {
                if (document.getElementById('sp-list')) spLoadList();
                if (document.getElementById('spa-list')) spaLoadList();
            }
        }, 6000);
        // الذكاء الآلي يكتب: نعرضها فور ما يرد السيرفر بحالة الكتابة
        function spPendingTicket() {
            var id = null;
            try {
                id = new URLSearchParams(location.search).get('ticket');
                if (id && /^[a-f0-9]{24}$/.test(id)) { sessionStorage.setItem('sp_pending_ticket', id); history.replaceState(null, '', location.pathname); }
                else id = null;
            } catch (e) { id = null; }
            if (id) return id;
            try { var v = sessionStorage.getItem('sp_pending_ticket'); return v && /^[a-f0-9]{24}$/.test(v) ? v : null; } catch (e) { return null; }
        }
        function spDeepLink() {
            try {
                var id = spPendingTicket();
                if (!id || !ME) return;
                try { sessionStorage.removeItem('sp_pending_ticket'); } catch (e) {}
                if (ME.isAdmin) { openAdminPanel(); switchAdminTab('support'); setTimeout(function () { spOpenTicket(id, 'admin', 'spa-body'); }, 300); }
                else spOpen(id);
            } catch (e) {}
        }
        // ── فحص العضو: أقسام البنك ──
        var SP_INS_CATS = [['account', '🏦 معلومات الحساب'], ['card', '💳 معلومات البطاقة'], ['transfers', '💸 الحوالات'], ['loans', '📋 القروض'], ['flash', '⚡ معلومات فلاش'], ['log', '📜 آخر حركات الحساب']];
        function spCatOf(k) {
            return k.indexOf('account.') === 0 ? 'account' : k.indexOf('card.') === 0 ? 'card' : k.indexOf('tx.') === 0 ? 'transfers' : k.indexOf('loan.') === 0 ? 'loans' : k.indexOf('flash.') === 0 ? 'flash' : 'log';
        }
        async function spEditPerson() {
            var c = SP.cur; if (!c) return;
            var d;
            try { d = await spApi('/api/support/admin/tickets/' + c.id + '/person'); }
            catch (e) { toast(e.message); return; }
            var box = document.getElementById('wf-box');
            box.innerHTML =
                '<h3>✏️ تعديل الحساب البنكي</h3>' +
                '<p style="font-size:12px;color:var(--muted);margin:0 0 8px;">رقم الحساب: ' + spEsc(d.accountNumber) + '</p>' +
                '<label style="font-size:13px;color:var(--muted);">الاسم</label>' +
                '<input id="ep-name" value="' + spEsc(d.name) + '">' +
                '<label style="font-size:13px;color:var(--muted);">حد البطاقات (-1 = حسب الإعداد العام)</label>' +
                '<input id="ep-limit" type="number" value="' + spEsc(d.cardLimit) + '">' +
                '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:14px;"><input type="checkbox" id="ep-frozen" style="width:auto;margin:0;"' + (d.frozen ? ' checked' : '') + '> الحساب مجمّد</label>' +
                '<div class="wf-actions"><button class="btn gray sm" onclick="closeWarnForm()">إلغاء</button><button class="btn sm" onclick="spSavePerson()">حفظ</button></div>';
            document.getElementById('wf-overlay').classList.add('open');
        }
        async function spSavePerson() {
            var c = SP.cur; if (!c) return;
            var body = { name: document.getElementById('ep-name').value, cardLimit: document.getElementById('ep-limit').value, frozen: document.getElementById('ep-frozen').checked };
            try {
                var r = await spApi('/api/support/admin/tickets/' + c.id + '/person', { method: 'POST', body: JSON.stringify(body) });
                toast('✅ تم التعديل — ' + r.name + (r.frozen ? ' (مجمّد)' : ''));
                closeWarnForm();
                await spLoadNew();
            } catch (e) { toast(e.message); }
        }

        // ───── كود التكتات المنقول من فلاش ─────
        var SP = { cur: null, es: null, esOk: false, img: null, lastLive: 0, liveT: null, badgeT: null, loading: false, again: false, atab: 'waiting' };
        var SP_CATS = ['مشكلة في الحساب البنكي', 'تحويل / رصيد', 'قرض', 'البطاقة البنكية', 'رواتب العساكر', 'اقتراح', 'أخرى'];
        var SP_PLACE_MAP = {
            'مشكلة في الحساب البنكي': ['الدخول للبنك', 'الرئيسية', 'كشف الحساب', 'الإشعارات', 'تجميد الحساب', 'أخرى'],
            'تحويل / رصيد': ['تحويل ما وصل', 'خصم ما أعرفه', 'رسوم التحويل', 'رصيد ناقص', 'التوفير', 'أخرى'],
            'قرض': ['طلب قرض جديد', 'سداد القرض', 'حالة الطلب', 'انتهاء القرض', 'أخرى'],
            'البطاقة البنكية': ['طلب بطاقة', 'الرقم السري', 'تجديد البطاقة', 'سداد المخالفات بالبطاقة', 'تجميد البطاقة', 'أخرى'],
            'رواتب العساكر': ['الراتب ما نزل', 'مبلغ الراتب غلط', 'الرتبة', 'أخرى'],
            'اقتراح': ['الرئيسية', 'التحويل', 'القروض', 'البطاقات', 'لوحة الإدارة', 'أخرى']
        };
        var SP_PLACE_Q = {
            'مشكلة في الحساب البنكي': 'وين المشكلة في حسابك البنكي؟',
            'تحويل / رصيد': 'وش نوع مشكلة التحويل أو الرصيد؟',
            'قرض': 'وين المشكلة في القرض؟',
            'البطاقة البنكية': 'وين المشكلة في البطاقة؟',
            'رواتب العساكر': 'وش مشكلة الراتب؟',
            'اقتراح': 'لأي قسم الاقتراح؟'
        };
        function spCatChanged(cat) {
            var wrap = document.getElementById('spn-place-wrap'); if (!wrap) return;
            var list = SP_PLACE_MAP[cat];
            if (!list) { wrap.style.display = 'none'; document.getElementById('spn-place-box').innerHTML = ''; return; }
            wrap.style.display = '';
            document.getElementById('spn-place-q').textContent = SP_PLACE_Q[cat] || 'وين المشكلة؟';
            document.getElementById('spn-place-box').innerHTML = csHtml('spn-place', list.map(function (x) { return [x, x]; }), list[0]);
            try { csEnhanceAll(); } catch (e) {}
        }
        var SP_ST = { ai: '🤖 مساعد ذكي', waiting: '⏳ بانتظار إداري', active: '✅ مع إداري', closed: '🔒 مغلق' };
        function spEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function spTime(d) { try { return new Date(d).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
        function spGuestToken() {
            var t = null;
            try { t = localStorage.getItem('moi_guest_token'); } catch (e) {}
            if (!t || t.length !== 32) {
                var a = new Uint8Array(16); crypto.getRandomValues(a);
                t = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
                try { localStorage.setItem('moi_guest_token', t); } catch (e) {}
            }
            return t;
        }
        async function spApi(url, opts) {
            var o = Object.assign({ headers: { 'Content-Type': 'application/json', 'x-guest-token': spGuestToken() } }, opts || {});
            var r = await fetch(url, o);
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok) throw new Error(d.error || 'خطأ');
            return d;
        }

        function spBadges() {
            if (SP.badgeT) return;
            SP.badgeT = setTimeout(async function () {
                SP.badgeT = null;
                try {
                    var b = await spApi('/api/support/badges');
                    var u = b.user || 0;
                    var a = b.admin ? (b.admin.waiting + b.admin.unread) : 0;
                    SP.nu = u; SP.na = a;
                    spPaintBadges();
                } catch (e) {}
            }, 250);
        }
        function spPaintBadges() {
            var fb = document.getElementById('sp-fab-badge');
            var total = (SP.nu || 0) + (SP.na || 0);
            if (fb) { fb.style.display = total ? 'inline-flex' : 'none'; fb.textContent = total; }
            document.querySelectorAll('.sp-nav-user').forEach(function (el) { el.querySelectorAll('.sp-badge').forEach(function (x) { x.remove(); }); if (SP.nu) el.insertAdjacentHTML('beforeend', '<span class="sp-badge">' + SP.nu + '</span>'); });
            document.querySelectorAll('.sp-nav-admin').forEach(function (el) { el.querySelectorAll('.sp-badge').forEach(function (x) { x.remove(); }); if (SP.na) el.insertAdjacentHTML('beforeend', '<span class="sp-badge">' + SP.na + '</span>'); });
        }

        function spFitViewport() {
            var m = document.getElementById('sp-modal');
            if (!m || !m.classList.contains('open')) return;
            var vv = window.visualViewport;
            if (!vv) return;
            var wasKb = m.classList.contains('kb');
            var kb = vv.height < window.innerHeight - 120;
            m.style.top = vv.offsetTop + 'px';
            m.style.height = vv.height + 'px';
            m.classList.toggle('kb', kb);
            if (kb !== wasKb) { var mb = document.getElementById('sp-msgs'); if (mb) mb.scrollTop = mb.scrollHeight; }
        }
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', spFitViewport);
            window.visualViewport.addEventListener('scroll', spFitViewport);
        }
        function spOpen(tid) {
            var m = document.getElementById('sp-modal');
            if (!m.classList.contains('open')) SP.scrollY = window.pageYOffset || 0;
            m.classList.add('open');
            document.documentElement.classList.add('sp-lock');
            if (!SP.focusBound) {
                SP.focusBound = true;
                m.addEventListener('focusout', function () {
                    setTimeout(function () { window.scrollTo(0, SP.scrollY || 0); spFitViewport(); }, 120);
                });
            }
            spFitViewport();
            if (tid) spOpenTicket(tid, 'user', 'sp-body'); else spShowList();
        }
        function spClose() {
            var m = document.getElementById('sp-modal');
            try { if (document.activeElement && m.contains(document.activeElement)) document.activeElement.blur(); } catch (e) {}
            m.classList.remove('open', 'kb');
            m.style.top = ''; m.style.height = '';
            document.documentElement.classList.remove('sp-lock');
            window.scrollTo(0, SP.scrollY || 0);
            if (SP.cur && SP.cur.box === 'sp-body') SP.cur = null;
            SP.img = null;
            spBadges();
        }
        function spShowList() {
            SP.cur = null; SP.img = null;
            document.getElementById('sp-body').innerHTML =
                '<button class="sp-btn" id="sp-newbtn" onclick="spShowNew()" style="margin-bottom:12px;">+ تكت جديد</button>' +
                '<div id="sp-list"><div style="color:var(--muted);text-align:center;padding:20px;">جارِ التحميل...</div></div>';
            spLoadList();
        }
        async function spLoadList() {
            var box = document.getElementById('sp-list'); if (!box) return;
            try {
                var d = await spApi('/api/support/tickets');
                var unrated = d.tickets.filter(function (t) { return t.needRate; })[0];
                if (unrated && !d.banned) { spOpenTicket(unrated.id, 'user', 'sp-body'); return; }
                var hasOpen = d.tickets.some(function (t) { return t.status !== 'closed'; });
                var nb = document.getElementById('sp-newbtn');
                if (nb) {
                    nb.disabled = hasOpen || !!d.banned; nb.style.opacity = (hasOpen || d.banned) ? '0.55' : '';
                    nb.textContent = d.banned ? '🚫 تم حظرك من خدمة الدعم الفني' : hasOpen ? '🔒 عندك تكت مفتوح، لين تقفله الإدارة ما تقدر تفتح جديد' : '+ تكت جديد';
                }
                if (!d.tickets.length) { box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;">ما عندك تكتات، افتح تكت جديد وبنساعدك 👌</div>'; return; }
                box.innerHTML = d.tickets.map(function (t) {
                    return '<div class="sp-row" onclick="spOpenTicket(&quot;' + t.id + '&quot;,&quot;user&quot;,&quot;sp-body&quot;)">' +
                        '<div class="t1"><span>#' + t.no + ' — ' + spEsc(t.category) + (t.unread ? '<span class="sp-badge">' + t.unread + '</span>' : '') + '</span><span class="sp-chip ' + t.status + '">' + SP_ST[t.status] + '</span></div>' +
                        '<div class="t2">' + spEsc(t.last || '') + '</div></div>';
                }).join('');
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;">' + spEsc(e.message) + '</div>'; }
        }
        function spShowNew() {
            SP.cur = null; SP.img = null;
            var guest = !ME;
            document.getElementById('sp-body').innerHTML =
                '<button class="sp-link" onclick="spShowList()" style="align-self:flex-start;margin-bottom:8px;">‹ رجوع</button>' +
                (guest ? '<label class="sp-lbl">اسمك</label><input id="spn-name" class="sp-field" maxlength="40" placeholder="اكتب اسمك">' : '') +
                '<label class="sp-lbl">نوع المشكلة</label>' + csHtml('spn-cat', SP_CATS.map(function (c) { return [c, c]; }), SP_CATS[0], { onpick: 'spCatChanged(value)' }) +
                '<div id="spn-place-wrap"><label class="sp-lbl" id="spn-place-q"></label><div id="spn-place-box"></div></div>' +
                '<label class="sp-lbl">اشرح المشكلة</label><textarea id="spn-text" class="sp-field" rows="4" maxlength="1500" placeholder="وش اللي صار؟ وش الزر اللي ضغطته؟ وش الخطأ اللي ظهر؟"></textarea>' +
                '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;"><label class="sp-attach">📎<input type="file" accept="image/*" style="display:none" onchange="spPick(this)"></label><div id="spn-prev" class="sp-prev" style="margin:0;"></div></div>' +
                '<button class="sp-btn" id="spn-go" onclick="spCreate()">فتح التكت</button>';
            spCatChanged(SP_CATS[0]);
            try { csEnhanceAll(); } catch (e) {}
        }
        async function spCreate() {
            var b = document.getElementById('spn-go');
            var text = document.getElementById('spn-text').value.trim();
            var nm = document.getElementById('spn-name');
            if (nm && nm.value.trim().length < 2) return toast('اكتب اسمك');
            if (!text && !SP.img) return toast('اشرح المشكلة أو أرفق صورة');
            b.disabled = true;
            try {
                var d = await spApi('/api/support/tickets', { method: 'POST', body: JSON.stringify({
                    name: nm ? nm.value.trim() : undefined,
                    category: document.getElementById('spn-cat').value,
                    place: (document.getElementById('spn-place-wrap').style.display !== 'none' && document.getElementById('spn-place')) ? document.getElementById('spn-place').value : '',
                    text: text, image: SP.img
                }) });
                SP.img = null;
                spOpenTicket(d.id, 'user', 'sp-body');
            } catch (e) { toast(e.message); b.disabled = false; }
        }

        function spPick(inp) {
            var f = inp.files && inp.files[0]; inp.value = '';
            if (!f) return;
            if (f.type.indexOf('image/') !== 0) return toast('اختر صورة فقط');
            var fr = new FileReader();
            fr.onload = function () {
                var im = new Image();
                im.onload = function () {
                    var max = 1280, w = im.width, h = im.height;
                    if (w > max || h > max) { var k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
                    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                    cv.getContext('2d').drawImage(im, 0, 0, w, h);
                    var q = 0.8, out = cv.toDataURL('image/jpeg', q);
                    while (out.length > 1500000 && q > 0.35) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
                    SP.img = out;
                    spPaintPrev();
                };
                im.onerror = function () { toast('تعذر قراءة الصورة'); };
                im.src = fr.result;
            };
            fr.readAsDataURL(f);
        }
        function spPaintPrev() {
            var p = document.getElementById('sp-prev') || document.getElementById('spn-prev');
            if (!p) return;
            p.innerHTML = SP.img ? '<img src="' + SP.img + '"><button class="sp-link" onclick="SP.img=null;spPaintPrev()">✕ إزالة</button>' : '';
        }
        function spViewImg(src) {
            document.getElementById('sp-lightbox-img').src = src;
            document.getElementById('sp-lightbox').style.display = 'flex';
        }

        async function spOpenTicket(id, mode, box) {
            spVoiceReset(); spVmStopAll(); SP.noteMode = false;
            SP.cur = { id: id, mode: mode, box: box, n: 0, t: null, role: null, typing: false };
            SP.img = null; SP.edit = null; SP.reply = null; spMmClose();
            var el = document.getElementById(box);
            el.innerHTML =
                '<div class="sp-chat">' +
                '<div class="sp-bar"><button class="sp-link" onclick="spBack()">‹ رجوع</button><div class="sp-title" id="sp-title">...</div><button class="sp-link" id="sp-edit" onclick="spEditPerson()" style="color:#fbbf24;display:none;">✏️ تعديل</button><button class="sp-link" id="sp-inspect" onclick="spInspect()" style="color:#86efac;display:none;">🔍 فحص</button><button class="sp-link" id="sp-notify" onclick="spNotifyUser()" style="color:#93c5fd;display:none;">🔔 إشعار</button><button class="sp-link" id="sp-close" onclick="spCloseTicket()" style="color:#fca5a5;">إغلاق</button><button class="sp-link" id="sp-del" onclick="spDeleteTicket()" style="color:#fca5a5;display:none;">🗑️ حذف</button><button class="sp-link" id="sp-ban" onclick="spBanUser()" style="color:#fca5a5;display:none;">🚫 حظر</button></div>' +
                '<div class="sp-state" id="sp-state"></div>' +
                '<div class="sp-info" id="sp-info" style="display:none;"></div>' +
                '<div class="sp-msgs" id="sp-msgs"></div>' +
                '<div id="sp-rate" class="sp-rate" style="display:none;"></div>' +
                '<div id="sp-prev" class="sp-prev"></div>' +
                '<div id="sp-ctxbar" class="sp-ctxbar" style="display:none;"></div>' +
                '<div class="sp-compose" id="sp-compose">' +
                    '<div class="sp-cin" id="sp-cin">' +
                        '<label class="sp-attach">📎<input type="file" accept="image/*" style="display:none" onchange="spPick(this)"></label>' +
                        '<button class="sp-mic" id="sp-mic" title="رسالة صوتية" onclick="spVoiceStart()">🎙️</button>' +
                        (mode === 'admin' ? '<button class="sp-mic" id="sp-note-btn" title="ملاحظة داخلية (للإدارة فقط)" onclick="spNoteToggle()">📝</button><button class="sp-mic" title="ردود جاهزة" onclick="spCannedOpen()">⚡</button>' : '') +
                        '<textarea id="sp-in" class="sp-field" rows="1" placeholder="اكتب رسالتك..."></textarea>' +
                        '<button class="sp-btn" id="sp-send" onclick="spSend()">➤</button>' +
                    '</div>' +
                    '<div class="sp-vbar" id="sp-vbar"></div>' +
                '</div></div>';
            var ta = document.getElementById('sp-in');
            ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); spSend(); } };
            ta.oninput = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 110) + 'px'; spTypingPing(); };
            spWireMsgs();
            await spLoadNew(true);
        }
        function spBack() {
            spVoiceReset(); spVmStopAll(); SP.noteMode = false;
            SP.cur = null; SP.img = null; SP.edit = null; SP.reply = null; spMmClose();
            if (document.getElementById('spa-body')) spaShowList(); else spShowList();
        }
        async function spLoadNew(first) {
            var c = SP.cur; if (!c) return;
            if (SP.loading) { SP.again = true; return; }
            SP.loading = true;
            try {
                var d = await spApi('/api/support/tickets/' + c.id + '?after=' + c.n);
                if (SP.cur !== c) return;
                c.t = d.ticket; c.role = d.role; c.canInspect = !!d.canInspect;
                if (d.typing) c.typing = true;
                (d.peers || []).forEach(function (p) { spPeerTyping({ id: c.id, name: p.name, tag: p.tag, kind: p.kind }); });
                var skNew = (d.shared || []).join(','), skChanged = (c.sharedKey !== skNew);
                c.sharedKey = skNew; c.shared = d.shared || [];
                var box = document.getElementById('sp-msgs');
                if (!box) return;
                if (c.mver === undefined) c.mver = d.mver;
                else if (d.mver !== undefined && d.mver !== c.mver) {
                    // انعدلت أو انحذفت رسالة قديمة: نعيد رسم الرسايل كلها من الأول
                    c.mver = d.mver; c.n = 0; c.mm = {}; c.keepScroll = box.scrollTop; box.innerHTML = '';
                    SP.again = true;
                    return;
                }
                var near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
                var tp = document.getElementById('sp-typing'); if (tp) tp.remove();
                var pp = document.getElementById('sp-peers'); if (pp) pp.remove();
                d.msgs.forEach(function (m) {
                    if (c.peers) Object.keys(c.peers).forEach(function (k) { var q = c.peers[k]; if ((m.sender === 'user' && q.kind === 'owner') || (m.sender === 'admin' && q.kind !== 'owner' && q.name === m.name)) delete c.peers[k]; });
                    box.insertAdjacentHTML('beforeend', spMsgHtml(m));
                    if (m.sender === 'ai') { c.typing = false; c.suggest = !!m.suggest; }
                    if (m.sender === 'user') c.suggest = false;
                });
                c.n = d.n;
                spShowTyping();
                spShowPeers();
                spPaintState();
                if (skChanged) spLoadInfo();
                if (first || near || d.msgs.some(function (m) { return m.sender === (c.mode === 'admin' ? 'admin' : 'user'); })) box.scrollTop = box.scrollHeight;
                if (c.keepScroll != null) { box.scrollTop = c.keepScroll; c.keepScroll = null; }
                if (d.msgs.length) spBadges();
            } catch (e) {
                if (first) { var el = document.getElementById(c.box); if (el) el.innerHTML = '<div style="color:#fca5a5;padding:14px;">' + spEsc(e.message) + '</div>'; }
                else if (SP.cur === c && /غير موجود/.test(e.message)) { toast('هذا التكت انحذف'); spBack(); }
            } finally {
                SP.loading = false;
                if (SP.again) { SP.again = false; spLoadNew(); }
            }
        }
        function spMsgHtml(m) {
            if (m.hid) return '';
            var c = SP.cur;
            if (c) { if (!c.mm) c.mm = {}; c.mm[m.i] = m; }
            if (m.sender === 'note') {
                var rt = m.role === 'senior' ? '<span class="sp-role senior">كبار المسؤولين</span>' : '<span class="sp-role admin">إداري</span>';
                return '<div class="sp-msg note" data-i="' + m.i + '"><div class="sp-who">📝 ملاحظة داخلية (ما تظهر للعضو) — ' + spEsc(m.name || '') + rt + '</div><div class="sp-b">' + spEsc(m.text || '') + '</div><div class="sp-time">' + spTime(m.at) + '</div></div>';
            }
            var mine = c.mode === 'admin' ? m.sender === 'admin' : m.sender === 'user';
            var cls = m.sender === 'system' ? 'sys' : (mine ? 'me' : 'other') + (m.sender === 'ai' ? ' ai' : '') + (m.sender === 'admin' && !mine ? ' admin' : '') + (m.del ? ' del' : '');
            var gt = spGuestToken();
            var roleTag = m.sender === 'admin' ? (m.role === 'senior' ? '<span class="sp-role senior">كبار المسؤولين</span>' : '<span class="sp-role admin">إداري</span>') : '';
            var who = m.sender === 'system' ? '' : '<div class="sp-who">' + (m.sender === 'ai' ? '🤖 ' : m.sender === 'admin' ? '🛡️ ' : '') + spEsc(m.name || '') + roleTag + '</div>';
            var img = m.img ? '<img class="sp-img" loading="lazy" src="/api/support/tickets/' + c.id + '/img/' + m.i + '?gt=' + gt + '" onclick="spViewImg(this.src)">' : '';
            var body = (m.text ? spEsc(m.text) : '');
            if (m.aud) body += spVoiceHtml(m, c);
            var quote = m.rp != null ? '<div class="sp-quote" onclick="spJumpTo(' + m.rp + ')"><b>' + spEsc(m.rpn || '') + '</b>' + spEsc(m.rpt || '') + '</div>' : '';
            var delTag = m.del ? '<div class="sp-del-tag">🗑️ ' + (c.mode === 'admin' ? 'محذوفة — حذفها ' + spEsc(m.delBy || '') + (m.rev ? ' • معروضة للعضو' : ' • مخفية عن العضو') : 'رسالة محذوفة (عرضتها لك الإدارة)') + '</div>' : '';
            var data = m.sender === 'system' ? '' : ' data-i="' + m.i + '"';
            return '<div class="sp-msg ' + cls + '"' + data + '>' + who + '<div class="sp-b">' + delTag + quote + body + img + '</div>' + (m.sender === 'system' ? '' : '<div class="sp-time">' + spTime(m.at) + (m.ed ? '<span class="sp-ed">• معدّلة</span>' : '') + '</div>') + '</div>';
        }
        // ===== قائمة خيارات الرسالة (تطلع من تحت بعرض الشاشة) =====
        function spIsSenior() { return !!(ME && ME.isSeniorAdmin && SP.cur && SP.cur.mode === 'admin'); }
        function spMmClose() { var e = document.getElementById('sp-mm-ov'); if (e) e.remove(); }
        function spMsgMenuOpen(i) {
            var c = SP.cur; if (!c || !c.mm || !c.mm[i]) return;
            var m = c.mm[i], t = c.t || {}, closed = t.status === 'closed', senior = spIsSenior();
            var isMsg = m.sender !== 'note' && m.sender !== 'system';
            var items = [];
            if (m.text) items.push(['copy', '📋', 'نسخ الرسالة']);
            if (isMsg && !m.del && !closed) items.push(['reply', '↩️', 'رد على الرسالة']);
            if (isMsg && m.own && !m.del && !closed && !m.aud) items.push(['edit', '✏️', 'تعديل الرسالة']);
            if (isMsg && !m.del && (m.own || senior) && (!closed || senior)) items.push(['del', '🗑️', 'حذف الرسالة', 'danger']);
            if (senior && m.del) items.push(['reveal', m.rev ? '🙈' : '👁️', m.rev ? 'إخفاء الرسالة عن العضو' : 'عرض الرسالة للعضو']);
            if (senior && isMsg) items.push(['info', 'ℹ️', 'تفاصيل الرسالة']);
            if (!items.length) return;
            spMmRender(m, items);
        }
        function spMmRender(m, items) {
            spMmClose();
            var ov = document.createElement('div');
            ov.id = 'sp-mm-ov';
            ov.onclick = function (e) { if (e.target === ov) spMmClose(); };
            var prev = (m.text || (m.aud ? '🎙️ رسالة صوتية' : (m.img ? '📷 صورة' : ''))).slice(0, 90);
            var h = '<div id="sp-mm-sheet"><div class="sp-mm-grip"></div><div class="sp-mm-prev">' + spEsc(prev) + '</div>';
            items.forEach(function (it) { h += '<button class="sp-mm-it ' + (it[3] || '') + '" data-a="' + it[0] + '"><span>' + it[1] + '</span>' + it[2] + '</button>'; });
            h += '<button class="sp-mm-it cancel" data-a="x">إغلاق</button></div>';
            ov.innerHTML = h;
            ov.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.sp-mm-it') : null; if (b) spMsgAct(b.getAttribute('data-a'), m.i); });
            document.body.appendChild(ov);
        }
        function spMmInfo(m) {
            var sh = document.getElementById('sp-mm-sheet'); if (!sh) return;
            var h = '<div class="sp-mm-grip"></div><div class="sp-mm-info">';
            h += '<div>👤 المرسل: <b>' + spEsc(m.name || '-') + '</b>' + (m.sender === 'admin' ? (m.role === 'senior' ? ' (كبار المسؤولين)' : ' (إداري)') : m.sender === 'ai' ? ' (المساعد الآلي)' : m.sender === 'user' ? ' (العضو)' : '') + '</div>';
            h += '<div>🕒 أُرسلت: <b>' + exFull(m.at) + '</b></div>';
            if (m.ed) { h += '<div>✏️ آخر تعديل: <b>' + exFull(m.edAt) + '</b></div>'; (m.edits || []).forEach(function (e, k) { h += '<div class="ed">النسخة ' + (k + 1) + ' (قبل التعديل — ' + spTime(e.at) + '): ' + spEsc(e.text || '') + '</div>'; }); }
            if (m.del) { h += '<div style="color:#fca5a5;">🗑️ حذفها: <b>' + spEsc(m.delBy || '-') + '</b> — ' + exFull(m.delAt) + '</div><div>👁️ معروضة للعضو: <b>' + (m.rev ? 'نعم' : 'لا') + '</b></div>'; }
            h += '</div><button class="sp-mm-it cancel" data-a="x">إغلاق</button>';
            sh.innerHTML = h;
        }
        async function spMsgAct(a, i) {
            var c = SP.cur;
            if (a === 'x' || !c || !c.mm || !c.mm[i]) return spMmClose();
            var m = c.mm[i];
            if (a === 'info') return spMmInfo(m);
            spMmClose();
            var ta = document.getElementById('sp-in');
            if (a === 'copy') return spCopyText(m.text);
            if (a === 'reply') {
                SP.edit = null;
                SP.reply = { i: i, name: m.name || '', text: m.text || (m.aud ? '🎙️ رسالة صوتية' : (m.img ? '📷 صورة' : '')) };
                spPaintCtx(); if (ta) ta.focus(); return;
            }
            if (a === 'edit') {
                SP.reply = null; SP.edit = { i: i };
                if (ta) { ta.value = m.text || ''; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 110) + 'px'; ta.focus(); }
                spPaintCtx(); return;
            }
            if (a === 'del') {
                if (!(await confirmModal('متأكد تبي تحذف هذي الرسالة؟'))) return;
                try { await spApi('/api/support/tickets/' + c.id + '/messages/' + i + '/delete', { method: 'POST', body: '{}' }); toast('تم حذف الرسالة'); await spLoadNew(); } catch (e) { toast(e.message); }
                return;
            }
            if (a === 'reveal') return spRevealAsk(i);
        }
        async function spRevealAsk(i) {
            var c = SP.cur; if (!c || !c.mm || !c.mm[i]) return;
            var m = c.mm[i];
            if (!(await confirmModal(m.rev ? 'تبي تخفي هذي الرسالة المحذوفة عن العضو؟' : 'تبي تعرض هذي الرسالة المحذوفة للعضو؟'))) return;
            try {
                await spApi('/api/support/tickets/' + c.id + '/messages/' + i + '/reveal', { method: 'POST', body: JSON.stringify({ show: !m.rev }) });
                toast(m.rev ? 'تم إخفاؤها عن العضو' : 'تم عرضها للعضو');
                await spLoadNew();
            } catch (e) { toast(e.message); }
        }
        function spCopyText(txt) {
            txt = String(txt || '');
            function fb() {
                var ta = document.createElement('textarea');
                ta.value = txt; ta.style.cssText = 'position:fixed;top:-100px;opacity:0;';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); toast('تم نسخ الرسالة'); } catch (e) { toast('تعذر النسخ'); }
                ta.remove();
            }
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { toast('تم نسخ الرسالة'); }).catch(fb); else fb();
        }
        function spJumpTo(i) {
            var el = document.querySelector('#sp-msgs .sp-msg[data-i="' + i + '"]');
            if (!el) { toast('الرسالة غير موجودة'); return; }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('sp-flash');
            setTimeout(function () { el.classList.remove('sp-flash'); }, 1400);
        }
        function spPaintCtx() {
            var b = document.getElementById('sp-ctxbar'); if (!b) return;
            if (SP.edit) { b.style.display = 'flex'; b.innerHTML = '<span>✏️ تعديل الرسالة</span><button class="sp-link" onclick="spCtxCancel()">✕ إلغاء</button>'; }
            else if (SP.reply) { b.style.display = 'flex'; b.innerHTML = '<span>↩️ رد على <b>' + spEsc(SP.reply.name) + '</b>: ' + spEsc(String(SP.reply.text).slice(0, 50)) + '</span><button class="sp-link" onclick="spCtxCancel()">✕</button>'; }
            else { b.style.display = 'none'; b.innerHTML = ''; }
        }
        function spCtxCancel() {
            var wasEdit = !!SP.edit;
            SP.edit = null; SP.reply = null; spPaintCtx();
            if (wasEdit) { var ta = document.getElementById('sp-in'); if (ta) { ta.value = ''; ta.style.height = 'auto'; } }
        }
        function spMsgClick(e) {
            if (SP.lpFired) { SP.lpFired = false; return; }
            var t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.sp-img, .sp-vm, .sp-quote, button, a, audio, input, textarea')) return;
            try { var sel = window.getSelection && window.getSelection().toString(); if (sel) return; } catch (x) {}
            var el = t.closest('.sp-msg[data-i]'); if (!el) return;
            var i = parseInt(el.getAttribute('data-i'), 10), c = SP.cur;
            if (!c || !c.mm || !c.mm[i]) return;
            if (c.mm[i].del && spIsSenior()) return spRevealAsk(i);
            spMsgMenuOpen(i);
        }
        function spLpStart(e) {
            var el = e.target && e.target.closest ? e.target.closest('.sp-msg[data-i]') : null;
            clearTimeout(SP.lpT); SP.lpFired = false;
            if (!el) return;
            SP.lpT = setTimeout(function () { SP.lpFired = true; spMsgMenuOpen(parseInt(el.getAttribute('data-i'), 10)); }, 520);
        }
        function spLpCancel() { clearTimeout(SP.lpT); }
        function spWireMsgs() {
            var mb = document.getElementById('sp-msgs'); if (!mb) return;
            mb.onclick = spMsgClick;
            mb.oncontextmenu = function (e) {
                var el = e.target && e.target.closest ? e.target.closest('.sp-msg[data-i]') : null;
                if (!el) return;
                e.preventDefault();
                spMsgMenuOpen(parseInt(el.getAttribute('data-i'), 10));
            };
            mb.addEventListener('touchstart', spLpStart, { passive: true });
            mb.addEventListener('touchend', spLpCancel, { passive: true });
            mb.addEventListener('touchmove', spLpCancel, { passive: true });
            mb.addEventListener('touchcancel', spLpCancel, { passive: true });
        }
        function spShowTyping() {
            var c = SP.cur, box = document.getElementById('sp-msgs'); if (!c || !box) return;
            var tp = document.getElementById('sp-typing'); if (tp) tp.remove();
            if (c.typing) {
                box.insertAdjacentHTML('beforeend', '<div class="sp-msg other ai" id="sp-typing"><div class="sp-who">🤖 المساعد الآلي</div><div class="sp-b sp-dots"><span></span><span></span><span></span></div></div>');
                box.scrollTop = box.scrollHeight;
            }
        }
        function spPaintState() {
            var c = SP.cur; if (!c || !c.t) return;
            var t = c.t, adm = c.mode === 'admin';
            if (t.status !== 'ai' && c.typing) { c.typing = false; spShowTyping(); }
            document.getElementById('sp-title').textContent = '#' + t.no + ' — ' + t.category + (adm ? ' — ' + t.name + (t.guest ? ' (زائر)' : '') : '');
            var st = document.getElementById('sp-state'), html = '';
            if (t.status === 'ai') {
                html = adm ? '<span>🤖 التكت عند المساعد الآلي (العضو ما طلب إداري)</span><button class="sp-btn warn" onclick="spJoin()">استلام التكت</button>'
                           : '<span>🤖 تتحدث مع المساعد الآلي</span><button class="sp-btn warn" id="sp-human" onclick="spHuman()">🧑‍💼 تحدث مع عضو حقيقي</button>';
            } else if (t.status === 'waiting') {
                html = adm ? '<span>⏳ العضو ينتظر إداري</span><button class="sp-btn warn pulse" onclick="spJoin()">✋ استلام التكت</button>'
                           : '<span>⏳ بانتظار إداري، بيجيك الرد هنا مباشرة بدون ما تحدّث الصفحة</span>';
            } else if (t.status === 'active') {
                html = '<span>✅ الإداري ' + spEsc(t.adminName || '') + ' ' + (adm ? 'مستلم التكت' : 'معك الحين') + '</span>';
            } else {
                html = '<span>🔒 التكت مغلق' + (adm ? (t.rating ? ' — التقييم ⭐ ' + t.rating + '/5' : (t.needRate ? ' — بانتظار تقييم العضو' : '')) : '') + '</span>';
            }
            st.innerHTML = html;
            var closed = t.status === 'closed';
            var isSen = !!(ME && ME.isSeniorAdmin);
            var canWrite = !closed && (!adm || t.status === 'active' || isSen);
            document.getElementById('sp-compose').style.display = canWrite ? 'flex' : 'none';
            var rb = document.getElementById('sp-rate');
            if (rb) {
                if (!adm && t.needRate) { rb.style.display = 'block'; if (!rb.firstChild) rb.innerHTML = spRateHtml(); }
                else { rb.style.display = 'none'; rb.innerHTML = ''; }
            }
            document.getElementById('sp-close').style.display = (closed || !(adm || isSen)) ? 'none' : 'inline';
            var banBtn = document.getElementById('sp-ban');
            if (banBtn) banBtn.style.display = (adm && isSen) ? 'inline' : 'none';
            var editBtn = document.getElementById('sp-edit');
            if (editBtn) editBtn.style.display = (adm && isSen && !t.guest) ? 'inline' : 'none';
            var delBtn = document.getElementById('sp-del');
            if (delBtn) delBtn.style.display = (closed && adm && ME && ME.isSeniorAdmin) ? 'inline' : 'none';
            var ib = document.getElementById('sp-inspect');
            if (ib) ib.style.display = (adm && c.canInspect && !t.guest && !closed) ? 'inline' : 'none';
            var nb = document.getElementById('sp-notify');
            if (nb) nb.style.display = (adm && !t.guest && !closed) ? 'inline' : 'none';
            var hb = document.getElementById('sp-human');
            if (hb && c.suggest) hb.classList.add('pulse');
        }
        async function spSend() {
            var c = SP.cur; if (!c) return;
            var ta = document.getElementById('sp-in'), btn = document.getElementById('sp-send');
            var text = ta.value.trim();
            if (SP.edit) {
                if (!text) { toast('اكتب النص الجديد'); return; }
                btn.disabled = true;
                try {
                    await spApi('/api/support/tickets/' + c.id + '/messages/' + SP.edit.i + '/edit', { method: 'POST', body: JSON.stringify({ text: text }) });
                    SP.edit = null; ta.value = ''; ta.style.height = 'auto'; spPaintCtx();
                    toast('تم تعديل الرسالة');
                    await spLoadNew();
                } catch (e) { toast(e.message); }
                btn.disabled = false; ta.focus();
                return;
            }
            if (!text && !SP.img) return;
            btn.disabled = true;
            try {
                if (SP.noteMode && SP.img) { toast('الملاحظة الداخلية نص فقط'); btn.disabled = false; return; }
                var rpl = (!SP.noteMode && SP.reply) ? SP.reply.i : undefined;
                await spApi('/api/support/tickets/' + c.id + (SP.noteMode ? '/note' : '/messages'), { method: 'POST', body: JSON.stringify(SP.noteMode ? { text: text } : { text: text, image: SP.img, replyTo: rpl }) });
                ta.value = ''; ta.style.height = 'auto'; SP.img = null; spPaintPrev(); SP.reply = null; spPaintCtx();
                await spLoadNew();
                if (!SP.noteMode && c.mode === 'user' && c.t && c.t.status === 'ai') {
                    c.typing = true; spShowTyping();
                    setTimeout(function () { if (SP.cur === c && c.typing) { c.typing = false; spShowTyping(); } }, 40000);
                }
            } catch (e) { toast(e.message); }
            btn.disabled = false; ta.focus();
        }

        /* ---------------- الرسائل الصوتية (مثل ديسكورد) ---------------- */
        var SPV = { rec: null, stream: null, chunks: [], mime: '', t0: 0, timer: null, ctx: null, an: null, samples: [], blob: null, dur: 0, wf: '', cancelled: false, pa: null, praf: null };
        var SPVP = { a: null, el: null, raf: null, rate: 1 };
        var SPV_MAX_SEC = 600, SPV_LIVE_BARS = 36, SPV_BARS = 32;
        function spFmtDur(sec) { sec = Math.max(0, Math.floor(sec || 0)); var s = sec % 60; return Math.floor(sec / 60) + ':' + (s < 10 ? '0' : '') + s; }
        function spVoiceSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
        function spVoicePickMime() {
            var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
            for (var i = 0; i < c.length; i++) { try { if (MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {} }
            return '';
        }
        function spWfDecode(wf) {
            var out = [];
            try { var s = atob(wf || ''); for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) / 255); } catch (e) {}
            return out;
        }
        function spWaveHtml(vals, n) {
            var h = '';
            for (var i = 0; i < n; i++) {
                var v = 0.18;
                if (vals.length) {
                    var a = Math.floor(i * vals.length / n), b = Math.max(a + 1, Math.floor((i + 1) * vals.length / n)), sum = 0;
                    for (var k = a; k < b; k++) sum += vals[k] || 0;
                    v = sum / (b - a);
                }
                h += '<i style="height:' + Math.round(4 + Math.max(0.05, v) * 24) + 'px"></i>';
            }
            return h;
        }
        function spVoicePaint(mode) {
            var cin = document.getElementById('sp-cin'), bar = document.getElementById('sp-vbar');
            if (!cin || !bar) return;
            if (!mode) { bar.style.display = 'none'; bar.innerHTML = ''; cin.style.display = 'flex'; return; }
            cin.style.display = 'none'; bar.style.display = 'flex';
            if (mode === 'rec') {
                bar.innerHTML = '<button class="sp-vb-ic" title="إلغاء" onclick="spVoiceCancel()">🗑️</button><span class="sp-rec-dot"></span><span class="sp-rec-time" id="spv-time">0:00</span><div class="sp-wave" id="spv-live">' + spWaveHtml([], SPV_LIVE_BARS) + '</div><button class="sp-vb-stop" title="إيقاف التسجيل" onclick="spVoiceStop()">⏹</button>';
            } else {
                bar.innerHTML = '<button class="sp-vb-ic" title="حذف" onclick="spVoiceCancel()">🗑️</button><button class="sp-vm-play" id="spv-play" onclick="spVoicePreviewToggle()">▶</button><div class="sp-wave sp-vm-wave" id="spv-wave" onclick="spVoicePreviewSeek(event)">' + spWaveHtml(spWfDecode(SPV.wf), SPV_BARS) + '</div><span class="sp-rec-time" id="spv-dur">' + spFmtDur(SPV.dur) + '</span><button class="sp-btn" id="spv-send" onclick="spVoiceSend()">➤</button>';
            }
        }
        async function spVoiceStart() {
            if (SPV.rec || SPV.blob) return;
            if (!spVoiceSupported()) { toast('متصفحك ما يدعم تسجيل الصوت'); return; }
            spVmStopAll();
            var stream;
            try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
            catch (e) { toast('اسمح للمايك من إعدادات المتصفح عشان تسجل رسالة صوتية'); return; }
            var mime = spVoicePickMime(), rec;
            try { rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream); }
            catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); toast('تعذر بدء التسجيل'); return; }
            SPV.stream = stream; SPV.rec = rec; SPV.chunks = []; SPV.samples = []; SPV.cancelled = false; SPV.blob = null;
            SPV.mime = String(rec.mimeType || mime || 'audio/webm').split(';')[0];
            rec.ondataavailable = function (e) { if (e.data && e.data.size) SPV.chunks.push(e.data); };
            rec.onstop = spVoiceOnStop;
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                SPV.ctx = new AC();
                if (SPV.ctx.resume) SPV.ctx.resume();
                var src = SPV.ctx.createMediaStreamSource(stream);
                SPV.an = SPV.ctx.createAnalyser(); SPV.an.fftSize = 512;
                src.connect(SPV.an);
            } catch (e) { SPV.an = null; }
            SPV.t0 = Date.now();
            rec.start(250);
            spVoicePaint('rec');
            SPV.timer = setInterval(spVoiceTick, 100);
        }
        function spVoiceTick() {
            var el = Date.now() - SPV.t0, v;
            if (SPV.an) {
                var buf = new Uint8Array(SPV.an.fftSize), sum = 0;
                SPV.an.getByteTimeDomainData(buf);
                for (var i = 0; i < buf.length; i++) { var d = (buf[i] - 128) / 128; sum += d * d; }
                v = Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.5);
            } else { v = 0.2 + Math.random() * 0.3; }
            SPV.samples.push(v);
            var t = document.getElementById('spv-time'); if (t) t.textContent = spFmtDur(el / 1000);
            var live = document.getElementById('spv-live');
            if (live) {
                var last = SPV.samples.slice(-SPV_LIVE_BARS), bars = live.children, off = SPV_LIVE_BARS - last.length;
                for (var k = 0; k < bars.length; k++) { var x = k - off; bars[k].style.height = Math.round(4 + (x >= 0 ? Math.max(0.05, last[x]) : 0.05) * 24) + 'px'; }
            }
            if (el >= SPV_MAX_SEC * 1000) spVoiceStop();
        }
        function spVoiceStop() { try { if (SPV.rec && SPV.rec.state !== 'inactive') SPV.rec.stop(); } catch (e) {} }
        function spVoiceRelease() {
            if (SPV.timer) { clearInterval(SPV.timer); SPV.timer = null; }
            try { if (SPV.stream) SPV.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            try { if (SPV.ctx) SPV.ctx.close(); } catch (e) {}
            SPV.stream = null; SPV.ctx = null; SPV.an = null;
        }
        function spVoiceOnStop() {
            var dur = (Date.now() - SPV.t0) / 1000;
            spVoiceRelease();
            SPV.rec = null;
            if (SPV.cancelled) { SPV.chunks = []; SPV.samples = []; return; }
            if (dur < 1 || !SPV.chunks.length) { SPV.chunks = []; SPV.samples = []; spVoicePaint(null); toast('التسجيل قصير'); return; }
            var blob = new Blob(SPV.chunks, { type: SPV.mime });
            SPV.chunks = [];
            if (blob.size > 3.8 * 1024 * 1024) { SPV.samples = []; spVoicePaint(null); toast('الرسالة الصوتية كبيرة، قصّر التسجيل'); return; }
            var n = 64, vals = [], mx = 0.05;
            for (var i = 0; i < n; i++) {
                var a = Math.floor(i * SPV.samples.length / n), b = Math.max(a + 1, Math.floor((i + 1) * SPV.samples.length / n)), sum = 0;
                for (var k = a; k < b; k++) sum += SPV.samples[k] || 0;
                var v = sum / (b - a); vals.push(v); if (v > mx) mx = v;
            }
            var bytes = vals.map(function (v) { return Math.max(18, Math.min(255, Math.round(v / mx * 255))); });
            SPV.wf = btoa(String.fromCharCode.apply(null, bytes));
            SPV.samples = [];
            SPV.blob = blob; SPV.dur = Math.min(SPV_MAX_SEC, Math.max(1, Math.round(dur)));
            spVoicePaint('preview');
        }
        function spVoiceCancel() {
            SPV.cancelled = true;
            if (SPV.rec && SPV.rec.state !== 'inactive') { try { SPV.rec.stop(); } catch (e) {} }
            spVoiceReset();
        }
        function spVoiceReset() {
            if (SPV.rec) { SPV.cancelled = true; try { if (SPV.rec.state !== 'inactive') SPV.rec.stop(); } catch (e) {} SPV.rec = null; }
            spVoiceRelease();
            if (SPV.pa) { try { SPV.pa.pause(); } catch (e) {} if (SPV.pa.src) { try { URL.revokeObjectURL(SPV.pa.src); } catch (e) {} } SPV.pa = null; }
            if (SPV.praf) { cancelAnimationFrame(SPV.praf); SPV.praf = null; }
            SPV.blob = null; SPV.chunks = []; SPV.samples = []; SPV.wf = ''; SPV.dur = 0;
            spVoicePaint(null);
        }
        function spVoicePreviewPaint(frac, playing) {
            var w = document.getElementById('spv-wave'), p = document.getElementById('spv-play'), d = document.getElementById('spv-dur');
            if (p) p.textContent = playing ? '⏸' : '▶';
            if (w) { var on = Math.round(frac * w.children.length); for (var i = 0; i < w.children.length; i++) w.children[i].className = i < on ? 'on' : ''; }
            if (d) d.textContent = spFmtDur(playing || frac > 0 ? frac * SPV.dur : SPV.dur);
        }
        function spVoicePreviewTick() {
            var a = SPV.pa; if (!a) return;
            spVoicePreviewPaint(Math.min(1, a.currentTime / SPV.dur), !a.paused);
            if (!a.paused) SPV.praf = requestAnimationFrame(spVoicePreviewTick);
        }
        function spVoicePreviewToggle() {
            if (!SPV.blob) return;
            if (!SPV.pa) {
                var a = new Audio(URL.createObjectURL(SPV.blob));
                a.onended = function () { a.currentTime = 0; spVoicePreviewPaint(0, false); };
                a.onpause = function () { spVoicePreviewTick(); };
                a.onplay = function () { spVoicePreviewTick(); };
                SPV.pa = a;
            }
            if (SPV.pa.paused) { spVmStopAll(); SPV.pa.play().catch(function () { toast('تعذر تشغيل التسجيل'); }); } else SPV.pa.pause();
        }
        function spVoicePreviewSeek(ev) {
            var w = document.getElementById('spv-wave'); if (!w || !SPV.blob) return;
            var r = w.getBoundingClientRect(), f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
            if (!SPV.pa) spVoicePreviewToggle();
            var a = SPV.pa; if (!a) return;
            try { a.currentTime = f * SPV.dur; } catch (e) {}
            spVoicePreviewPaint(f, !a.paused);
        }
        function spBlobToB64(blob) {
            return new Promise(function (res, rej) {
                var fr = new FileReader();
                fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
                fr.onerror = function () { rej(new Error('تعذر قراءة التسجيل')); };
                fr.readAsDataURL(blob);
            });
        }
        async function spVoiceSend() {
            var c = SP.cur; if (!c || !SPV.blob) return;
            var btn = document.getElementById('spv-send'); if (btn) btn.disabled = true;
            if (SPV.pa) { try { SPV.pa.pause(); } catch (e) {} }
            try {
                var b64 = await spBlobToB64(SPV.blob);
                await spApi('/api/support/tickets/' + c.id + '/messages', { method: 'POST', body: JSON.stringify({ audio: b64, audioMime: SPV.blob.type || SPV.mime, audioDuration: SPV.dur, audioWave: SPV.wf }) });
                spVoiceReset();
                await spLoadNew();
            } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
        }
        /* مشغّل الرسالة الصوتية داخل الشات */
        function spVoiceHtml(m, c) {
            var src = '/api/support/tickets/' + c.id + '/audio/' + m.i + '?gt=' + spGuestToken();
            return '<div class="sp-vm" data-src="' + spEsc(src) + '" data-dur="' + (m.dur || 0) + '">' +
                '<button class="sp-vm-play" onclick="spVmToggle(this.parentNode)">▶</button>' +
                '<div class="sp-wave sp-vm-wave" onclick="spVmSeek(event, this)">' + spWaveHtml(spWfDecode(m.wf), SPV_BARS) + '</div>' +
                '<span class="sp-vm-dur">' + spFmtDur(m.dur) + '</span>' +
                '<button class="sp-vm-speed" onclick="spVmSpeed(this.parentNode)">' + SPVP.rate + 'x</button></div>';
        }
        function spVmDur(box) { return parseFloat(box.getAttribute('data-dur')) || 0; }
        function spVmPaint(box, frac, playing) {
            if (!box) return;
            var p = box.querySelector('.sp-vm-play'), w = box.querySelector('.sp-vm-wave'), d = box.querySelector('.sp-vm-dur'), dur = spVmDur(box);
            if (p) p.textContent = playing ? '⏸' : '▶';
            if (w) { var on = Math.round(frac * w.children.length); for (var i = 0; i < w.children.length; i++) w.children[i].className = i < on ? 'on' : ''; }
            if (d) d.textContent = spFmtDur(playing || frac > 0 ? frac * dur : dur);
            var sp = box.querySelector('.sp-vm-speed'); if (sp) sp.textContent = SPVP.rate + 'x';
        }
        function spVmTick() {
            var a = SPVP.a, box = SPVP.el; if (!a || !box) return;
            var dur = spVmDur(box) || (isFinite(a.duration) ? a.duration : 0);
            spVmPaint(box, dur ? Math.min(1, a.currentTime / dur) : 0, !a.paused);
            if (!a.paused) SPVP.raf = requestAnimationFrame(spVmTick);
        }
        function spVmStopAll() {
            if (SPVP.raf) { cancelAnimationFrame(SPVP.raf); SPVP.raf = null; }
            if (SPVP.a) { try { SPVP.a.pause(); SPVP.a.removeAttribute('src'); SPVP.a.load(); } catch (e) {} }
            if (SPVP.el) spVmPaint(SPVP.el, 0, false);
            SPVP.a = null; SPVP.el = null;
        }
        function spVmToggle(box) {
            if (SPVP.a && SPVP.el === box) { if (SPVP.a.paused) SPVP.a.play().catch(function () {}); else SPVP.a.pause(); return; }
            spVmStopAll();
            if (SPV.pa && !SPV.pa.paused) SPV.pa.pause();
            var a = new Audio(box.getAttribute('data-src'));
            a.preload = 'auto'; a.playbackRate = SPVP.rate;
            a.onplay = function () { spVmTick(); };
            a.onpause = function () { spVmTick(); };
            a.onended = function () { a.currentTime = 0; spVmPaint(box, 0, false); };
            a.onerror = function () { toast('تعذر تشغيل الرسالة الصوتية'); if (SPVP.a === a) { SPVP.a = null; SPVP.el = null; } spVmPaint(box, 0, false); };
            SPVP.a = a; SPVP.el = box;
            a.play().catch(function () { toast('تعذر تشغيل الرسالة الصوتية'); });
        }
        function spVmSeek(ev, wave) {
            var box = wave.parentNode, r = wave.getBoundingClientRect(), f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), dur = spVmDur(box);
            if (!(SPVP.a && SPVP.el === box)) spVmToggle(box);
            var a = SPVP.a; if (!a || !dur) return;
            var go = function () { try { a.currentTime = f * dur; } catch (e) {} spVmPaint(box, f, !a.paused); };
            if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, { once: true });
        }
        function spVmSpeed(box) {
            SPVP.rate = SPVP.rate === 1 ? 1.5 : SPVP.rate === 1.5 ? 2 : 1;
            if (SPVP.a) SPVP.a.playbackRate = SPVP.rate;
            var sp = box.querySelector('.sp-vm-speed'); if (sp) sp.textContent = SPVP.rate + 'x';
        }

        /* ---------------- التقييم الإجباري + الردود الجاهزة + الملاحظات الداخلية ---------------- */
        var SPR = { n: 0 };
        function spRateHtml() {
            SPR.n = 0;
            return '<div style="font-weight:bold;">⭐ قيّم خدمة الدعم</div><div style="font-size:12px;color:var(--muted);margin-top:2px;">التقييم إجباري عشان تقدر تفتح تكت جديد</div>' +
                '<div class="sp-stars" id="sp-stars">' + [1, 2, 3, 4, 5].map(function (n) { return '<button onclick="spRateStar(' + n + ')">★</button>'; }).join('') + '</div>' +
                '<textarea id="sp-rate-c" class="sp-field" rows="2" maxlength="300" placeholder="تعليق (اختياري)" style="margin-bottom:8px;"></textarea>' +
                '<button class="sp-btn" id="sp-rate-go" disabled onclick="spRateSend()">إرسال التقييم</button>';
        }
        function spRateStar(n) {
            SPR.n = n;
            var b = document.getElementById('sp-stars').children;
            for (var i = 0; i < b.length; i++) b[i].className = i < n ? 'on' : '';
            document.getElementById('sp-rate-go').disabled = false;
        }
        async function spRateSend() {
            var c = SP.cur; if (!c || !SPR.n) return;
            var btn = document.getElementById('sp-rate-go'); if (btn) btn.disabled = true;
            try {
                var cm = document.getElementById('sp-rate-c');
                await spApi('/api/support/tickets/' + c.id + '/rate', { method: 'POST', body: JSON.stringify({ stars: SPR.n, comment: cm ? cm.value.trim() : '' }) });
                toast('🙏 شكراً لتقييمك');
                var rb = document.getElementById('sp-rate'); if (rb) { rb.style.display = 'none'; rb.innerHTML = ''; }
                await spLoadNew();
            } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
        }
        async function spRatingAdmin(uid, name) {
            var box = document.getElementById('spa-list'); if (!box) return;
            box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;">جارِ التحميل...</div>';
            try {
                var d = await spApi('/api/support/admin/ratings/' + encodeURIComponent(uid));
                var h = '<div class="sp-row" style="cursor:default;"><div class="t1"><span>🛡️ تقييمات ' + spEsc(name) + '</span><button class="sp-link" onclick="spLoadRatings()">‹ رجوع</button></div></div>';
                h += d.list.length ? d.list.map(function (r) {
                    return '<div class="sp-row" style="cursor:pointer;" data-id="' + spEsc(r.ticketId) + '" onclick="spOpenTicket(this.dataset.id, \\'admin\\', \\'spa-body\\')"><div class="t1"><span>#' + r.no + ' — ' + spEsc(r.name || '-') + '</span><span>' + '★'.repeat(r.stars) + '</span></div>' + (r.comment ? '<div class="t2">' + spEsc(r.comment) + '</div>' : '') + '<div class="t2">' + spEsc(r.category || '') + ' • ' + exFull(r.at) + ' • اضغط لفتح التكت</div></div>';
                }).join('') : '<div style="color:var(--muted);text-align:center;padding:24px;">ما فيه تقييمات</div>';
                box.innerHTML = h;
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;">' + spEsc(e.message) + '</div>'; }
        }
        async function spLoadRatings() {
            var box = document.getElementById('spa-list'); if (!box) return;
            try {
                var d = await spApi('/api/support/admin/ratings');
                if (!d.total) { box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;">ما فيه تقييمات للحين</div>'; return; }
                var html = '<div class="sp-row" style="cursor:default;"><div class="t1"><span>📊 الإجمالي</span><span>⭐ ' + d.avg.toFixed(2) + ' (' + d.total + ' تقييم)</span></div></div>';
                html += d.admins.map(function (a) {
                    var dist = [5, 4, 3, 2, 1].map(function (n) { return n + '★ ' + a.dist[n - 1]; }).join(' • ');
                    return '<div class="sp-row" style="cursor:pointer;" data-u="' + spEsc(a.uid) + '" data-n="' + spEsc(a.name) + '" onclick="spRatingAdmin(this.dataset.u, this.dataset.n)"><div class="t1"><span>🛡️ ' + spEsc(a.name) + '</span><span>⭐ ' + a.avg.toFixed(2) + ' (' + a.count + ')</span></div><div class="t2">' + dist + '</div></div>';
                }).join('');
                if (d.recent.length) {
                    html += '<div style="margin:12px 4px 6px;font-weight:bold;">💬 آخر التعليقات</div>' + d.recent.map(function (r) {
                        return '<div class="sp-row" style="cursor:default;"><div class="t1"><span>#' + r.no + ' — ' + spEsc(r.name || '-') + '</span><span>' + '★'.repeat(r.stars) + '</span></div><div class="t2">' + spEsc(r.comment) + '</div><div class="t2">الإداري: ' + spEsc(r.adminName || '-') + '</div></div>';
                    }).join('');
                }
                box.innerHTML = html;
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;">' + spEsc(e.message) + '</div>'; }
        }
        function spNoteToggle() {
            SP.noteMode = !SP.noteMode;
            var b = document.getElementById('sp-note-btn'), ta = document.getElementById('sp-in');
            if (b) b.className = 'sp-mic' + (SP.noteMode ? ' on' : '');
            if (ta) { ta.className = 'sp-field' + (SP.noteMode ? ' note-mode' : ''); ta.placeholder = SP.noteMode ? '📝 ملاحظة داخلية، الإدارة فقط تشوفها...' : 'اكتب رسالتك...'; ta.focus(); }
        }
        function spCannedClose() { var b = document.getElementById('sp-canned'); if (b) b.remove(); }
        async function spCannedOpen() {
            if (document.getElementById('sp-canned')) { spCannedClose(); return; }
            var comp = document.getElementById('sp-compose'); if (!comp) return;
            var box = document.createElement('div'); box.id = 'sp-canned'; box.className = 'sp-canned';
            box.innerHTML = '<div style="color:var(--muted);padding:10px;text-align:center;">جارِ التحميل...</div>';
            comp.parentNode.insertBefore(box, comp);
            await spCannedPaint();
        }
        async function spCannedPaint() {
            var box = document.getElementById('sp-canned'); if (!box) return;
            try {
                var d = await spApi('/api/support/admin/canned');
                SP.canned = d.list;
                var sen = !!(ME && ME.isSeniorAdmin);
                box.innerHTML = '<div class="sp-canned-h"><b>⚡ ردود جاهزة</b><button class="sp-link" onclick="spCannedClose()">✕</button></div>' +
                    (d.list.length ? d.list.map(function (r, i) {
                        return '<div class="sp-canned-r" onclick="spCannedUse(' + i + ')"><div><b>' + spEsc(r.title) + '</b><div style="font-size:12px;color:var(--muted);">' + spEsc(r.text) + '</div></div>' +
                            (sen ? '<button class="sp-link" style="color:#fca5a5;" onclick="event.stopPropagation();spCannedDel(&quot;' + r.id + '&quot;)">🗑️</button>' : '') + '</div>';
                    }).join('') : '<div style="padding:10px;color:var(--muted);">ما فيه ردود</div>') +
                    (sen ? '<button class="sp-btn" style="margin:8px;width:calc(100% - 16px);" onclick="spCannedAdd()">➕ إضافة رد جاهز</button>' : '');
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;padding:10px;">' + spEsc(e.message) + '</div>'; }
        }
        function spCannedUse(i) {
            var r = SP.canned && SP.canned[i]; if (!r) return;
            var ta = document.getElementById('sp-in'); if (!ta) return;
            ta.value = (ta.value ? ta.value + ' ' : '') + r.text;
            ta.dispatchEvent(new Event('input'));
            spCannedClose(); ta.focus();
        }
        async function spCannedAdd() {
            var title = await promptModal('عنوان الرد الجاهز'); if (!title || !title.trim()) return;
            var text = await promptModal('نص الرد'); if (!text || !text.trim()) return;
            try { await spApi('/api/support/admin/canned', { method: 'POST', body: JSON.stringify({ title: title.trim(), text: text.trim() }) }); toast('✅ تمت الإضافة'); spCannedPaint(); }
            catch (e) { toast(e.message); }
        }
        async function spCannedDel(id) {
            if (!(await confirmModal('تبي تحذف هذا الرد الجاهز؟'))) return;
            try { await spApi('/api/support/admin/canned/' + id, { method: 'DELETE' }); toast('🗑️ تم الحذف'); spCannedPaint(); }
            catch (e) { toast(e.message); }
        }
        async function spHuman() {
            var c = SP.cur; if (!c) return;
            try { await spApi('/api/support/tickets/' + c.id + '/human', { method: 'POST', body: '{}' }); toast('📨 تم إرسال طلبك للإدارة'); await spLoadNew(); }
            catch (e) { toast(e.message); }
        }
        async function spJoin() {
            var c = SP.cur; if (!c) return;
            try { await spApi('/api/support/admin/tickets/' + c.id + '/join', { method: 'POST', body: '{}' }); await spLoadNew(); }
            catch (e) { toast(e.message); }
        }
        async function spCloseTicket() {
            var c = SP.cur; if (!c) return;
            if (!(await confirmModal('تبي تسكّر هذا التكت؟'))) return;
            try { await spApi('/api/support/tickets/' + c.id + '/close', { method: 'POST', body: '{}' }); await spLoadNew(); }
            catch (e) { toast(e.message); }
        }

        async function spDeleteTicket() {
            var c = SP.cur; if (!c) return;
            if (!(await confirmModal('تبي تحذف هذا التكت نهائياً؟ ما يرجع بعد الحذف.'))) return;
            try { await spApi('/api/support/admin/tickets/' + c.id, { method: 'DELETE' }); toast('🗑️ تم حذف التكت'); spBack(); }
            catch (e) { toast(e.message); }
        }
        function spFmtDate(v) {
            try { return new Date(v).toLocaleString('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', year: 'numeric', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return '—'; }
        }
        function spInfoRowHtml(r) {
            if (r.at) return '<div class="sp-info-r"><span>' + spEsc(r.l) + (r.v && r.v !== '—' ? ' <small style="color:var(--muted);">— ' + spEsc(r.v) + '</small>' : '') + '</span><b>' + spEsc(spFmtDate(r.at)) + '</b></div>';
            return '<div class="sp-info-r"><span>' + spEsc(r.l) + '</span><b>' + spEsc(r.d ? spFmtDate(r.v) : r.v) + '</b></div>';
        }
        async function spLoadInfo() {
            var c = SP.cur; if (!c) return;
            var box = document.getElementById('sp-info'); if (!box) return;
            if (!c.shared || !c.shared.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
            box.style.display = 'block';
            if (!box.innerHTML) box.innerHTML = '<div style="font-size:12px;color:var(--muted);">جارِ التحميل...</div>';
            try {
                var d = await spApi('/api/support/tickets/' + c.id + '/info');
                if (SP.cur !== c) return;
                box = document.getElementById('sp-info'); if (!box) return;
                var adm = c.mode === 'admin';
                box.innerHTML = '<div class="sp-info-h"><b>🔎 ' + (adm ? 'المعروض للعضو' : 'معلومات من الإدارة') + '</b><button class="sp-link" style="font-size:12px;" onclick="spLoadInfo()">🔄 تحديث</button></div>' +
                    d.items.map(function (it) {
                        return '<div class="sp-info-c"><div class="sp-info-t">' + spEsc(it.title) + '</div>' + it.rows.map(spInfoRowHtml).join('') + '</div>';
                    }).join('');
            } catch (e) {
                box = document.getElementById('sp-info');
                if (box) box.innerHTML = '<div style="color:#fca5a5;font-size:12px;">' + spEsc(e.message) + '</div>';
            }
        }
        function spInspect() {
            var c = SP.cur; if (!c) return;
            c.insp = null;
            var cnt = {};
            (c.shared || []).forEach(function (k) { var q = spCatOf(k); cnt[q] = (cnt[q] || 0) + 1; });
            var box = document.getElementById('wf-box');
            box.innerHTML = '<h3>🔍 فحص العضو</h3>' +
                '<p style="font-size:12px;color:var(--muted);margin:0 0 8px;">اختر القسم، وبعدها تضغط على الخانة اللي تبي تظهر للعضو. ما يشوفها إلا العضو والإداري المستلم وكبار المسؤولين.</p>' +
                SP_INS_CATS.map(function (x) {
                    return '<button class="btn sm" style="width:100%;margin:4px 0;display:flex;justify-content:space-between;align-items:center;" data-c="' + x[0] + '" onclick="spInspectCat(this.dataset.c)"><span>' + x[1] + '</span>' + (cnt[x[0]] ? '<span style="color:#bbf7d0;">' + cnt[x[0]] + ' ظاهر</span>' : '') + '</button>';
                }).join('') +
                '<div class="wf-actions"><button class="btn danger sm" onclick="spInspectHideAll()">🙈 إخفاء الكل عن العضو</button><button class="btn gray sm" onclick="closeWarnForm()">إغلاق</button></div>';
            document.getElementById('wf-overlay').classList.add('open');
        }
        async function spInspectCat(cat) {
            var c = SP.cur; if (!c) return;
            var box = document.getElementById('wf-box');
            box.innerHTML = '<div style="padding:14px;color:var(--muted);">جارِ التحميل...</div>';
            try {
                var d = await spApi('/api/support/admin/tickets/' + c.id + '/inspect/' + cat);
                c.insp = { cat: cat, title: d.title, rows: d.rows };
                spInspectPaint();
            } catch (e) { toast(e.message); spInspect(); }
        }
        function spInspectPaint() {
            var c = SP.cur, I = c && c.insp; if (!I) return;
            var box = document.getElementById('wf-box'); if (!box) return;
            var sh = c.shared || [];
            var shownN = I.rows.filter(function (r) { return sh.indexOf(r.k) >= 0; }).length;
            var rows = I.rows.length ? I.rows.map(function (r) {
                var on = sh.indexOf(r.k) >= 0;
                var main = r.at
                    ? '<div style="font-size:12px;color:var(--muted);">' + spEsc(spFmtDate(r.at)) + '</div><div style="font-size:13px;word-break:break-word;"><b>' + spEsc(r.l) + '</b>' + (r.v && r.v !== '—' ? ' — ' + spEsc(r.v) : '') + '</div>'
                    : '<div style="font-size:12px;color:var(--muted);">' + spEsc(r.l) + '</div><div style="font-size:14px;word-break:break-word;">' + spEsc(r.d ? spFmtDate(r.v) : r.v) + '</div>';
                return '<div class="sp-ins-r' + (on ? ' on' : '') + '"><div style="flex:1;min-width:0;">' + main + '</div><button class="btn sm ' + (on ? 'danger' : '') + '" data-k="' + spEsc(r.k) + '" onclick="spInspectToggle(this.dataset.k)">' + (on ? '🙈 إخفاء' : '👁 إظهار') + '</button></div>';
            }).join('') : '<div style="color:var(--muted);font-size:13px;padding:10px 0;">ما فيه بيانات</div>';
            box.innerHTML = '<h3>' + spEsc(I.title) + '</h3>' +
                '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">اضغط على اللي تبي يشوفه العضو (' + shownN + ' من ' + I.rows.length + ' ظاهر)</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;"><button class="btn sm" onclick="spInspectAll(true)">👁 إظهار الكل</button><button class="btn sm gray" onclick="spInspectAll(false)">🙈 إخفاء الكل</button></div>' +
                '<div class="sp-ins-list">' + rows + '</div>' +
                '<div class="wf-actions"><button class="btn gray sm" onclick="spInspect()">‹ رجوع</button><button class="btn gray sm" onclick="closeWarnForm()">إغلاق</button></div>';
        }
        async function spShare(body) {
            var c = SP.cur; if (!c) return;
            try {
                var r = await spApi('/api/support/admin/tickets/' + c.id + '/share', { method: 'POST', body: JSON.stringify(body) });
                c.shared = r.shared || []; c.sharedKey = c.shared.join(',');
                if (c.insp) spInspectPaint();
                spLoadInfo();
            } catch (e) { toast(e.message); }
        }
        function spInspectToggle(k) {
            var c = SP.cur; if (!c) return;
            spShare((c.shared || []).indexOf(k) >= 0 ? { hide: [k] } : { show: [k] });
        }
        function spInspectAll(on) {
            var c = SP.cur; if (!c || !c.insp) return;
            var sh = c.shared || [];
            var keys = c.insp.rows.map(function (r) { return r.k; }).filter(function (k) { return on ? sh.indexOf(k) < 0 : sh.indexOf(k) >= 0; });
            if (!keys.length) return;
            spShare(on ? { show: keys } : { hide: keys });
        }
        async function spInspectHideAll() {
            var c = SP.cur; if (!c) return;
            if (!(c.shared || []).length) { toast('ما فيه شي ظاهر للعضو'); return; }
            c.insp = null;
            await spShare({ hide: (c.shared || []).slice() });
            spInspect();
        }
        function spTypingPing() {
            var c = SP.cur; if (!c) return;
            var ta = document.getElementById('sp-in'); if (!ta || !ta.value.trim()) return;
            if (c.t && (c.t.status === 'closed' || (c.t.status === 'ai' && c.mode === 'user'))) return;
            var now = Date.now();
            if (now - (c.pingAt || 0) < 2500) return;
            c.pingAt = now;
            spApi('/api/support/tickets/' + c.id + '/typing', { method: 'POST', body: '{}' }).catch(function () {});
        }
        function spPeerTyping(d) {
            var c = SP.cur; if (!c || c.id !== d.id) return;
            if (!c.peers) c.peers = {};
            c.peers[d.kind + '|' + d.name] = { name: d.name, tag: d.tag, kind: d.kind, t: Date.now() };
            spShowPeers();
            if (!c.peerT) c.peerT = setInterval(function () {
                if (SP.cur !== c) { clearInterval(c.peerT); c.peerT = null; return; }
                var now = Date.now(), any = false;
                Object.keys(c.peers).forEach(function (k) { if (now - c.peers[k].t > 4500) delete c.peers[k]; else any = true; });
                spShowPeers();
                if (!any) { clearInterval(c.peerT); c.peerT = null; }
            }, 1000);
        }
        function spShowPeers() {
            var c = SP.cur, box = document.getElementById('sp-msgs'); if (!c || !box) return;
            var old = document.getElementById('sp-peers');
            var keys = Object.keys(c.peers || {});
            if (!keys.length) { if (old) old.remove(); return; }
            var near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
            var html = keys.map(function (k) {
                var p = c.peers[k], cls = p.kind === 'senior' ? 'senior' : p.kind === 'admin' ? 'admin' : 'member';
                return '<div class="sp-peer"><span class="sp-peer-n">' + spEsc(p.name) + '</span><span class="sp-role ' + cls + '">' + spEsc(p.tag) + '</span><span>يكتب</span><span class="sp-dots"><span></span><span></span><span></span></span></div>';
            }).join('');
            if (old) old.innerHTML = html; else box.insertAdjacentHTML('beforeend', '<div id="sp-peers" class="sp-peers">' + html + '</div>');
            if (near) box.scrollTop = box.scrollHeight;
        }
        async function spBanUser() {
            var c = SP.cur; if (!c) return;
            var reason = await _fmOpen('حظر هذا المستخدم من الدعم الفني (حسابه وجهازه)؟ اكتب السبب (اختياري):', { isPrompt: true, okText: 'حظر' });
            if (reason === null) return;
            try { await spApi('/api/support/admin/tickets/' + c.id + '/ban', { method: 'POST', body: JSON.stringify({ reason: reason }) }); toast('🚫 تم حظر المستخدم من الدعم'); await spLoadNew(); }
            catch (e) { toast(e.message); }
        }
        async function spLoadBans() {
            var box = document.getElementById('spa-list'); if (!box) return;
            try {
                var d = await spApi('/api/support/admin/bans');
                if (!d.bans.length) { box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;">ما فيه محظورين</div>'; return; }
                box.innerHTML = d.bans.map(function (b) {
                    return '<div class="sp-row" style="cursor:default;"><div class="t1"><span>🚫 ' + spEsc(b.name || '-') + (b.guest ? ' (زائر)' : '') + '</span><button class="sp-link" style="color:#86efac;" onclick="spUnban(&quot;' + b.id + '&quot;)">فك الحظر</button></div>' +
                        '<div class="t2">' + (b.reason ? 'السبب: ' + spEsc(b.reason) : 'بدون سبب') + '</div>' +
                        '<div class="t2">بواسطة ' + spEsc(b.by || '-') + '</div></div>';
                }).join('');
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;">' + spEsc(e.message) + '</div>'; }
        }
        async function spUnban(id) {
            if (!(await confirmModal('تبي تفك الحظر عن هذا المستخدم؟'))) return;
            try { await spApi('/api/support/admin/bans/' + id, { method: 'DELETE' }); toast('✅ تم فك الحظر'); spLoadBans(); }
            catch (e) { toast(e.message); }
        }
        async function spDeleteRow(id) {
            if (!(await confirmModal('تبي تحذف هذا التكت نهائياً؟ ما يرجع بعد الحذف.'))) return;
            try { await spApi('/api/support/admin/tickets/' + id, { method: 'DELETE' }); toast('🗑️ تم حذف التكت'); spaLoadList(); }
            catch (e) { toast(e.message); }
        }
        async function spDeleteAllClosed() {
            if (!(await confirmModal('تبي تحذف كل التكتات المغلقة نهائياً؟ ما ترجع بعد الحذف.'))) return;
            try { var d = await spApi('/api/support/admin/closed', { method: 'DELETE' }); toast('🗑️ انحذف ' + (d.deleted || 0) + ' تكت'); spaLoadList(); }
            catch (e) { toast(e.message); }
        }
        function spaShowList() {
            SP.cur = null; SP.img = null;
            var senior = !!(ME && ME.isSeniorAdmin);
            var tabs = senior ? [['waiting', '⏳ انتظار الإدارة'], ['active', '✅ قيد المتابعة'], ['ai', '🤖 عند المساعد'], ['closed', '🔒 مغلقة'], ['rates', '⭐ التقييمات'], ['bans', '🚫 المحظورين']] : [['waiting', '⏳ انتظار الإدارة']];
            if (!senior) SP.atab = 'waiting';
            document.getElementById('spa-tabs').innerHTML = tabs.map(function (t) {
                return '<button class="sp-tab ' + (SP.atab === t[0] ? 'on' : '') + '" onclick="SP.atab=&quot;' + t[0] + '&quot;;spaShowList()">' + t[1] + '</button>';
            }).join('');
            document.getElementById('spa-body').innerHTML = '<div id="spa-list"><div style="color:var(--muted);text-align:center;padding:20px;">جارِ التحميل...</div></div>';
            spaLoadList();
        }
        async function spaLoadList() {
            var box = document.getElementById('spa-list'); if (!box) return;
            if (SP.atab === 'bans') return spLoadBans();
            if (SP.atab === 'rates') return spLoadRatings();
            try {
                var d = await spApi('/api/support/admin/tickets?status=' + SP.atab);
                if (!d.tickets.length) { box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;">ما فيه تكتات هنا</div>'; return; }
                var canDel = !!(ME && ME.isSeniorAdmin) && SP.atab === 'closed';
                box.innerHTML = (canDel ? '<button class="sp-btn" style="margin-bottom:12px;background:#b91c1c;" onclick="spDeleteAllClosed()">🗑️ حذف كل التكتات المغلقة</button>' : '') + d.tickets.map(function (t) {
                    return '<div class="sp-row" onclick="spOpenTicket(&quot;' + t.id + '&quot;,&quot;admin&quot;,&quot;spa-body&quot;)">' +
                        '<div class="t1"><span>#' + t.no + ' — ' + spEsc(t.name) + (t.guest ? ' (زائر)' : '') + (t.unread ? '<span class="sp-badge">' + t.unread + '</span>' : '') + '</span><span class="sp-chip ' + t.status + '">' + SP_ST[t.status] + (t.adminName ? ' — ' + spEsc(t.adminName) : '') + '</span></div>' +
                        '<div class="t2">' + spEsc(t.category) + (t.place ? ' • ' + spEsc(t.place) : '') + '</div>' +
                        '<div class="t2">' + spEsc(t.last || '') + '</div>' +
                        (canDel ? '<div style="margin-top:8px;"><button class="sp-link" style="color:#fca5a5;" onclick="event.stopPropagation();spDeleteRow(&quot;' + t.id + '&quot;)">🗑️ حذف</button></div>' : '') +
                        '</div>';
                }).join('');
            } catch (e) { box.innerHTML = '<div style="color:#fca5a5;">' + spEsc(e.message) + '</div>'; }
        }

        // ═══════════ بطاقة بنك فلاش الجديدة ═══════════
        var FBC_THEMES = {
            blue:   { c1: '#1e40af', c2: '#0b1b44', ac: '#93c5fd' },
            green:  { c1: '#15803d', c2: '#052e16', ac: '#86efac' },
            red:    { c1: '#b91c1c', c2: '#3b0a0a', ac: '#fca5a5' },
            gold:   { c1: '#b45309', c2: '#3b1d03', ac: '#fde68a' },
            purple: { c1: '#6d28d9', c2: '#1e0a4a', ac: '#c4b5fd' },
            black:  { c1: '#334155', c2: '#020617', ac: '#cbd5e1' }
        };
        function fbcFlip(el) { el.classList.toggle('flip'); }
        function fbcEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        function bankCardHtml(c, o) {
            o = o || {};
            var th = FBC_THEMES[c.cardColor] || FBC_THEMES.blue;
            var exp = o.expiryStr || (c.cardExpiry ? new Date(c.cardExpiry).toLocaleDateString('en-US', { month: '2-digit', year: '2-digit' }) : '--/--');
            var cvv = o.hideCvv ? '•••' : fbcEsc(c.cardCVV || '---');
            var logo = '<svg viewBox="0 0 100 100" width="34" height="34"><defs><linearGradient id="fbcg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef08a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="rgba(255,255,255,.10)" stroke="rgba(255,255,255,.6)" stroke-width="3"/><path d="M57 10 28 55h19l-7 35 32-47H52z" fill="url(#fbcg)"/></svg>';
            var chip = '<svg viewBox="0 0 50 38" width="46" height="35"><rect width="50" height="38" rx="7" fill="#e5c76b"/><rect x="1.5" y="1.5" width="47" height="35" rx="6" fill="none" stroke="rgba(0,0,0,.25)"/><path d="M0 13h14M0 25h14M36 13h14M36 25h14M14 0v38M36 0v38M14 19h22" stroke="rgba(0,0,0,.35)" fill="none"/></svg>';
            var wifi = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linecap="round"><path d="M8.5 15.5a5 5 0 0 1 0-7"/><path d="M12 18.5a9 9 0 0 0 0-13"/><path d="M15.5 21.5a13 13 0 0 0 0-19"/></svg>';
            var frozen = c.cardFrozen ? '<div class="fbc-frozen">🔒 مجمّدة</div>' : '';
            return '<div class="fbc-wrap"><div class="fbc" style="--c1:' + th.c1 + ';--c2:' + th.c2 + ';--ac:' + th.ac + ';" onclick="fbcFlip(this)">' +
                '<div class="fbc-face fbc-front"><div class="fbc-shine"></div>' + frozen +
                '<div class="fbc-top"><div class="fbc-brand">' + logo + '<div><b>FLASH BANK</b><small>بنك فلاش</small></div></div>' + wifi + '</div>' +
                '<div class="fbc-chip">' + chip + '<span>DEBIT</span></div>' +
                '<div class="fbc-num">' + fbcEsc(c.cardNumber || '#### #### #### ####') + '</div>' +
                '<div class="fbc-bot"><div><small>CARD HOLDER</small><div class="fbc-hn">' + fbcEsc(c.cardHolderName || '---') + '</div></div>' +
                '<div><small>EXPIRES</small><div style="' + (o.expired ? 'color:#fca5a5;' : '') + '">' + exp + '</div></div></div></div>' +
                '<div class="fbc-face fbc-back"><div class="fbc-strip"></div>' +
                '<div class="fbc-sign"><div class="fbc-sigbox">⚡ FLASH BANK</div><div class="fbc-cvv"><small>CVV</small><b>' + cvv + '</b></div></div>' +
                '<div class="fbc-note">🔒 الرقم السري غير مطبوع على البطاقة ولا يعرفه أحد، احفظه في ذاكرتك.</div>' +
                '<div class="fbc-tap">اضغط لقلب البطاقة</div></div>' +
                '</div></div>';
        }
        async function ccResetPin(id) {
            if (!(await uiConfirm('تبي تعيد تعيين الرقم السري لهذه البطاقة؟', { title: '🔄 إعادة تعيين الرقم السري', okText: 'نعم، أعد التعيين', detail: 'الرقم القديم يتمسح، والعضو يحط رقم جديد بنفسه. الرقم السري ما يظهر لأحد.' }))) return;
            const res = await fetch('/api/superadmin/cards/' + id + '/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            showMsg('cc-msg-' + id, data.msg, data.success ? 'success' : 'danger');
            if (data.success) loadCardControlPanel();
        }


        // ═══════════ سجل البنك: حذف شامل مرة وحدة + المالك يحذف سجل بالسحب لليمين ═══════════
        let bankLogAllowClear = false, bankLogCanDeleteEach = false;
        async function loadBankLog() {
            const res = await fetch('/api/superadmin/logs');
            const data = await res.json();
            const logs = (data && data.list) || [];
            bankLogAllowClear = !!(data && data.logClearAvailable);
            bankLogCanDeleteEach = !!(data && data.canDeleteEach);
            const container = document.getElementById('bank-log-container');
            const clearBox = bankLogAllowClear
                ? '<div class="card" style="border-color:#7f1d1d; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;"><div><b style="color:#f87171;">🗑️ حذف اللوق الشامل</b><div style="font-size:0.8rem; color:#94a3b8; margin-top:3px;">يشتغل مرة وحدة بس، وبعدها الزر يختفي.</div></div><button class="btn btn-red" onclick="clearAllBankLogs()">🗑️ حذف الكل</button></div>'
                : '';
            if (!logs.length) { container.innerHTML = clearBox + '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد أحداث مسجلة.</p>'; return; }
            const actionColor = { register: '#4ade80', transfer: '#60a5fa', transfer_fee: '#94a3b8', loan_approve: '#4ade80', loan_reject: '#fca5a5', card_approve: '#4ade80', card_reject: '#fca5a5', manual_deposit: '#4ade80', manual_deduct: '#fca5a5', card_pin_reset: '#fde047', clear_log: '#f87171' };
            container.innerHTML = clearBox + logs.map(function (l) {
                var col = actionColor[l.action] || '#64748b';
                return '<div class="blog-item" data-lid="' + l._id + '" style="padding:8px 12px; border-right:3px solid ' + col + '; background:rgba(255,255,255,0.02); border-radius:6px; margin-bottom:6px;">' +
                    '<div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:4px;"><span style="color:' + col + '; font-size:0.8rem; font-weight:bold;">' + String(l.action || '').replace(/_/g, ' ').toUpperCase() + '</span>' +
                    '<span style="color:#475569; font-size:0.75rem;">' + new Date(l.createdAt).toLocaleString('ar-SA') + '</span></div>' +
                    '<p style="font-size:0.83rem; margin-top:3px;">' + fbcEsc(l.description) + '</p>' +
                    (l.performedByTag ? '<p style="color:#64748b; font-size:0.75rem; margin-top:2px;">بواسطة: ' + fbcEsc(l.performedByTag) + '</p>' : '') + '</div>';
            }).join('');
            if (bankLogCanDeleteEach) bindBankLogSwipe(container);
        }
        async function clearAllBankLogs() {
            if (!(await uiConfirm('بيتحذف كل اللوق الشامل نهائياً، والزر ما يرجع بعدها. متأكد؟', { title: '🗑️ حذف اللوق الشامل', danger: true, okText: 'نعم، احذف الكل' }))) return;
            const res = await fetch('/api/superadmin/logs/clear', { method: 'POST' });
            const data = await res.json();
            if (data.success) { uiToast('تم حذف اللوق الشامل', 'success'); } else { uiToast(data.msg || 'تعذر الحذف', 'danger'); }
            loadBankLog();
        }
        function bindBankLogSwipe(container) {
            Array.prototype.forEach.call(container.querySelectorAll('.blog-item[data-lid]'), function (el) {
                var sx = 0, sy = 0, dx = 0, on = false;
                el.style.touchAction = 'pan-y';
                el.addEventListener('pointerdown', function (e) { on = true; sx = e.clientX; sy = e.clientY; dx = 0; el.style.transition = 'none'; try { el.setPointerCapture(e.pointerId); } catch (x) {} });
                el.addEventListener('pointermove', function (e) {
                    if (!on) return;
                    dx = e.clientX - sx;
                    if (Math.abs(e.clientY - sy) > Math.abs(dx) + 12) { on = false; el.style.transform = ''; el.style.opacity = ''; return; }
                    if (dx > 0) { el.style.transform = 'translateX(' + dx + 'px)'; el.style.opacity = String(Math.max(0.25, 1 - dx / 300)); }
                });
                var end = async function () {
                    if (!on) return;
                    on = false;
                    el.style.transition = 'transform .2s, opacity .2s';
                    if (dx < 120) { el.style.transform = ''; el.style.opacity = ''; return; }
                    el.style.transform = 'translateX(110%)'; el.style.opacity = '0';
                    try {
                        const r = await fetch('/api/superadmin/logs/' + el.dataset.lid, { method: 'DELETE' });
                        const d = await r.json();
                        if (!d.success) throw new Error(d.msg || 'تعذر الحذف');
                        setTimeout(function () { el.remove(); }, 200);
                    } catch (e) { el.style.transform = ''; el.style.opacity = ''; uiToast(e.message, 'danger'); }
                };
                el.addEventListener('pointerup', end);
                el.addEventListener('pointercancel', end);
            });
        }


        // ═══════════ الملفات البنكية (كبار المسؤولين) ═══════════
        var profTimer = null;
        function fmtMoney(n) { return (Number(n) || 0).toLocaleString('en-US') + ' $'; }
        function fmtDT(d) { try { return new Date(d).toLocaleString('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return '—'; } }
        function loadProfilesPanel() {
            var box = document.getElementById('profiles-container');
            box.innerHTML = '<div class="card card-blue"><h2>🗂️ الملفات البنكية</h2><p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">ابحث باسم العضو أو رقم حسابه أو رقم بطاقته أو رتبته، ويطلع لك ملفه البنكي كامل.</p>' +
                '<input id="prof-q" placeholder="🔍 اسم / رقم حساب / رقم بطاقة / رتبة" autocomplete="off" oninput="profSearchSoon()" /><div id="prof-results"></div></div><div id="prof-view"></div>';
        }
        function profSearchSoon() { clearTimeout(profTimer); profTimer = setTimeout(profSearch, 300); }
        async function profSearch() {
            var q = (document.getElementById('prof-q') || {}).value || '';
            var box = document.getElementById('prof-results'); if (!box) return;
            if (q.trim().length < 2) { box.innerHTML = ''; return; }
            box.innerHTML = '<p style="color:#64748b; padding:8px;">جارِ البحث...</p>';
            try {
                var res = await fetch('/api/senior/profiles?q=' + encodeURIComponent(q.trim()));
                var list = await res.json();
                if (!list.length) { box.innerHTML = '<p style="color:#64748b; padding:8px;">ما فيه نتائج.</p>'; return; }
                box.innerHTML = list.map(function (a) {
                    return '<div class="prof-row" data-uid="' + fbcEsc(a.uid) + '" onclick="loadProfile(this.dataset.uid)"><div><b>' + fbcEsc(a.name) + '</b> <span style="color:#64748b; font-size:0.78rem;">#' + fbcEsc(a.accountNumber) + '</span>' + (a.frozen ? ' <span class="frozen-badge">مجمّد</span>' : '') +
                        '<div style="color:#94a3b8; font-size:0.78rem;">' + fbcEsc(a.rank || '—') + (a.unit ? ' • ' + fbcEsc(a.unit) : '') + (a.cards ? ' • 💳 ' + a.cards : '') + '</div></div><b style="color:#4ade80;">' + fmtMoney(a.balance) + '</b></div>';
                }).join('');
            } catch (e) { box.innerHTML = '<p style="color:#fca5a5;">تعذر البحث</p>'; }
        }
        function profTxRow(t) {
            var inn = t.dir === 'in';
            var labels = { transfer: 'حوالة', deposit: 'إيداع', withdraw: 'خصم', loan_receive: 'استلام قرض', loan_pay: 'سداد قرض', savings_deposit: 'إيداع توفير', savings_withdraw: 'سحب توفير', interest: 'فائدة', transfer_fee: 'رسوم تحويل', card_renewal_fee: 'رسوم تجديد بطاقة', violation_payment: 'سداد مخالفة' };
            return '<div class="prof-tx"><div><b style="color:' + (inn ? '#4ade80' : '#f87171') + ';">' + (inn ? '⬇️ وارد' : '⬆️ صادر') + '</b> ' + fbcEsc(labels[t.type] || t.type) +
                (t.otherName ? ' <span style="color:#94a3b8;">' + (inn ? 'من ' : 'إلى ') + fbcEsc(t.otherName) + '</span>' : '') +
                (t.note ? '<div style="color:#64748b; font-size:0.75rem;">' + fbcEsc(t.note) + '</div>' : '') + '</div>' +
                '<div style="text-align:left;"><b style="color:' + (inn ? '#4ade80' : '#f87171') + ';">' + (inn ? '+' : '-') + fmtMoney(t.amount) + '</b><div style="color:#475569; font-size:0.72rem;">' + fmtDT(t.at) + '</div></div></div>';
        }
        function profLastBox(title, t, color) {
            if (!t) return '<div class="prof-last" style="border-color:#334155;"><small>' + title + '</small><div style="color:#64748b;">ما فيه</div></div>';
            return '<div class="prof-last" style="border-color:' + color + ';"><small>' + title + '</small><b style="color:' + color + '; font-size:1.1rem;">' + fmtMoney(t.amount) + '</b><div style="font-size:0.78rem;">' + (t.dir === 'in' ? 'من ' : 'إلى ') + fbcEsc(t.otherName || t.otherAccount || '—') + '</div><div style="color:#64748b; font-size:0.72rem;">' + fmtDT(t.at) + '</div></div>';
        }
        async function loadProfile(uid) {
            var view = document.getElementById('prof-view'); if (!view) return;
            view.innerHTML = '<div class="card">جارِ تحميل الملف...</div>';
            try {
                var res = await fetch('/api/senior/profile/' + encodeURIComponent(uid));
                var p = await res.json();
                if (!p.success) { view.innerHTML = '<div class="card" style="color:#fca5a5;">' + fbcEsc(p.msg || 'تعذر التحميل') + '</div>'; return; }
                var a = p.account, f = p.flash;
                var roleNames = { user: 'عضو', staff: 'موظف', management: 'إدارة', admin: 'رئيس بنك', super_admin: 'كبار المسؤولين' };
                var h = '<div class="card card-blue"><div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;"><div><h2 style="border:none; margin:0 0 4px;">👤 ' + fbcEsc(a.name) + '</h2>' +
                    '<div style="color:#94a3b8; font-size:0.85rem;">رقم الحساب: <b style="color:#e2e8f0;">' + fbcEsc(a.accountNumber) + '</b> • الصفة: ' + fbcEsc(roleNames[a.role] || a.role) + '</div>' +
                    (f ? '<div style="color:#94a3b8; font-size:0.85rem;">⚡ فلاش: ' + fbcEsc(f.name || '') + ' • الرتبة: ' + fbcEsc(f.rank || '—') + ' • اليونت: ' + fbcEsc(f.unit || '—') + '</div>' : '') + '</div>' +
                    (a.frozen ? '<span class="frozen-badge">🔒 الحساب مجمّد</span>' : '<span style="color:#4ade80; font-size:0.85rem;">✅ الحساب نشط</span>') + '</div></div>';
                h += '<div class="card"><h2>🏦 حسابه البنكي الحين</h2><div class="prof-grid">' +
                    '<div class="prof-stat"><small>الرصيد</small><b style="color:#4ade80;">' + fmtMoney(a.balance) + '</b></div>' +
                    '<div class="prof-stat"><small>التوفير</small><b style="color:#60a5fa;">' + fmtMoney(a.savings) + '</b></div>' +
                    '<div class="prof-stat"><small>إجمالي الوارد (حوالات)</small><b>' + fmtMoney(p.totals.in.total) + '</b><em>' + p.totals.in.n + ' حوالة</em></div>' +
                    '<div class="prof-stat"><small>إجمالي الصادر (حوالات)</small><b>' + fmtMoney(p.totals.out.total) + '</b><em>' + p.totals.out.n + ' حوالة</em></div>' +
                    '<div class="prof-stat"><small>فُتح الحساب</small><b style="font-size:0.85rem;">' + fmtDT(a.createdAt) + '</b></div>' +
                    '<div class="prof-stat"><small>حد البطاقات</small><b>' + a.cardLimitEffective + '</b><em>' + (a.cardLimit === -1 ? 'حسب الإعداد العام' : 'مخصص') + '</em></div>' +
                    '<div class="prof-stat"><small>حظر الدعم</small><b>' + (a.supportBanned ? '🚫 محظور' : 'لا') + '</b></div>' +
                    '<div class="prof-stat"><small>تكتاته</small><b>' + p.tickets.total + '</b><em>' + p.tickets.open + ' مفتوح</em></div></div></div>';
                h += '<div class="card"><h2>💳 البطاقات</h2>';
                var shown = p.cards.filter(function (c) { return c.status === 'approved' || c.status === 'disabled'; });
                if (!shown.length) h += '<p style="color:#64748b;">ما عنده بطاقة مفعّلة.</p>';
                shown.forEach(function (c) {
                    var st = c.status === 'disabled' ? '🚫 معطّلة من الإدارة' : (c.cardFrozen ? '🔒 مجمّدة' : '✅ مفعّلة');
                    h += '<div style="margin-bottom:18px;">' + bankCardHtml(c, { hideCvv: true }) +
                        '<div class="prof-cardinfo"><span>الحالة: <b>' + st + '</b></span><span>رقم البطاقة: <b dir="ltr">' + fbcEsc(c.cardNumber) + '</b></span><span>الحامل: <b>' + fbcEsc(c.cardHolderName) + '</b></span>' +
                        '<span>الانتهاء: <b>' + (c.cardExpiry ? new Date(c.cardExpiry).toLocaleDateString('ar-SA-u-ca-gregory') : 'غير محدد') + '</b></span><span>اللون: <b>' + fbcEsc(c.cardColor) + '</b></span>' +
                        '<span>الرقم السري: <b>' + (c.pinSet ? '🔒 معيّن (مخفي — ما أحد يعرفه)' : 'لم يُعيَّن بعد') + '</b></span><span>رتبته في الطلب: <b>' + fbcEsc(c.militaryRank || '—') + ' / ' + fbcEsc(c.militarySector || '—') + '</b></span></div></div>';
                });
                var others = p.cards.filter(function (c) { return c.status !== 'approved' && c.status !== 'disabled'; });
                if (others.length) h += '<p style="color:#64748b; font-size:0.8rem;">طلبات أخرى: ' + others.map(function (c) { return ({ pending: 'معلّق', rejected: 'مرفوض', expired: 'منتهي' }[c.status] || c.status); }).join('، ') + '</p>';
                h += '</div>';
                h += '<div class="card"><h2>💸 آخر حوالة</h2><div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' + profLastBox('⬇️ آخر حوالة واردة', p.lastIn, '#4ade80') + profLastBox('⬆️ آخر حوالة صادرة', p.lastOut, '#f87171') + '</div></div>';
                if (p.loans.length) h += '<div class="card"><h2>📋 القروض</h2>' + p.loans.map(function (l) { return '<div class="prof-tx"><div>' + (l.status === 'pending' ? '⏳ معلّق' : '✅ شغّال') + ' — ' + fmtMoney(l.amount) + '</div><div>المتبقي: <b>' + fmtMoney(l.remaining) + '</b></div></div>'; }).join('') + '</div>';
                h += '<div class="card"><h2>📜 سجل الحوالات والحركات (آخر ' + p.transfers.length + ')</h2>' + (p.transfers.length ? p.transfers.map(profTxRow).join('') : '<p style="color:#64748b;">ما فيه حركات.</p>') + '</div>';
                view.innerHTML = h;
                view.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (e) { view.innerHTML = '<div class="card" style="color:#fca5a5;">تعذر تحميل الملف</div>'; }
        }


        // ═══════════ التحديث التلقائي (بولنق) ═══════════
        function silentRefreshCurrentPage() {
            try {
                if (document.hidden) { pendingSilentRefresh = true; return; }
                const ae = document.activeElement;
                const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
                let modalOpen = false;
                document.querySelectorAll('.custom-modal').forEach(function(m) { if (getComputedStyle(m).display !== 'none') modalOpen = true; });
                if (document.getElementById('sp-modal').classList.contains('open')) modalOpen = true;
                if (typing || modalOpen) { pendingSilentRefresh = true; return; }
                pendingSilentRefresh = false;
                const pg = document.querySelector('.page.active');
                if (!pg) return;
                const id = pg.id.replace('page-', '');
                loadNotifCount();
                if (id === 'dashboard' || id === 'savings') loadDashboard();
                else if (id === 'loans') { loadLoanInfo(); loadDashboard(); }
                else if (id === 'history') loadHistory();
                else if (id === 'notifications') loadNotifications();
                else if (id === 'cards') loadMyCards();
                else if (id === 'transfer') loadDashboard();
            } catch (e) {}
        }
        document.addEventListener('visibilitychange', function() { if (!document.hidden && pendingSilentRefresh) silentRefreshCurrentPage(); });

        function startUserPolling() {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const res = await fetch('/api/poll/user');
                    const data = await res.json();
                    if (!data || Object.keys(data).length === 0) return;
                    if (data.unreadCount !== undefined && data.unreadCount !== lastUnreadCount) {
                        lastUnreadCount = data.unreadCount;
                        loadNotifCount();
                    }
                    if (data.latestUnreadId !== undefined) handleNotifPush(data.latestUnreadId);
                    if (currentAccount && (data.balance !== undefined || data.isFrozen !== undefined)) {
                        const changed = currentAccount.balance !== data.balance
                            || currentAccount.savingsBalance !== data.savingsBalance
                            || currentAccount.isFrozen !== data.isFrozen;
                        currentAccount.balance = data.balance;
                        currentAccount.savingsBalance = data.savingsBalance;
                        currentAccount.isFrozen = data.isFrozen;
                        if (changed) loadDashboard();
                    }
                    if (data.lastTicketActivity && lastSeenTicketActivity && data.lastTicketActivity !== lastSeenTicketActivity) {
                        spBadges();
                        if (SP.cur) spLoadNew();
                        else if (document.getElementById('sp-list')) spLoadList();
                    }
                    if (data.lastTicketActivity) lastSeenTicketActivity = data.lastTicketActivity;
                    if (data.lastActivity) {
                        if (lastSeenActivity && data.lastActivity !== lastSeenActivity) silentRefreshCurrentPage();
                        lastSeenActivity = data.lastActivity;
                    }
                    if (pendingSilentRefresh) silentRefreshCurrentPage();
                } catch(e) {}
            }, 2000);
        }

        function startAdminPolling() {
            if (adminPollInterval) clearInterval(adminPollInterval);
            adminPollInterval = setInterval(async () => {
                try {
                    const res = await fetch('/api/poll/admin');
                    const data = await res.json();
                    if (!data || Object.keys(data).length === 0) return;
                    const supportTab = document.getElementById('atab-support');
                    if (supportTab) supportTab.textContent = data.openTickets > 0 ? ('🎧 الدعم (' + data.openTickets + ')') : '🎧 الدعم';
                    const ticketActivityChanged = data.lastTicketActivity && lastSeenAdminTicketActivity && data.lastTicketActivity !== lastSeenAdminTicketActivity;
                    if (ticketActivityChanged) {
                        spBadges();
                        if (SP.cur) spLoadNew();
                        else if (document.getElementById('spa-list')) spaLoadList();
                    }
                    const activityChanged = data.lastActivity && lastSeenAdminActivity && data.lastActivity !== lastSeenAdminActivity;
                    if (activityChanged) {
                        const vis = function (id) { const e = document.getElementById(id); return e && e.style.display !== 'none'; };
                        if (vis('atab-accounts-section') && typeof loadAdminAccounts === 'function') loadAdminAccounts();
                        if (vis('atab-loans-section') && typeof loadAdminLoans === 'function') loadAdminLoans();
                        if (vis('atab-cards-section') && typeof loadAdminCards === 'function') loadAdminCards();
                        if (vis('atab-bank-log-section') && typeof loadBankLog === 'function') loadBankLog();
                    }
                    if (data.lastActivity) lastSeenAdminActivity = data.lastActivity;
                    if (data.lastTicketActivity) lastSeenAdminTicketActivity = data.lastTicketActivity;
                } catch(e) {}
            }, 2000);
        }

        init();
    </script>

<footer style="text-align: center; padding: 1.5rem; margin-top: 2rem; border-top: 1px solid rgba(59,130,246,0.2); background: rgba(5,15,30,0.8); color: #475569; font-size: 0.9rem;">
    <p>جميع الحقوق محفوظة © 2026 | <span style="color: #3b82f6; font-weight: bold;">بنك فلاش — Flash Bank</span></p>
</footer>
</body>
</html>`);
});

// معالج أخطاء عام (بدل صفحة "Internal Server Error" الفاضية) + تسجيل أي خطأ غير ملتقط في اللوق
app.use((err, req, res, next) => {
    console.error('❌ خطأ في السيرفر:', err && err.message ? err.message : err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, msg: 'خطأ داخلي في السيرفر' });
    res.status(500).send(ssoPage('صار خطأ مؤقت في البنك. جرّب مرة ثانية من فلاش.', flashHome(req)));
});
process.on('unhandledRejection', (e) => console.error('❌ unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('❌ uncaughtException:', e && e.message ? e.message : e));

const PORT = process.env.PORT || 7697;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startKeepAlive();
});

// ═══════════ نظام التصحية: يخلي البنك (وفلاش) صاحي دايم ═══════════
// Render المجاني ينيّم الموقع بعد 15 دقيقة بدون زوار، فنرسل طلب خفيف كل 9 دقايق.
// ملاحظة: هذا يمنع النوم طول ما البنك شغال. لو نام لأي سبب (إعادة تشغيل مثلاً) ما يقدر يصحّي نفسه،
// عشان كذا يُنصح بخدمة خارجية (UptimeRobot) تفحص /healthz كل 5 دقايق.
function startKeepAlive() {
    const selfUrl = String(process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    const targets = [];
    if (selfUrl) targets.push({ name: 'البنك', url: selfUrl + '/healthz' });
    else console.log('⚠️ التصحية: ما لقيت رابط البنك (RENDER_EXTERNAL_URL أو SELF_URL) — ضيف SELF_URL في إعدادات Render');
    if (String(process.env.KEEP_FLASH_ALIVE || 'true') !== 'false') targets.push({ name: 'فلاش', url: FLASH_API + '/healthz' });
    if (!targets.length) return;
    async function pingAll() {
        for (const t of targets) {
            try {
                const r = await fetch(t.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'bank-keepalive' } });
                if (r.status >= 500) console.log('⚠️ التصحية: ' + t.name + ' رد ' + r.status);
            } catch (e) { console.log('⚠️ التصحية: تعذر الوصول لـ' + t.name + ' (' + (e && e.message ? e.message : e) + ')'); }
        }
    }
    setTimeout(pingAll, 60 * 1000);
    setInterval(pingAll, 9 * 60 * 1000);
    console.log('💓 نظام التصحية شغال (كل 9 دقايق): ' + targets.map(t => t.name).join(' + '));
}
