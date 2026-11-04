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
            body: JSON.stringify({ uid: String(n.discord), title: n.type === 'danger' ? '🚨 بنك فلاش — إنذار' : '🏦 بنك فلاش', body: String(n.message), type: String(n.type || 'info') }),
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
    stealth: { type: Boolean, default: false },   // المالك المتخفي (يتفعّل تلقائياً عند دخول البنك من فلاش)
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
    cardPIN: { type: String, default: null },       // قديم (يُشفَّر تلقائياً عند التشغيل)
    cardPINEnc: { type: String, default: null },    // الرقم السري مشفّر AES — يشوفه كبار المسؤولين فقط
    pinFails: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },
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
// المالك المتخفي: أي حدث يسويه ما ينسجل أبداً
(function () {
    const origCreate = BankLog.create.bind(BankLog);
    BankLog.create = async function (doc, ...rest) {
        try { if (doc && !Array.isArray(doc) && doc.performedBy && doc.performedBy !== 'system' && await isStealthOwner(doc.performedBy)) return doc; } catch (e) {}
        return origCreate(doc, ...rest);
    };
})();

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
    logClearUsed: { type: Boolean, default: false },
    notifWipeDone: { type: Boolean, default: false },
    cardExpiryBackfill: { type: Boolean, default: false },
    supportCanned: { type: [{ title: String, text: String }], default: [] }
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
    fundAccount: { type: String, default: '' },         // رقم حساب التمويل (يحدده المالك): منه تنسحب الرواتب
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
    let paidCount = 0, totalPaid = 0, shortCount = 0;
    const tag = advance ? ' (دفعة مسبقة)' : '';
    // الرواتب تنسحب من حساب التمويل (يحدده المالك) وتنزل للعساكر — مو من بنك فلاش
    const fund = settings.fundAccount ? await Account.findOne({ accountNumber: settings.fundAccount }) : null;
    if (!fund) return { paidCount: 0, totalPaid: 0, shortCount: 0, noFund: true };
    let stop = false;
    for (const p of list) {
        const salary = settings.ranksSalaries.get(p.rank);
        if (!salary || salary <= 0) continue; // ما فيه راتب محدد لهذي الرتبة

        const acc = await Account.findOne({ discord: p.discord });
        if (!acc || acc.isFrozen) continue; // ما عنده حساب بنكي أو حسابه مجمد
        if (String(acc._id) === String(fund._id)) continue; // صاحب حساب التمويل ما ياخذ من نفسه
        if (stop) { shortCount++; continue; }

        // خصم ذرّي من حساب التمويل (لو الرصيد ما يكفي نوقف)
        const taken = await Account.findOneAndUpdate({ _id: fund._id, balance: { $gte: salary } }, { $inc: { balance: -salary } });
        if (!taken) { stop = true; shortCount++; continue; }

        await Account.findByIdAndUpdate(acc._id, { $inc: { balance: salary } });
        await Transaction.create({
            fromAccount: fund.accountNumber,
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
    if (paidCount > 0) {
        await Transaction.create({ fromDiscord: fund.discord, fromAccount: fund.accountNumber, amount: totalPaid, type: 'withdraw', note: `صرف رواتب عسكرية${tag} (${paidCount} شخص)` });
        await Notification.create({ discord: fund.discord, message: `💸 سُحب ${totalPaid.toLocaleString()} $ من حسابك لرواتب العساكر (${paidCount} شخص).`, type: 'info' });
    }
    if (shortCount > 0) {
        await Notification.create({ discord: fund.discord, message: `⚠️ رصيد حساب تمويل الرواتب ما كفى: ما انصرف راتب ${shortCount} شخص. عبّي الحساب.`, type: 'warning' });
    }
    return { paidCount, totalPaid, shortCount };
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

    const { paidCount, totalPaid, shortCount, noFund } = await payMilitarySalaries(personnel, settings, false);
    if (noFund) return { success: false, msg: "ما تم تحديد حساب تمويل الرواتب — المالك يحدده من تاب رواتب العساكر" };

    const now = new Date();
    const nextPayoutAt = new Date(now.getTime() + periodToMs(settings.periodValue, settings.periodUnit));
    await MilitarySalarySettings.updateOne({}, { lastPayoutAt: now, nextPayoutAt });

    await BankLog.create({
        action: 'military_salary_payout',
        description: `صرف رواتب العساكر: ${paidCount} حساب بإجمالي ${totalPaid.toLocaleString()} $${shortCount ? ` — ${shortCount} ما انصرف لهم (رصيد التمويل ما كفى)` : ''}`,
        performedBy: 'system',
        performedByTag: 'نظام رواتب العساكر'
    });

    return { success: true, paidCount, totalPaid, shortCount, nextPayoutAt };
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

const BANK_EXT_CSS = String.raw`
html,body{touch-action:manipulation;-webkit-text-size-adjust:100%}input,textarea,select{font-size:16px !important}
.sp-chat{overflow:hidden}.sp-rate{max-height:42vh;overflow:auto;flex-shrink:0}.sp-msgs{min-height:120px}#supportModal .modal-content{overscroll-behavior:contain}
.sp-row{background:rgba(255,255,255,.04);border:1px solid rgba(59,130,246,.2);border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.sp-row .t1{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:bold;font-size:.9rem}
.sp-row .t2{color:#94a3b8;font-size:.8rem;margin-top:3px}
.sp-badge{background:#ef4444;color:#fff;border-radius:10px;padding:0 7px;font-size:.7rem;margin-inline-start:6px}
.sp-chip{font-size:.72rem;padding:2px 8px;border-radius:10px;background:#334155;white-space:nowrap}
.sp-chip.ai{background:#4c1d95}.sp-chip.waiting{background:#92400e}.sp-chip.active{background:#166534}.sp-chip.closed{background:#475569}
.sp-link{background:none;border:none;color:#60a5fa;cursor:pointer;font-family:inherit;font-size:.85rem}
.sp-chat{display:flex;flex-direction:column;height:72vh;max-height:640px}
.sp-bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}.sp-title{font-weight:bold;flex:1;text-align:center}
.sp-state{margin-bottom:6px}.sp-msgs{flex:1;overflow-y:auto;padding:10px;background:rgba(0,0,0,.25);border-radius:10px;display:flex;flex-direction:column;gap:8px}
.sp-msg{max-width:84%;display:flex;flex-direction:column}.sp-msg.me{align-self:flex-start}.sp-msg.other{align-self:flex-end}
.sp-msg .sp-b{padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word;font-size:.9rem;background:rgba(255,255,255,.08)}
.sp-msg.me .sp-b{background:#1d4ed8}.sp-msg.ai .sp-b{background:#3b2a6b}.sp-msg.other.admin .sp-b,.sp-msg.other .sp-b{background:rgba(255,255,255,.1)}
.sp-msg.sys{align-self:center;max-width:92%}.sp-msg.sys .sp-b{background:transparent;color:#94a3b8;font-size:.78rem;text-align:center}
.sp-msg.note{align-self:center;max-width:92%}.sp-msg.note .sp-b{background:#713f12;color:#fef9c3}
.sp-msg.del .sp-b{background:#7f1d1d}.sp-deltag{font-size:.7rem;color:#fecaca;margin-bottom:3px}
.sp-who{font-size:.72rem;color:#94a3b8;margin-bottom:2px}.sp-time{font-size:.66rem;color:#64748b;margin-top:2px}
.sp-role{font-size:.62rem;padding:0 6px;border-radius:8px;margin-inline-start:5px}.sp-role.senior{background:#b45309;color:#fff}.sp-role.admin{background:#1d4ed8;color:#fff}
.sp-quote{border-right:3px solid #60a5fa;padding:2px 8px;margin-bottom:5px;font-size:.78rem;color:#cbd5e1;background:rgba(0,0,0,.2);border-radius:6px}.sp-quote b{display:block;color:#60a5fa}
.sp-img{max-width:100%;max-height:220px;border-radius:8px;display:block;margin-top:4px;cursor:zoom-in}
.sp-compose{display:flex;gap:6px;align-items:flex-end;margin-top:8px}.sp-compose textarea{margin:0;flex:1;resize:none;min-height:40px}
.sp-attach,.sp-mic{background:rgba(255,255,255,.08);border:none;border-radius:10px;padding:9px 11px;cursor:pointer;font-size:1rem;color:#fff}
.sp-typing{font-size:.75rem;color:#94a3b8;min-height:16px;padding:2px 6px}.sp-ctx{background:rgba(59,130,246,.15);border-radius:8px;padding:5px 9px;font-size:.78rem;margin-top:6px}
.sp-info{background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:10px;padding:8px;margin-bottom:6px;font-size:.8rem;max-height:150px;overflow:auto}
.sp-ir{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed rgba(255,255,255,.07);font-size:.82rem}.sp-ir span:first-child{color:#94a3b8}
.sp-rate{background:rgba(234,179,8,.08);border:1px solid #eab308;border-radius:10px;padding:10px;margin-top:8px}.sp-stars button{background:none;border:none;font-size:1.8rem;color:#475569;cursor:pointer}.sp-stars button.on{color:#facc15}
.sp-tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:10px}.sp-tab{background:rgba(255,255,255,.06);border:1px solid transparent;color:#94a3b8;border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit;white-space:nowrap}.sp-tab.on{background:rgba(59,130,246,.25);border-color:#3b82f6;color:#60a5fa}
.bk-wrap{perspective:1000px;max-width:370px;margin-top:12px;cursor:pointer}.bk-inner{position:relative;width:100%;aspect-ratio:1.586;transition:transform .7s;transform-style:preserve-3d}.bk-wrap.flip .bk-inner{transform:rotateY(180deg)}
.bk-face{position:absolute;inset:0;border-radius:18px;padding:16px 18px;backface-visibility:hidden;-webkit-backface-visibility:hidden;color:#fff;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.18);display:flex;flex-direction:column;justify-content:space-between;direction:ltr;font-family:'Courier New',monospace}
.bk-back{transform:rotateY(180deg);justify-content:flex-start;padding:16px 0}.bk-shine{position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.14) 45%,transparent 60%);pointer-events:none}
.bk-chip{width:44px;height:33px;border-radius:7px;background:linear-gradient(135deg,#fde68a,#b45309);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}.bk-num{font-size:1.22rem;letter-spacing:3px;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bk-lbl{font-size:.55rem;letter-spacing:1px}.bk-val{font-size:.85rem;text-transform:uppercase}.bk-net{display:flex}.bk-net i{width:26px;height:26px;border-radius:50%;background:rgba(239,68,68,.9);display:block}.bk-net i+i{background:rgba(250,204,21,.9);margin-left:-11px}
.bk-mag{height:46px;background:linear-gradient(180deg,#000,#1a1a1a 50%,#000);margin-top:8px;box-shadow:0 1px 0 rgba(255,255,255,.08)}.bk-game{margin:6px 14px 0;padding:5px 8px;border:1px solid #fca5a5;border-radius:6px;background:rgba(0,0,0,.45);color:#fecaca;font-size:.62rem;text-align:center;font-weight:bold;direction:rtl;line-height:1.5}.bk-sig{flex:1;height:32px;background:repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0 4px,#cbd5e1 4px,#cbd5e1 8px)}.bk-cvv{background:#fff;color:#000;padding:6px 10px;border-radius:4px;font-weight:bold;letter-spacing:2px}
.bk-frozen{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.65);color:#fca5a5;font-size:.65rem;padding:3px 8px;border-radius:6px;z-index:2}.bk-gray{filter:grayscale(1);opacity:.65}
`;
const BANK_EXT_JS = String.raw`
// منع تكبير الشاشة (تطبيق)
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false }); });
document.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
var _lt = 0; document.addEventListener('touchend', function (e) { var n = Date.now(); if (n - _lt < 350) e.preventDefault(); _lt = n; }, { passive: false });
// ═══════════ إضافات البنك: خدمة العملاء + البطاقة + ملف العضو + اللوق ═══════════
var BKB = function (u) { return (window.BANK_BASE || '') + u; };
function spEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function spTime(d) { try { return new Date(d).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
function spDate(d) { try { return new Date(d).toLocaleString('ar-SA'); } catch (e) { return ''; } }
function bkToast(m, t) { try { uiToast(m, t || 'info'); } catch (e) { alert(m); } }
async function spApi(url, opts) {
    opts = opts || {};
    var o = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts.body !== undefined) o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    var r = await fetch(url, o);
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok || d.success === false) { var e = new Error(d.error || d.msg || 'خطأ'); e.data = d; throw e; }
    return d;
}
function spAsk(msg, ph, okText) {
    return new Promise(function (resolve) {
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px;';
        ov.innerHTML = '<div style="background:#0d1f3c;border:1px solid #3b82f6;border-radius:14px;padding:18px;max-width:380px;width:100%;"><p style="margin-bottom:10px;">' + spEsc(msg) + '</p><textarea id="sp-ask-in" rows="2" placeholder="' + spEsc(ph || '') + '" style="margin-bottom:10px;"></textarea><div style="display:flex;gap:8px;"><button class="btn btn-blue" style="flex:1" id="sp-ask-ok">' + (okText || 'تأكيد') + '</button><button class="btn" style="flex:1;background:#334155" id="sp-ask-no">إلغاء</button></div></div>';
        document.body.appendChild(ov);
        var done = function (v) { ov.remove(); resolve(v); };
        ov.querySelector('#sp-ask-ok').onclick = function () { done(ov.querySelector('#sp-ask-in').value); };
        ov.querySelector('#sp-ask-no').onclick = function () { done(null); };
    });
}
async function spConfirm(m) { try { return await uiConfirm(m, { okText: 'تأكيد' }); } catch (e) { return confirm(m); } }

var SP = { cur: null, img: null, reply: null, edit: null, note: false, tab: 'waiting', meta: null, timer: null, loading: false, rec: null, mode: 'user' };
var SP_ST = { ai: '🤖 مساعد آلي', waiting: '⏳ بانتظار إداري', active: '✅ مع إداري', closed: '🔒 مغلق' };

function openSupportModal() { document.getElementById('supportModal').style.display = 'block'; SP.mode = 'user'; spShowList(); }
function closeSupportModal() { document.getElementById('supportModal').style.display = 'none'; spStop(); SP.cur = null; spBadges(); }
function spStop() { if (SP.timer) { clearInterval(SP.timer); SP.timer = null; } }
function spBox() { return document.getElementById(SP.cur && SP.cur.box ? SP.cur.box : (SP.mode === 'admin' ? 'sp-admin-body' : 'sp-body')); }

async function spLoadMeta() { if (!SP.meta) SP.meta = await spApi('/api/support/meta'); return SP.meta; }
function spShowList() {
    spStop(); SP.cur = null; SP.img = null;
    document.getElementById('sp-body').innerHTML = '<button class="btn btn-blue btn-full" id="sp-newbtn" onclick="spShowNew()" style="margin-bottom:12px;">+ تكت جديد</button><div id="sp-list" style="color:#64748b;text-align:center;padding:16px;">جارِ التحميل...</div>';
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
        if (nb) { nb.disabled = hasOpen || !!d.banned; nb.style.opacity = (hasOpen || d.banned) ? '.55' : ''; nb.textContent = d.banned ? '🚫 تم حظرك من خدمة العملاء' : hasOpen ? '🔒 عندك تكت مفتوح، لين يتسكّر ما تقدر تفتح جديد' : '+ تكت جديد'; }
        if (!d.tickets.length) { box.innerHTML = 'ما عندك تكتات، افتح تكت جديد وبنساعدك 👌'; return; }
        box.innerHTML = d.tickets.map(function (t) { return spRowHtml(t, 'user', 'sp-body', false); }).join('');
    } catch (e) { box.innerHTML = '<span style="color:#fca5a5">' + spEsc(e.message) + '</span>'; }
}
function spRowHtml(t, mode, boxId, del) {
    return '<div class="sp-row" onclick="spOpenTicket(\'' + t.id + '\',\'' + mode + '\',\'' + boxId + '\')"><div class="t1"><span>#' + t.no + ' — ' + spEsc(mode === 'admin' ? t.name : t.category) + (t.unread ? '<span class="sp-badge">' + t.unread + '</span>' : '') + '</span><span class="sp-chip ' + t.status + '">' + SP_ST[t.status] + (t.adminName && mode === 'admin' ? ' — ' + spEsc(t.adminName) : '') + '</span></div>' +
        (mode === 'admin' ? '<div class="t2">' + spEsc(t.category) + (t.place ? ' • ' + spEsc(t.place) : '') + '</div>' : '') + '<div class="t2">' + spEsc(t.last || '') + '</div>' +
        (del ? '<div style="margin-top:6px"><button class="sp-link" style="color:#fca5a5" onclick="event.stopPropagation();spDeleteRow(\'' + t.id + '\')">🗑️ حذف</button></div>' : '') + '</div>';
}
async function spShowNew() {
    SP.img = null; var m = await spLoadMeta();
    document.getElementById('sp-body').innerHTML = '<button class="sp-link" onclick="spShowList()">‹ رجوع</button>' +
        '<label>نوع المشكلة</label><select id="spn-cat" onchange="spCatChanged()">' + m.cats.map(function (c) { return '<option>' + spEsc(c) + '</option>'; }).join('') + '</select>' +
        '<div id="spn-place-wrap"><label>وين بالضبط؟</label><select id="spn-place"></select></div>' +
        '<label>اشرح المشكلة</label><textarea id="spn-text" rows="4" maxlength="1500" placeholder="وش اللي صار؟ وش الخطأ اللي ظهر؟"></textarea>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><label class="sp-attach">📎<input type="file" accept="image/*" style="display:none" onchange="spPick(this)"></label><div id="sp-prev"></div></div>' +
        '<button class="btn btn-blue btn-full" id="spn-go" onclick="spCreate()">فتح التكت</button>';
    spCatChanged();
}
function spCatChanged() {
    var c = document.getElementById('spn-cat').value, l = (SP.meta.places || {})[c], w = document.getElementById('spn-place-wrap');
    if (!l) { w.style.display = 'none'; return; }
    w.style.display = ''; document.getElementById('spn-place').innerHTML = l.map(function (x) { return '<option>' + spEsc(x) + '</option>'; }).join('');
}
async function spCreate() {
    var b = document.getElementById('spn-go'), text = document.getElementById('spn-text').value.trim();
    if (!text && !SP.img) return bkToast('اشرح المشكلة أو أرفق صورة', 'warning');
    b.disabled = true;
    try {
        var w = document.getElementById('spn-place-wrap');
        var d = await spApi('/api/support/tickets', { method: 'POST', body: { category: document.getElementById('spn-cat').value, place: w.style.display !== 'none' ? document.getElementById('spn-place').value : '', text: text, image: SP.img } });
        SP.img = null; spOpenTicket(d.id, 'user', 'sp-body');
    } catch (e) { bkToast(e.message, 'danger'); b.disabled = false; if (e.data && e.data.needRate) spOpenTicket(e.data.needRate, 'user', 'sp-body'); }
}
function spPick(inp) {
    var f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
    if (f.type.indexOf('image/') !== 0) return bkToast('اختر صورة فقط', 'warning');
    var fr = new FileReader();
    fr.onload = function () {
        var im = new Image();
        im.onload = function () {
            var max = 1100, w = im.width, h = im.height;
            if (w > max || h > max) { var k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
            var cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(im, 0, 0, w, h);
            var q = 0.8, out = cv.toDataURL('image/jpeg', q);
            while (out.length > 1100000 && q > 0.3) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
            SP.img = out; spPaintPrev();
        };
        im.src = fr.result;
    };
    fr.readAsDataURL(f);
}
function spPaintPrev() { var p = document.getElementById('sp-prev'); if (p) p.innerHTML = SP.img ? '<img src="' + SP.img + '" style="height:46px;border-radius:6px"> <button class="sp-link" onclick="SP.img=null;spPaintPrev()">✕</button>' : ''; }

// ── المحادثة ──
async function spOpenTicket(id, mode, boxId) {
    spStop(); SP.mode = mode; SP.cur = { id: id, mode: mode, box: boxId, n: 0, mver: undefined, mm: {}, role: null }; SP.img = null; SP.reply = null; SP.edit = null; SP.note = false;
    var admin = mode === 'admin';
    document.getElementById(boxId).innerHTML = '<div class="sp-chat"><div class="sp-bar"><button class="sp-link" onclick="spBack()">‹ رجوع</button><div class="sp-title" id="sp-title">...</div><span id="sp-tools"></span></div>' +
        '<div class="sp-state" id="sp-state"></div><div class="sp-info" id="sp-info" style="display:none"></div><div class="sp-msgs" id="sp-msgs"></div><div id="sp-typing" class="sp-typing"></div><div id="sp-rate" class="sp-rate" style="display:none"></div><div id="sp-prev"></div><div id="sp-ctx" class="sp-ctx" style="display:none"></div>' +
        '<div class="sp-compose" id="sp-compose"><label class="sp-attach">📎<input type="file" accept="image/*" style="display:none" onchange="spPick(this)"></label><button class="sp-mic" id="sp-mic" onclick="spVoice()">🎙️</button>' +
        (admin ? '<button class="sp-mic" id="sp-note-btn" title="ملاحظة داخلية" onclick="spNoteToggle()">📝</button><button class="sp-mic" title="ردود جاهزة" onclick="spCanned()">⚡</button>' : '') +
        '<textarea id="sp-in" rows="1" placeholder="اكتب رسالتك..."></textarea><button class="btn btn-blue" id="sp-send" onclick="spSend()">➤</button></div></div>';
    var ta = document.getElementById('sp-in');
    ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); spSend(); } };
    var lastPing = 0; ta.oninput = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 110) + 'px'; if (Date.now() - lastPing > 2000 && SP.cur) { lastPing = Date.now(); spApi('/api/support/tickets/' + SP.cur.id + '/typing', { method: 'POST', body: {} }).catch(function () {}); } };
    document.getElementById('sp-msgs').onclick = spMsgClick;
    await spLoadNew(true);
    SP.timer = setInterval(function () { if (SP.cur) spLoadNew(); }, 2200);
}
function spBack() {
    spStop(); SP.cur = null; SP.img = null; SP.reply = null; SP.edit = null;
    if (SP.mode === 'admin') spaShowList(); else spShowList();
}
async function spLoadNew(first) {
    var c = SP.cur; if (!c || SP.loading) return; SP.loading = true;
    try {
        var d = await spApi('/api/support/tickets/' + c.id + '?after=' + c.n);
        if (SP.cur !== c) return;
        c.t = d.ticket; c.role = d.role; c.canInspect = !!d.canInspect; c.senior = !!d.senior;
        var sk = (d.shared || []).join(','), skCh = c.sharedKey !== sk; c.sharedKey = sk; c.shared = d.shared || [];
        var box = document.getElementById('sp-msgs'); if (!box) return;
        if (c.mver === undefined) c.mver = d.mver;
        else if (d.mver !== c.mver) { c.mver = d.mver; c.n = 0; c.mm = {}; box.innerHTML = ''; SP.loading = false; return spLoadNew(); }
        var near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
        d.msgs.forEach(function (m) { box.insertAdjacentHTML('beforeend', spMsgHtml(m)); });
        c.n = d.n;
        var tp = document.getElementById('sp-typing'); if (tp) tp.textContent = d.typing ? ('✍️ ' + d.typing + ' يكتب...') : (d.aiTyping ? '🤖 المساعد يكتب...' : '');
        spPaintState();
        if (skCh) spLoadInfo();
        if (first || (near && d.msgs.length)) box.scrollTop = box.scrollHeight;
        if (d.msgs.length) spBadges();
    } catch (e) {
        if (first) { var el = document.getElementById(c.box); if (el) el.innerHTML = '<div style="color:#fca5a5;padding:12px">' + spEsc(e.message) + '</div>'; }
        else if (/غير موجود/.test(e.message)) { bkToast('هذا التكت انحذف', 'warning'); spBack(); }
    } finally { SP.loading = false; }
}
function spMedia(c, m) {
    var src = BKB('/api/support/tickets/' + c.id + '/media/' + m.media);
    if (m.mk === 'img') return '<img class="sp-img" loading="lazy" src="' + src + '" onclick="spViewImg(this.src)">';
    if (m.mk === 'aud') return '<audio controls preload="none" src="' + src + '" style="max-width:100%;height:36px"></audio>';
    return '';
}
function spViewImg(src) { var o = document.createElement('div'); o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center'; o.innerHTML = '<img src="' + src + '" style="max-width:96%;max-height:92%">'; o.onclick = function () { o.remove(); }; document.body.appendChild(o); }
function spMsgHtml(m) {
    if (m.hid) return '';
    var c = SP.cur; c.mm[m.i] = m;
    var roleTag = m.role === 'senior' ? '<span class="sp-role senior">كبار المسؤولين</span>' : (m.sender === 'admin' ? '<span class="sp-role admin">إداري</span>' : '');
    if (m.sender === 'note') return '<div class="sp-msg note" data-i="' + m.i + '"><div class="sp-who">📝 ملاحظة داخلية (ما تظهر للعضو) — ' + spEsc(m.name) + roleTag + '</div><div class="sp-b">' + spEsc(m.text) + '</div><div class="sp-time">' + spTime(m.at) + '</div></div>';
    var mine = c.mode === 'admin' ? m.sender === 'admin' : m.sender === 'user';
    var cls = m.sender === 'system' ? 'sys' : (mine ? 'me' : 'other') + (m.sender === 'ai' ? ' ai' : '') + (m.del ? ' del' : '');
    var who = m.sender === 'system' ? '' : '<div class="sp-who">' + (m.sender === 'ai' ? '🤖 ' : m.sender === 'admin' ? '🛡️ ' : '') + spEsc(m.name) + roleTag + '</div>';
    var quote = m.rp != null ? '<div class="sp-quote"><b>' + spEsc(m.rpn) + '</b>' + spEsc(m.rpt) + '</div>' : '';
    var delTag = m.del ? '<div class="sp-deltag">🗑️ ' + (c.mode === 'admin' ? 'محذوفة — حذفها ' + spEsc(m.delBy) + (m.rev ? ' • معروضة للعضو' : ' • مخفية عن العضو') : 'رسالة محذوفة (عرضتها لك الإدارة)') + '</div>' : '';
    var data = m.sender === 'system' ? '' : ' data-i="' + m.i + '"';
    return '<div class="sp-msg ' + cls + '"' + data + '>' + who + '<div class="sp-b">' + delTag + quote + spEsc(m.text) + (m.media ? spMedia(c, m) : '') + '</div>' + (m.sender === 'system' ? '' : '<div class="sp-time">' + spTime(m.at) + (m.ed ? ' • معدّلة' : '') + '</div>') + '</div>';
}
function spPaintState() {
    var c = SP.cur, t = c.t, st = document.getElementById('sp-state'); if (!st) return;
    document.getElementById('sp-title').textContent = '#' + t.no + ' — ' + (c.mode === 'admin' ? t.name : t.category);
    var h = '<span class="sp-chip ' + t.status + '">' + SP_ST[t.status] + (t.adminName ? ' — ' + spEsc(t.adminName) : '') + '</span>';
    var tools = '';
    if (c.mode === 'admin') {
        if (t.status === 'waiting' || (t.status === 'ai' && false)) h += ' <button class="btn btn-green" style="padding:4px 10px" onclick="spJoin()">✋ استلام</button>';
        if (t.status !== 'closed') h += ' <button class="btn btn-red" style="padding:4px 10px" onclick="spCloseTicket()">🔒 إغلاق</button>';
        if (c.canInspect) tools += '<button class="sp-link" onclick="spInspect()">🔎 فحص</button> ';
        if (c.senior) tools += '<button class="sp-link" style="color:#fca5a5" onclick="spBan()">🚫 حظر</button>';
    } else if (t.status === 'ai') h += ' <button class="btn btn-blue" style="padding:4px 10px" onclick="spHuman()">🧑‍💼 تحدث مع عضو حقيقي</button>';
    st.innerHTML = h + '<div style="color:#94a3b8;font-size:.78rem;margin-top:4px">' + spEsc(t.category) + (t.place ? ' • ' + spEsc(t.place) : '') + '</div>';
    document.getElementById('sp-tools').innerHTML = tools;
    var closed = t.status === 'closed', cp = document.getElementById('sp-compose');
    var canWrite = !closed && (c.mode === 'user' || c.senior || (t.status === 'active'));
    cp.style.display = canWrite ? 'flex' : 'none';
    var rb = document.getElementById('sp-rate');
    if (closed && c.mode === 'user' && t.rating == null) { if (!rb.innerHTML) { rb.innerHTML = '<b>⭐ قيّم خدمة الدعم</b><div style="font-size:.78rem;color:#94a3b8">التقييم إجباري عشان تفتح تكت جديد</div><div class="sp-stars" id="sp-stars">' + [1, 2, 3, 4, 5].map(function (n) { return '<button onclick="spStar(' + n + ')">★</button>'; }).join('') + '</div><textarea id="sp-rate-c" rows="2" maxlength="300" placeholder="تعليق (اختياري)"></textarea><button class="btn btn-blue btn-full" id="sp-rate-go" disabled onclick="spRate()">إرسال التقييم</button>'; } rb.style.display = 'block'; }
    else rb.style.display = 'none';
    if (c.mode === 'user' && c.shared && c.shared.length) { var inf = document.getElementById('sp-info'); if (inf && !inf.dataset.l) { inf.dataset.l = '1'; } }
}
var SPR = { n: 0 };
function spStar(n) { SPR.n = n; var b = document.getElementById('sp-stars').children; for (var i = 0; i < b.length; i++) b[i].className = i < n ? 'on' : ''; document.getElementById('sp-rate-go').disabled = false; }
async function spRate() {
    var c = SP.cur; if (!c || !SPR.n) return;
    try { await spApi('/api/support/tickets/' + c.id + '/rate', { method: 'POST', body: { stars: SPR.n, comment: (document.getElementById('sp-rate-c') || {}).value || '' } }); bkToast('🙏 شكراً لتقييمك', 'success'); document.getElementById('sp-rate').innerHTML = ''; spBack(); }
    catch (e) { bkToast(e.message, 'danger'); }
}
async function spLoadInfo() {
    var c = SP.cur, el = document.getElementById('sp-info'); if (!c || !el) return;
    if (!c.shared || !c.shared.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    try {
        var d = await spApi('/api/support/tickets/' + c.id + '/info');
        if (!d.items.length) { el.style.display = 'none'; return; }
        el.style.display = ''; el.innerHTML = '<b>🔎 معلومات معروضة' + (c.mode === 'user' ? ' لك' : ' للعضو') + '</b>' + d.items.map(function (g) { return '<div class="sp-grp"><div style="color:#60a5fa;font-weight:bold">' + spEsc(g.title) + '</div>' + g.rows.map(function (r) { return '<div class="sp-ir"><span>' + spEsc(r.l) + '</span><span>' + spEsc(r.d ? spDate(r.v) : r.at ? spDate(r.at) + ' — ' + r.v : r.v) + '</span></div>'; }).join('') + '</div>'; }).join('');
    } catch (e) {}
}
async function spSend() {
    var c = SP.cur; if (!c) return;
    var ta = document.getElementById('sp-in'), text = ta.value.trim();
    if (SP.edit != null) {
        if (!text) return;
        try { await spApi('/api/support/tickets/' + c.id + '/messages/' + SP.edit + '/edit', { method: 'POST', body: { text: text } }); SP.edit = null; ta.value = ''; spPaintCtx(); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); }
        return;
    }
    if (!text && !SP.img) return;
    var btn = document.getElementById('sp-send'); btn.disabled = true;
    try {
        if (SP.note) await spApi('/api/support/tickets/' + c.id + '/note', { method: 'POST', body: { text: text } });
        else await spApi('/api/support/tickets/' + c.id + '/messages', { method: 'POST', body: { text: text, image: SP.img, replyTo: SP.reply } });
        ta.value = ''; ta.style.height = 'auto'; SP.img = null; SP.reply = null; spPaintPrev(); spPaintCtx(); await spLoadNew();
        var b = document.getElementById('sp-msgs'); if (b) b.scrollTop = b.scrollHeight;
    } catch (e) { bkToast(e.message, 'danger'); }
    btn.disabled = false;
}
function spNoteToggle() { SP.note = !SP.note; var b = document.getElementById('sp-note-btn'); if (b) b.style.background = SP.note ? '#eab308' : ''; document.getElementById('sp-in').placeholder = SP.note ? 'ملاحظة داخلية (ما تظهر للعضو)...' : 'اكتب رسالتك...'; }
function spPaintCtx() {
    var b = document.getElementById('sp-ctx'); if (!b) return;
    var c = SP.cur;
    if (SP.edit != null) { b.style.display = ''; b.innerHTML = '✏️ تعديل رسالة <button class="sp-link" onclick="SP.edit=null;document.getElementById(\'sp-in\').value=\'\';spPaintCtx()">✕</button>'; }
    else if (SP.reply != null && c.mm[SP.reply]) { b.style.display = ''; b.innerHTML = '↩️ رد على ' + spEsc(c.mm[SP.reply].name || '') + ': ' + spEsc((c.mm[SP.reply].text || '').slice(0, 40)) + ' <button class="sp-link" onclick="SP.reply=null;spPaintCtx()">✕</button>'; }
    else { b.style.display = 'none'; b.innerHTML = ''; }
}
function spMsgClick(e) {
    var el = e.target.closest('.sp-msg[data-i]'); if (!el || e.target.closest('img,audio,button')) return;
    var c = SP.cur, m = c.mm[el.dataset.i]; if (!m) return;
    var closed = c.t.status === 'closed', items = [];
    if (!m.del && !closed && m.sender !== 'note') items.push(['↩️ رد', 'reply']);
    if (m.text) items.push(['📋 نسخ', 'copy']);
    if (m.own && !m.del && !closed && !m.media && (m.sender === 'user' || m.sender === 'admin')) items.push(['✏️ تعديل', 'edit']);
    if (!m.del && m.sender !== 'note' && (m.own || c.senior)) items.push(['🗑️ حذف', 'del']);
    if (c.senior && m.del) items.push([m.rev ? '🙈 إخفاء عن العضو' : '👁️ عرض للعضو', 'reveal']);
    if (c.senior && m.edits && m.edits.length) items.push(['🕘 سجل التعديل', 'hist']);
    if (!items.length) return;
    var ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center';
    ov.innerHTML = '<div style="background:#0d1f3c;border-radius:14px 14px 0 0;width:100%;max-width:420px;padding:10px">' + items.map(function (it) { return '<button class="btn btn-full" style="background:rgba(255,255,255,.07);margin-bottom:6px" data-a="' + it[1] + '">' + it[0] + '</button>'; }).join('') + '</div>';
    ov.onclick = function (ev) { var a = ev.target.getAttribute('data-a'); ov.remove(); if (a) spMsgAct(a, m); };
    document.body.appendChild(ov);
}
async function spMsgAct(a, m) {
    var c = SP.cur, base = '/api/support/tickets/' + c.id + '/messages/' + m.i;
    try {
        if (a === 'reply') { SP.reply = m.i; SP.edit = null; spPaintCtx(); document.getElementById('sp-in').focus(); }
        else if (a === 'copy') { try { await navigator.clipboard.writeText(m.text); bkToast('تم النسخ', 'success'); } catch (e) {} }
        else if (a === 'edit') { SP.edit = m.i; SP.reply = null; document.getElementById('sp-in').value = m.text; spPaintCtx(); document.getElementById('sp-in').focus(); }
        else if (a === 'del') { if (await spConfirm('تحذف هذي الرسالة؟')) { await spApi(base + '/delete', { method: 'POST', body: {} }); spLoadNew(); } }
        else if (a === 'reveal') { await spApi(base + '/reveal', { method: 'POST', body: { show: !m.rev } }); spLoadNew(); }
        else if (a === 'hist') { uiAlert('سجل التعديلات:\n' + m.edits.map(function (x) { return '• ' + spDate(x.at) + ': ' + x.text; }).join('\n')); }
    } catch (e) { bkToast(e.message, 'danger'); }
}
async function spHuman() { try { await spApi('/api/support/tickets/' + SP.cur.id + '/human', { method: 'POST', body: {} }); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); } }
async function spJoin() { try { await spApi('/api/support/admin/tickets/' + SP.cur.id + '/join', { method: 'POST', body: {} }); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); } }
async function spCloseTicket() { if (!(await spConfirm('تقفل هذا التكت؟'))) return; try { await spApi('/api/support/tickets/' + SP.cur.id + '/close', { method: 'POST', body: {} }); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); } }
async function spBan() { var r = await spAsk('حظر هذا العضو من خدمة العملاء؟ اكتب السبب (اختياري):', 'السبب', 'حظر'); if (r === null) return; try { await spApi('/api/support/admin/tickets/' + SP.cur.id + '/ban', { method: 'POST', body: { reason: r } }); bkToast('🚫 تم الحظر', 'success'); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); } }
async function spDeleteRow(id) { if (!(await spConfirm('تحذف التكت نهائياً؟'))) return; try { await spApi('/api/support/admin/tickets/' + id, { method: 'DELETE' }); spaLoadList(); } catch (e) { bkToast(e.message, 'danger'); } }
async function spDeleteAllClosed() { if (!(await spConfirm('تحذف كل التكتات المغلقة نهائياً؟'))) return; try { var d = await spApi('/api/support/admin/closed', { method: 'DELETE' }); bkToast('🗑️ انحذف ' + d.deleted, 'success'); spaLoadList(); } catch (e) { bkToast(e.message, 'danger'); } }

// ── الردود الجاهزة ──
async function spCanned() {
    var d = await spApi('/api/support/admin/canned').catch(function () { return { list: [] }; });
    var ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center';
    var senior = SP.cur && SP.cur.senior;
    ov.innerHTML = '<div style="background:#0d1f3c;border-radius:14px 14px 0 0;width:100%;max-width:440px;max-height:75vh;overflow:auto;padding:12px"><b>⚡ ردود جاهزة</b>' + d.list.map(function (r) { return '<div class="sp-row" data-t="' + spEsc(r.text) + '"><div class="t1"><span>' + spEsc(r.title) + '</span>' + (senior ? '<button class="sp-link" style="color:#fca5a5" data-del="' + r.id + '">🗑️</button>' : '') + '</div><div class="t2">' + spEsc(r.text) + '</div></div>'; }).join('') + (senior ? '<button class="btn btn-green btn-full" data-add="1">+ إضافة رد</button>' : '') + '</div>';
    ov.onclick = async function (ev) {
        var del = ev.target.getAttribute('data-del'), add = ev.target.getAttribute('data-add'), row = ev.target.closest('[data-t]');
        if (del) { await spApi('/api/support/admin/canned/' + del, { method: 'DELETE' }); ov.remove(); spCanned(); }
        else if (add) { var t = await spAsk('عنوان الرد:'); if (!t) return; var x = await spAsk('نص الرد:'); if (!x) return; try { await spApi('/api/support/admin/canned', { method: 'POST', body: { title: t, text: x } }); } catch (e) { bkToast(e.message, 'danger'); } ov.remove(); spCanned(); }
        else if (row) { document.getElementById('sp-in').value = row.getAttribute('data-t'); ov.remove(); }
        else if (ev.target === ov) ov.remove();
    };
    document.body.appendChild(ov);
}

// ── فحص العضو ──
var SPI = { cat: null, rows: [], sel: {} };
function spInspect() {
    var ov = document.createElement('div'); ov.id = 'sp-insp'; ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:12px';
    ov.innerHTML = '<div style="background:#0d1f3c;border:1px solid #3b82f6;border-radius:14px;width:100%;max-width:480px;max-height:85vh;overflow:auto;padding:14px"><div style="display:flex;justify-content:space-between"><b>🔎 فحص العضو</b><button class="sp-link" onclick="document.getElementById(\'sp-insp\').remove()">✕</button></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">' + [['account', '🏦 الحساب'], ['card', '💳 البطاقة'], ['transfers', '💸 الحوالات'], ['loan', '📋 القروض'], ['flash', '⚡ فلاش']].map(function (c) { return '<button class="btn btn-blue" style="padding:5px 10px" onclick="spInspectCat(\'' + c[0] + '\')">' + c[1] + '</button>'; }).join('') + '</div><div id="sp-insp-body" style="color:#94a3b8;font-size:.85rem">اختر قسم، وعلّم اللي تبي يظهر للعضو.</div></div>';
    document.body.appendChild(ov);
}
async function spInspectCat(cat) {
    var b = document.getElementById('sp-insp-body'); b.textContent = 'جارِ التحميل...';
    try {
        var d = await spApi('/api/support/admin/tickets/' + SP.cur.id + '/inspect/' + cat);
        SPI.cat = cat; SPI.rows = d.rows; SPI.sel = {}; d.rows.forEach(function (r) { SPI.sel[r.k] = !!r.shown; });
        b.innerHTML = '<b style="color:#60a5fa">' + spEsc(d.title) + '</b>' + d.rows.map(function (r, i) { return '<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.08);cursor:pointer"><input type="checkbox" style="width:auto;margin:3px 0 0" ' + (r.shown ? 'checked' : '') + ' onchange="SPI.sel[SPI.rows[' + i + '].k]=this.checked"><span style="flex:1"><span style="color:#94a3b8">' + spEsc(r.l) + '</span><br>' + spEsc(r.d ? spDate(r.v) : r.at ? spDate(r.at) + ' — ' + r.v : r.v) + '</span></label>'; }).join('') + '<button class="btn btn-green btn-full" style="margin-top:10px" onclick="spShare()">💾 حفظ (إظهار المعلّم للعضو)</button>';
    } catch (e) { b.innerHTML = '<span style="color:#fca5a5">' + spEsc(e.message) + '</span>'; }
}
async function spShare() {
    var show = [], hide = []; SPI.rows.forEach(function (r) { (SPI.sel[r.k] ? show : hide).push(r.k); });
    try { await spApi('/api/support/admin/tickets/' + SP.cur.id + '/share', { method: 'POST', body: { show: show, hide: hide } }); bkToast('✅ تم الحفظ', 'success'); spLoadNew(); } catch (e) { bkToast(e.message, 'danger'); }
}

// ── الرسائل الصوتية ──
async function spVoice() {
    var mic = document.getElementById('sp-mic');
    if (SP.rec) { SP.rec.stop(); return; }
    if (!(navigator.mediaDevices && window.MediaRecorder)) return bkToast('جهازك ما يدعم التسجيل الصوتي', 'warning');
    try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].filter(function (m) { return MediaRecorder.isTypeSupported(m); })[0] || '';
        var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {}), chunks = [], t0 = Date.now();
        rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async function () {
            stream.getTracks().forEach(function (t) { t.stop(); }); SP.rec = null; mic.textContent = '🎙️'; mic.style.background = '';
            var dur = Math.round((Date.now() - t0) / 1000); if (dur < 1) return;
            var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            if (blob.size > 2.5 * 1024 * 1024) return bkToast('الرسالة الصوتية طويلة', 'warning');
            var fr = new FileReader();
            fr.onload = async function () {
                try { await spApi('/api/support/tickets/' + SP.cur.id + '/messages', { method: 'POST', body: { audio: String(fr.result).split(',')[1], audioMime: (rec.mimeType || 'audio/webm').split(';')[0], audioDuration: dur, replyTo: SP.reply } }); SP.reply = null; spPaintCtx(); spLoadNew(); }
                catch (e) { bkToast(e.message, 'danger'); }
            };
            fr.readAsDataURL(blob);
        };
        rec.start(); SP.rec = rec; mic.textContent = '⏹️'; mic.style.background = '#ef4444';
        setTimeout(function () { if (SP.rec === rec) rec.stop(); }, 120000);
    } catch (e) { bkToast('تعذر فتح المايك', 'danger'); }
}

// ── لوحة الإدارة / كبار التكتات ──
function loadAdminSupport() {
    SP.mode = 'admin'; spStop(); SP.cur = null;
    var box = document.getElementById('admin-support-container');
    box.innerHTML = '<div class="sp-tabs" id="spa-tabs"></div><div id="sp-admin-body" style="min-height:360px"></div>';
    spaShowList();
}
function spaShowList() {
    spStop(); SP.cur = null; SP.mode = 'admin';
    var senior = currentRole === 'super_admin';
    var tabs = senior ? [['waiting', '⏳ انتظار'], ['active', '✅ قيد المتابعة'], ['ai', '🤖 المساعد'], ['closed', '🔒 مغلقة'], ['rates', '⭐ التقييمات'], ['bans', '🚫 المحظورين']] : [['waiting', '⏳ انتظار الإدارة']];
    if (!senior) SP.tab = 'waiting';
    document.getElementById('spa-tabs').innerHTML = tabs.map(function (t) { return '<button class="sp-tab ' + (SP.tab === t[0] ? 'on' : '') + '" onclick="SP.tab=\'' + t[0] + '\';spaShowList()">' + t[1] + '</button>'; }).join('');
    document.getElementById('sp-admin-body').innerHTML = '<div id="spa-list" style="color:#64748b;text-align:center;padding:16px">جارِ التحميل...</div>';
    spaLoadList();
}
async function spaLoadList() {
    var box = document.getElementById('spa-list'); if (!box) return;
    try {
        if (SP.tab === 'bans') {
            var b = await spApi('/api/support/admin/bans');
            box.innerHTML = b.bans.length ? b.bans.map(function (x) { return '<div class="sp-row"><div class="t1"><span>🚫 ' + spEsc(x.name) + '</span><button class="sp-link" style="color:#86efac" onclick="spUnban(\'' + x.id + '\')">فك الحظر</button></div><div class="t2">' + (x.reason ? 'السبب: ' + spEsc(x.reason) : 'بدون سبب') + ' — ' + spEsc(x.by || '') + '</div></div>'; }).join('') : 'ما فيه محظورين';
            return;
        }
        if (SP.tab === 'rates') {
            var d = await spApi('/api/support/admin/ratings');
            if (!d.total) { box.innerHTML = 'ما فيه تقييمات للحين'; return; }
            box.innerHTML = '<div class="sp-row"><div class="t1"><span>📊 الإجمالي</span><span>⭐ ' + d.avg.toFixed(2) + ' (' + d.total + ')</span></div></div>' + d.admins.map(function (a) { return '<div class="sp-row" onclick="spRatingAdmin(\'' + spEsc(a.uid) + '\',\'' + spEsc(a.name) + '\')"><div class="t1"><span>🛡️ ' + spEsc(a.name) + '</span><span>⭐ ' + a.avg.toFixed(2) + ' (' + a.count + ')</span></div><div class="t2">' + [5, 4, 3, 2, 1].map(function (n) { return n + '★ ' + a.dist[n - 1]; }).join(' • ') + '</div></div>'; }).join('') + (d.recent.length ? '<b style="display:block;margin:10px 0 4px">💬 آخر التعليقات</b>' + d.recent.map(function (r) { return '<div class="sp-row"><div class="t1"><span>#' + r.no + ' — ' + spEsc(r.name) + '</span><span>' + '★'.repeat(r.stars) + '</span></div><div class="t2">' + spEsc(r.comment) + '</div><div class="t2">الإداري: ' + spEsc(r.adminName || '-') + '</div></div>'; }).join('') : '');
            return;
        }
        var l = await spApi('/api/support/admin/tickets?status=' + SP.tab);
        var canDel = currentRole === 'super_admin' && SP.tab === 'closed';
        box.innerHTML = l.tickets.length ? (canDel ? '<button class="btn btn-red btn-full" style="margin-bottom:10px" onclick="spDeleteAllClosed()">🗑️ حذف كل التكتات المغلقة</button>' : '') + l.tickets.map(function (t) { return spRowHtml(t, 'admin', 'sp-admin-body', canDel); }).join('') : 'ما فيه تكتات هنا';
    } catch (e) { box.innerHTML = '<span style="color:#fca5a5">' + spEsc(e.message) + '</span>'; }
}
async function spRatingAdmin(uid, name) {
    var box = document.getElementById('spa-list');
    try { var d = await spApi('/api/support/admin/ratings/' + encodeURIComponent(uid)); box.innerHTML = '<button class="sp-link" onclick="spaLoadList()">‹ رجوع</button> <b>🛡️ ' + spEsc(name) + '</b>' + d.list.map(function (r) { return '<div class="sp-row" onclick="spOpenTicket(\'' + r.ticketId + '\',\'admin\',\'sp-admin-body\')"><div class="t1"><span>#' + r.no + ' — ' + spEsc(r.name) + '</span><span>' + '★'.repeat(r.stars) + '</span></div>' + (r.comment ? '<div class="t2">' + spEsc(r.comment) + '</div>' : '') + '</div>'; }).join(''); } catch (e) { bkToast(e.message, 'danger'); }
}
async function spUnban(id) { if (!(await spConfirm('تفك الحظر؟'))) return; try { await spApi('/api/support/admin/bans/' + id, { method: 'DELETE' }); spaLoadList(); } catch (e) { bkToast(e.message, 'danger'); } }
function loadAdminTicketsLog() { loadAdminSupport(); }

// عدّاد التكتات على الأزرار
async function spBadges() {
    try {
        var d = await spApi('/api/support/badges');
        var n = d.user || 0;
        ['nav-support'].forEach(function (id) { var b = document.getElementById(id); if (b) b.innerHTML = '🎧 خدمة العملاء' + (n ? ' <span class="sp-badge">' + n + '</span>' : ''); });
        if (d.admin) { var t = document.getElementById('atab-support'); if (t) t.innerHTML = '🎧 الدعم' + ((d.admin.waiting + d.admin.unread) ? ' <span class="sp-badge">' + (d.admin.waiting + d.admin.unread) + '</span>' : ''); }
    } catch (e) {}
}

// ═══════════ البطاقة الجديدة ═══════════
var BK_THEMES = {
    blue: ['#1d4ed8', '#0b1d4a', '#60a5fa'], green: ['#15803d', '#052e16', '#4ade80'], red: ['#b91c1c', '#450a0a', '#fca5a5'],
    gold: ['#b45309', '#3b1d03', '#fde047'], purple: ['#6d28d9', '#2e1065', '#c4b5fd'], black: ['#334155', '#020617', '#94a3b8']
};
function bkCardHtml(c, o) {
    o = o || {}; var th = BK_THEMES[c.cardColor] || BK_THEMES.blue;
    var exp = c.cardExpiry ? new Date(c.cardExpiry).toLocaleDateString('en-US', { month: '2-digit', year: '2-digit' }) : '--/--';
    var num = String(c.cardNumber || '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim() || '#### #### #### ####';
    var bg = 'background:radial-gradient(circle at 85% 0%,' + th[0] + ' 0%,' + th[1] + ' 75%);';
    var logo = '<svg viewBox="0 0 100 100" width="30" height="30" style="vertical-align:middle"><rect width="100" height="100" rx="22" fill="#fff"/><path transform="translate(10 10) scale(.8)" fill="#1d4ed8" d="M50 6 L92 30 H8 Z M16 38 h14 v38 h-14 Z M43 38 h14 v38 h-14 Z M70 38 h14 v38 h-14 Z M8 82 H92 V94 H8 Z"/></svg>';
    var front = '<div class="bk-face bk-front" style="' + bg + '"><div class="bk-shine"></div>' + (c.cardFrozen ? '<div class="bk-frozen">🔒 مجمّدة</div>' : '') +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-weight:900;letter-spacing:2px;color:' + th[2] + '">' + logo + ' FLASH BANK</span><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="' + th[2] + '" stroke-width="1.8" stroke-linecap="round"><path d="M8 8a6 6 0 0 1 0 8M12 5a10 10 0 0 1 0 14M16 2a14 14 0 0 1 0 20" transform="rotate(0 12 12)"/></svg></div>' +
        '<div class="bk-chip"></div><div class="bk-num">' + spEsc(num) + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="bk-lbl" style="color:' + th[2] + '">CARD HOLDER</div><div class="bk-val">' + spEsc(c.cardHolderName || '---') + '</div></div><div><div class="bk-lbl" style="color:' + th[2] + '">VALID THRU</div><div class="bk-val">' + exp + '</div></div><div class="bk-net"><i></i><i></i></div></div></div>';
    var back = '<div class="bk-face bk-back" style="' + bg + '"><div class="bk-mag"></div><div style="display:flex;align-items:center;gap:8px;margin:12px 14px 6px"><div class="bk-sig"></div><div class="bk-cvv">' + (o.showCvv && c.cardCVV ? spEsc(c.cardCVV) : '•••') + '</div></div>' +
        '<p style="font-size:.6rem;color:rgba(255,255,255,.75);margin:2px 14px;direction:rtl;text-align:right">🔐 الرقم السري غير مطبوع — احفظه ولا تعطيه أحد</p>' +
        '<div class="bk-game">⚠️ هذي بطاقة لعبة وليست بطاقة حقيقية — للاستخدام داخل اللعبة فقط<br><span style="font-family:Arial">THIS IS A GAME CARD — NOT A REAL BANK CARD</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 14px 0;color:rgba(255,255,255,.7);font-size:.55rem"><span>FLASH BANK</span><span>CUSTOMER SERVICE: IN-GAME</span></div></div>';
    return '<div class="bk-wrap ' + (c.cardFrozen ? 'bk-gray' : '') + '" onclick="this.classList.toggle(\'flip\')"><div class="bk-inner">' + front + back + '</div></div><p style="text-align:center;color:#64748b;font-size:.72rem;margin:4px 0 0">اضغط على البطاقة لقلبها</p><p style="text-align:center;color:#fca5a5;font-size:.74rem;margin:2px 0 0;font-weight:bold">⚠️ بطاقة لعبة وليست حقيقية</p>';
}
async function loadMyCards() {
    loadMilitaryOptions();
    var cards = await (await fetch('/api/account/cards')).json();
    var container = document.getElementById('cards-list-container');
    if (!cards.length) { container.innerHTML = '<div class="card" style="text-align:center;color:#64748b">لا توجد بطاقات بعد.</div>'; return; }
    var statusMap = { pending: '⏳ قيد المراجعة', approved: '✅ مفعّلة', rejected: '❌ مرفوضة', disabled: '🚫 معطّلة من الإدارة', expired: '⌛ منتهية الصلاحية' };
    var colorMap = { pending: '#fde047', approved: '#4ade80', rejected: '#fca5a5', disabled: '#ef4444', expired: '#94a3b8' };
    container.innerHTML = cards.map(function (c) {
        var isExpired = c.cardExpiry && new Date(c.cardExpiry) < new Date() && c.status === 'approved', status = isExpired ? 'expired' : c.status;
        var needsPin = c.status === 'approved' && c.cardNumber && !c.pinSet;
        var card = c.status === 'approved' && c.cardNumber && c.pinSet ? bkCardHtml(c, { showCvv: true }) : '';
        var pinSetup = needsPin ? '<div style="background:#0f1420;border:2px solid #ef4444;border-radius:16px;padding:18px;margin-top:12px;max-width:380px;text-align:center"><div style="font-size:3rem;color:#ef4444;line-height:1">🔐</div><p style="color:#fca5a5;font-weight:bold;margin:8px 0">عيّن رقمك السري لتفعيل البطاقة</p><p style="color:#94a3b8;font-size:.78rem;margin-bottom:10px">احفظه في بالك: ما يظهر لك ولا يطبع على البطاقة، وما يشوفه غير كبار المسؤولين.</p><button class="btn btn-red" style="width:100%" onclick="openPinPad(\'' + c._id + '\')">✅ تحديد الرقم السري</button></div>' : '';
        return '<div class="card" style="margin-bottom:14px;border-color:' + (colorMap[status] || '#3b82f6') + '"><b style="color:' + colorMap[status] + '">' + (statusMap[status] || status) + '</b>' +
            '<p style="color:#94a3b8;font-size:.85rem;margin-top:4px">' + (c.militaryRank ? ('الرتبة: ' + spEsc(c.militaryRank) + ' | القطاع: ' + spEsc(c.militarySector || '—') + ' | اليونت: ' + spEsc(c.militaryUnit || '—')) : '') + '</p>' +
            (c.adminNote ? '<p style="color:#60a5fa;font-size:.83rem;margin-top:4px">ملاحظة الإدارة: ' + spEsc(c.adminNote) + '</p>' : '') + card + pinSetup +
            (isExpired ? '<p style="color:#fca5a5;font-size:.78rem;margin-top:8px">⌛ البطاقة منتهية</p><button class="btn btn-yellow" style="margin-top:8px" onclick="renewCard(\'' + c._id + '\')">🔄 تجديد البطاقة</button>' : '') +
            (status === 'disabled' ? '<p style="color:#ef4444;font-size:.82rem;margin-top:8px">⚠️ تم تعطيل هذه البطاقة. تواصل مع خدمة العملاء.</p>' : '') + '</div>';
    }).join('');
}

// ── تحكم البطاقات (كبار المسؤولين): الرقم السري يعرضونه بزر ──
async function loadCardControlPanel() {
    var cards = await (await fetch('/api/superadmin/cards/control')).json();
    window.CC_CARDS = cards;
    var el = document.getElementById('card-control-container');
    if (!cards.length) { el.innerHTML = '<p style="color:#64748b; text-align:center; padding:20px;">لا توجد بطاقات مفعّلة حالياً.</p>'; return; }
    var names = { blue: 'أزرق', green: 'أخضر', red: 'أحمر', gold: 'ذهبي', purple: 'بنفسجي', black: 'أسود' };
    el.innerHTML = cards.map(function (c) {
        var id = c._id;
        return '<div class="card" style="margin-bottom:10px; ' + (c.cardFrozen ? 'border-color:#475569; opacity:0.85;' : 'border-color:#3b82f6;') + '">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;"><div>' +
            '<b>' + spEsc(c.discordTag) + '</b> <span style="color:#64748b; font-size:0.8rem;">' + spEsc(c.discord) + '</span>' +
            '<p style="margin-top:5px; color:#94a3b8; font-size:0.85rem;">رقم البطاقة: ' + spEsc(c.cardNumber || '---') + '</p>' +
            '<p style="color:#94a3b8; font-size:0.85rem;">اللون: ' + (names[c.cardColor] || c.cardColor) + '</p>' +
            '<p style="color:#94a3b8; font-size:0.85rem;">الانتهاء: ' + (c.cardExpiry ? spDate(c.cardExpiry) : '—') + '</p>' +
            '<p style="color:#94a3b8; font-size:0.85rem;">الرقم السري: ' + (c.pinSet && c.pinPlain ? '<b style="color:#fde047; letter-spacing:2px;">' + spEsc(c.pinPlain) + '</b>' : '<span style="color:#64748b;">لم يُعيَّن بعد</span>') + '</p>' +
            (c.cardFrozen ? '<p style="color:#fca5a5; font-size:0.82rem;">🔒 البطاقة مجمّدة حالياً</p>' : '') + (c.status === 'disabled' ? '<p style="color:#fca5a5; font-size:0.82rem;">🚫 معطّلة</p>' : '') + (c.locked ? '<p style="color:#fca5a5; font-size:0.82rem;">⛔ مقفولة بسبب محاولات خاطئة</p>' : '') +
            '</div><div style="display:flex; gap:6px; flex-direction:column; min-width:220px;">' +
            '<div style="display:flex; gap:6px;"><input id="cc-pin-' + id + '" placeholder="رقم سري جديد (4 أرقام)" maxlength="4" inputmode="numeric" style="padding:5px 8px; font-size:0.8rem; margin-bottom:0;" /><button class="btn btn-blue" style="padding:5px 10px;" onclick="ccChangePin(\'' + id + '\')">💾</button></div>' +
            '<button class="btn btn-blue" style="padding:5px 10px;" onclick="ccView(\'' + id + '\')">💳 عرض البطاقة</button>' +
            '<div style="display:flex; gap:6px;"><button class="btn ' + (c.cardFrozen ? 'btn-green' : 'btn-yellow') + '" style="padding:5px 10px; flex:1;" onclick="ccToggleFreeze(\'' + id + '\')">' + (c.cardFrozen ? '🔓 فك التجميد' : '🔒 تجميد') + '</button><button class="btn btn-red" style="padding:5px 10px;" onclick="ccDeleteCard(\'' + id + '\')">🗑️ حذف</button></div>' +
            '<button class="btn" id="cc-more-btn-' + id + '" style="padding:5px 10px; background:rgba(59,130,246,.2); border:1px solid #3b82f6;" onclick="document.getElementById(\'cc-more-' + id + '\').style.display = document.getElementById(\'cc-more-' + id + '\').style.display === \'none\' ? \'grid\' : \'none\'">🎛️ تحكم</button>' +
            '<div id="cc-more-' + id + '" style="display:none; grid-template-columns:1fr 1fr; gap:6px;">' +
            '<button class="btn btn-blue" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'color\')">🎨 تغيير اللون</button>' +
            '<button class="btn btn-blue" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'extend\')">📅 تمديد الصلاحية</button>' +
            '<button class="btn btn-yellow" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'reset-pin\')">🔄 إعادة تعيين السري</button>' +
            '<button class="btn btn-green" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'unlock\')">🔓 فك قفل المحاولات</button>' +
            '<button class="btn btn-yellow" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'disable\')">' + (c.status === 'disabled' ? '✅ تفعيل البطاقة' : '🚫 تعطيل البطاقة') + '</button>' +
            '<button class="btn btn-blue" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'notify\')">📨 إشعار للعضو</button>' +
            '<button class="btn btn-blue" style="padding:5px 6px; font-size:.78rem;" onclick="ccAct(\'' + id + '\',\'copy\',\'' + spEsc(c.cardNumber || '') + '\')">📋 نسخ الرقم</button>' +
            '<button class="btn btn-blue" style="padding:5px 6px; font-size:.78rem;" onclick="switchAdminTab(\'profile\'); setTimeout(function(){ pfOpen(\'' + c.discord + '\'); }, 150)">🔎 ملف العضو</button>' +
            '</div><div id="cc-msg-' + id + '"></div></div></div></div>';
    }).join('');
}
function ccView(id) {
    var c = (window.CC_CARDS || []).filter(function (x) { return x._id === id; })[0]; if (!c) return;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="width:100%;max-width:400px;text-align:center"><p style="color:#e2e8f0;margin-bottom:6px">' + spEsc(c.discordTag) + '</p>' + bkCardHtml(c, { showCvv: false }) + '<button class="btn btn-blue" style="margin-top:14px;width:100%">إغلاق</button></div>';
    ov.onclick = function (e) { if (e.target === ov || e.target.tagName === 'BUTTON') ov.remove(); };
    document.body.appendChild(ov);
}
async function ccAct(id, a, extra) {
    var url = '/api/superadmin/cards/' + id + '/' + a, method = 'PUT', body = {};
    if (a === 'copy') { try { await navigator.clipboard.writeText(extra); bkToast('تم النسخ', 'success'); } catch (e) {} return; }
    if (a === 'color') { var c = await spAsk('اللون: blue / green / red / gold / purple / black', 'gold', 'تغيير'); if (!c) return; body.color = c.trim().toLowerCase(); }
    if (a === 'extend') { var d = await spAsk('كم يوم تمدد من الحين؟', '7', 'تمديد'); if (!d) return; body.days = d.trim(); }
    if (a === 'notify') { var m = await spAsk('اكتب الرسالة لصاحب البطاقة:', '', 'إرسال'); if (!m) return; body.message = m; method = 'POST'; }
    if (a === 'reset-pin' && !(await spConfirm('تعيد تعيين الرقم السري؟ العضو بيحدد رقم جديد.'))) return;
    if (a === 'disable') { url = '/api/admin/cards/' + id + '/toggle-disable'; }
    var r = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' && a === 'disable' ? undefined : JSON.stringify(body) });
    var data = await r.json().catch(function () { return {}; });
    bkToast(data.msg || (data.success ? 'تم' : 'فشل'), data.success ? 'success' : 'danger'); loadCardControlPanel();
}
async function ccShowPin(id) {
    var d = await spApi('/api/superadmin/cards/' + id + '/pin').catch(function (e) { return { success: false, msg: e.message }; });
    uiAlert(d.success ? (d.pin ? '🔐 الرقم السري: ' + d.pin + '\n(مسجّل في اللوق إنك عرضته)' : 'ما عيّن رقم سري بعد') : d.msg);
}
async function ccChangePin(id) {
    var pin = await spAsk('اكتب الرقم السري الجديد (4 أرقام):', '0000', 'حفظ');
    if (pin === null) return; pin = pin.trim();
    if (!/^\d{4}$/.test(pin)) return bkToast('لازم 4 أرقام', 'warning');
    var d = await spApi('/api/superadmin/cards/' + id + '/pin', { method: 'PUT', body: { pin: pin } }).catch(function (e) { return { msg: e.message }; });
    bkToast(d.msg || 'تم', d.success ? 'success' : 'danger'); loadCardControlPanel();
}

// ═══════════ ملف العضو (كبار المسؤولين) ═══════════
function loadProfilePanel() {
    document.getElementById('profile-container').innerHTML = '<div class="card card-blue"><h2>🔎 ملف عضو</h2><input id="pf-q" placeholder="ابحث بالاسم أو رقم الحساب..." autocomplete="off" oninput="pfSearch()"><div id="pf-res"></div></div><div id="pf-out"></div>';
}
var pfT = null;
function pfSearch() {
    clearTimeout(pfT);
    pfT = setTimeout(async function () {
        var q = document.getElementById('pf-q').value.trim(), box = document.getElementById('pf-res');
        if (q.length < 2) { box.innerHTML = ''; return; }
        var l = await (await fetch('/api/admin/account-search?q=' + encodeURIComponent(q))).json();
        box.innerHTML = l.map(function (a) { return '<div class="sp-row" onclick="pfOpen(\'' + a.uid + '\')"><div class="t1"><span>👤 ' + spEsc(a.name) + '</span><span>' + spEsc(a.accountNumber) + '</span></div></div>'; }).join('') || '<p style="color:#64748b">ما لقيت أحد</p>';
    }, 300);
}
async function pfOpen(uid) {
    var out = document.getElementById('pf-out'); out.innerHTML = '<div class="card">جارِ التحميل...</div>';
    var d = await spApi('/api/superadmin/profile/' + uid).catch(function (e) { return { success: false, msg: e.message }; });
    if (!d.success) { out.innerHTML = '<div class="card" style="color:#fca5a5">' + spEsc(d.msg) + '</div>'; return; }
    var a = d.account, f = d.flash, row = function (l, v) { return '<div class="sp-ir"><span>' + l + '</span><span>' + spEsc(v == null || v === '' ? '—' : v) + '</span></div>'; };
    var tx = function (t) { return t ? (t.amount || 0).toLocaleString() + ' $ — ' + spDate(t.createdAt) + (t.note ? ' — ' + t.note : '') : 'لا يوجد'; };
    var h = '<div class="card"><h2>🏦 الحساب البنكي الآن</h2>' + row('الاسم', a.discordTag) + row('رقم الحساب', a.accountNumber) + row('الرصيد الجاري', (a.balance || 0).toLocaleString() + ' $') + row('رصيد التوفير', (a.savingsBalance || 0).toLocaleString() + ' $') + row('الحالة', a.isFrozen ? '🔒 مجمّد' : '✅ نشط') + row('محظور من الدعم', a.supportBanned ? 'نعم' : 'لا') + row('تاريخ الفتح', spDate(a.createdAt)) +
        '<button class="btn ' + (a.isFrozen ? 'btn-green' : 'btn-yellow') + '" style="margin-top:8px" onclick="pfFreeze(\'' + a._id + '\',\'' + uid + '\')">' + (a.isFrozen ? '🔓 فك تجميد الحساب' : '🔒 تجميد الحساب') + '</button></div>';
    h += '<div class="card"><h2>⚡ حسابه في فلاش الآن</h2>' + (f ? row('الاسم', f.name) + row('الرتبة', f.rank) + row('اليونت', f.unit) + row('القطاع', f.sector) + row('النقاط', f.points) + row('رقم البطاقة العسكرية', f.cardNumber) + row('البطاقة', f.revoked ? '🚫 ملغاة' : '✅ سارية') + row('الحالة', f.blocked ? '⛔ موقوف' : 'نشط') : '<p style="color:#64748b">تعذر جلب بيانات فلاش (أو ما له ملف).</p>') + '</div>';
    h += '<div class="card"><h2>💳 بطاقاته</h2>' + (d.cards.length ? d.cards.map(function (c) {
        return (c.cardNumber ? bkCardHtml(c, { showCvv: false }) : '') + '<div style="margin:8px 0 14px">' + row('الحالة', { pending: '⏳ قيد المراجعة', approved: '✅ مفعّلة', rejected: '❌ مرفوضة', disabled: '🚫 معطّلة' }[c.status] || c.status) + row('الانتهاء', c.cardExpiry ? spDate(c.cardExpiry) : '—') + row('التجميد', c.cardFrozen ? 'مجمّدة' : 'لا') + row('الرقم السري', c.pinSet ? 'معيّن' : 'لم يُعيَّن') + row('تاريخ الطلب', spDate(c.requestedAt)) +
            (c.pinSet ? '<button class="btn btn-blue" style="margin-top:6px;padding:5px 10px" onclick="ccShowPin(\'' + c._id + '\')">👁️ عرض الرقم السري</button>' : '') + '</div>';
    }).join('') : '<p style="color:#64748b">ما عنده بطاقات.</p>') + '</div>';
    h += '<div class="card"><h2>💸 الحوالات</h2>' + row('📥 آخر حوالة واردة', tx(d.lastIn)) + row('📤 آخر حوالة صادرة', tx(d.lastOut)) +
        '<h3 style="margin:12px 0 6px;color:#60a5fa;font-size:.95rem">سجل الحركات (آخر ' + d.txs.length + ')</h3>' + (d.txs.map(function (t) { var out = t.fromAccount === a.accountNumber; return '<div class="sp-row" style="cursor:default"><div class="t1"><span style="color:' + (out ? '#fca5a5' : '#4ade80') + '">' + (out ? '📤 ' : '📥 ') + (t.amount || 0).toLocaleString() + ' $</span><span style="font-size:.75rem;color:#64748b">' + spDate(t.createdAt) + '</span></div><div class="t2">' + spEsc(t.type || '') + (t.note ? ' — ' + spEsc(t.note) : '') + ' ' + spEsc(out ? (t.toAccount ? '← ' + t.toAccount : '') : (t.fromAccount ? '→ ' + t.fromAccount : '')) + '</div></div>'; }).join('') || '<p style="color:#64748b">لا توجد حركات.</p>') + '</div>';
    if (d.loans.length) h += '<div class="card"><h2>📋 القروض</h2>' + d.loans.map(function (l) { return row(spDate(l.requestedAt) + ' — ' + l.status, (l.amount || 0).toLocaleString() + ' $ (متبقي ' + (l.remaining || 0).toLocaleString() + ')'); }).join('') + '</div>';
    out.innerHTML = h;
}
async function pfFreeze(id, uid) { await fetch('/api/admin/accounts/' + id + '/freeze', { method: 'PUT' }); pfOpen(uid); }

// ═══════════ سجل البنك: حذف كامل + سحب لليمين للمالك ═══════════
async function loadBankLog() {
    var d = await (await fetch('/api/superadmin/logs')).json();
    var logs = d.list || [], el = document.getElementById('bank-log-container');
    var clr = d.logClearAvailable ? '<div class="card" style="border-color:#7f1d1d;display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b style="color:#f87171">🗑️ حذف اللوق الشامل</b><div style="font-size:.78rem;color:#94a3b8">يشتغل مرة وحدة بس، وبعدها الزر يختفي.</div></div><button class="btn btn-red" onclick="clearAllBankLogs()">حذف اللوق</button></div>' : '';
    var colors = { register: '#4ade80', transfer: '#60a5fa', loan_approve: '#4ade80', loan_reject: '#fca5a5', card_approve: '#4ade80', card_reject: '#fca5a5', manual_deposit: '#4ade80', manual_deduct: '#fca5a5', card_pin_view: '#fde047', support_ban: '#f87171' };
    el.innerHTML = clr + (logs.length ? logs.map(function (l) {
        return '<div class="bk-log" data-lid="' + l._id + '" style="padding:8px 12px;border-right:3px solid ' + (colors[l.action] || '#64748b') + ';background:rgba(255,255,255,.03);border-radius:6px;margin-bottom:6px"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px"><span style="color:' + (colors[l.action] || '#94a3b8') + ';font-size:.8rem;font-weight:bold">' + spEsc(String(l.action || '').replace(/_/g, ' ').toUpperCase()) + '</span><span style="color:#475569;font-size:.75rem">' + spDate(l.createdAt) + '</span></div><p style="font-size:.83rem;margin-top:3px">' + spEsc(l.description) + '</p>' + (l.performedByTag ? '<p style="color:#64748b;font-size:.75rem">بواسطة: ' + spEsc(l.performedByTag) + '</p>' : '') + '</div>';
    }).join('') : '<p style="color:#64748b;text-align:center;padding:20px">لا توجد أحداث مسجلة.</p>');
    if (d.canSwipe) bkBindSwipe(el);
}
async function clearAllBankLogs() {
    if (!(await spConfirm('⚠️ بيتحذف كل اللوق نهائياً، والزر ما يرجع بعدها. متأكد؟'))) return;
    var d = await spApi('/api/superadmin/logs/clear', { method: 'POST', body: {} }).catch(function (e) { return { success: false, msg: e.message }; });
    bkToast(d.success ? 'تم حذف اللوق' : d.msg, d.success ? 'success' : 'danger'); loadBankLog();
}
function bkBindSwipe(c) {
    Array.prototype.forEach.call(c.querySelectorAll('.bk-log[data-lid]'), function (el) {
        var sx = 0, sy = 0, dx = 0, on = false; el.style.touchAction = 'pan-y';
        el.addEventListener('pointerdown', function (e) { on = true; sx = e.clientX; sy = e.clientY; dx = 0; el.style.transition = 'none'; try { el.setPointerCapture(e.pointerId); } catch (x) {} });
        el.addEventListener('pointermove', function (e) {
            if (!on) return; dx = e.clientX - sx;
            if (Math.abs(e.clientY - sy) > Math.abs(dx) + 12) { on = false; el.style.transform = ''; el.style.opacity = ''; return; }
            if (dx > 0) { el.style.transform = 'translateX(' + dx + 'px)'; el.style.opacity = String(Math.max(.25, 1 - dx / 300)); }
        });
        var end = async function () {
            if (!on) return; on = false; el.style.transition = 'transform .2s,opacity .2s';
            if (dx < 120) { el.style.transform = ''; el.style.opacity = ''; return; }
            el.style.transform = 'translateX(110%)'; el.style.opacity = '0';
            try { await spApi('/api/superadmin/logs/' + el.dataset.lid, { method: 'DELETE' }); setTimeout(function () { el.remove(); }, 200); }
            catch (e) { el.style.transform = ''; el.style.opacity = ''; }
        };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    });
}

// ═══════════ التحديث التلقائي (بدون منطق التذاكر القديم) ═══════════
var pollInterval = null, adminPollInterval = null, lastSeenActivity = 0, lastSeenAdminActivity = 0, lastUnreadCount = null, spTick = 0;
function startUserPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async function () {
        try {
            var data = await (await fetch('/api/poll/user')).json();
            if (!data || !Object.keys(data).length) return;
            if (data.unreadCount !== undefined && data.unreadCount !== lastUnreadCount) { lastUnreadCount = data.unreadCount; loadNotifCount(); }
            if (data.latestUnreadId !== undefined) handleNotifPush(data.latestUnreadId);
            if (currentAccount && (data.balance !== undefined || data.isFrozen !== undefined)) {
                var ch = currentAccount.balance !== data.balance || currentAccount.savingsBalance !== data.savingsBalance || currentAccount.isFrozen !== data.isFrozen;
                currentAccount.balance = data.balance; currentAccount.savingsBalance = data.savingsBalance; currentAccount.isFrozen = data.isFrozen;
                if (ch) loadDashboard();
            }
            if (data.lastActivity) { if (lastSeenActivity && data.lastActivity !== lastSeenActivity) silentRefreshCurrentPage(); lastSeenActivity = data.lastActivity; }
            if (pendingSilentRefresh) silentRefreshCurrentPage();
            if (++spTick % 4 === 0) spBadges();
        } catch (e) {}
    }, 2500);
    spBadges();
}
function startAdminPolling() {
    if (adminPollInterval) clearInterval(adminPollInterval);
    adminPollInterval = setInterval(async function () {
        try {
            var data = await (await fetch('/api/poll/admin')).json();
            if (!data || !Object.keys(data).length) return;
            var ch = data.lastActivity && lastSeenAdminActivity && data.lastActivity !== lastSeenAdminActivity;
            if (ch) {
                [['accounts', 'loadAdminAccounts'], ['loans', 'loadAdminLoans'], ['cards', 'loadAdminCards'], ['bank-log', 'loadBankLog']].forEach(function (p) {
                    var s = document.getElementById('atab-' + p[0] + '-section');
                    if (s && s.style.display !== 'none' && typeof window[p[1]] === 'function') window[p[1]]();
                });
            }
            if (data.lastActivity) lastSeenAdminActivity = data.lastActivity;
        } catch (e) {}
    }, 3000);
}
// ربط تبويب ملف العضو + تحديث ظهور التبويبات
(function () {
    var _sw = switchAdminTab;
    switchAdminTab = function (tab) {
        _sw(tab);
        ['profile'].forEach(function (t) { var b = document.getElementById('atab-' + t), s = document.getElementById('atab-' + t + '-section'); if (b) b.classList.toggle('active', t === tab); if (s) s.style.display = t === tab ? 'block' : 'none'; });
        if (tab === 'profile') loadProfilePanel();
    };
})();
`;

const BANK_EXT2_JS = String.raw`
// ═══════════ إضافات: ألوان بأزرار، CVV للكبار، مرفوضات، قروض نشطة، تمويل الرواتب، أدوات المالك ═══════════
var BK2_COLORS = [
    ['blue', 'أزرق', '#1d4ed8'], ['green', 'أخضر', '#15803d'], ['red', 'أحمر', '#b91c1c'],
    ['gold', 'ذهبي', '#b45309'], ['purple', 'بنفسجي', '#6d28d9'], ['black', 'أسود', '#1e293b']
];
function bk2IsSenior() { try { return currentRole === 'super_admin'; } catch (e) { return false; } }
function bk2Esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function bk2Overlay(inner, z) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:' + (z || 99990) + ';background:rgba(2,8,20,.78);display:flex;align-items:center;justify-content:center;padding:14px;direction:rtl';
    ov.innerHTML = '<div class="bk2-box" style="background:#0f1a2e;border:1px solid #1e3a5f;border-radius:16px;width:100%;max-width:440px;max-height:88vh;overflow-y:auto;padding:16px;color:#e2e8f0">' + inner + '</div>';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    return ov;
}
async function bk2Json(url, opts) {
    try {
        var o = opts || {};
        if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}); }
        var r = await fetch((window.BANK_BASE || '') + url, o);
        return await r.json();
    } catch (e) { return { success: false, msg: 'تعذر الاتصال' }; }
}

// ── اختيار لون البطاقة بأزرار ──
function bk2SwatchesHtml(sel) {
    return BK2_COLORS.map(function (c) {
        return '<button type="button" data-c="' + c[0] + '" style="display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:2px solid ' + (sel === c[0] ? '#fff' : 'transparent') + ';border-radius:12px;padding:6px 8px;cursor:pointer;color:#cbd5e1;font-size:.75rem">' +
            '<span style="width:44px;height:28px;border-radius:7px;background:linear-gradient(135deg,' + c[2] + ',#020617);display:block"></span>' + c[1] + '</button>';
    }).join('');
}
function bkPickColor(cur) {
    return new Promise(function (resolve) {
        var ov = bk2Overlay('<h3 style="margin-bottom:10px;color:#60a5fa">🎨 اختر لون البطاقة</h3><div id="bk2-sw" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">' + bk2SwatchesHtml(cur) + '</div><button class="btn" id="bk2-sw-x" style="margin-top:12px;width:100%;background:#334155">إلغاء</button>');
        var done = false;
        function fin(v) { if (done) return; done = true; ov.remove(); resolve(v); }
        ov.querySelectorAll('#bk2-sw button').forEach(function (b) { b.onclick = function () { fin(b.getAttribute('data-c')); }; });
        ov.querySelector('#bk2-sw-x').onclick = function () { fin(null); };
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) fin(null); });
    });
}
// تحويل قائمة اللون (select) في طلبات البطاقات إلى أزرار
function bk2Swatchify(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('select[id^="card-color-"]'), function (sel) {
        if (sel.getAttribute('data-sw')) return;
        sel.setAttribute('data-sw', '1'); sel.style.display = 'none';
        var box = document.createElement('div');
        box.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
        box.innerHTML = bk2SwatchesHtml(sel.value);
        box.querySelectorAll('button').forEach(function (b) {
            b.onclick = function () {
                sel.value = b.getAttribute('data-c');
                box.querySelectorAll('button').forEach(function (x) { x.style.borderColor = 'transparent'; });
                b.style.borderColor = '#fff';
            };
        });
        sel.parentNode.appendChild(box);
    });
}
(function () {
    // تغيير اللون من لوحة تحكم البطاقات
    var _ccAct = ccAct;
    ccAct = async function (id, a, extra) {
        if (a === 'color') {
            var cc = (window.CC_CARDS || []).filter(function (x) { return x._id === id; })[0];
            var c = await bkPickColor(cc && cc.cardColor); if (!c) return;
            var d = await bk2Json('/api/superadmin/cards/' + id + '/color', { method: 'PUT', body: { color: c } });
            bkToast(d.msg || (d.success ? 'تم' : 'فشل'), d.success ? 'success' : 'danger'); loadCardControlPanel(); return;
        }
        return _ccAct(id, a, extra);
    };
    // CVV يظهر للكبار على البطاقة وفي لوحة التحكم
    var _bk = bkCardHtml;
    bkCardHtml = function (c, o) { o = o || {}; if (bk2IsSenior() && c && c.cardCVV) o.showCvv = true; return _bk(c, o); };
    ccView = function (id) {
        var c = (window.CC_CARDS || []).filter(function (x) { return x._id === id; })[0]; if (!c) return;
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:16px';
        ov.innerHTML = '<div style="width:100%;max-width:400px;text-align:center"><p style="color:#e2e8f0;margin-bottom:6px">' + spEsc(c.discordTag) + '</p>' + bkCardHtml(c, { showCvv: true }) + '<button class="btn btn-blue" style="margin-top:14px;width:100%">إغلاق</button></div>';
        ov.onclick = function (e) { if (e.target === ov || e.target.tagName === 'BUTTON') ov.remove(); };
        document.body.appendChild(ov);
    };
    var _lcc = loadCardControlPanel;
    loadCardControlPanel = async function () {
        await _lcc();
        (window.CC_CARDS || []).forEach(function (c) {
            if (!c.cardCVV) return;
            var inp = document.getElementById('cc-pin-' + c._id); if (!inp) return;
            var card = inp.closest('.card'); if (!card) return;
            var ps = card.querySelectorAll('p'), anchor = null;
            Array.prototype.forEach.call(ps, function (p) { if (p.textContent.indexOf('الرقم السري') === 0) anchor = p; });
            if (anchor) anchor.insertAdjacentHTML('afterend', '<p style="color:#94a3b8;font-size:0.85rem;">CVV: <b style="color:#fde047;letter-spacing:2px;">' + bk2Esc(c.cardCVV) + '</b></p>');
        });
    };
    // طلبات البطاقات: ألوان بأزرار + قسم المرفوضات (للكبار)
    var _lac = loadAdminCards;
    loadAdminCards = async function () {
        await _lac();
        var cont = document.getElementById('admin-cards-container'); if (!cont) return;
        bk2Swatchify(cont);
        if (!bk2IsSenior()) return;
        var list = await fetch((window.BANK_BASE || '') + '/api/superadmin/cards/rejected').then(function (r) { return r.json(); }).catch(function () { return []; });
        var old = document.getElementById('bk2-rejected'); if (old) old.remove();
        var box = document.createElement('div'); box.id = 'bk2-rejected'; box.style.marginTop = '18px';
        var h = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap"><h3 style="color:#fca5a5">❌ البطاقات المرفوضة (' + list.length + ')</h3>' +
            (list.length ? '<button class="btn btn-red" style="padding:5px 10px" onclick="bk2ClearRejected()">🗑️ حذف الكل</button>' : '') + '</div>';
        if (!list.length) h += '<p style="color:#64748b;text-align:center;padding:12px">ما فيه بطاقات مرفوضة.</p>';
        h += list.map(function (c) {
            return '<div class="card" style="margin-bottom:8px;border-color:#7f1d1d"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap"><div>' +
                '<b>' + bk2Esc(c.discordTag) + '</b> <span style="color:#64748b;font-size:.78rem">' + bk2Esc(c.discord) + '</span>' +
                '<p style="color:#94a3b8;font-size:.82rem;margin-top:4px">🎖️ ' + bk2Esc(c.militaryRank || '—') + ' | 🛡️ ' + bk2Esc(c.militarySector || '—') + ' | 🧩 ' + bk2Esc(c.militaryUnit || '—') + '</p>' +
                (c.adminNote ? '<p style="color:#fca5a5;font-size:.8rem">' + bk2Esc(c.adminNote) + '</p>' : '') +
                '<p style="color:#64748b;font-size:.75rem">' + spDate(c.reviewedAt || c.requestedAt) + '</p></div>' +
                '<button class="btn btn-red" style="padding:5px 10px" onclick="bk2DelRejected(\'' + c._id + '\')">🗑️ حذف</button></div></div>';
        }).join('');
        box.innerHTML = h; cont.appendChild(box);
    };
})();
async function bk2DelRejected(id) {
    if (!(await uiConfirm('تحذف هذا الطلب المرفوض؟ بيختفي من عند العضو كذلك.', { title: '🗑️ حذف', danger: true, okText: 'احذف' }))) return;
    var d = await bk2Json('/api/superadmin/cards/rejected/' + id, { method: 'DELETE' });
    bkToast(d.success ? 'تم الحذف' : (d.msg || 'فشل'), d.success ? 'success' : 'danger'); loadAdminCards();
}
async function bk2ClearRejected() {
    if (!(await uiConfirm('تحذف كل البطاقات المرفوضة؟ بتنحذف من الجميع.', { title: '🗑️ حذف الكل', danger: true, okText: 'احذف الكل' }))) return;
    var d = await bk2Json('/api/superadmin/cards/rejected-clear', { method: 'POST', body: {} });
    bkToast(d.success ? 'تم حذف ' + d.deleted : (d.msg || 'فشل'), d.success ? 'success' : 'danger'); loadAdminCards();
}

// ── القروض: المعلّقة + النشطة لين الحين ──
loadAdminLoans = async function () {
    var loans = await fetch((window.BANK_BASE || '') + '/api/admin/loans').then(function (r) { return r.json(); }).catch(function () { return []; });
    var cont = document.getElementById('admin-loans-container'); if (!cont) return;
    var pending = loans.filter(function (l) { return l.status === 'pending'; });
    var active = loans.filter(function (l) { return l.status === 'approved' && (l.remaining || 0) > 0; });
    var totRem = active.reduce(function (s, l) { return s + (l.remaining || 0); }, 0);
    function exp(l) {
        return l.expiresAt ? '<p style="color:' + (new Date(l.expiresAt) < new Date() ? '#fca5a5' : '#fde047') + ';font-size:.78rem;margin-top:3px">⏳ ينتهي: ' + new Date(l.expiresAt).toLocaleDateString('ar-SA') + '</p>' : '<p style="color:#64748b;font-size:.78rem;margin-top:3px">⏳ بدون تاريخ انتهاء</p>';
    }
    var h = '<h3 style="color:#fde047;margin-bottom:8px">⏳ طلبات معلّقة (' + pending.length + ')</h3>';
    h += pending.length ? pending.map(function (l) {
        return '<div class="card card-yellow" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><div><b>' + bk2Esc(l.discordTag) + '</b>' +
            '<p style="margin-top:5px">المبلغ: <b style="color:#fde047">' + (l.amount || 0).toLocaleString() + ' $</b></p>' + exp(l) +
            '<p style="color:#64748b;font-size:.8rem">' + new Date(l.requestedAt).toLocaleString('ar-SA') + '</p></div>' +
            '<div style="display:flex;gap:6px"><button class="btn btn-green" style="padding:5px 10px" onclick="actionLoan(\'' + l._id + '\',\'approve\')">✅ موافقة</button><button class="btn btn-red" style="padding:5px 10px" onclick="actionLoan(\'' + l._id + '\',\'reject\')">❌ رفض</button></div></div></div>';
    }).join('') : '<p style="color:#64748b;text-align:center;padding:12px">لا توجد قروض معلقة.</p>';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px;flex-wrap:wrap;gap:6px"><h3 style="color:#4ade80">✅ قروض نشطة لين الحين (' + active.length + ')</h3><span style="color:#fca5a5;font-size:.85rem">إجمالي المتبقي: <b>' + totRem.toLocaleString() + ' $</b></span></div>';
    h += active.length ? active.map(function (l) {
        var paidPct = l.amount ? Math.max(0, Math.min(100, Math.round(((l.amount - (l.remaining || 0)) / l.amount) * 100))) : 0;
        return '<div class="card card-green" style="margin-bottom:10px"><b>' + bk2Esc(l.discordTag) + '</b>' +
            '<p style="margin-top:5px">المبلغ: <b style="color:#fde047">' + (l.amount || 0).toLocaleString() + ' $</b> — المتبقي: <b style="color:#fca5a5">' + (l.remaining || 0).toLocaleString() + ' $</b></p>' +
            '<div style="background:#0b1424;border-radius:6px;height:7px;margin-top:6px;overflow:hidden"><i style="display:block;height:100%;width:' + paidPct + '%;background:#4ade80"></i></div>' +
            '<p style="color:#64748b;font-size:.76rem;margin-top:3px">مسدّد ' + paidPct + '% — بدأ ' + (l.approvedAt ? new Date(l.approvedAt).toLocaleDateString('ar-SA') : '—') + '</p>' + exp(l) + '</div>';
    }).join('') : '<p style="color:#64748b;text-align:center;padding:12px">ما فيه قروض نشطة.</p>';
    cont.innerHTML = h;
};

// ── تمويل الرواتب (المالك يحدد الحساب، والباقي يشوفون الحالة فقط) ──
(function () {
    var _lms = loadMilitarySalaryPanel;
    loadMilitarySalaryPanel = async function () {
        await _lms();
        var sb = document.getElementById('military-salary-status'); if (!sb) return;
        var old = document.getElementById('ms-fund-box'); if (old) old.remove();
        var box = document.createElement('div'); box.id = 'ms-fund-box'; box.className = 'toggle-box'; box.style.cssText = 'display:block;margin-top:10px';
        sb.insertAdjacentElement('afterend', box);
        if (window.ownerPower) {
            var d = await bk2Json('/api/owner/salary-funding');
            box.innerHTML = '<b style="color:#fde047">💰 حساب تمويل الرواتب (تنسحب منه الرواتب وتنزل للعساكر)</b>' +
                '<p style="color:#94a3b8;font-size:.82rem;margin:6px 0">' + (d.fundAccount ? ('الحساب: <b>' + bk2Esc(d.name) + '</b> — ' + bk2Esc(d.fundAccount) + ' — الرصيد: <b>' + (d.balance || 0).toLocaleString() + ' $</b>') : '<span style="color:#fca5a5">ما تم تحديد حساب — الرواتب ما راح تنصرف لين تحدده.</span>') + '</p>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap"><input id="ms-fund-input" placeholder="رقم الحساب (6 أرقام)" maxlength="6" inputmode="numeric" value="' + bk2Esc(d.fundAccount || '') + '" style="width:170px;margin-bottom:0">' +
                '<button class="btn btn-green" onclick="bk2SaveFund()">💾 حفظ</button>' + (d.fundAccount ? '<button class="btn btn-red" onclick="bk2SaveFund(true)">إلغاء</button>' : '') + '</div><div id="ms-fund-msg" style="margin-top:6px"></div>';
        } else {
            var st = await fetch((window.BANK_BASE || '') + '/api/superadmin/military-salary/status').then(function (r) { return r.json(); }).catch(function () { return {}; });
            box.innerHTML = st.fundSet ? '<span style="color:#4ade80">💰 الرواتب تنسحب من حساب تمويل محدد ✅</span>' : '<span style="color:#fca5a5">⚠️ ما فيه حساب تمويل محدد (يحدده المالك) — الرواتب ما تنصرف.</span>';
        }
    };
})();
async function bk2SaveFund(clear) {
    var v = clear ? '' : (document.getElementById('ms-fund-input').value || '').trim();
    var d = await bk2Json('/api/owner/salary-funding', { method: 'POST', body: { accountNumber: v } });
    var m = document.getElementById('ms-fund-msg'); if (m) m.innerHTML = '<span style="color:' + (d.success ? '#4ade80' : '#fca5a5') + '">' + bk2Esc(d.msg || '') + '</span>';
    if (d.success) setTimeout(loadMilitarySalaryPanel, 700);
}

// ── الإشعارات: الإنذار يوصل أول ما يدخل (حتى لو جاه وهو برّا) مع صوت، ويستمر لين يضغط «فهمت» ──
var BK2_ACK = {};
(function () {
    var _show = showDangerModal;
    showDangerModal = function (title, text) {
        _show(title, text);
        try {
            var btn = document.querySelector('.dg-ov .dg-btn');
            if (btn && !btn.getAttribute('data-ack')) {
                btn.setAttribute('data-ack', '1');
                btn.addEventListener('click', function () {
                    var ids = Object.keys(BK2_ACK); BK2_ACK = {};
                    ids.forEach(function (id) { fetch((window.BANK_BASE || '') + '/api/notifications/' + id + '/read', { method: 'PUT' }).catch(function () {}); });
                    setTimeout(function () { try { loadNotifCount(); } catch (e) {} }, 400);
                });
            }
        } catch (e) {}
    };
    // مفتاح تشغيل الصوت: أول لمسة/نقرة تفتح الصوت (المتصفح يمنعه قبل كذا)
    function unlock() { try { var c = getDangerCtx(); if (c && c.state === 'suspended') c.resume(); } catch (e) {} }
    ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });
    var seenKey = 'bk2_seen_notifs';
    function seenSet() { try { return JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch (e) { return []; } }
    function seenSave(a) { try { localStorage.setItem(seenKey, JSON.stringify(a.slice(-60))); } catch (e) {} }
    handleNotifPush = async function (latestId) {
        if (notifBusy) return;
        if (notifBaseline && latestId === lastLatestUnread) return;
        notifBusy = true;
        try {
            var res = await fetch((window.BANK_BASE || '') + '/api/notifications');
            var list = await res.json();
            if (!Array.isArray(list)) return;
            lastLatestUnread = latestId;
            var first = !notifBaseline; notifBaseline = true;
            var seen = seenSet();
            var fresh = list.filter(function (n) { return !n.read && !toastedNotifIds.has(n._id); }).reverse();
            if (first) {
                // أول دخول: الإنذارات غير المقروءة تظهر فوراً بصوت، والباقي (آخر 10 دقايق وما انعرض قبل) كتوست
                fresh = fresh.filter(function (n) {
                    if (n.type === 'danger') return true;
                    return (Date.now() - new Date(n.createdAt).getTime() < 10 * 60 * 1000) && seen.indexOf(n._id) < 0;
                });
                list.forEach(function (n) { if (n.read || fresh.indexOf(n) < 0) toastedNotifIds.add(n._id); });
            }
            fresh.forEach(function (n) { toastedNotifIds.add(n._id); if (seen.indexOf(n._id) < 0) seen.push(n._id); });
            seenSave(seen);
            var danger = fresh.filter(function (n) { return n.type === 'danger'; });
            var others = fresh.filter(function (n) { return n.type !== 'danger'; });
            danger.forEach(function (n) { BK2_ACK[n._id] = 1; showNotifToast(n); });
            others.slice(-3).forEach(showNotifToast);
        } catch (e) {} finally { notifBusy = false; }
    };
    // رجع للتطبيق (من إشعار أو من تبويب ثاني): افحص فوراً
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && notifBaseline) { notifBusy = false; handleNotifPush('vis-' + Date.now()); }
    });
})();

// ── أدوات المالك داخل البنك (نفس أدوات فلاش المناسبة للبنك) + وضع التخفي ──
var BK2_LIVE = { timer: null };
async function bkOwnerInit() {
    if (!window.ownerPower || document.getElementById('bk2-owner-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'bk2-owner-bar';
    bar.style.cssText = 'position:fixed;bottom:92px;left:12px;z-index:4500;display:flex;flex-direction:column;gap:7px;direction:rtl';
    function b(bg, txt, fn, id) { return '<button ' + (id ? 'id="' + id + '" ' : '') + 'class="btn" style="background:' + bg + ';padding:7px 12px;font-size:.8rem;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.4)" onclick="' + fn + '">' + txt + '</button>'; }
    var toggle = '<button id="bk2-bar-toggle" class="btn" style="background:#1e293b;padding:7px 12px;font-size:.8rem;border-radius:10px;border:1px solid #334155" onclick="bk2BarToggle()">👑 المالك</button>';
    bar.innerHTML = '<div id="bk2-bar-btns" style="display:none;flex-direction:column;gap:7px">' +
        b('#0e7490', '🖥️ غرفة التحكم', 'bk2BarClose();openAdminPanel()') +
        b('#be123c', '📡 العمليات الحية', 'bk2BarClose();bk2OpenLive()') +
        b('#0369a1', '👥 الحسابات', 'bk2BarClose();openAdminPanel();switchAdminTab(\'accounts\')') +
        b('#1d4ed8', '🕹️ تحكم البطاقات', 'bk2BarClose();openAdminPanel();switchAdminTab(\'card-control\')') +
        b('#b45309', '💰 تمويل الرواتب', 'bk2BarClose();openAdminPanel();switchAdminTab(\'military-salary\')') +
        b('#374151', '👻 وضع التخفي', 'bk2ToggleStealth()', 'bk2-stealth-btn') +
        b('#b91c1c', '🚨 إغلاق البنك', 'bk2ToggleLock()', 'bk2-lock-btn') + '</div>' + toggle;
    document.body.appendChild(bar);
    var st = await bk2Json('/api/owner/stealth'); bk2PaintStealth(!!st.on);
    var se = await bk2Json('/api/admin/settings'); bk2PaintLock(!!(se && se.isMaintenance));
}
function bk2BarToggle() { var e = document.getElementById('bk2-bar-btns'); e.style.display = e.style.display === 'none' ? 'flex' : 'none'; }
function bk2BarClose() { var e = document.getElementById('bk2-bar-btns'); if (e) e.style.display = 'none'; }
function bk2PaintStealth(on) { var x = document.getElementById('bk2-stealth-btn'); if (!x) return; x.textContent = on ? '🙈 إيقاف التخفي' : '👻 وضع التخفي'; x.style.background = on ? '#6d28d9' : '#374151'; var t = document.getElementById('bk2-bar-toggle'); if (t) t.textContent = on ? '👻 المالك (متخفي)' : '👑 المالك'; }
function bk2PaintLock(on) { var x = document.getElementById('bk2-lock-btn'); if (!x) return; x.textContent = on ? '✅ فتح البنك' : '🚨 إغلاق البنك'; x.setAttribute('data-on', on ? '1' : '0'); }
async function bk2ToggleStealth() {
    var cur = await bk2Json('/api/owner/stealth'); var next = !cur.on;
    var d = await bk2Json('/api/owner/stealth', { method: 'POST', body: { on: next } });
    if (d.success) { bk2PaintStealth(next); bkToast(next ? '👻 وضع التخفي شغال' : '🙈 تم إيقاف التخفي', 'info'); }
}
async function bk2ToggleLock() {
    var x = document.getElementById('bk2-lock-btn'); var next = x.getAttribute('data-on') !== '1';
    if (next && !(await uiConfirm('🚨 بيتقفل البنك على الكل (صيانة) إلا كبار المسؤولين. متأكد؟', { title: 'إغلاق البنك', danger: true, okText: 'اقفل' }))) return;
    var d = await bk2Json('/api/admin/toggle-feature', { method: 'POST', body: { feature: 'isMaintenance', value: next } });
    if (d.success) { bk2PaintLock(next); bkToast(next ? '🚨 تم إغلاق البنك' : '✅ تم فتح البنك', 'info'); } else bkToast(d.msg || 'فشل', 'danger');
}
function bk2OpenLive() {
    var ov = bk2Overlay('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="color:#fca5a5">📡 العمليات الحية</h3><button class="btn" style="background:#334155;padding:4px 10px" id="bk2-live-x">✕</button></div><div id="bk2-live-feed" style="font-size:.8rem">جاري التحميل...</div>', 99992);
    function stop() { if (BK2_LIVE.timer) { clearInterval(BK2_LIVE.timer); BK2_LIVE.timer = null; } }
    ov.querySelector('#bk2-live-x').onclick = function () { stop(); ov.remove(); };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) stop(); });
    async function tick() {
        var feed = document.getElementById('bk2-live-feed'); if (!feed) { stop(); return; }
        var d = await bk2Json('/api/superadmin/logs');
        var logs = (d.list || []).slice(0, 40);
        feed.innerHTML = logs.length ? logs.map(function (l) {
            return '<div style="padding:5px 0;border-bottom:1px solid #1e293b"><span style="color:#64748b">' + spTime(l.createdAt) + '</span> <b style="color:#93c5fd">' + bk2Esc(String(l.action || '').replace(/_/g, ' ')) + '</b><div style="color:#cbd5e1">' + bk2Esc(l.description || '') + '</div></div>';
        }).join('') : '<p style="color:#64748b;text-align:center">لا شي بعد</p>';
    }
    stop(); tick(); BK2_LIVE.timer = setInterval(tick, 3000);
}

`;

const SUPER_ADMIN_IDS = ['1003511814140743825','1231269832201207808'];

// ── نظام التحديث اللحظي (Real-time activity signal) ──────────────────────
// أي عملية تغيّر رصيد/حساب/تذكرة تستدعي هذي الدالة، وكل الأطراف (الشخص
// نفسه، الطرف الثاني، الأدمن) يشوفون التحديث خلال أقرب دورة بولنق.
let lastBankActivity = Date.now();
let lastTicketActivity = Date.now();
function bumpActivity() { lastBankActivity = Date.now(); }
function bumpTicketActivity() { lastTicketActivity = Date.now(); bumpActivity(); }

async function initBankSettings() {
    let s = await BankSettings.findOne();
    if (!s) s = await BankSettings.create({});
    // أول تشغيل بعد التحديث: حذف سجل الإشعارات كامل (مرة وحدة بس)
    if (!s.notifWipeDone) { await Notification.deleteMany({}); await BankSettings.updateOne({}, { notifWipeDone: true }); console.log('🧹 تم حذف سجل الإشعارات'); }
    // البطاقات اللي انقبلت اليوم: تاريخ انتهائها بعد أسبوع من القبول (مرة وحدة)
    if (!s.cardExpiryBackfill) {
        const sod = new Date(Date.now() + 3 * 3600000); sod.setUTCHours(0, 0, 0, 0); const start = new Date(sod.getTime() - 3 * 3600000);
        const todays = await CardRequest.find({ status: 'approved', reviewedAt: { $gte: start }, cardNumber: { $ne: null } });
        for (const c of todays) await CardRequest.updateOne({ _id: c._id }, { cardExpiry: new Date(new Date(c.reviewedAt).getTime() + 7 * 24 * 60 * 60 * 1000) });
        await BankSettings.updateOne({}, { cardExpiryBackfill: true });
    }
    // تشفير أي رقم سري قديم كان محفوظ نص عادي
    const olds = await CardRequest.find({ cardPIN: { $nin: [null, ''] } });
    for (const c of olds) { await CardRequest.updateOne({ _id: c._id }, { cardPINEnc: encPin(c.cardPIN), cardPIN: null }); }
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
app.use(express.json({ limit: '8mb' }));
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

// المالك الحقيقي (مخفي): يجي علامته من فلاش عند الدخول، أو من BANK_OWNER_IDS
async function isTrueOwner(uid) {
    uid = String(uid);
    if ((process.env.BANK_OWNER_IDS || '').split(',').map(x => x.trim()).includes(uid)) return true;
    try { const fl = await FlashLink.findOne({ uid }, { isOwner: 1 }).lean(); return !!(fl && fl.isOwner); } catch (e) { return false; }
}
// الرقم السري للبطاقة: مشفّر AES-256-GCM (مو hash) عشان كبار المسؤولين بس يقدرون يعرضونه
const PIN_KEY = crypto.createHash('sha256').update('bank-pin|' + (process.env.BANK_PIN_KEY || INTERNAL_API_KEY || 'change-me-bank-pin-key')).digest();
function encPin(pin) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', PIN_KEY, iv);
    const enc = Buffer.concat([c.update(String(pin), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map(x => x.toString('base64')).join(':');
}
function decPin(str) {
    try {
        const [iv, tag, enc] = String(str || '').split(':').map(x => Buffer.from(x, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', PIN_KEY, iv); d.setAuthTag(tag);
        return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (e) { return null; }
}
function pinMatches(card, pin) {
    const real = decPin(card.cardPINEnc);
    if (real == null) return false;
    const a = Buffer.from(real), b = Buffer.from(String(pin));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const CARD_PUBLIC = '-cardPIN -cardPINEnc -pinFails -pinLockedUntil';
const CARD_ADMIN = CARD_PUBLIC + ' -cardCVV';
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

        if (p.owner) { try { await FlashLink.updateOne({ uid }, { $set: { stealth: true } }); } catch (e) {} }
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
        res.json({ loggedIn: true, user: req.user, role, hasAccount: !!account, maintenance: settings?.isMaintenance || false, flashRegistered, isOwner: await isBankOwner(req.user.id), ownerPower: await isTrueOwner(req.user.id) });
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
        if (card.pinLockedUntil && new Date(card.pinLockedUntil) > new Date()) return res.json({ success: false, msg: '🔒 البطاقة مقفولة مؤقتاً بسبب محاولات خاطئة، جرّب بعد شوي' });
        const normalizedStored = String(card.cardNumber).replace(/\s/g, '');
        if (normalizedStored !== normalizedInput || !pinMatches(card, cardPIN)) {
            const fails = (card.pinFails || 0) + 1;
            await CardRequest.updateOne({ _id: card._id }, { pinFails: fails >= 5 ? 0 : fails, pinLockedUntil: fails >= 5 ? new Date(Date.now() + 15 * 60000) : null });
            return res.json({ success: false, msg: 'رقم البطاقة أو الرقم السري غير صحيح' });
        }
        if (card.pinFails) await CardRequest.updateOne({ _id: card._id }, { pinFails: 0, pinLockedUntil: null });

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
        let transferFee = settings?.transferFee || 0;
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
        const hid = await hiddenOwnerUids(req.user.id);
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

// ═══════════════════════════════════════════════════════════════════════
// ✨ إضافات جديدة: التخفي، تمويل الرواتب من حساب المالك، البطاقات المرفوضة، تأكيد الإشعار
// ═══════════════════════════════════════════════════════════════════════

// ── المالك (مخفي): وسيط يسمح للمالك الحقيقي فقط ──
async function ownerOnly(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: 'يجب تسجيل الدخول' });
    if (await isTrueOwner(req.user.id)) return next();
    return res.status(403).json({ success: false, msg: 'غير مصرح' });
}

// ── وضع التخفي: لما المالك يدخل البنك من زر «بنك فلاش» يتخفّى تلقائياً ──
// المتخفي: ما ينسجل له شي في سجل البنك، ولا يظهر حسابه في قوائم/بحث الإدارة.
async function isStealthOwner(uid) {
    try {
        uid = String(uid);
        if (!(await isTrueOwner(uid))) return false;
        const fl = await FlashLink.findOne({ uid }, { stealth: 1 }).lean();
        return !!(fl && fl.stealth);
    } catch (e) { return false; }
}
async function hiddenOwnerUids(viewerUid) {
    try {
        if (viewerUid && await isTrueOwner(viewerUid)) return [];
        const list = await FlashLink.find({ stealth: true, isOwner: true }, { uid: 1 }).lean();
        const envIds = (process.env.BANK_OWNER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
        if (envIds.length) {
            const extra = await FlashLink.find({ uid: { $in: envIds }, stealth: true }, { uid: 1 }).lean();
            extra.forEach(x => list.push(x));
        }
        return Array.from(new Set(list.map(x => String(x.uid))));
    } catch (e) { return []; }
}
app.get('/api/owner/stealth', ownerOnly, async (req, res) => {
    const fl = await FlashLink.findOne({ uid: String(req.user.id) }, { stealth: 1 }).lean();
    res.json({ success: true, on: !!(fl && fl.stealth) });
});
app.post('/api/owner/stealth', ownerOnly, async (req, res) => {
    const on = !!(req.body || {}).on;
    await FlashLink.updateOne({ uid: String(req.user.id) }, { $set: { stealth: on } }, { upsert: true });
    res.json({ success: true, on });
});

// ── تأكيد قراءة إشعار واحد (نافذة الإنذار تضغط «فهمت» فيتعلّم مقروء) ──
app.put('/api/notifications/:id/read', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false });
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.json({ success: false });
        await Notification.updateOne({ _id: req.params.id, discord: req.user.id }, { read: true });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// ── تمويل الرواتب: حساب يحدده المالك فقط، الرواتب تنسحب منه وتنزل للعساكر ──
app.get('/api/owner/salary-funding', ownerOnly, async (req, res) => {
    try {
        const s = await getMilitarySalarySettings();
        let acc = null;
        if (s.fundAccount) acc = await Account.findOne({ accountNumber: s.fundAccount }, { discordTag: 1, accountNumber: 1, balance: 1 }).lean();
        res.json({ success: true, fundAccount: s.fundAccount || '', name: acc ? acc.discordTag : '', balance: acc ? acc.balance : 0 });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});
app.post('/api/owner/salary-funding', ownerOnly, async (req, res) => {
    try {
        const num = String((req.body || {}).accountNumber || '').trim();
        const s = await getMilitarySalarySettings();
        if (!num) {
            await MilitarySalarySettings.updateOne({ _id: s._id }, { fundAccount: '' });
            return res.json({ success: true, msg: 'تم إلغاء حساب التمويل (الرواتب ما تنصرف لين تحدد حساب)' });
        }
        const acc = await Account.findOne({ accountNumber: num });
        if (!acc) return res.json({ success: false, msg: 'رقم الحساب غير موجود' });
        await MilitarySalarySettings.updateOne({ _id: s._id }, { fundAccount: num });
        await BankLog.create({ action: 'salary_funding_set', description: 'تحديد حساب تمويل رواتب العساكر', performedBy: req.user.id, performedByTag: 'كبار المسؤولين' });
        res.json({ success: true, msg: '✅ تم تحديد حساب التمويل: ' + acc.discordTag + ' (' + acc.accountNumber + ')', name: acc.discordTag, balance: acc.balance });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── البطاقات المرفوضة (كبار المسؤولين): عرض + حذف، والحذف يشيلها من العضو كذلك ──
app.get('/api/superadmin/cards/rejected', isBankSuperAdmin, async (req, res) => {
    try {
        const list = await CardRequest.find({ status: 'rejected' }).select(CARD_ADMIN).sort({ reviewedAt: -1, requestedAt: -1 }).limit(300).lean();
        res.json(list);
    } catch (e) { res.json([]); }
});
app.delete('/api/superadmin/cards/rejected/:id', isBankSuperAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findOne({ _id: req.params.id, status: 'rejected' });
        if (!card) return res.json({ success: false, msg: 'الطلب غير موجود أو مو مرفوض' });
        await CardRequest.deleteOne({ _id: card._id });
        await BankLog.create({ action: 'card_delete', description: 'حذف طلب بطاقة مرفوض: ' + card.discordTag, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        bumpActivity();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});
app.post('/api/superadmin/cards/rejected-clear', isBankSuperAdmin, async (req, res) => {
    try {
        const r = await CardRequest.deleteMany({ status: 'rejected' });
        await BankLog.create({ action: 'card_delete', description: 'حذف كل الطلبات المرفوضة (' + (r.deletedCount || 0) + ')', performedBy: req.user.id, performedByTag: req.user.username });
        bumpActivity();
        res.json({ success: true, deleted: r.deletedCount || 0 });
    } catch (e) { res.json({ success: false, msg: e.message }); }
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
        fundSet: !!settings.fundAccount,
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
        const { paidCount, totalPaid, shortCount, noFund } = await payMilitarySalaries(chosen, settings, true);
        if (noFund) return res.json({ success: false, msg: "ما تم تحديد حساب تمويل الرواتب (يحدده المالك)" });
        if (!paidCount) return res.json({ success: false, msg: shortCount ? "رصيد حساب التمويل ما يكفي" : "ما تم الصرف: تأكد أن لهم حسابات غير مجمدة ورواتب محددة لرتبهم" });
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
        const limit = (acc.cardLimit !== -1 ? acc.cardLimit : (settings?.globalCardLimit ?? 1));
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
        const cards = await CardRequest.find({ discord: req.user.id }).select(CARD_PUBLIC).sort({ requestedAt: -1 });
        res.json(cards);
    } catch (e) { res.json([]); }
});

// عرض جميع طلبات البطاقات للأدمن
app.get('/api/admin/cards', isStaffOrAbove, async (req, res) => {
    try {
        const cards = await CardRequest.find({ status: 'pending' }).select(CARD_ADMIN).sort({ requestedAt: -1 });
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
                cardExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                pinSet: false,
                cardPIN: null, cardPINEnc: null, pinFails: 0, pinLockedUntil: null
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
        await CardRequest.findByIdAndUpdate(card._id, { cardPINEnc: encPin(pin), cardPIN: null, pinSet: true, pinFails: 0, pinLockedUntil: null });
        res.json({ success: true, msg: "✅ تم حفظ الرقم السري بنجاح — احفظه ولا تعطيه أحد، ما أحد يقدر يشوفه غير كبار المسؤولين" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// ── تحكم البطاقة (حق كبار المسؤولين فقط) ──────────────────────────────────
// عرض كل البطاقات المفعّلة (لصفحة تحكم كبار المسؤولين)
app.get('/api/superadmin/cards/control', isBankSuperAdmin, async (req, res) => {
    try {
        const raw = await CardRequest.find({ status: { $in: ['approved', 'disabled'] } }).select('-cardPIN -pinFails').sort({ reviewedAt: -1 }).lean();
        res.json(raw.map(c => { const o = Object.assign({}, c, { pinPlain: c.cardPINEnc ? decPin(c.cardPINEnc) : null, locked: !!(c.pinLockedUntil && new Date(c.pinLockedUntil) > new Date()) }); delete o.cardPINEnc; return o; }));
    } catch (e) { res.json([]); }
});

// عرض/تغيير الرقم السري لبطاقة معينة
app.put('/api/superadmin/cards/:id/pin', isBankSuperAdmin, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "يجب أن يتكون الرقم السري من 4 أرقام" });
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: "البطاقة غير موجودة" });
        await CardRequest.findByIdAndUpdate(card._id, { cardPINEnc: encPin(pin), cardPIN: null, pinSet: true, pinFails: 0, pinLockedUntil: null });
        await BankLog.create({ action: 'card_pin_change', description: `تغيير الرقم السري لبطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true, msg: "✅ تم تغيير الرقم السري" });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

// عرض الرقم السري (كبار المسؤولين فقط) — كل عرض ينسجل في اللوق
app.get('/api/superadmin/cards/:id/pin', isBankSuperAdmin, async (req, res) => {
    try {
        const card = await CardRequest.findById(req.params.id).select('discord discordTag pinSet cardPINEnc');
        if (!card) return res.json({ success: false, msg: 'البطاقة غير موجودة' });
        if (!card.pinSet || !card.cardPINEnc) return res.json({ success: true, pin: null });
        await BankLog.create({ action: 'card_pin_view', description: `عرض الرقم السري لبطاقة ${card.discordTag}`, performedBy: req.user.id, performedByTag: (await isTrueOwner(req.user.id)) ? 'كبار المسؤولين' : req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        res.json({ success: true, pin: decPin(card.cardPINEnc) });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});
// أزرار تحكم إضافية (كبار المسؤولين)
async function cardCtl(req, res, fn, logText) {
    try {
        const card = await CardRequest.findById(req.params.id);
        if (!card) return res.json({ success: false, msg: 'البطاقة غير موجودة' });
        const msg = await fn(card);
        await BankLog.create({ action: 'card_control', description: `${logText} — ${card.discordTag}`, performedBy: req.user.id, performedByTag: (await isTrueOwner(req.user.id)) ? 'كبار المسؤولين' : req.user.username, targetDiscord: card.discord, targetTag: card.discordTag });
        bumpActivity(); res.json({ success: true, msg: msg || 'تم' });
    } catch (e) { res.json({ success: false, msg: e.message }); }
}
app.put('/api/superadmin/cards/:id/color', isBankSuperAdmin, (req, res) => cardCtl(req, res, async card => {
    const c = String(req.body.color || ''); if (!['blue', 'green', 'red', 'gold', 'purple', 'black'].includes(c)) throw new Error('لون غير صالح');
    await CardRequest.updateOne({ _id: card._id }, { cardColor: c }); return '🎨 تم تغيير اللون';
}, 'تغيير لون بطاقة'));
app.put('/api/superadmin/cards/:id/reset-pin', isBankSuperAdmin, (req, res) => cardCtl(req, res, async card => {
    await CardRequest.updateOne({ _id: card._id }, { cardPINEnc: null, cardPIN: null, pinSet: false, pinFails: 0, pinLockedUntil: null });
    await Notification.create({ discord: card.discord, message: '🔐 تمت إعادة تعيين الرقم السري لبطاقتك — حدد رقم جديد من صفحة بطاقاتي.', type: 'warning' }); return '🔄 تمت إعادة التعيين، العضو يحدد رقم جديد';
}, 'إعادة تعيين الرقم السري'));
app.put('/api/superadmin/cards/:id/unlock', isBankSuperAdmin, (req, res) => cardCtl(req, res, async card => {
    await CardRequest.updateOne({ _id: card._id }, { pinFails: 0, pinLockedUntil: null }); return '🔓 تم فك قفل المحاولات';
}, 'فك قفل محاولات البطاقة'));
app.put('/api/superadmin/cards/:id/extend', isBankSuperAdmin, (req, res) => cardCtl(req, res, async card => {
    const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 7));
    await CardRequest.updateOne({ _id: card._id }, { cardExpiry: new Date(Date.now() + days * 86400000), ...(card.status === 'expired' ? { status: 'approved' } : {}) });
    await Notification.create({ discord: card.discord, message: `📅 تم تمديد صلاحية بطاقتك ${days} يوم.`, type: 'success' }); return `📅 تم التمديد ${days} يوم`;
}, 'تمديد صلاحية بطاقة'));
app.post('/api/superadmin/cards/:id/notify', isBankSuperAdmin, (req, res) => cardCtl(req, res, async card => {
    const m = String(req.body.message || '').trim().slice(0, 300); if (!m) throw new Error('اكتب الرسالة');
    await Notification.create({ discord: card.discord, message: '📢 بخصوص بطاقتك: ' + m, type: 'info' }); return '📨 تم إرسال الإشعار';
}, 'إشعار لصاحب بطاقة'));
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
        await BankTicket.deleteMany({ uid: userDiscordId });
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
        const hid = await hiddenOwnerUids(req.user.id);
        const accs = await Account.find({ $or: [{ discordTag: rx }, { accountNumber: rx }], ...(hid.length ? { discord: { $nin: hid } } : {}) }, { discord: 1, discordTag: 1, accountNumber: 1 }).limit(8).lean();
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
        const owner = await isTrueOwner(req.user.id);
        const logs = await BankLog.find().sort({ createdAt: -1 }).limit(200).lean();
        const ownerIds = new Set();
        for (const id of new Set(logs.map(l => l.performedBy).filter(Boolean))) if (await isTrueOwner(id)) ownerIds.add(String(id));
        const list = logs.map(l => (!owner && ownerIds.has(String(l.performedBy))) ? Object.assign(l, { performedBy: null, performedByTag: 'كبار المسؤولين' }) : l);
        const s = await BankSettings.findOne();
        res.json({ list, logClearAvailable: !(s && s.logClearUsed), canSwipe: owner });
    } catch (e) { res.json({ list: [], logClearAvailable: false, canSwipe: false }); }
});
// حذف اللوق كامل بضغطة زر (مرة وحدة، وبعدها الزر يختفي)
app.post('/api/superadmin/logs/clear', isBankSuperAdmin, async (req, res) => {
    const r = await BankSettings.updateOne({ logClearUsed: { $ne: true } }, { logClearUsed: true });
    if (!(r.modifiedCount ?? r.nModified)) return res.json({ success: false, msg: 'تم استخدام زر حذف اللوق من قبل' });
    await BankLog.deleteMany({});
    await BankLog.create({ action: 'log_clear', description: 'حذف اللوق الشامل', performedBy: req.user.id, performedByTag: (await isTrueOwner(req.user.id)) ? 'كبار المسؤولين' : req.user.username });
    res.json({ success: true });
});
// حذف سجل واحد (المالك فقط — بالسحب لليمين)
app.delete('/api/superadmin/logs/:id', isBankSuperAdmin, async (req, res) => {
    if (!(await isTrueOwner(req.user.id))) return res.status(403).json({ success: false, msg: 'غير مصرح' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.json({ success: false });
    await BankLog.deleteOne({ _id: req.params.id });
    res.json({ success: true });
});

// ── ملف العضو (كبار المسؤولين): بطاقته + حوالاته + حسابه في فلاش وفي البنك ──
app.get('/api/superadmin/profile/:uid', isBankSuperAdmin, async (req, res) => {
    try {
        const uid = String(req.params.uid);
        const acc = await Account.findOne({ discord: uid }).lean();
        if (!acc) return res.json({ success: false, msg: 'ما له حساب بنكي' });
        const cards = await CardRequest.find({ discord: uid }).select(CARD_PUBLIC).sort({ requestedAt: -1 }).lean();
        const pinState = await CardRequest.find({ discord: uid }, { pinSet: 1 }).lean();
        const q = { $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] };
        const txs = await Transaction.find(q).sort({ createdAt: -1 }).limit(100).lean();
        const lastIn = await Transaction.findOne({ type: 'transfer', toAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean();
        const lastOut = await Transaction.findOne({ type: 'transfer', fromAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean();
        const loans = await Loan.find({ discord: uid }).sort({ requestedAt: -1 }).limit(5).lean();
        let flash = null; try { const d = await flashGet('/api/bank/member-card?uid=' + encodeURIComponent(uid)); if (d && d.success && d.found) flash = d; } catch (e) {}
        const role = await getBankRole(uid);
        res.json({ success: true, account: acc, cards, txs, lastIn, lastOut, loans, flash, role: role === 'super_admin' ? 'user' : role });
    } catch (e) { res.json({ success: false, msg: e.message }); }
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

// ── API: polling للمستخدم (تحديث تلقائي) ──
app.get('/api/poll/user', checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({});
    try {
        const acc = await Account.findOne({ discord: req.user.id });
        const unreadCount = await Notification.countDocuments({ discord: req.user.id, read: false });
        const latestUnread = await Notification.findOne({ discord: req.user.id, read: false }).sort({ createdAt: -1 }).select('_id');
        res.json({ balance: acc?.balance, savingsBalance: acc?.savingsBalance, isFrozen: acc?.isFrozen, unreadCount, latestUnreadId: latestUnread ? String(latestUnread._id) : null, lastActivity: lastBankActivity, lastTicketActivity });
    } catch (e) { res.json({}); }
});
app.get('/api/poll/admin', isStaffOrAbove, async (req, res) => {
    try {
        const openTickets = await BankTicket.countDocuments({ status: 'waiting' });
        const pendingLoans = await Loan.countDocuments({ status: 'pending' });
        const pendingCards = await CardRequest.countDocuments({ status: 'pending' });
        res.json({ openTickets, pendingLoans, pendingCards, lastActivity: lastBankActivity, lastTicketActivity });
    } catch (e) { res.json({}); }
});

// ════════════════════════════════════════════════════════════════════════
// 🎧 نظام خدمة العملاء (منقول من فلاش): مساعد آلي ← عضو حقيقي ← استلام ← إغلاق ← تقييم
// ════════════════════════════════════════════════════════════════════════
const SUPPORT_CATEGORIES = ['مشكلة في الحساب', 'التحويلات', 'القروض', 'البطاقة البنكية', 'التوفير', 'مخالفة / سداد', 'اقتراح', 'أخرى'];
const SUPPORT_PLACES = {
    'مشكلة في الحساب': ['الرصيد', 'الحساب مجمّد', 'كشف الحساب', 'رقم الحساب', 'أخرى'],
    'التحويلات': ['حوالة ما وصلت', 'حوالة بالغلط', 'رسوم التحويل', 'تحويل ما يشتغل', 'أخرى'],
    'القروض': ['طلب قرض', 'حالة الطلب', 'سداد القرض', 'انتهاء القرض', 'أخرى'],
    'البطاقة البنكية': ['طلب بطاقة', 'الرقم السري', 'تجديد البطاقة', 'بطاقة مجمّدة / معطّلة', 'أخرى'],
    'التوفير': ['إيداع', 'سحب', 'الفائدة', 'أخرى'],
    'مخالفة / سداد': ['سداد مخالفة بالبطاقة', 'خُصم مبلغ غلط', 'أخرى'],
    'اقتراح': ['التحويلات', 'البطاقات', 'القروض', 'أخرى']
};
const BankTicket = mongoose.model('BankTicket', new mongoose.Schema({
    no: { type: Number, index: true },
    uid: { type: String, index: true },
    name: String, accountNumber: String,
    category: String, place: String, subject: String,
    status: { type: String, default: 'ai' }, // ai / waiting / active / closed
    adminUid: { type: String, default: null }, adminName: { type: String, default: null },
    unreadUser: { type: Number, default: 0 }, unreadAdmin: { type: Number, default: 0 },
    ratingRequired: { type: Boolean, default: false },
    rating: { type: Number, default: null }, ratingComment: { type: String, default: null }, ratedAt: { type: Date, default: null },
    closedByUid: { type: String, default: null }, closedByName: { type: String, default: null },
    shared: { type: [String], default: [] },
    messages: [{
        sender: String, name: String, text: String,
        media: { type: String, default: null }, mediaKind: { type: String, default: null },
        audioDuration: { type: Number, default: null },
        suggest: Boolean, role: String, senderUid: { type: String, default: null },
        replyTo: { type: Number, default: null },
        edited: { type: Boolean, default: false }, editedAt: { type: Date, default: null },
        edits: { type: [{ _id: false, text: String, at: Date }], default: [] },
        deleted: { type: Boolean, default: false }, deletedAt: { type: Date, default: null }, deletedByName: { type: String, default: null },
        revealed: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    mver: { type: Number, default: 0 }
}, { timestamps: true }));
const TicketMedia = mongoose.model('TicketMedia', new mongoose.Schema({
    ticket: { type: String, index: true }, kind: String, mime: String, data: Buffer, createdAt: { type: Date, default: Date.now }
}));
const SupportBan = mongoose.model('SupportBan', new mongoose.Schema({
    uid: { type: String, index: true }, name: String, reason: String, byName: String, createdAt: { type: Date, default: Date.now }
}));
const SupportRating = mongoose.model('SupportRating', new mongoose.Schema({
    ticketId: String, no: Number, uid: String, name: String, category: String,
    adminUid: { type: String, index: true }, adminName: String, stars: Number, comment: String, at: { type: Date, default: Date.now }
}));
const SUPPORT_CANNED_SEEDS = [
    { title: 'ترحيب', text: 'هلا والله 👋 معك إدارة البنك، كيف أقدر أخدمك؟' },
    { title: 'نحتاج لقطة شاشة', text: 'ممكن ترسل لقطة شاشة توضح المشكلة؟' },
    { title: 'جاري المراجعة', text: 'استلمنا طلبك وجاري المراجعة، لا تقفل التكت وبنرد عليك بأقرب وقت 🙏' },
    { title: 'تم الحل', text: 'تم حل المشكلة ✅ لو احتجت أي شي ثاني افتح تكت جديد، وبنسكّر هذا التكت.' }
];
const SUPPORT_BANNED_MSG = 'تم حظرك من خدمة العملاء';
const supTyping = new Map(); // ticketId -> { owner: ts, admin: { name, ts } }
const supAiBusy = new Set();
const supNotifyAt = new Map();

async function supBanned(uid) {
    if (await SupportBan.exists({ uid: String(uid) })) return true;
    const a = await Account.findOne({ discord: String(uid) }, { supportBanned: 1 }).lean();
    return !!(a && a.supportBanned);
}
// اسم الظهور: المالك دايماً مخفي باسم «كبار المسؤولين»
async function supDisplayName(req) {
    if (await isTrueOwner(req.user.id)) return 'كبار المسؤولين';
    return req.user.username;
}
async function supAuth(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    const role = await getBankRole(req.user.id);
    req.sup = { uid: String(req.user.id), role, isAdmin: ['staff', 'management', 'admin', 'super_admin'].includes(role), senior: role === 'super_admin' };
    next();
}
const supMw = [checkMaintenance, supAuth];
function supAdminOnly(req, res, next) { if (!req.sup.isAdmin) return res.status(403).json({ error: 'للإدارة فقط' }); next(); }
function supSeniorOnly(req, res, next) { if (!req.sup.senior) return res.status(403).json({ error: 'لكبار المسؤولين فقط' }); next(); }

async function supLoad(req, res, full) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404).json({ error: 'التكت غير موجود' }); return null; }
    const t = await BankTicket.findById(req.params.id);
    if (!t) { res.status(404).json({ error: 'التكت غير موجود' }); return null; }
    const uid = req.sup.uid;
    let role = null;
    if (t.uid === uid) role = 'owner';
    else if (req.sup.isAdmin) {
        role = 'admin';
        if (!req.sup.senior && !(t.status === 'waiting' || t.adminUid === uid)) { res.status(403).json({ error: 'هذا التكت مو من صلاحياتك' }); return null; }
    }
    if (!role) { res.status(403).json({ error: 'ما عندك صلاحية على هذا التكت' }); return null; }
    return { t, role, uid, senior: role === 'admin' && req.sup.senior };
}
function supCanInspect(t, x) { return x.role === 'admin' && (x.senior || (t.status === 'active' && t.adminUid === x.uid)); }
function supIsOwn(m, x) { return x.role === 'owner' ? m.sender === 'user' : (m.sender === 'admin' && m.senderUid === x.uid); }
function supSeeDeleted(m, x) { return !!(x.senior || (x.role === 'owner' && m.revealed)); }
function supPubMsg(m, i, x, msgs) {
    if (m.deleted && !supSeeDeleted(m, x)) return { i, sender: m.sender, name: m.name, hid: true, at: m.createdAt };
    const o = { i, sender: m.sender, name: m.name, text: m.text || '', media: m.media || null, mk: m.mediaKind || null, dur: m.audioDuration || 0, suggest: !!m.suggest, role: m.role || null, own: supIsOwn(m, x), ed: !!m.edited, edAt: m.editedAt || null, at: m.createdAt };
    if (m.deleted) { o.del = true; o.delBy = m.deletedByName || ''; o.rev = !!m.revealed; }
    if (typeof m.replyTo === 'number' && m.replyTo >= 0 && msgs[m.replyTo]) {
        const q = msgs[m.replyTo];
        const hidden = (q.sender === 'note' && x.role !== 'admin') || (q.deleted && !supSeeDeleted(q, x));
        o.rp = m.replyTo; o.rpn = hidden ? '' : (q.name || '');
        o.rpt = hidden ? 'رسالة محذوفة' : (q.text ? String(q.text).slice(0, 80) : (q.mediaKind === 'aud' ? '🎙️ رسالة صوتية' : (q.mediaKind === 'img' ? '📷 صورة' : '')));
    }
    if (x.senior && m.edits && m.edits.length) o.edits = m.edits.map(e => ({ text: e.text, at: e.at }));
    return o;
}
function supPubTicket(t) {
    return { id: String(t._id), no: t.no, name: t.name, category: t.category, place: t.place, subject: t.subject, status: t.status, adminName: t.adminName, updatedAt: t.updatedAt, createdAt: t.createdAt, rating: t.rating == null ? null : t.rating, needRate: !!(t.status === 'closed' && t.ratingRequired && t.rating == null) };
}
function supPreview(t, forUser) {
    const arr = t.messages || [];
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (!m.deleted && !(forUser && m.sender === 'note')) return (m.text || (m.mediaKind === 'aud' ? '🎙️ رسالة صوتية' : (m.mediaKind === 'img' ? '📷 صورة' : ''))).slice(0, 60);
    }
    return '';
}
function supAdd(t, m) { t.messages.push(Object.assign({ createdAt: new Date() }, m)); }
async function supNotifyUser(t, msg, type) {
    try { await Notification.create({ discord: t.uid, message: msg, type: type || 'info' }); } catch (e) {}
}
function supCleanImage(v) {
    if (!v || typeof v !== 'string' || v.length > 1500000) return null;
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+\/=]+)$/.exec(v);
    return m ? { mime: m[1], buf: Buffer.from(m[2], 'base64') } : null;
}
function supCleanAudio(b) {
    if (!b || typeof b.audio !== 'string') return null;
    const mime = String(b.audioMime || '').split(';')[0].trim().toLowerCase();
    if (!['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/mpeg'].includes(mime)) return null;
    if (b.audio.length > 4000000 || !/^[A-Za-z0-9+\/=]+$/.test(b.audio)) return null;
    const buf = Buffer.from(b.audio, 'base64');
    if (buf.length < 200 || buf.length > 3 * 1024 * 1024) return null;
    return { mime, buf, dur: Math.min(600, Math.max(1, Math.round(Number(b.audioDuration) || 1))) };
}
async function supMediaFields(t, img, aud) {
    if (img) { const m = await TicketMedia.create({ ticket: String(t._id), kind: 'img', mime: img.mime, data: img.buf }); return { media: String(m._id), mediaKind: 'img' }; }
    if (aud) { const m = await TicketMedia.create({ ticket: String(t._id), kind: 'aud', mime: aud.mime, data: aud.buf }); return { media: String(m._id), mediaKind: 'aud', audioDuration: aud.dur }; }
    return {};
}

// ── المساعد الآلي (أسئلة شائعة + Claude اختياري لو ANTHROPIC_API_KEY مضبوط) ──
function supNorm(s) {
    return String(s || '').toLowerCase().replace(/[\u064B-\u065F\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const SUPPORT_FAQ = [
    { id: 'human', keys: ['عضو حقيقي', 'شخص حقيقي', 'ابي اداري', 'ابغى اداري', 'اكلم اداري', 'موظف', 'مسؤول', 'بشري', 'مو بوت', 'اكلم احد'], human: true, a: 'أكيد 👍 اضغط زر «🧑‍💼 تحدث مع عضو حقيقي» فوق، وبيوصل طلبك لفريق البنك وأول ما يدخل أحد بيرد عليك هنا مباشرة.' },
    { id: 'thanks', keys: ['شكرا', 'مشكور', 'يعطيك العافيه', 'تسلم', 'جزاك الله', 'ممنون'], bare: true, a: 'العفو 🌹 إذا عندك أي شي ثاني اكتبه لي، وإذا انحلت مشكلتك تقدر تسكّر التكت.' },
    { id: 'hello', keys: ['السلام عليكم', 'سلام عليكم', 'هلا', 'مرحبا', 'اهلين', 'اهلا', 'هاي', 'صباح الخير', 'مساء الخير'], bare: true, a: 'هلا والله 👋 وش المشكلة اللي تواجهك في البنك؟ اكتب لي بالتفصيل، وتقدر ترفق صورة 📎' },
    { id: 'transfer', keys: ['تحويل', 'حواله', 'حوالة', 'ما وصلت', 'ما وصل', 'حولت', 'رسوم التحويل'], a: 'للتحويل: افتح «💸 تحويل»، اكتب رقم الحساب (6 أرقام) والمبلغ. تأكد إن رصيدك يكفي المبلغ + الرسوم إن وجدت، وإن حسابك مو مجمّد وإن التحويل مو مقفول من الإدارة.\nتقدر تشوف كل حوالاتك في «📜 كشف حساب».' },
    { id: 'loan', keys: ['قرض', 'القرض', 'سداد القرض', 'طلب قرض', 'اقتراض'], a: 'القروض تنراجع يدوياً من الإدارة. تقدم من صفحة «📋 القروض» (الحد الأقصى 1,000,000 $) وتجيك إشعار بالقرار. السداد من نفس الصفحة وقت ما تحب.' },
    { id: 'savings', keys: ['توفير', 'التوفير', 'فائده', 'الفائده', 'ايداع', 'سحب'], a: 'حساب التوفير تقدر تودع فيه وتسحب منه من صفحة «💰 التوفير»، وتنحسب عليه فائدة حسب نسبة البنك.' },
    { id: 'pin', keys: ['الرقم السري', 'رقم سري', 'pin', 'نسيت الرقم', 'كلمه المرور', 'باسورد'], a: 'الرقم السري للبطاقة (4 أرقام) أنت اللي تحدده أول مرة، وما أحد يقدر يشوفه حتى الإدارة. إذا نسيته اضغط «تحدث مع عضو حقيقي» وبيعيدون تعيينه لك لتحط رقم جديد. ⚠️ لا ترسله لأحد أبداً.', human: true },
    { id: 'card', keys: ['بطاقه', 'بطاقتي', 'البطاقه', 'طلب بطاقه', 'فيزا', 'تجديد البطاقه', 'تجديد'], a: 'طلب البطاقة من «💳 بطاقاتي»: اكتب رقم بطاقتك العسكرية وبياناتك ووافق على التعهد، وتنراجع من الإدارة. بعد القبول تحدد رقمك السري. البطاقة المنتهية تقدر تجددها من نفس الصفحة (قد يكون فيه رسوم).' },
    { id: 'frozen', keys: ['مجمد', 'مجمّد', 'تجميد', 'حسابي مجمد', 'فريز'], a: 'تجميد الحساب أو البطاقة قرار من الإدارة. إذا تبي تعرف السبب أو تعترض اضغط «تحدث مع عضو حقيقي».', human: true },
    { id: 'fine', keys: ['مخالفه', 'مخالفة', 'سداد مخالفه', 'خصم', 'خصموا'], a: 'سداد المخالفات يتم من موقع فلاش بالبطاقة البنكية (رقم البطاقة + الرقم السري) ويُخصم من رصيدك ويوصلك إشعار. إذا انخصم مبلغ غلط اضغط «تحدث مع عضو حقيقي».', human: true },
    { id: 'balance', keys: ['رصيدي', 'الرصيد', 'ما نزل', 'ما انضاف', 'راتب', 'راتبي'], a: 'رصيدك وحركاتك تشوفها في الرئيسية و«📜 كشف حساب». رواتب العساكر تنزل تلقائياً حسب جدول الرتب. إذا ناقص شي اضغط «تحدث مع عضو حقيقي».', human: true },
    { id: 'complaint', keys: ['شكوى', 'اشتكي', 'ظلم', 'تعدي', 'سرقه', 'احتيال'], human: true, a: 'نأسف لهذا الشي، الشكاوى تتابعها الإدارة مباشرة. اضغط «🧑‍💼 تحدث مع عضو حقيقي» ووضّح القصة وأرفق أي إثبات.' }
];
function supFaqReply(t) {
    const users = t.messages.filter(m => m.sender === 'user');
    const last = users[users.length - 1] || {};
    const prevAi = [...t.messages].reverse().find(m => m.sender === 'ai');
    const aiCount = t.messages.filter(m => m.sender === 'ai').length;
    const text = supNorm(last.text);
    const out = (txt, human) => ({ text: txt + (human ? ' [[HUMAN]]' : ''), suggest: !!human });
    if (!text) return out('وصلتنا الصورة 👍 اكتب لي وش المشكلة بالضبط؟ أو اضغط «تحدث مع عضو حقيقي».', users.length > 1);
    let best = null, bs = 0;
    for (const f of SUPPORT_FAQ) {
        let sc = 0;
        for (const k of f.keys) { const nk = supNorm(k); if (nk && text.indexOf(nk) !== -1) sc += nk.indexOf(' ') !== -1 ? 2 : 1; }
        if (f.bare && text.split(' ').length > 6) sc = 0;
        if (sc > bs) { best = f; bs = sc; }
    }
    if (best) {
        const tail = ['hello', 'thanks', 'human'].includes(best.id) ? '' : '\n\nإذا ما انحلت مشكلتك اضغط «تحدث مع عضو حقيقي» 👇';
        if (prevAi && prevAi.text && prevAi.text.indexOf(best.a.slice(0, 40)) !== -1 && !['hello', 'thanks'].includes(best.id)) return out('شكلي كررت عليك نفس الجواب 😅 اضغط «تحدث مع عضو حقيقي» وبيتابع معك أحد من الإدارة.', true);
        return out(best.a + tail, !!best.human);
    }
    if (aiCount >= 2 || (prevAi && prevAi.suggest)) return out('ما قدرت أحدد مشكلتك بالضبط 🙏 اضغط «تحدث مع عضو حقيقي» وبيساعدك أحد من الإدارة.', true);
    return out('ما فهمت مشكلتك بالضبط، ممكن توضح لي أكثر؟\n• وش القسم (تحويل، قرض، بطاقة...)؟\n• وش اللي صار بالضبط؟\n• هل ظهرت رسالة خطأ؟ (اكتبها أو أرفق صورة 📎)', false);
}
async function supAskClaude(t) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || typeof fetch !== 'function') return null;
    const convo = t.messages.filter(m => !m.deleted && (m.sender === 'user' || m.sender === 'ai') && m.text).slice(-14);
    const msgs = [];
    convo.forEach(m => { const role = m.sender === 'user' ? 'user' : 'assistant'; const last = msgs[msgs.length - 1]; if (last && last.role === role) last.content += '\n' + m.text; else msgs.push({ role, content: m.text }); });
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length) return null;
    const acc = await Account.findOne({ discord: t.uid }).lean();
    const ctx = 'العضو: ' + t.name + (acc ? '، رقم الحساب ' + acc.accountNumber + '، الحساب ' + (acc.isFrozen ? 'مجمّد' : 'نشط') : '') + '. تصنيف التكت: ' + (t.category || '-') + (t.place ? ' — ' + t.place : '') + '.';
    const sys = ['أنت مساعد خدمة عملاء «بنك فلاش» — بنك داخل لعبة أدوار (ماين كرافت/محاكاة) ولا يمت للواقع بصلة.', 'البنك فيه: تحويلات بين الحسابات برقم 6 أرقام، حساب توفير بفائدة، قروض بموافقة الإدارة، بطاقات بنكية برقم سري، رواتب عساكر، سداد مخالفات من فلاش.', 'أسلوبك: لهجة سعودية بيضاء بسيطة ومحترمة، ردود قصيرة (٢–٥ أسطر). اسأل سؤال واحد فقط كل مرة إذا المشكلة غير واضحة.', 'ممنوع: تخترع ميزات أو وعود، أو تغيّر أرصدة أو قرارات. لا تطلب أبداً الرقم السري أو رقم البطاقة أو الـ CVV.', 'إذا تحتاج إدارة قل له يضغط زر «تحدث مع عضو حقيقي» وأضف في آخر ردك [[HUMAN]] بدون شرح.', ctx].join('\n');
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: process.env.SUPPORT_AI_MODEL || 'claude-sonnet-4-6', max_tokens: 600, system: sys, messages: msgs }) });
        const d = await r.json();
        if (!r.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
        return (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim() || null;
    } finally { clearTimeout(timer); }
}
async function supRunAi(id) {
    if (supAiBusy.has(id)) return;
    supAiBusy.add(id);
    try {
        let t = await BankTicket.findById(id);
        if (!t || t.status !== 'ai') return;
        let text = null;
        if (t.messages.filter(m => m.sender === 'ai').length < 40) {
            try { text = await supAskClaude(t); } catch (e) { console.error('❌ مساعد الدعم:', e.message); }
            if (!text) text = supFaqReply(t).text;
        }
        t = await BankTicket.findById(id);
        if (!t || t.status !== 'ai') return;
        let suggest = false;
        if (!text) { text = 'ما قدرت أرد عليك الحين 🙏 اضغط «تحدث مع عضو حقيقي».'; suggest = true; }
        else if (text.indexOf('[[HUMAN]]') !== -1) { text = text.split('[[HUMAN]]').join('').trim(); suggest = true; }
        supAdd(t, { sender: 'ai', name: 'المساعد الآلي', text: text.slice(0, 1800), suggest });
        t.unreadUser += 1;
        await t.save();
        bumpTicketActivity();
    } catch (e) { console.error('❌ supRunAi:', e.message); }
    finally { supAiBusy.delete(id); }
}

// ── التكتات: إنشاء / قائمة / عرض ──
app.get('/api/support/meta', supMw, (req, res) => res.json({ cats: SUPPORT_CATEGORIES, places: SUPPORT_PLACES }));
app.post('/api/support/tickets', supMw, async (req, res) => {
    try {
        const settings = await BankSettings.findOne();
        if (settings && settings.disableSupport) return res.status(403).json({ error: settings.disableSupportReason || '🔒 خدمة العملاء موقوفة حالياً.' });
        const uid = req.sup.uid;
        if (await supBanned(uid)) return res.status(403).json({ error: SUPPORT_BANNED_MSG });
        const b = req.body || {};
        const text = String(b.text || '').trim().slice(0, 1500);
        const img = supCleanImage(b.image);
        if (b.image && !img) return res.status(400).json({ error: 'الصورة غير صالحة أو حجمها كبير' });
        if (!text && !img) return res.status(400).json({ error: 'اكتب وصف المشكلة' });
        if (await BankTicket.countDocuments({ uid, status: { $ne: 'closed' } }) >= 1) return res.status(400).json({ error: 'عندك تكت مفتوح، لازم يتسكّر أول عشان تفتح تكت جديد' });
        const unrated = await BankTicket.findOne({ uid, status: 'closed', ratingRequired: true, rating: null }).select('_id').lean();
        if (unrated) return res.status(400).json({ error: 'لازم تقيّم تكتك السابق أول', needRate: String(unrated._id) });
        const last = await BankTicket.findOne().sort({ no: -1 }).select('no').lean();
        const category = SUPPORT_CATEGORIES.includes(b.category) ? b.category : 'أخرى';
        const place = category === 'أخرى' ? '' : String(b.place || '').replace(/[<>]/g, '').trim().slice(0, 60);
        const acc = await Account.findOne({ discord: uid }).lean();
        const t = new BankTicket({ no: ((last && last.no) || 1000) + 1, uid, name: req.user.username, accountNumber: acc ? acc.accountNumber : '', category, place, subject: (text || 'صورة').slice(0, 60), status: 'ai' });
        supAdd(t, Object.assign({ sender: 'user', name: req.user.username, text, senderUid: uid }, await supMediaFields(t, img, null)));
        await t.save();
        bumpTicketActivity();
        res.json({ ok: true, id: String(t._id) });
        supRunAi(String(t._id));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/support/tickets', supMw, async (req, res) => {
    const list = await BankTicket.find({ uid: req.sup.uid }).sort({ updatedAt: -1 }).limit(50).lean();
    res.json({ banned: await supBanned(req.sup.uid), tickets: list.map(t => Object.assign(supPubTicket(t), { unread: t.unreadUser || 0, last: supPreview(t, true) })) });
});
app.get('/api/support/badges', supMw, async (req, res) => {
    const out = { user: await BankTicket.countDocuments({ uid: req.sup.uid, unreadUser: { $gt: 0 } }), admin: null };
    if (req.sup.isAdmin) {
        out.admin = { waiting: await BankTicket.countDocuments({ status: 'waiting' }), unread: await BankTicket.countDocuments(req.sup.senior ? { status: { $in: ['waiting', 'active'] }, unreadAdmin: { $gt: 0 } } : { status: 'active', adminUid: req.sup.uid, unreadAdmin: { $gt: 0 } }) };
    }
    res.json(out);
});
app.get('/api/support/tickets/:id', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t, role } = x;
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const msgs = t.messages.map((m, i) => supPubMsg(m, i, x, t.messages)).slice(after).filter(m => role === 'admin' || m.sender !== 'note');
    if (role === 'owner' && t.unreadUser) { t.unreadUser = 0; await BankTicket.updateOne({ _id: t._id }, { $set: { unreadUser: 0 } }); }
    if (role === 'admin' && t.unreadAdmin) { await BankTicket.updateOne({ _id: t._id }, { $set: { unreadAdmin: 0 } }); }
    const ty = supTyping.get(String(t._id)) || {};
    const typing = role === 'owner' ? (ty.admin && Date.now() - ty.admin.ts < 4500 ? ty.admin.name : null) : (ty.owner && Date.now() - ty.owner < 4500 ? t.name : null);
    const can = supCanInspect(t, x);
    res.json({ ticket: supPubTicket(t), role, msgs, n: t.messages.length, mver: t.mver || 0, shared: (role === 'owner' || can) ? (t.shared || []) : [], canInspect: can, senior: x.senior, typing, aiTyping: t.status === 'ai' && supAiBusy.has(String(t._id)) });
});
app.get('/api/support/tickets/:id/media/:mid', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const m = x.t.messages.find(q => q.media === req.params.mid);
    if (!m || (m.deleted && !supSeeDeleted(m, x))) return res.status(404).end();
    if (!mongoose.Types.ObjectId.isValid(req.params.mid)) return res.status(404).end();
    const d = await TicketMedia.findById(req.params.mid).lean();
    if (!d) return res.status(404).end();
    const buf = Buffer.from(d.data.buffer ? d.data.buffer : d.data); const size = buf.length;
    const h = { 'Content-Type': d.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (rg && (rg[1] || rg[2])) {
        let s, e;
        if (rg[1] === '') { s = Math.max(0, size - parseInt(rg[2], 10)); e = size - 1; } else { s = parseInt(rg[1], 10); e = rg[2] ? Math.min(parseInt(rg[2], 10), size - 1) : size - 1; }
        if (!(s <= e) || s >= size) { res.set('Content-Range', 'bytes */' + size); return res.status(416).end(); }
        res.status(206).set(Object.assign(h, { 'Content-Range': 'bytes ' + s + '-' + e + '/' + size, 'Content-Length': e - s + 1 }));
        return res.end(buf.subarray(s, e + 1));
    }
    res.set(Object.assign(h, { 'Content-Length': size })); res.end(buf);
});

// ── الرسائل ──
const supMsgThrottle = new Map();
app.post('/api/support/tickets/:id/messages', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t, role, uid } = x;
    if (t.status === 'closed') return res.status(400).json({ error: 'التكت مغلق' });
    const key = String(t._id) + ':' + role;
    if (Date.now() - (supMsgThrottle.get(key) || 0) < 600) return res.status(429).json({ error: 'على راحتك شوي' });
    supMsgThrottle.set(key, Date.now());
    const b = req.body || {};
    const aud = b.audio ? supCleanAudio(b) : null;
    if (b.audio && !aud) return res.status(400).json({ error: 'الرسالة الصوتية غير صالحة أو كبيرة' });
    const text = aud ? '' : String(b.text || '').trim().slice(0, 1500);
    const img = aud ? null : supCleanImage(b.image);
    if (!aud && b.image && !img) return res.status(400).json({ error: 'الصورة غير صالحة أو حجمها كبير' });
    if (!text && !img && !aud) return res.status(400).json({ error: 'اكتب رسالة أو أرفق صورة' });
    if (t.messages.length >= 300) return res.status(400).json({ error: 'وصل التكت للحد الأقصى من الرسائل، افتح تكت جديد' });
    if (img && t.messages.filter(m => m.mediaKind === 'img').length >= 10) return res.status(400).json({ error: 'وصلت الحد الأقصى للصور' });
    if (aud && t.messages.filter(m => m.mediaKind === 'aud').length >= 25) return res.status(400).json({ error: 'وصلت الحد الأقصى للرسائل الصوتية' });
    let replyTo = null;
    if (b.replyTo !== undefined && b.replyTo !== null && b.replyTo !== '') {
        const k = parseInt(b.replyTo, 10), q = t.messages[k];
        if (!(k >= 0 && q && !q.deleted && q.sender !== 'system' && !(q.sender === 'note' && role !== 'admin'))) return res.status(400).json({ error: 'الرسالة اللي تبي ترد عليها غير موجودة' });
        replyTo = k;
    }
    if (role === 'owner') {
        if (await supBanned(uid)) return res.status(403).json({ error: SUPPORT_BANNED_MSG });
        supAdd(t, Object.assign({ sender: 'user', name: t.name, text, senderUid: uid, replyTo }, await supMediaFields(t, img, aud)));
        if (t.status !== 'ai') t.unreadAdmin += 1;
        await t.save(); bumpTicketActivity(); res.json({ ok: true });
        if (t.status === 'ai') {
            if (aud) { const t2 = await BankTicket.findById(t._id); supAdd(t2, { sender: 'ai', name: 'المساعد الآلي', text: '🎙️ وصلتني رسالتك الصوتية، بس أنا مساعد آلي وما أقدر أسمع الصوت. اكتب مشكلتك كتابة، أو اضغط «تحدث مع عضو حقيقي».', suggest: true }); t2.unreadUser += 1; await t2.save(); }
            else supRunAi(String(t._id));
        }
    } else {
        if (!x.senior && t.status !== 'active') return res.status(400).json({ error: 'استلم التكت أول عشان تقدر ترد' });
        if (!x.senior && t.adminUid !== uid) return res.status(403).json({ error: 'هذا التكت مستلمه ' + (t.adminName || 'إداري ثاني') });
        if (x.senior && t.status === 'ai') t.status = 'waiting';
        supAdd(t, Object.assign({ sender: 'admin', name: await supDisplayName(req), role: x.senior ? 'senior' : 'admin', text, senderUid: uid, replyTo }, await supMediaFields(t, img, aud)));
        t.unreadUser += 1;
        await t.save(); bumpTicketActivity(); res.json({ ok: true });
        const k2 = String(t._id); if (Date.now() - (supNotifyAt.get(k2) || 0) > 60000) { supNotifyAt.set(k2, Date.now()); supNotifyUser(t, '💬 ردّ فريق الدعم على تكتك #' + t.no, 'info'); }
    }
});
async function supMsgLoad(req, res) {
    const x = await supLoad(req, res); if (!x) return null;
    const i = parseInt(req.params.i, 10), m = x.t.messages[i];
    if (!(i >= 0) || !m) { res.status(404).json({ error: 'الرسالة غير موجودة' }); return null; }
    x.i = i; x.m = m; return x;
}
app.post('/api/support/tickets/:id/messages/:i/edit', supMw, async (req, res) => {
    const x = await supMsgLoad(req, res); if (!x) return;
    const { t, m } = x;
    if (t.status === 'closed') return res.status(400).json({ error: 'التكت مغلق' });
    if (m.deleted) return res.status(400).json({ error: 'الرسالة محذوفة' });
    if (m.sender !== 'user' && m.sender !== 'admin') return res.status(400).json({ error: 'هذي الرسالة ما تنعدل' });
    if (!supIsOwn(m, x)) return res.status(403).json({ error: 'تعدّل رسايلك أنت بس' });
    if (m.mediaKind === 'aud') return res.status(400).json({ error: 'الرسالة الصوتية ما تنعدل' });
    const text = String((req.body || {}).text || '').trim().slice(0, 1500);
    if (!text) return res.status(400).json({ error: 'اكتب النص الجديد' });
    if (text === (m.text || '')) return res.json({ ok: true });
    m.edits.push({ text: m.text || '', at: new Date() }); if (m.edits.length > 20) m.edits = m.edits.slice(-20);
    m.text = text; m.edited = true; m.editedAt = new Date(); t.mver = (t.mver || 0) + 1;
    await t.save(); bumpTicketActivity(); res.json({ ok: true });
});
app.post('/api/support/tickets/:id/messages/:i/delete', supMw, async (req, res) => {
    const x = await supMsgLoad(req, res); if (!x) return;
    const { t, m } = x;
    if (m.deleted) return res.status(400).json({ error: 'الرسالة محذوفة من قبل' });
    if (m.sender === 'system' || m.sender === 'note') return res.status(400).json({ error: 'هذي الرسالة ما تنحذف' });
    const own = supIsOwn(m, x);
    if (!own && !x.senior) return res.status(403).json({ error: 'تحذف رسايلك أنت بس' });
    if (t.status === 'closed' && !x.senior) return res.status(400).json({ error: 'التكت مغلق' });
    const dn = x.role === 'owner' ? (t.name || 'العضو') : await supDisplayName(req);
    m.deleted = true; m.deletedAt = new Date(); m.deletedByName = dn; m.revealed = false;
    supAdd(t, { sender: 'system', name: dn, text: own ? (dn + ' حذف رسالة') : (dn + ' حذف رسالة ' + (m.name || '')).trim() });
    t.mver = (t.mver || 0) + 1; await t.save(); bumpTicketActivity(); res.json({ ok: true });
});
app.post('/api/support/tickets/:id/messages/:i/reveal', supMw, async (req, res) => {
    const x = await supMsgLoad(req, res); if (!x) return;
    if (!x.senior) return res.status(403).json({ error: 'لكبار المسؤولين فقط' });
    if (!x.m.deleted) return res.status(400).json({ error: 'هذي الرسالة مو محذوفة' });
    x.m.revealed = !!(req.body || {}).show; x.t.mver = (x.t.mver || 0) + 1; await x.t.save(); bumpTicketActivity();
    res.json({ ok: true, revealed: x.m.revealed });
});
app.post('/api/support/tickets/:id/typing', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const k = String(x.t._id); const cur = supTyping.get(k) || {};
    if (x.role === 'owner') cur.owner = Date.now(); else cur.admin = { name: await supDisplayName(req), ts: Date.now() };
    supTyping.set(k, cur);
    if (supTyping.size > 2000) for (const [a, v] of supTyping) if (Date.now() - Math.max(v.owner || 0, (v.admin && v.admin.ts) || 0) > 60000) supTyping.delete(a);
    res.json({ ok: true });
});

// ── تحويل لإداري / استلام / إغلاق / تقييم / ملاحظات ──
app.post('/api/support/tickets/:id/human', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t, role } = x;
    if (role !== 'owner') return res.status(403).json({ error: 'هذا الزر لصاحب التكت' });
    if (t.status !== 'ai') return res.status(400).json({ error: t.status === 'closed' ? 'التكت مغلق' : 'طلبك وصل للإدارة من قبل' });
    t.status = 'waiting';
    supAdd(t, { sender: 'system', name: 'النظام', text: '📨 تم إرسال طلبك لفريق البنك، أول ما يدخل إداري بتوصلك رسالته هنا مباشرة.' });
    t.unreadAdmin += 1; await t.save(); bumpTicketActivity(); res.json({ ok: true });
});
app.post('/api/support/admin/tickets/:id/join', supMw, supAdminOnly, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t } = x;
    if (t.status === 'closed') return res.status(400).json({ error: 'التكت مغلق' });
    if (t.status === 'active' && t.adminUid && t.adminUid !== x.uid) return res.status(400).json({ error: 'هذا التكت مستلمه ' + t.adminName });
    if (t.status === 'active' && t.adminUid === x.uid) return res.json({ ok: true });
    const dn = await supDisplayName(req);
    t.status = 'active'; t.adminUid = x.uid; t.adminName = dn;
    supAdd(t, { sender: 'system', name: 'النظام', text: '✅ دخل ' + dn + ' للتكت' });
    t.unreadUser += 1; await t.save(); bumpTicketActivity(); res.json({ ok: true });
    supNotifyUser(t, '✅ تم استلام تكتك #' + t.no + ' من فريق البنك', 'success');
});
app.post('/api/support/tickets/:id/close', supMw, supAdminOnly, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t } = x;
    if (t.status === 'closed') return res.json({ ok: true });
    const dn = await supDisplayName(req);
    t.status = 'closed'; t.ratingRequired = true; t.closedByUid = x.uid; t.closedByName = dn;
    supAdd(t, { sender: 'system', name: 'النظام', text: '🔒 تم إغلاق التكت بواسطة ' + dn });
    t.unreadUser += 1; await t.save(); bumpTicketActivity(); res.json({ ok: true });
    supNotifyUser(t, '🔒 تم إغلاق تكتك #' + t.no + ' — قيّم الخدمة من «خدمة العملاء»', 'info');
});
app.post('/api/support/tickets/:id/rate', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t, role } = x;
    if (role !== 'owner') return res.status(403).json({ error: 'التقييم لصاحب التكت فقط' });
    if (t.status !== 'closed') return res.status(400).json({ error: 'التكت لسا مفتوح' });
    const stars = parseInt((req.body || {}).stars, 10);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'اختر من 1 إلى 5 نجوم' });
    const comment = String((req.body || {}).comment || '').replace(/[<>]/g, '').trim().slice(0, 300);
    const r = await BankTicket.updateOne({ _id: t._id, rating: null }, { $set: { rating: stars, ratingComment: comment, ratedAt: new Date() } });
    if (!(r.modifiedCount ?? r.nModified)) return res.status(400).json({ error: 'سبق وقيّمت هذا التكت' });
    const who = t.adminUid ? { uid: t.adminUid, name: t.adminName } : { uid: t.closedByUid || 'none', name: t.closedByName || 'غير محدد' };
    await SupportRating.create({ ticketId: String(t._id), no: t.no, uid: t.uid, name: t.name, category: t.category, adminUid: who.uid, adminName: who.name, stars, comment });
    bumpTicketActivity(); res.json({ ok: true });
});
app.get('/api/support/admin/ratings/:uid', supMw, supSeniorOnly, async (req, res) => {
    const list = await SupportRating.find({ adminUid: String(req.params.uid) }).sort({ at: -1 }).limit(200).lean();
    res.json({ list: list.map(r => ({ ticketId: r.ticketId, no: r.no, name: r.name, category: r.category, stars: r.stars, comment: r.comment || '', at: r.at })) });
});
app.get('/api/support/admin/ratings', supMw, supSeniorOnly, async (req, res) => {
    const cnt = n => ({ $sum: { $cond: [{ $eq: ['$stars', n] }, 1, 0] } });
    const admins = await SupportRating.aggregate([{ $group: { _id: '$adminUid', name: { $last: '$adminName' }, count: { $sum: 1 }, avg: { $avg: '$stars' }, s1: cnt(1), s2: cnt(2), s3: cnt(3), s4: cnt(4), s5: cnt(5) } }, { $sort: { avg: -1, count: -1 } }]);
    const recent = await SupportRating.find({ comment: { $nin: [null, ''] } }).sort({ at: -1 }).limit(30).lean();
    const total = admins.reduce((a, r) => a + r.count, 0), sum = admins.reduce((a, r) => a + r.avg * r.count, 0);
    res.json({ total, avg: total ? sum / total : 0, admins: admins.map(r => ({ uid: r._id, name: r.name || '-', count: r.count, avg: r.avg, dist: [r.s1, r.s2, r.s3, r.s4, r.s5] })), recent: recent.map(r => ({ no: r.no, name: r.name, adminName: r.adminName, stars: r.stars, comment: r.comment, category: r.category, at: r.at })) });
});
app.post('/api/support/tickets/:id/note', supMw, supAdminOnly, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t } = x;
    if (t.status === 'closed') return res.status(400).json({ error: 'التكت مغلق' });
    if (!x.senior && t.adminUid !== x.uid) return res.status(403).json({ error: 'استلم التكت أول' });
    const text = String((req.body || {}).text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'اكتب الملاحظة' });
    supAdd(t, { sender: 'note', name: await supDisplayName(req), role: x.senior ? 'senior' : 'admin', text });
    await t.save(); res.json({ ok: true });
});

// ── الردود الجاهزة ──
async function supCanned() {
    let s = await BankSettings.findOne();
    if (!s.supportCanned || !s.supportCanned.length) { s.supportCanned = SUPPORT_CANNED_SEEDS.map(r => ({ title: r.title, text: r.text })); await s.save(); }
    return s;
}
app.get('/api/support/admin/canned', supMw, supAdminOnly, async (req, res) => { const s = await supCanned(); res.json({ list: s.supportCanned.map(r => ({ id: String(r._id), title: r.title, text: r.text })) }); });
app.post('/api/support/admin/canned', supMw, supSeniorOnly, async (req, res) => {
    const title = String((req.body || {}).title || '').replace(/[<>]/g, '').trim().slice(0, 40), text = String((req.body || {}).text || '').replace(/[<>]/g, '').trim().slice(0, 500);
    if (!title || !text) return res.status(400).json({ error: 'اكتب العنوان والنص' });
    const s = await supCanned(); if (s.supportCanned.length >= 30) return res.status(400).json({ error: 'وصلت الحد الأقصى (30 رد)' });
    s.supportCanned.push({ title, text }); await s.save(); res.json({ ok: true });
});
app.delete('/api/support/admin/canned/:rid', supMw, supSeniorOnly, async (req, res) => {
    const s = await supCanned(); const b = s.supportCanned.length;
    s.supportCanned = s.supportCanned.filter(r => String(r._id) !== req.params.rid);
    if (s.supportCanned.length === b) return res.status(404).json({ error: 'غير موجود' });
    await s.save(); res.json({ ok: true });
});

// ── فحص العضو (الإداري المستلم/الكبار يختارون اللي يظهر للعضو) ──
const SUP_CATS = {
    account: { title: 'معلومات الحساب البنكي', keys: ['acc.name', 'acc.number', 'acc.balance', 'acc.savings', 'acc.state', 'acc.created'] },
    card: { title: 'البطاقة البنكية', keys: ['card.status', 'card.last4', 'card.expiry', 'card.frozen', 'card.pin'] },
    transfers: { title: 'الحوالات', keys: ['tx.lastIn', 'tx.lastOut'] },
    loan: { title: 'القروض', keys: ['loan.state', 'loan.amount', 'loan.remaining'] },
    flash: { title: 'معلومات فلاش', keys: ['fl.name', 'fl.rank', 'fl.unit', 'fl.sector', 'fl.card'] }
};
const SUP_FIXED = [].concat(...Object.values(SUP_CATS).map(c => c.keys));
const SUP_DYN = /^tx:[a-f0-9]{24}$/;
async function supRows(cat, uid, only) {
    if (only) { const has = cat === 'transfers' ? Array.from(only).some(k => SUP_DYN.test(k) || SUP_CATS.transfers.keys.includes(k)) : SUP_CATS[cat].keys.some(k => only.has(k)); if (!has) return []; }
    const R = (k, l, v) => ({ k, l, v: v == null || v === '' ? '—' : String(v) });
    const D = (k, l, v) => ({ k, l, v: v ? new Date(v).toISOString() : '—', d: !!v });
    let rows = [];
    const acc = await Account.findOne({ discord: uid }).lean();
    if (cat === 'account') {
        if (!acc) return [R('acc.name', 'الحساب', 'ما له حساب بنكي')].filter(r => !only || only.has(r.k));
        rows.push(R('acc.name', 'الاسم', acc.discordTag), R('acc.number', 'رقم الحساب', acc.accountNumber), R('acc.balance', 'الرصيد الجاري', (acc.balance || 0).toLocaleString() + ' $'), R('acc.savings', 'رصيد التوفير', (acc.savingsBalance || 0).toLocaleString() + ' $'), R('acc.state', 'حالة الحساب', acc.isFrozen ? 'مجمّد' : 'نشط'), D('acc.created', 'تاريخ فتح الحساب', acc.createdAt));
    } else if (cat === 'card') {
        const c = await CardRequest.findOne({ discord: uid, status: { $in: ['approved', 'disabled', 'pending'] } }).sort({ requestedAt: -1 }).lean();
        if (!c) return [R('card.status', 'البطاقة', 'ما عنده بطاقة')].filter(r => !only || only.has(r.k));
        const st = { pending: 'قيد المراجعة', approved: 'مفعّلة', disabled: 'معطّلة' }[c.status] || c.status;
        rows.push(R('card.status', 'حالة البطاقة', st), R('card.last4', 'آخر 4 أرقام', c.cardNumber ? c.cardNumber.slice(-4) : '—'), D('card.expiry', 'تاريخ الانتهاء', c.cardExpiry), R('card.frozen', 'التجميد', c.cardFrozen ? 'مجمّدة' : 'غير مجمّدة'), R('card.pin', 'الرقم السري', c.pinSet ? 'معيّن (ما أحد يشوفه)' : 'لم يُعيَّن'));
    } else if (cat === 'transfers') {
        if (!acc) return [];
        const base = { type: 'transfer' };
        const [lin, lout] = await Promise.all([Transaction.findOne({ ...base, toAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean(), Transaction.findOne({ ...base, fromAccount: acc.accountNumber }).sort({ createdAt: -1 }).lean()]);
        const f = t => t ? ((t.amount || 0).toLocaleString() + ' $ — ' + new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')) : null;
        rows.push(R('tx.lastIn', 'آخر حوالة واردة', f(lin)), R('tx.lastOut', 'آخر حوالة صادرة', f(lout)));
        const ids = only ? Array.from(only).filter(k => SUP_DYN.test(k)).map(k => k.slice(3)) : null;
        const q = { $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] };
        const txs = await Transaction.find(ids ? { $and: [q, { _id: { $in: ids } }] } : q).sort({ createdAt: -1 }).limit(ids ? 200 : 30).lean();
        txs.forEach(t => rows.push({ k: 'tx:' + t._id, l: (t.fromAccount === acc.accountNumber ? '📤 صادرة' : '📥 واردة') + ' — ' + (t.type || ''), v: (t.amount || 0).toLocaleString() + ' $' + (t.note ? ' — ' + String(t.note).slice(0, 60) : ''), at: new Date(t.createdAt).toISOString() }));
    } else if (cat === 'loan') {
        const l = await Loan.findOne({ discord: uid }).sort({ requestedAt: -1 }).lean();
        if (!l) return [R('loan.state', 'القرض', 'ما عنده قروض')].filter(r => !only || only.has(r.k));
        rows.push(R('loan.state', 'حالة آخر قرض', { pending: 'قيد المراجعة', approved: 'معتمد', rejected: 'مرفوض', paid: 'مسدّد', expired: 'منتهي' }[l.status] || l.status), R('loan.amount', 'المبلغ', (l.amount || 0).toLocaleString() + ' $'), R('loan.remaining', 'المتبقي', (l.remaining || 0).toLocaleString() + ' $'));
    } else if (cat === 'flash') {
        let d = null; try { d = await flashGet('/api/bank/member-card?uid=' + encodeURIComponent(uid)); } catch (e) {}
        if (!d || !d.success || !d.found) return [R('fl.name', 'فلاش', 'غير متاح')].filter(r => !only || only.has(r.k));
        rows.push(R('fl.name', 'الاسم المسجّل', d.name), R('fl.rank', 'الرتبة', d.rank), R('fl.unit', 'اليونت', d.unit), R('fl.sector', 'القطاع', d.sector), R('fl.card', 'رقم البطاقة العسكرية', d.cardNumber));
    }
    return rows.filter(r => !only || only.has(r.k));
}
app.get('/api/support/admin/tickets/:id/inspect/:cat', supMw, supAdminOnly, async (req, res) => {
    if (!SUP_CATS[req.params.cat]) return res.status(400).json({ error: 'قسم غير معروف' });
    const x = await supLoad(req, res); if (!x) return;
    if (!supCanInspect(x.t, x)) return res.status(403).json({ error: 'الفحص للإداري المستلم وكبار المسؤولين فقط' });
    const rows = await supRows(req.params.cat, x.t.uid, null);
    const sh = new Set(x.t.shared || []);
    res.json({ cat: req.params.cat, title: SUP_CATS[req.params.cat].title, rows: rows.map(r => Object.assign(r, { shown: sh.has(r.k) })) });
});
app.get('/api/support/tickets/:id/info', supMw, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    if (x.role === 'admin' && !supCanInspect(x.t, x)) return res.status(403).json({ error: 'غير مصرح' });
    if (!(x.t.shared || []).length) return res.json({ items: [] });
    const only = new Set(x.t.shared), items = [];
    for (const cat of Object.keys(SUP_CATS)) { const rows = await supRows(cat, x.t.uid, only); if (rows.length) items.push({ cat, title: SUP_CATS[cat].title, rows }); }
    res.json({ items });
});
app.post('/api/support/admin/tickets/:id/share', supMw, supAdminOnly, async (req, res) => {
    const x = await supLoad(req, res); if (!x) return;
    const { t } = x;
    if (!supCanInspect(t, x)) return res.status(403).json({ error: 'الفحص للإداري المستلم وكبار المسؤولين فقط' });
    if (t.status === 'closed') return res.status(400).json({ error: 'التكت مغلق' });
    const arr = v => Array.isArray(v) ? v.map(String).slice(0, 500) : [];
    const show = arr((req.body || {}).show), hide = arr((req.body || {}).hide);
    const fixed = new Set(SUP_FIXED);
    const okShow = show.filter(k => fixed.has(k) || SUP_DYN.test(k));
    const ids = okShow.filter(k => SUP_DYN.test(k)).map(k => k.slice(3));
    if (ids.length) {
        const acc = await Account.findOne({ discord: t.uid }).lean();
        if (!acc || await Transaction.countDocuments({ _id: { $in: ids }, $or: [{ fromAccount: acc.accountNumber }, { toAccount: acc.accountNumber }] }) !== ids.length) return res.status(400).json({ error: 'سجل غير صالح' });
    }
    const before = (t.shared || []).slice(), cur = new Set(before);
    hide.forEach(k => cur.delete(k)); okShow.forEach(k => cur.add(k));
    if (cur.size > 400) return res.status(400).json({ error: 'كثير، خفّ بعض اللي ظاهر أول' });
    const next = Array.from(cur);
    if (next.join(',') === before.join(',')) return res.json({ ok: true, shared: next });
    t.shared = next;
    if (!before.length && next.length) { supAdd(t, { sender: 'system', name: 'النظام', text: '🔎 ' + (await supDisplayName(req)) + ' عرض لك معلومات، تلقاها بأعلى التكت' }); t.unreadUser += 1; }
    await t.save(); bumpTicketActivity(); res.json({ ok: true, shared: next });
});

// ── قوائم الإدارة / الحظر / الحذف ──
app.get('/api/support/admin/tickets', supMw, supAdminOnly, async (req, res) => {
    const q = req.sup.senior ? { status: ['ai', 'waiting', 'active', 'closed'].includes(req.query.status) ? req.query.status : 'waiting' } : { $or: [{ status: 'waiting' }, { status: 'active', adminUid: req.sup.uid }] };
    const list = await BankTicket.find(q).sort({ updatedAt: -1 }).limit(100).lean();
    res.json({ tickets: list.map(t => Object.assign(supPubTicket(t), { unread: t.unreadAdmin || 0, last: supPreview(t) })) });
});
app.post('/api/support/admin/tickets/:id/ban', supMw, supSeniorOnly, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'التكت غير موجود' });
    const t = await BankTicket.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'التكت غير موجود' });
    if (['staff', 'management', 'admin', 'super_admin'].includes(await getBankRole(t.uid))) return res.status(400).json({ error: 'ما تقدر تحظر إداري' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
    if (!(await SupportBan.exists({ uid: t.uid }))) await SupportBan.create({ uid: t.uid, name: t.name, reason, byName: await supDisplayName(req) });
    const opens = await BankTicket.find({ uid: t.uid, status: { $ne: 'closed' } });
    for (const o of opens) { o.status = 'closed'; supAdd(o, { sender: 'system', name: 'النظام', text: '🚫 ' + SUPPORT_BANNED_MSG }); o.unreadUser += 1; await o.save(); }
    await BankLog.create({ action: 'support_ban', description: 'حظر ' + t.name + ' من خدمة العملاء' + (reason ? ' — ' + reason : ''), performedBy: req.user.id, performedByTag: await supDisplayName(req), targetDiscord: t.uid, targetTag: t.name });
    bumpTicketActivity(); res.json({ ok: true });
});
app.get('/api/support/admin/bans', supMw, supSeniorOnly, async (req, res) => {
    const list = await SupportBan.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ bans: list.map(b => ({ id: String(b._id), name: b.name, reason: b.reason, by: b.byName, at: b.createdAt })) });
});
app.delete('/api/support/admin/bans/:id', supMw, supSeniorOnly, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'غير موجود' });
    const b = await SupportBan.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ error: 'غير موجود' });
    await Account.updateOne({ discord: b.uid }, { supportBanned: false });
    res.json({ ok: true });
});
app.delete('/api/support/admin/closed', supMw, supSeniorOnly, async (req, res) => {
    const ids = (await BankTicket.find({ status: 'closed' }).select('_id').lean()).map(t => String(t._id));
    await TicketMedia.deleteMany({ ticket: { $in: ids } });
    const r = await BankTicket.deleteMany({ status: 'closed' });
    await BankLog.create({ action: 'delete_tickets', description: 'حذف التكتات المغلقة — العدد: ' + (r.deletedCount || 0), performedBy: req.user.id, performedByTag: await supDisplayName(req) });
    bumpTicketActivity(); res.json({ ok: true, deleted: r.deletedCount || 0 });
});
app.delete('/api/support/admin/tickets/:id', supMw, supSeniorOnly, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'التكت غير موجود' });
    const t = await BankTicket.findById(req.params.id).select('no status');
    if (!t) return res.status(404).json({ error: 'التكت غير موجود' });
    if (t.status !== 'closed') return res.status(400).json({ error: 'تقدر تحذف التكتات المغلقة فقط' });
    await TicketMedia.deleteMany({ ticket: String(t._id) }); await BankTicket.deleteOne({ _id: t._id });
    bumpTicketActivity(); res.json({ ok: true });
});

// ── الصفحة الرئيسية ─────────────────────────────────────────────────────────
app.use(async (req, res) => {
    const FLASH_HOME = flashHome(req);
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
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
        (function () {
            var f0 = window.fetch;
            window.fetch = function (u, o) {
                o = o || {};
                if (!o.signal && typeof AbortController !== 'undefined') {
                    var c = new AbortController(); o = Object.assign({}, o, { signal: c.signal });
                    var big = o.body && String(o.body).length > 300000;
                    var t = setTimeout(function () { try { c.abort(); } catch (e) {} }, big ? 90000 : 35000);
                    return f0.call(this, u, o).finally(function () { clearTimeout(t); });
                }
                return f0.call(this, u, o);
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
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:2px solid #3b82f6; padding-bottom:10px;">
                <h2 style="color:#60a5fa; margin:0; border:0; padding:0;">🎧 خدمة العملاء</h2>
                <button onclick="closeSupportModal()" style="background:none; border:none; color:white; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="sp-body"></div>
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
                <button id="atab-profile" class="tab-btn" style="display:none;" onclick="switchAdminTab('profile')">🔎 ملف عضو</button>
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

            <div id="atab-profile-section" style="display:none;">
                <div id="profile-container"></div>
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

    <style>${BANK_EXT_CSS}</style>
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
            window.ownerPower = !!data.ownerPower;

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
                    ['atab-stats','atab-accounts','atab-card-control','atab-profile','atab-staff','atab-locks'].forEach(id => {
                        const b = document.getElementById(id); if (b) b.style.display = 'none';
                    });
                } else if (currentRole === 'management') {
                    // إداري: القروض + البطاقات + الدعم + الحسابات
                    document.getElementById('admin-fab-btn').innerText = '⚙️ لوحة الإداري';
                    document.getElementById('admin-panel-title').innerText = "لوحة الإداري 🏢";
                    ['atab-stats','atab-card-control','atab-profile','atab-staff','atab-locks'].forEach(id => {
                        const b = document.getElementById(id); if (b) b.style.display = 'none';
                    });
                }

                if(currentRole === 'super_admin') {
                    document.getElementById('atab-settings').style.display = 'block';
                    document.getElementById('atab-bank-log').style.display = 'block';
                    document.getElementById('atab-card-control').style.display = 'block';
                    document.getElementById('atab-profile').style.display = 'block';
                    document.getElementById('atab-military-salary').style.display = 'block';
                    document.getElementById('superadmin-only-locks').style.display = 'block';
                    document.getElementById('admin-panel-title').innerText = "لوحة كبار مسؤولي البنك 👑";
                }
            }
            await loadDashboard();
            loadNotifCount();
            startUserPolling();
            if (window.bkOwnerInit) bkOwnerInit();
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




        init();
    </script>
    <script>${BANK_EXT_JS}</script>
    <script>${BANK_EXT2_JS}</script>

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
