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
    updatedAt: { type: Date, default: Date.now }
});
const FlashLink = mongoose.model("FlashLink", FlashLinkSchema);

// طلبات البطاقات البنكية
const CardRequestSchema = new mongoose.Schema({
    discord: String,
    discordTag: String,
    accountNumber: String,
    // بيانات مطلوبة
    monthlyIncome: Number,
    jobTitle: String,
    employerName: String,
    requestReason: String,
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
    pinSet: { type: Boolean, default: false },      // هل المستخدم حط الرقم السري؟
    cardFrozen: { type: Boolean, default: false },  // فريز شكلي من كبار المسؤولين فقط
});
const CardRequest = mongoose.model("CardRequest", CardRequestSchema);

// تذاكر خدمة العملاء
const SupportTicketSchema = new mongoose.Schema({
    discord: String,
    discordTag: String,
    accountNumber: String,
    subject: String,
    status: { type: String, default: 'open' }, // open / in_progress / closed
    messages: [{
        sender: String,      // discord id or 'bot' or 'admin'
        senderName: String,
        content: String,
        isAdmin: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
const SupportTicket = mongoose.model("SupportTicket", SupportTicketSchema);

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
    loanExpiryApplyTo: { type: String, default: 'new' }  // 'new' | 'existing' | 'both'
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

    let paidCount = 0, totalPaid = 0;
    for (const p of personnel) {
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
            note: `راتب عسكري — رتبة ${p.rank}`
        });
        await Notification.create({
            discord: p.discord,
            message: `💰 تم إيداع راتبك العسكري (${salary.toLocaleString()} $) عن رتبة ${p.rank}.`,
            type: 'success'
        });
        paidCount++;
        totalPaid += salary;
    }

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
        await FlashLink.findOneAndUpdate({ uid }, { $set: { name, rank: String(p.rank || '').slice(0, 60), unit: String(p.unit || '').slice(0, 60), isSenior: !!p.senior, updatedAt: new Date() } }, { upsert: true });

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
        res.json({ loggedIn: true, user: req.user, role, hasAccount: !!account, maintenance: settings?.isMaintenance || false, flashRegistered, isOwner: await isBankOwner(req.user.id) });
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
        if (normalizedStored !== normalizedInput || String(card.cardPIN) !== String(cardPIN)) {
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
        const accounts = await Account.find().sort({ createdAt: -1 });
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
        const loans = await Loan.find({ status: { $in: ['pending', 'approved'] } }).sort({ requestedAt: -1 });
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

        const { monthlyIncome, jobTitle, employerName, requestReason } = req.body;
        if (!monthlyIncome || !jobTitle || !employerName || !requestReason) 
            return res.json({ success: false, msg: "يجب تعبئة جميع الحقول المطلوبة" });

        await CardRequest.create({
            discord: req.user.id,
            discordTag: req.user.username,
            accountNumber: acc.accountNumber,
            monthlyIncome: parseFloat(monthlyIncome),
            jobTitle, employerName, requestReason
        });

        await Notification.create({
            discord: req.user.id,
            message: `📤 تم إرسال طلب البطاقة البنكية للمراجعة. سيتم إشعارك بالقرار.`,
            type: 'info'
        });

        bumpActivity();
        res.json({ success: true, msg: "✅ تم إرسال طلب البطاقة للمراجعة من قِبل الإدارة" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// عرض طلبات بطاقة المستخدم
app.get('/api/account/cards', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const cards = await CardRequest.find({ discord: req.user.id }).sort({ requestedAt: -1 });
        res.json(cards);
    } catch (e) { res.json([]); }
});

// عرض جميع طلبات البطاقات للأدمن
app.get('/api/admin/cards', isStaffOrAbove, async (req, res) => {
    try {
        const cards = await CardRequest.find({ status: 'pending' }).sort({ requestedAt: -1 });
        res.json(cards);
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
                cardPIN: null
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
        await CardRequest.findByIdAndUpdate(card._id, { cardPIN: pin, pinSet: true });
        res.json({ success: true, msg: "✅ تم حفظ الرقم السري بنجاح" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── تحكم البطاقة (حق كبار المسؤولين فقط) ──────────────────────────────────
// عرض كل البطاقات المفعّلة (لصفحة تحكم كبار المسؤولين)
app.get('/api/superadmin/cards/control', isBankSuperAdmin, async (req, res) => {
    try {
        const cards = await CardRequest.find({ status: { $in: ['approved', 'disabled'] } }).sort({ reviewedAt: -1 });
        res.json(cards);
    } catch (e) { res.json([]); }
});

// عرض/تغيير الرقم السري لبطاقة معينة
app.put('/api/superadmin/cards/:id/pin', isBankSuperAdmin, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "يجب أن يتكون الرقم السري من 4 أرقام" });
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        await CardRequest.findByIdAndUpdate(card._id, { cardPIN: pin, pinSet: true });
        await BankLog.create({ action: 'card_pin_change', description: `تغيير الرقم السري لبطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true, msg: "✅ تم تغيير الرقم السري" });
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

// ── APIs خدمة العملاء ─────────────────────────────────────────────────────────

// فتح تذكرة دعم جديدة
app.post('/api/support/ticket', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول" });
    const settings = await BankSettings.findOne();
    if (settings && settings.disableSupport) {
        return res.json({ success: false, disableSupport: true, msg: settings.disableSupportReason || "🔒 خدمة العملاء موقوفة حالياً." });
    }
    try {
        const acc = await Account.findOne({ discord: req.user.id });
        if (acc && acc.supportBanned) return res.json({ success: false, msg: "🚫 تم حظرك من استخدام خدمة العملاء." });

        const { subject, initialMessage } = req.body;
        if (!subject || !initialMessage) return res.json({ success: false, msg: "الموضوع والرسالة مطلوبان" });

        const ticket = await SupportTicket.create({
            discord: req.user.id,
            discordTag: req.user.username,
            accountNumber: acc?.accountNumber || 'غير معروف',
            subject,
            messages: [
                { sender: 'bot', senderName: 'بوت خدمة العملاء', content: `مرحباً ${req.user.username}! شكراً لتواصلك مع بنك فلاش. سيتم مراجعة طلبك من قِبل فريق الدعم قريباً. يرجى الانتظار.`, isAdmin: false },
                { sender: req.user.id, senderName: req.user.username, content: initialMessage, isAdmin: false }
            ]
        });

        bumpTicketActivity();
        res.json({ success: true, ticketId: ticket._id, msg: "✅ تم فتح التذكرة بنجاح" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// عرض تذاكر المستخدم
app.get('/api/support/tickets', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const tickets = await SupportTicket.find({ discord: req.user.id }).sort({ updatedAt: -1 });
        res.json(tickets);
    } catch (e) { res.json([]); }
});

// عرض تذكرة واحدة
app.get('/api/support/tickets/:id', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json(null);
    try {
        const ticket = await SupportTicket.findOne({ _id: req.params.id, discord: req.user.id });
        res.json(ticket);
    } catch (e) { res.json(null); }
});

// إرسال رسالة في التذكرة (مستخدم)
app.post('/api/support/tickets/:id/message', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false });
    const settings = await BankSettings.findOne();
    if (settings && settings.disableSupport) return res.json({ success: false, msg: "خدمة العملاء موقوفة." });
    try {
        const acc = await Account.findOne({ discord: req.user.id });
        if (acc && acc.supportBanned) return res.json({ success: false, msg: "أنت محظور من خدمة العملاء." });
        const { content } = req.body;
        if (!content) return res.json({ success: false });
        const ticket = await SupportTicket.findOne({ _id: req.params.id, discord: req.user.id });
        if (!ticket || ticket.status === 'closed') return res.json({ success: false, msg: "التذكرة مغلقة أو غير موجودة" });
        ticket.messages.push({ sender: req.user.id, senderName: req.user.username, content, isAdmin: false });
        ticket.updatedAt = new Date();
        await ticket.save();
        bumpTicketActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// عرض جميع التذاكر للأدمن
app.get('/api/admin/support/tickets', isStaffOrAbove, async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ status: { $in: ['open', 'in_progress'] } }).sort({ updatedAt: -1 });
        res.json(tickets);
    } catch (e) { res.json([]); }
});

// رد الأدمن على تذكرة
app.post('/api/admin/support/tickets/:id/reply', isStaffOrAbove, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.json({ success: false });
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.json({ success: false, msg: "التذكرة غير موجودة" });
        ticket.messages.push({ 
            sender: req.user.id, 
            senderName: req.user.username + ' (الإدارة)', 
            content, 
            isAdmin: true 
        });
        ticket.status = 'in_progress';
        ticket.updatedAt = new Date();
        await ticket.save();
        await Notification.create({
            discord: ticket.discord,
            message: `💬 ردّ فريق الدعم على تذكرتك: "${ticket.subject}"`,
            type: 'info'
        });
        bumpTicketActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// إغلاق تذكرة (أدمن)
app.put('/api/admin/support/tickets/:id/close', isStaffOrAbove, async (req, res) => {
    try {
        await SupportTicket.findByIdAndUpdate(req.params.id, { status: 'closed', updatedAt: new Date() });
        bumpTicketActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});


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
        await SupportTicket.deleteMany({ discord: userDiscordId });
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
        const accs = await Account.find({ $or: [{ discordTag: rx }, { accountNumber: rx }] }, { discord: 1, discordTag: 1, accountNumber: 1 }).limit(8).lean();
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

// ── APIs السجل العام (كبار المسؤولين فقط) ─────────────────────────────────
app.get('/api/superadmin/logs', isBankSuperAdmin, async (req, res) => {
    try {
        const logs = await BankLog.find().sort({ createdAt: -1 }).limit(200);
        res.json(logs);
    } catch (e) { res.json([]); }
});

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

// ── API: الحصول على تذكرة واحدة مغلقة (للأدمن) ─────────────────────────
app.get('/api/admin/support/tickets/:id', isStaffOrAbove, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        res.json(ticket);
    } catch (e) { res.json(null); }
});

// ── API: سجل التذاكر المغلقة (الأدمن) ──────────────────────────────────
app.get('/api/admin/support/tickets/closed', isStaffOrAbove, async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ status: 'closed' }).sort({ updatedAt: -1 }).limit(100);
        res.json(tickets);
    } catch (e) { res.json([]); }
});

// ── API: polling للمستخدم (تحديث تلقائي) ──────────────────────────────
app.get('/api/poll/user', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({});
    try {
        const acc = await Account.findOne({ discord: req.user.id });
        const unreadCount = await Notification.countDocuments({ discord: req.user.id, read: false });
        const latestUnread = await Notification.findOne({ discord: req.user.id, read: false }).sort({ createdAt: -1 }).select('_id');
        let activeTicket = null;
        if (req.query.ticketId) {
            activeTicket = await SupportTicket.findOne({ _id: req.query.ticketId, discord: req.user.id });
        }
        res.json({ balance: acc?.balance, savingsBalance: acc?.savingsBalance, isFrozen: acc?.isFrozen, unreadCount, latestUnreadId: latestUnread ? String(latestUnread._id) : null, activeTicket, lastActivity: lastBankActivity, lastTicketActivity });
    } catch (e) { res.json({}); }
});

// ── API: polling للأدمن (تحديث تلقائي) ─────────────────────────────────
app.get('/api/poll/admin', isStaffOrAbove, async (req, res) => {
    try {
        const openTickets = await SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } });
        const pendingLoans = await Loan.countDocuments({ status: 'pending' });
        const pendingCards = await CardRequest.countDocuments({ status: 'pending' });
        let activeTicket = null;
        if (req.query.ticketId) {
            activeTicket = await SupportTicket.findById(req.query.ticketId);
        }
        res.json({ openTickets, pendingLoans, pendingCards, activeTicket, lastActivity: lastBankActivity, lastTicketActivity });
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
        @keyframes ntIn { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: none; } }

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
                <li><button onclick="openSupportModal()" id="nav-support">🎧 خدمة العملاء</button></li>
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
            <button onclick="openSupportModal(); closeMobileMenu()">🎧 خدمة العملاء</button>
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
                <label>الراتب الشهري ($):</label>
                <input id="card-income" type="number" placeholder="مثال: 15000" min="1" />
                <label>المسمى الوظيفي:</label>
                <input id="card-job" placeholder="مثال: محاسب" />
                <label>اسم جهة العمل:</label>
                <input id="card-employer" placeholder="مثال: شركة فلاش للتطوير" />
                <label>سبب طلب البطاقة:</label>
                <input id="card-reason" placeholder="اشرح سبب حاجتك للبطاقة..." />
                <button class="btn btn-blue btn-full" onclick="submitCardRequest()">📤 إرسال الطلب للمراجعة</button>
            </div>
        </div>

        <button id="admin-fab-btn" class="admin-fab" onclick="openAdminPanel()">⚙️ إدارة البنك</button>
    </div>

    <div id="pinPadModal" class="custom-modal">
        <div class="modal-content" style="max-width:340px; text-align:center;">
            <p style="color:#e2e8f0; font-weight:bold; margin-bottom:6px;">🔐 أدخل الرقم السري</p>
            <p style="color:#64748b; font-size:0.8rem; margin-bottom:16px;">4 أرقام فقط</p>
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

    <div id="supportModal" class="custom-modal">
        <div class="modal-content" style="max-width:650px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:2px solid #3b82f6; padding-bottom:10px;">
                <h2 style="color:#60a5fa;">🎧 خدمة العملاء</h2>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button onclick="showTicketsList()" style="background:rgba(59,130,246,0.15); border:1px solid #3b82f6; color:#60a5fa; padding:5px 12px; border-radius:8px; cursor:pointer; font-family:inherit; font-size:0.82rem;">📋 تذاكري</button>
                    <button onclick="closeSupportModal()" style="background:none; border:none; color:white; font-size:24px; cursor:pointer;">✕</button>
                </div>
            </div>
            <!-- شاشة البوت (أسئلة أولية) -->
            <div id="support-bot-screen">
                <div style="background:rgba(59,130,246,0.1); border:1px solid #3b82f6; border-radius:10px; padding:15px; margin-bottom:15px;">
                    <p style="color:#60a5fa; font-weight:bold;">🤖 مرحباً! أنا مساعد بنك فلاش</p>
                    <p style="color:#94a3b8; font-size:0.9rem; margin-top:5px;">سأساعدك في توجيه طلبك للفريق المناسب. يرجى الإجابة على الأسئلة التالية:</p>
                </div>
                <div id="bot-questions-container"></div>
                <div id="bot-answers-container" style="margin-top:10px;"></div>
                <div id="support-new-ticket-form" style="display:none; margin-top:15px;">
                    <label>موضوع التذكرة:</label>
                    <input id="ticket-subject" placeholder="اكتب موضوع مشكلتك..." style="margin-bottom:10px;" />
                    <label>وصف المشكلة بالتفصيل:</label>
                    <textarea id="ticket-message" placeholder="اشرح مشكلتك هنا..." style="height:80px; resize:vertical; margin-bottom:10px;"></textarea>
                    <button class="btn btn-blue btn-full" onclick="submitNewTicket()">📤 فتح تذكرة دعم</button>
                    <div id="ticket-submit-msg" style="margin-top:8px;"></div>
                </div>
            </div>
            <!-- قائمة التذاكر -->
            <div id="support-tickets-screen" style="display:none;">
                <button class="btn btn-blue" style="margin-bottom:15px;" onclick="showSupportBot()">+ فتح تذكرة جديدة</button>
                <div id="tickets-list-container"></div>
            </div>
            <!-- شاشة تذكرة واحدة (المحادثة) -->
            <div id="support-chat-screen" style="display:none;">
                <button class="btn" style="background:rgba(255,255,255,0.1); margin-bottom:10px;" onclick="showTicketsList()">← رجوع للتذاكر</button>
                <div id="chat-messages" style="max-height:350px; overflow-y:auto; padding:10px; background:rgba(0,0,0,0.2); border-radius:10px; margin-bottom:10px;"></div>
                <div id="chat-input-area">
                    <input id="chat-input" placeholder="اكتب رسالتك..." style="margin-bottom:8px;" onkeydown="if(event.key==='Enter') sendChatMsg()" />
                    <button class="btn btn-blue btn-full" onclick="sendChatMsg()">إرسال ✉️</button>
                </div>
                <div id="chat-closed-msg" style="display:none; text-align:center; color:#64748b; padding:10px;">🔒 هذه التذكرة مغلقة</div>
            </div>
        </div>
    </div>

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
                <button id="atab-support" class="tab-btn" onclick="switchAdminTab('support')">🎧 الدعم</button>
                <button id="atab-tickets-log" class="tab-btn" onclick="switchAdminTab('tickets-log')">📁 سجل التذاكر</button>
                <button id="atab-staff" class="tab-btn" onclick="switchAdminTab('staff')">👔 الموظفون</button>
                <button id="atab-locks" class="tab-btn" onclick="switchAdminTab('locks')">🔒 إيقاف الميزات</button>
                <button id="atab-settings" class="tab-btn" style="display:none;" onclick="switchAdminTab('settings')">👑 إعدادات كبار المسؤولين</button>
                <button id="atab-military-salary" class="tab-btn" style="display:none;" onclick="switchAdminTab('military-salary')">🎖️ رواتب العساكر</button>
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

            <div id="atab-tickets-log-section" style="display:none;">
                <div id="admin-tickets-log-container">جاري التحميل...</div>
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
        const NOTIF_TOAST_MS = 2000;           // مدة بقاء الإشعار (بالملي ثانية)
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
            // التحذير: هزّة خفيفة للجوال
            if (type === 'warning' && navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
            // الخطر: صوت إنذار + هزّة (يشتغل فقط وهو داخل الموقع)
            if (type === 'danger') {
                playDangerSound();
                if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200, 100, 200]); } catch (e) {} }
            }
        }
        // ═══════════ صوت إنذار الخطر (مولَّد بالكود، ما يحتاج ملف صوت) ═══════════
        let dangerAudioCtx = null;
        function getDangerCtx() {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                if (!dangerAudioCtx) dangerAudioCtx = new AC();
                return dangerAudioCtx;
            } catch (e) { return null; }
        }
        // المتصفح يمنع الصوت قبل أول لمسة، فنفتحه مع أول ضغطة بالموقع
        let dangerPendingAt = 0;
        ['click', 'touchend', 'pointerdown', 'keydown'].forEach(function (ev) {
            document.addEventListener(ev, function () {
                const c = getDangerCtx();
                if (!c) return;
                if (c.state === 'suspended') c.resume().catch(function () {});
                // آيفون يحتاج صوت صامت داخل اللمسة عشان ينفتح الصوت
                try { const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource(); src.buffer = b; src.connect(c.destination); src.start(0); } catch (e) {}
                // إذا وصل إنذار والصوت كان محجوب، نشغّله أول ما يلمس الصفحة (خلال 15 ثانية)
                if (dangerPendingAt && Date.now() - dangerPendingAt < 15000) { dangerPendingAt = 0; playDangerSound(); }
            }, { passive: true });
        });
        function playDangerSound() {
            try {
                const c = getDangerCtx();
                if (!c) return;
                if (c.state !== 'running') {
                    dangerPendingAt = Date.now();
                    c.resume().then(function () { if (c.state === 'running') { dangerPendingAt = 0; playDangerSound(); } }).catch(function () {});
                    return;
                }
                const now = c.currentTime;
                const gain = c.createGain();
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.35, now + 0.05);
                gain.gain.setValueAtTime(0.35, now + 1.7);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
                gain.connect(c.destination);
                const osc = c.createOscillator();
                osc.type = 'square';
                // صفارة إنذار: تتبدل بين نغمتين 4 مرات
                for (let i = 0; i < 4; i++) {
                    osc.frequency.setValueAtTime(880, now + i * 0.5);
                    osc.frequency.setValueAtTime(660, now + i * 0.5 + 0.25);
                }
                osc.connect(gain);
                osc.start(now);
                osc.stop(now + 2.0);
            } catch (e) {}
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
                    document.getElementById('atab-card-control').style.display = 'block';
                    document.getElementById('atab-military-salary').style.display = 'block';
                    document.getElementById('superadmin-only-locks').style.display = 'block';
                    document.getElementById('admin-panel-title').innerText = "لوحة كبار مسؤولي البنك 👑";
                }
            }
            await loadDashboard();
            loadNotifCount();
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
            ['stats','accounts','loans','cards','support','tickets-log','staff','locks','settings','card-control','bank-log','military-salary'].forEach(t => {
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
            if(tab === 'tickets-log') loadAdminTicketsLog();
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
            const colors = { success: '#4ade80', danger: '#fca5a5', warning: '#fde047', info: '#60a5fa' };
            const bg = { success: 'rgba(34,197,94,0.1)', danger: 'rgba(239,68,68,0.1)', warning: 'rgba(234,179,8,0.1)', info: 'rgba(59,130,246,0.1)' };
            const el = document.getElementById(id);
            if(el) el.innerHTML = \`<div style="padding:10px; border-radius:8px; background:\${bg[type]}; color:\${colors[type]}; border:1px solid \${colors[type]}; margin-bottom:10px;">\${msg}</div>\`;
        }

        async function loadMyCards() {
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
                const realCard = c.status === 'approved' && c.cardNumber && c.pinSet ? \`
                    <div style="background:\${theme.bg}; border:1px solid \${theme.border}; border-radius:16px; padding:20px 22px; margin-top:12px; font-family:monospace; position:relative; overflow:hidden; min-width:280px; max-width:380px; \${c.cardFrozen ? 'filter:grayscale(1); opacity:0.6;' : ''}">
                        <div style="position:absolute; top:-20px; right:-20px; width:100px; height:100px; background:rgba(255,255,255,0.06); border-radius:50%;"></div>
                        <div style="position:absolute; bottom:-30px; left:-10px; width:130px; height:130px; background:rgba(255,255,255,0.04); border-radius:50%;"></div>
                        \${c.cardFrozen ? '<div style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.6); color:#fca5a5; font-size:0.7rem; padding:3px 8px; border-radius:6px; font-family:inherit;">🔒 مجمّدة</div>' : ''}
                        <p style="font-size:0.7rem; color:\${theme.accent}; letter-spacing:2px; margin-bottom:14px;">FLASH BANK</p>
                        <p style="font-size:1.25rem; letter-spacing:3px; color:#e2e8f0; margin-bottom:14px;">\${c.cardNumber || '#### #### #### ####'}</p>
                        <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:8px;">
                            <div>
                                <p style="font-size:0.65rem; color:\${theme.accent}; letter-spacing:1px;">CARD HOLDER</p>
                                <p style="font-size:0.9rem; color:#e2e8f0; text-transform:uppercase;">\${c.cardHolderName || '---'}</p>
                            </div>
                            <div>
                                <p style="font-size:0.65rem; color:\${theme.accent}; letter-spacing:1px;">EXPIRES</p>
                                <p style="font-size:0.9rem; color:\${isExpired ? '#fca5a5' : '#e2e8f0'};">\${expiryStr}</p>
                            </div>
                            <div>
                                <p style="font-size:0.65rem; color:\${theme.accent}; letter-spacing:1px;">CVV</p>
                                <p style="font-size:0.9rem; color:#e2e8f0;">\${c.cardCVV || '---'}</p>
                            </div>
                        </div>
                        \${isExpired ? '<p style="color:#fca5a5; font-size:0.78rem; margin-top:10px; font-family:inherit;">⌛ البطاقة منتهية — يمكنك طلب التجديد أدناه</p>' : ''}
                    </div>
                \` : '';
                const pinSetupCard = needsPin ? \`
                    <div style="background:#0f1420; border:2px solid #ef4444; border-radius:16px; padding:20px 22px; margin-top:12px; position:relative; overflow:hidden; min-width:280px; max-width:380px; text-align:center;">
                        <div style="font-size:3.5rem; color:#ef4444; line-height:1; margin-bottom:10px;">✕</div>
                        <p style="color:#fca5a5; font-weight:bold; margin-bottom:10px;">🔐 عيّن رقمك السري لتفعيل البطاقة</p>
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
                                <p style="color:#94a3b8; font-size:0.85rem; margin-top:4px;">المسمى: \${c.jobTitle} | جهة العمل: \${c.employerName}</p>
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

        async function submitCardRequest() {
            const income = document.getElementById('card-income').value;
            const job = document.getElementById('card-job').value.trim();
            const employer = document.getElementById('card-employer').value.trim();
            const reason = document.getElementById('card-reason').value.trim();
            if(!income||!job||!employer||!reason) return showMsg('card-req-msg','يجب تعبئة جميع الحقول','danger');
            showMsg('card-req-msg','جاري الإرسال...','info');
            const res = await fetch('/api/account/card/request', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ monthlyIncome: income, jobTitle: job, employerName: employer, requestReason: reason })
            });
            const data = await res.json();
            showMsg('card-req-msg', (data.success?'✅ ':'❌ ')+data.msg, data.success?'success':'danger');
            if(data.success) { loadMyCards(); document.getElementById('card-income').value=''; document.getElementById('card-job').value=''; document.getElementById('card-employer').value=''; document.getElementById('card-reason').value=''; }
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
                            <p style="margin-top:5px; color:#94a3b8; font-size:0.85rem;">المسمى: \${c.jobTitle} | الجهة: \${c.employerName}</p>
                            <p style="color:#4ade80; font-size:0.85rem;">الراتب: \${(c.monthlyIncome||0).toLocaleString()} $ / شهري</p>
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
        async function loadAdminTicketsLog() {
            const container = document.getElementById('admin-tickets-log-container');
            container.innerHTML = '<p style="text-align:center; color:#64748b; padding:20px;">جاري التحميل...</p>';
            try {
                const res = await fetch('/api/admin/support/tickets/closed');
                if (!res.ok) {
                    container.innerHTML = '<p style="text-align:center; color:#ef4444; padding:20px;">❌ غير مصرح أو خطأ في السيرفر.</p>';
                    return;
                }
                const tickets = await res.json();
                if (!Array.isArray(tickets) || !tickets.length) {
                    container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد تذاكر مغلقة.</p>';
                    return;
                }
                container.innerHTML = tickets.map(t => \`
                    <div class="card" style="margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                            <div>
                                <b>\${t.discordTag || 'غير معروف'}</b> — <span style="color:#60a5fa;">\${t.subject || ''}</span>
                                <p style="color:#64748b; font-size:0.78rem; margin-top:3px;">🔒 مغلقة — \${(t.messages || []).length} رسائل — \${t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('ar-SA') : ''}</p>
                            </div>
                            <button class="btn btn-blue" style="padding:4px 12px; font-size:0.8rem;" onclick="viewClosedTicket('\${t._id}')">👁️ عرض المحادثة</button>
                        </div>
                    </div>
                \`).join('');
            } catch (e) {
                container.innerHTML = '<p style="text-align:center; color:#ef4444; padding:20px;">❌ تعذر الاتصال بالسيرفر: ' + e.message + '</p>';
            }
        }

        async function viewClosedTicket(ticketId) {
            const res = await fetch(\`/api/admin/support/tickets/\${ticketId}\`);
            const ticket = await res.json();
            if (!ticket) return uiAlert('لم يتم العثور على التذكرة', 'danger');
            const msgs = ticket.messages.map(m => {
                const isAdmin = m.isAdmin;
                const isBot = m.sender === 'bot';
                const col = isBot ? '#fde047' : isAdmin ? '#60a5fa' : '#4ade80';
                return \`<div style="border-right:3px solid \${col}; padding:6px 10px; margin-bottom:8px; background:rgba(255,255,255,0.03); border-radius:6px;"><b style="color:\${col}; font-size:0.8rem;">\${isBot ? '🤖 بوت' : m.senderName}</b><p style="font-size:0.85rem; margin-top:3px;">\${m.content}</p><p style="color:#475569; font-size:0.72rem; margin-top:2px;">\${new Date(m.createdAt).toLocaleString('ar-SA')}</p></div>\`;
            }).join('');
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = \`<div style="background:#050f1e;border:2px solid #3b82f6;border-radius:14px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><h3 style="color:#60a5fa;">\${ticket.subject}</h3><button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:white;font-size:20px;cursor:pointer;">✕</button></div>\${msgs}</div>\`;
            document.body.appendChild(overlay);
        }

        // ─── سجل البنك ──────────────────────────────────────────────────────
        async function loadBankLog() {
            const res = await fetch('/api/superadmin/logs');
            const logs = await res.json();
            const container = document.getElementById('bank-log-container');
            if (!logs.length) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد أحداث مسجلة.</p>'; return; }
            const actionColor = { register:'#4ade80', transfer:'#60a5fa', transfer_fee:'#94a3b8', loan_approve:'#4ade80', loan_reject:'#fca5a5', card_approve:'#4ade80', card_reject:'#fca5a5', manual_deposit:'#4ade80', manual_deduct:'#fca5a5', hire_staff:'#a78bfa', fire_staff:'#f97316', card_renew_request:'#fde047', set_card_expiry:'#fde047', update_fees:'#fde047', update_loan_expiry:'#fde047' };
            container.innerHTML = logs.map(l => \`
                <div style="padding:8px 12px; border-right:3px solid \${actionColor[l.action]||'#64748b'}; background:rgba(255,255,255,0.02); border-radius:6px; margin-bottom:6px;">
                    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:4px;">
                        <span style="color:\${actionColor[l.action]||'#94a3b8'}; font-size:0.8rem; font-weight:bold;">\${l.action.replace(/_/g,' ').toUpperCase()}</span>
                        <span style="color:#475569; font-size:0.75rem;">\${new Date(l.createdAt).toLocaleString('ar-SA')}</span>
                    </div>
                    <p style="font-size:0.83rem; margin-top:3px;">\${l.description}</p>
                    \${l.performedByTag ? \`<p style="color:#64748b; font-size:0.75rem; margin-top:2px;">بواسطة: \${l.performedByTag}</p>\` : ''}
                </div>
            \`).join('');
        }

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

        async function runMilitarySalaryNow() {
            if (!(await uiConfirm('متأكد تبي تصرف الرواتب الآن يدوياً لكل العساكر المستحقين؟', { title: '💰 صرف الرواتب الآن', okText: 'نعم، اصرف' }))) return;
            showMsg('military-salary-msg', 'جاري الصرف...', 'info');
            const res = await fetch('/api/superadmin/military-salary/run-now', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showMsg('military-salary-msg', \`✅ تم صرف الرواتب لـ \${data.paidCount} حساب بإجمالي \${data.totalPaid.toLocaleString()} $\`, 'success');
                loadMilitarySalaryPanel();
            } else {
                showMsg('military-salary-msg', '❌ '+data.msg, 'danger');
            }
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

        function openSupportModal() {
            document.getElementById('supportModal').style.display = 'block';
            showSupportBot();
        }

        function showSupportBot() {
            document.getElementById('support-bot-screen').style.display = 'block';
            document.getElementById('support-tickets-screen').style.display = 'none';
            document.getElementById('support-chat-screen').style.display = 'none';
            botAnswers = [];
            currentBotQ = 0;
            renderBotQuestion();
        }

        function renderBotQuestion() {
            const qContainer = document.getElementById('bot-questions-container');
            const aContainer = document.getElementById('bot-answers-container');
            const ticketForm = document.getElementById('support-new-ticket-form');
            
            // عرض الإجابات السابقة
            aContainer.innerHTML = botAnswers.map((a, i) => \`
                <div style="background:rgba(59,130,246,0.1); border-radius:8px; padding:8px 12px; margin-bottom:6px; font-size:0.85rem; color:#94a3b8;">
                    <b style="color:#60a5fa;">\${botQuestions[i].q}</b><br>\${a}
                </div>
            \`).join('');

            if (currentBotQ >= botQuestions.length) {
                // انتهت الأسئلة - اعرض فورم التذكرة
                qContainer.innerHTML = \`
                    <div style="background:rgba(34,197,94,0.1); border:1px solid #22c55e; border-radius:10px; padding:12px; margin-bottom:10px;">
                        <p style="color:#4ade80; font-weight:bold;">✅ شكراً! سيتم الآن توصيلك بفريق الدعم</p>
                        <p style="color:#94a3b8; font-size:0.85rem; margin-top:5px;">يرجى ملء التفاصيل وفتح التذكرة. انتظر ردّ طاقم المسؤولين.</p>
                    </div>
                \`;
                ticketForm.style.display = 'block';
                // تعبئة الموضوع تلقائياً
                document.getElementById('ticket-subject').value = botAnswers[0] || '';
                return;
            }

            const bq = botQuestions[currentBotQ];
            qContainer.innerHTML = \`
                <div style="background:rgba(59,130,246,0.08); border:1px solid #3b82f6; border-radius:10px; padding:12px; margin-bottom:10px;">
                    <p style="color:#60a5fa; font-weight:bold; margin-bottom:10px;">\${bq.q}</p>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        \${bq.options.map(opt => \`<button class="btn btn-blue" style="font-size:0.82rem; padding:6px 12px;" onclick="answerBotQ('\${opt}')">\${opt}</button>\`).join('')}
                    </div>
                </div>
            \`;
            ticketForm.style.display = 'none';
        }

        function answerBotQ(answer) {
            botAnswers.push(answer);
            currentBotQ++;
            renderBotQuestion();
        }

        async function submitNewTicket() {
            const subject = document.getElementById('ticket-subject').value.trim();
            const message = document.getElementById('ticket-message').value.trim();
            if(!subject||!message) return showMsg('ticket-submit-msg','الموضوع والرسالة مطلوبان','danger');
            showMsg('ticket-submit-msg','جاري الإرسال...','info');
            const res = await fetch('/api/support/ticket', {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ subject, initialMessage: message + (botAnswers.length ? \`\\n\\n---\\nمعلومات إضافية: \${botAnswers.join(' | ')}\` : '') })
            });
            const data = await res.json();
            if(data.disableSupport) { showMsg('ticket-submit-msg','🔒 ' + data.msg,'danger'); return; }
            if(data.success) {
                showMsg('ticket-submit-msg','✅ تم فتح التذكرة! انتظر رد الفريق','success');
                setTimeout(() => showTicketsList(), 1500);
            } else {
                showMsg('ticket-submit-msg','❌ '+data.msg,'danger');
            }
        }

        async function showTicketsList() {
            document.getElementById('support-bot-screen').style.display = 'none';
            document.getElementById('support-tickets-screen').style.display = 'block';
            document.getElementById('support-chat-screen').style.display = 'none';
            const res = await fetch('/api/support/tickets');
            const tickets = await res.json();
            const container = document.getElementById('tickets-list-container');
            if(!tickets.length) { container.innerHTML = '<p style="color:#64748b; text-align:center;">لا توجد تذاكر سابقة.</p>'; return; }
            const statusMap = { open: '🟡 مفتوحة', in_progress: '🔵 قيد المعالجة', closed: '🔒 مغلقة' };
            container.innerHTML = tickets.map(t => \`
                <div class="card" style="margin-bottom:8px; cursor:pointer;" onclick="openTicketChat('\${t._id}')">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                        <div>
                            <b style="color:#60a5fa;">\${t.subject}</b>
                            <p style="color:#64748b; font-size:0.8rem; margin-top:3px;">\${statusMap[t.status]||t.status} — \${new Date(t.updatedAt).toLocaleDateString('ar-SA')}</p>
                        </div>
                        <span style="color:#94a3b8; font-size:0.8rem;">\${t.messages.length} رسائل ←</span>
                    </div>
                </div>
            \`).join('');
        }

        async function refreshTicketChat() {
            const res = await fetch(\`/api/support/tickets/\${currentTicketId}\`);
            const ticket = await res.json();
            if(!ticket) return;
            const isClosed = ticket.status === 'closed';
            const chatDiv = document.getElementById('chat-messages');
            chatDiv.innerHTML = ticket.messages.map((m, idx) => {
                const isBot = m.sender === 'bot';
                const isAdmin = m.isAdmin;
                const bgColor = isBot ? 'rgba(234,179,8,0.1)' : isAdmin ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)';
                const nameColor = isBot ? '#fde047' : isAdmin ? '#60a5fa' : '#4ade80';
                return \`
                    <div data-msg="\${idx}" style="background:\${bgColor}; border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                        <b style="color:\${nameColor}; font-size:0.82rem;">\${isBot ? '🤖 بوت خدمة العملاء' : m.senderName}</b>
                        <p style="margin-top:4px; font-size:0.88rem;">\${m.content}</p>
                        <p style="color:#475569; font-size:0.73rem; margin-top:3px;">\${new Date(m.createdAt).toLocaleString('ar-SA')}</p>
                    </div>
                \`;
            }).join('');
            chatDiv.scrollTop = chatDiv.scrollHeight;
            document.getElementById('chat-input-area').style.display = isClosed ? 'none' : 'block';
            document.getElementById('chat-closed-msg').style.display = isClosed ? 'block' : 'none';
        }

        async function sendChatMsg() {
            const content = document.getElementById('chat-input').value.trim();
            if(!content) return;
            const res = await fetch(\`/api/support/tickets/\${currentTicketId}/message\`, {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ content })
            });
            const data = await res.json();
            if(data.success) { document.getElementById('chat-input').value=''; await refreshTicketChat(); }
            else uiAlert('❌ ' + (data.msg||'فشل الإرسال'));
        }

        // ─── أدمن: دوال الدعم ──────────────────────────────────────────────────

        async function loadAdminSupport() {
            const res = await fetch('/api/admin/support/tickets');
            const tickets = await res.json();
            const container = document.getElementById('admin-support-container');
            if(!tickets.length) { container.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد تذاكر مفتوحة.</p>'; container.dataset.lastMsgCount = '0'; return; }
            container.dataset.lastMsgCount = tickets.reduce((sum, t) => sum + t.messages.length, 0);
            const statusMap = { open: '🟡 مفتوحة', in_progress: '🔵 قيد المعالجة' };
            container.innerHTML = tickets.map(t => \`
                <div class="card card-yellow" style="margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                        <div>
                            <b>\${t.discordTag}</b> <span style="color:#64748b; font-size:0.8rem;">\${t.discord}</span>
                            <p style="color:#60a5fa; margin-top:5px; font-weight:bold;">\${t.subject}</p>
                            <p style="color:#64748b; font-size:0.78rem;">\${statusMap[t.status]||t.status} — \${t.messages.length} رسائل — \${new Date(t.updatedAt).toLocaleDateString('ar-SA')}</p>
                            <div style="max-height:120px; overflow-y:auto; margin-top:8px; background:rgba(0,0,0,0.2); border-radius:8px; padding:8px;">
                                \${t.messages.map(m=>\`<p style="font-size:0.8rem; margin-bottom:5px; color:\${m.isAdmin?'#60a5fa':m.sender==='bot'?'#fde047':'#e2e8f0'};"><b>\${m.sender==='bot'?'🤖 بوت':m.senderName}:</b> \${m.content}</p>\`).join('')}
                            </div>
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; min-width:180px;">
                            <textarea id="admin-reply-\${t._id}" placeholder="اكتب الرد هنا..." style="height:60px; resize:vertical; font-size:0.82rem; margin-bottom:0;"></textarea>
                            <div style="display:flex; gap:6px;">
                                <button class="btn btn-blue" style="padding:5px 10px; flex:1;" onclick="adminReplyTicket('\${t._id}')">💬 رد</button>
                                <button class="btn btn-red" style="padding:5px 10px;" onclick="adminCloseTicket('\${t._id}')">🔒 إغلاق</button>
                            </div>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        async function adminReplyTicket(id) {
            const content = document.getElementById(\`admin-reply-\${id}\`)?.value.trim();
            if(!content) return uiAlert('أدخل نص الرد', 'warning');
            const res = await fetch(\`/api/admin/support/tickets/\${id}/reply\`, {
                method: 'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ content })
            });
            const data = await res.json();
            if(data.success) { loadAdminSupport(); }
        }

        async function adminCloseTicket(id) {
            if (!(await uiConfirm('إغلاق هذه التذكرة؟', { title: '🎧 إغلاق تذكرة', okText: 'نعم، أغلقها' }))) return;
            const res = await fetch(\`/api/admin/support/tickets/\${id}/close\`, { method: 'PUT' });
            const data = await res.json();
            if(data.success) loadAdminSupport();
        }

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
                            <p style="color:#94a3b8; font-size:0.85rem;">الرقم السري: \${c.pinSet ? \`<b style="color:#fde047; letter-spacing:2px;">\${c.cardPIN}</b>\` : '<span style="color:#64748b;">لم يُعيَّن بعد</span>'}</p>
                            \${c.cardFrozen ? '<p style="color:#fca5a5; font-size:0.82rem;">🔒 البطاقة مجمّدة حالياً</p>' : ''}
                        </div>
                        <div style="display:flex; gap:6px; flex-direction:column; min-width:220px;">
                            <div style="display:flex; gap:6px;">
                                <input id="cc-pin-\${c._id}" placeholder="رقم سري جديد (4 أرقام)" maxlength="4" inputmode="numeric" style="padding:5px 8px; font-size:0.8rem; margin-bottom:0;" />
                                <button class="btn btn-blue" style="padding:5px 10px;" onclick="ccChangePin('\${c._id}')">💾</button>
                            </div>
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

        async function ccChangePin(id) {
            const pin = document.getElementById(\`cc-pin-\${id}\`)?.value.trim();
            if (!pin || !/^\\d{4}$/.test(pin)) return showMsg(\`cc-msg-\${id}\`, 'يجب أن يتكون الرقم السري من 4 أرقام', 'danger');
            const res = await fetch(\`/api/superadmin/cards/\${id}/pin\`, {
                method: 'PUT', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ pin })
            });
            const data = await res.json();
            showMsg(\`cc-msg-\${id}\`, data.msg, data.success ? 'success' : 'danger');
            if (data.success) loadCardControlPanel();
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

        function startUserPolling() {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const url = activePollingTicketId ? \`/api/poll/user?ticketId=\${activePollingTicketId}\` : '/api/poll/user';
                    const res = await fetch(url);
                    const data = await res.json();
                    if (!data || Object.keys(data).length === 0) return;

                    // تحديث الإشعارات
                    if (data.unreadCount !== undefined && data.unreadCount !== lastUnreadCount) {
                        lastUnreadCount = data.unreadCount;
                        loadNotifCount();
                    }
                    if (data.latestUnreadId !== undefined) handleNotifPush(data.latestUnreadId);

                    // تحديث رصيد/حالة الحساب — أي تغيير (إيداع، تحويل، تجميد...) يحدّث اللوحة فوراً
                    if (currentAccount && (data.balance !== undefined || data.isFrozen !== undefined)) {
                        const changed = currentAccount.balance !== data.balance
                            || currentAccount.savingsBalance !== data.savingsBalance
                            || currentAccount.isFrozen !== data.isFrozen;
                        currentAccount.balance = data.balance;
                        currentAccount.savingsBalance = data.savingsBalance;
                        currentAccount.isFrozen = data.isFrozen;
                        if (changed) loadDashboard();
                    }

                    // تحديث تلقائي لمحادثة التذكرة المفتوحة
                    if (data.activeTicket && activePollingTicketId) {
                        const chatDiv = document.getElementById('chat-messages');
                        if (chatDiv) {
                            const prevCount = chatDiv.querySelectorAll('[data-msg]').length;
                            if (data.activeTicket.messages.length > prevCount) {
                                refreshTicketChat();
                            }
                        }
                    }

                    // تذاكري (قائمة التذاكر) تتحدث فور أي رد أو تغيير حالة
                    if (data.lastTicketActivity && lastSeenTicketActivity && data.lastTicketActivity !== lastSeenTicketActivity) {
                        const ticketsScreen = document.getElementById('support-tickets-screen');
                        if (ticketsScreen && ticketsScreen.style.display !== 'none' && typeof showTicketsList === 'function') {
                            showTicketsList();
                        }
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

        let pendingSilentRefresh = false;
        function silentRefreshCurrentPage() {
            try {
                if (document.hidden) { pendingSilentRefresh = true; return; }
                const ae = document.activeElement;
                const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
                let modalOpen = false;
                document.querySelectorAll('.custom-modal').forEach(function(m) { if (getComputedStyle(m).display !== 'none') modalOpen = true; });
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

        function startAdminPolling() {
            if (adminPollInterval) clearInterval(adminPollInterval);
            adminPollInterval = setInterval(async () => {
                try {
                    const url = adminActivePollingTicketId ? \`/api/poll/admin?ticketId=\${adminActivePollingTicketId}\` : '/api/poll/admin';
                    const res = await fetch(url);
                    const data = await res.json();
                    if (!data || Object.keys(data).length === 0) return;

                    // تحديث عداد التذاكر في التاب
                    const supportTab = document.getElementById('atab-support');
                    if (supportTab && data.openTickets > 0) {
                        supportTab.textContent = \`🎧 الدعم (\${data.openTickets})\`;
                    } else if (supportTab) {
                        supportTab.textContent = '🎧 الدعم';
                    }

                    // تحديث تلقائي للمحادثة المفتوحة في لوحة الأدمن
                    if (data.activeTicket && adminActivePollingTicketId) {
                        const adminContainer = document.getElementById('admin-support-container');
                        if (adminContainer && adminContainer.dataset.lastMsgCount) {
                            if (data.activeTicket.messages.length > parseInt(adminContainer.dataset.lastMsgCount)) {
                                loadAdminSupport();
                                adminContainer.dataset.lastMsgCount = data.activeTicket.messages.length;
                            }
                        }
                    }

                    // تذكرة جديدة أو تحديث بالتذاكر (فوري) — إذا التاب مفتوح يتحدث تلقائياً
                    const ticketActivityChanged = data.lastTicketActivity && lastSeenAdminTicketActivity && data.lastTicketActivity !== lastSeenAdminTicketActivity;
                    const supportSection = document.getElementById('atab-support-section');
                    if (supportSection && supportSection.style.display !== 'none') {
                        const currentCount = supportSection.querySelectorAll('.card').length;
                        if (data.openTickets !== currentCount || ticketActivityChanged) {
                            loadAdminSupport();
                        }
                    }

                    // أي عملية بنكية (تحويل بين شخصين، إيداع أدمن، قرض، بطاقة...) تحدّث
                    // تبويبات الأدمن المفتوحة حالياً بدون ما يحتاج يعيد تحميل الصفحة
                    const activityChanged = data.lastActivity && lastSeenAdminActivity && data.lastActivity !== lastSeenAdminActivity;
                    if (activityChanged) {
                        const accountsSection = document.getElementById('atab-accounts-section');
                        if (accountsSection && accountsSection.style.display !== 'none' && typeof loadAdminAccounts === 'function') loadAdminAccounts();
                        const loansSection = document.getElementById('atab-loans-section');
                        if (loansSection && loansSection.style.display !== 'none' && typeof loadAdminLoans === 'function') loadAdminLoans();
                        const cardsSection = document.getElementById('atab-cards-section');
                        if (cardsSection && cardsSection.style.display !== 'none' && typeof loadAdminCards === 'function') loadAdminCards();
                        const ticketsLogSection = document.getElementById('atab-tickets-log-section');
                        if (ticketsLogSection && ticketsLogSection.style.display !== 'none' && typeof loadAdminTicketsLog === 'function') loadAdminTicketsLog();
                        const bankLogSection = document.getElementById('atab-bank-log-section');
                        if (bankLogSection && bankLogSection.style.display !== 'none' && typeof loadBankLog === 'function') loadBankLog();
                    }
                    if (data.lastActivity) lastSeenAdminActivity = data.lastActivity;
                    if (data.lastTicketActivity) lastSeenAdminTicketActivity = data.lastTicketActivity;
                } catch(e) {}
            }, 2000);
        }

        // تغليف openTicketChat لتفعيل polling
        const _origOpenTicketChat = openTicketChat;
        async function openTicketChat(ticketId) {
            activePollingTicketId = ticketId;
            currentTicketId = ticketId;
            document.getElementById('support-tickets-screen').style.display = 'none';
            document.getElementById('support-chat-screen').style.display = 'block';
            await refreshTicketChat();
        }

        function closeSupportModal() {
            document.getElementById('supportModal').style.display = 'none';
            activePollingTicketId = null;
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
});
