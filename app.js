const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;

const app = express();

// ── إعدادات ديسكورد والمسؤولين ──────────────────────────────────────────
const DISCORD_CLIENT_ID = '1270290369359384600';
const DISCORD_CLIENT_SECRET = 'alqaq47MY2ge50dJ2YOp6wevAak0y1av';
const DISCORD_CALLBACK_URL = 'https://id-1f0p.onrender.com/auth/discord/callback';

// قائمة كبار المسؤولين (أصحاب الصلاحيات الكاملة)
const SUPER_ADMIN_IDS = ['1003511814140743825', '1231269832201207808', '1458502584481484952']; 

// ── MongoDB والموديلات ──────────────────────────────────────────────────
mongoose.connect("mongodb+srv://hmooduu6_db_user:0ks7Ktqh5IIteciW@cluster0.6bk7qm9.mongodb.net/?appName=Cluster0")
.then(() => {
    console.log("✅ MongoDB connected");
    initSettings();
})
.catch(err => console.log("❌ MongoDB error:", err));


// موديل الهوية مع رقم الهوية والاختصار
const IdSchema = new mongoose.Schema({
    idNumber: { type: String, unique: true },
    shortId: { type: String, unique: true },
    name: String,
    age: String,
    dob: String,
    nationality: String,
    gender: String,
    discord: String, 
    discordTag: String, 
    status: { type: String, default: "pending" }, 
    rejectedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
const Id = mongoose.model("Id", IdSchema);

// موديل الإعدادات
const SettingsSchema = new mongoose.Schema({
    isMaintenance: { type: Boolean, default: false },
    isApplyLocked: { type: Boolean, default: false },
    isIdsPageLocked: { type: Boolean, default: false },
    staffList: { type: [String], default: [] }
});
const Settings = mongoose.model("Settings", SettingsSchema);

// ── موديل طلبات فتح حساب البنك ─────────────────────────────────────────
const BankRequestSchema = new mongoose.Schema({
    discord: { type: String, required: true },
    discordTag: { type: String },
    idNumber: { type: String },   // رقم الهوية الطويل أو القصير اللي دخله
    status: { type: String, default: "pending" }, // pending / approved / rejected
    accountNumber: { type: String, default: null }, // 6 أرقام عند القبول
    createdAt: { type: Date, default: Date.now }
});
const BankRequest = mongoose.model("BankRequest", BankRequestSchema);

// ── موديل اللوق الشامل (سجل كل أحداث الموقع للسوبر أدمين) ───────────────────────
const ApprovalLogSchema = new mongoose.Schema({
    discordId: String,       // آيدي المستخدم المتأثر بالحدث (صاحب الطلب مثلاً)
    discordTag: String,
    actorId: { type: String, default: null },   // آيدي اللي سوى الإجراء (أدمن/سوبر أدمين)
    actorTag: { type: String, default: null },
    action: String,       // نوع الحدث: id_submitted / id_approved / id_rejected / id_hidden / id_unarchived / bank_request_submitted / bank_approved / bank_rejected / staff_added / staff_removed / settings_toggled
    site: String,         // اسم الموقع/القسم اللي صار فيه الحدث
    accountNumber: String,
    details: { type: String, default: '' },   // وصف إضافي عن الحدث
    createdAt: { type: Date, default: Date.now }
});
const ApprovalLog = mongoose.model("ApprovalLog", ApprovalLogSchema);

// دالة عامة لتسجيل أي حدث يصير في الموقع داخل اللوق
async function logEvent({ action, discordId = null, discordTag = null, actorId = null, actorTag = null, site = "وزارة الداخلية", accountNumber = null, details = '' }) {
    try {
        await ApprovalLog.create({ action, discordId, discordTag, actorId, actorTag, site, accountNumber, details });
    } catch (e) { console.log("⚠️ فشل تسجيل الحدث باللوق:", e.message); }
}

// دالة لتجهيز الإعدادات الافتراضية
async function initSettings() {
    let set = await Settings.findOne();
    if (!set) {
        await Settings.create({ staffList: [], isMaintenance: false });
    } else {
        // هذا السطر يغصب قاعدة البيانات على إلغاء الصيانة فور تشغيل السيرفر
        await Settings.updateOne({}, { isMaintenance: false });
    }
}

// ── API خاص للبحث من قبل نظام الشرطة ─────────────────────────────────────
app.get("/api/police/search/:idInput", async (req, res) => {
    try {
        const { idInput } = req.params;
        // البحث عن الهوية سواء بالرقم الطويل أو القصير
        const person = await Id.findOne({
            $or: [{ idNumber: idInput }, { shortId: idInput }],
            status: "approved"
        });

        if (!person) {
            return res.json({ success: false, msg: "لم يتم العثور على هوية معتمدة بهذا الرقم" });
        }

        res.json({ 
            success: true, 
            person: {
                name: person.name,
                idNumber: person.idNumber,
                shortId: person.shortId,
                discord: person.discord,
                nationality: person.nationality
            } 
        });
    } catch (e) {
        res.json({ success: false, msg: "خطأ في السيرفر: " + e.message });
    }
});


// ── دالات مساعدة ─────────────────────────────────────────────────────────
function generateUniqueNumbers() {
    const idNumber = Math.floor(10000000000 + Math.random() * 90000000000).toString();
    const shortId = Math.floor(10000 + Math.random() * 90000).toString();
    return { idNumber, shortId };
}

function generateAccountNumber() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Middleware للتحقق من الرتب والصيانة ──────────────────────────────────
async function getRole(discordId) {
    if (SUPER_ADMIN_IDS.includes(discordId)) return 'super_admin';
    const settings = await Settings.findOne();
    if (settings && settings.staffList.includes(discordId)) return 'staff';
    return 'user';
}

async function isStaff(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getRole(req.user.id);
    if (role === 'staff' || role === 'super_admin') return next();
    return res.status(403).json({ success: false, msg: "غير مصرح لك" });
}

async function isSuperAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const role = await getRole(req.user.id);
    if (role === 'super_admin') return next();
    return res.status(403).json({ success: false, msg: "هذه الصلاحية لكبار المسؤولين فقط" });
}

async function checkMaintenance(req, res, next) {
    const settings = await Settings.findOne();
    
    // إذا كان وضع الصيانة مفعلاً في قاعدة البيانات والموقع مقفل
    if (settings && settings.isMaintenance) {
        if (req.isAuthenticated()) {
            const role = await getRole(req.user.id);
            if (role === 'super_admin') return next(); 
        }
        if (req.path.startsWith('/api/')) {
            return res.json({ success: true, maintenance: true, msg: "الموقع في وضع الصيانة حالياً" });
        }
        // هنا قمنا بإضافة هذا السطر لكي يمرر الصفحات العادية للسوبر أدمين فقط، أو يمكنك تركه كما هو
    }
    next();
}


// ── Middleware الإعدادات الأساسية ──────────────────────────────────────────
app.use(session({ 
    secret: 'norv_civil_secret_111',
    resave: false, 
    saveUninitialized: false,
    name: 'civil_session',  // ← هنا برا الـ cookie
    cookie: { 
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));



app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public"));
app.use(passport.initialize());
app.use(passport.session());

// ── Passport Configuration ──────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: DISCORD_CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// ── Auth Routes ────────────────────────────────────────────────────────
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
});

app.get('/api/auth/me', async (req, res) => {
    if (req.isAuthenticated()) {
        const role = await getRole(req.user.id);
        res.json({ loggedIn: true, user: req.user, role });
    } else {
        res.json({ loggedIn: false, role: 'user' });
    }
});
app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// ── APIs المواطنين ────────────────────────────────────────────────────────

app.post("/api/ids", checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ success: false, msg: "يجب تسجيل الدخول أولاً" });
    try {
        const settings = await Settings.findOne();
        if (settings && settings.isApplyLocked) {
            return res.json({ success: false, msg: "استخراج الهويات مقفل حالياً من قبل الإدارة" });
        }
        const { name, age, dob, nationality, gender } = req.body;
        const discordId = req.user.id;
        if (!name || !age || !dob || !nationality || !gender)
            return res.json({ success: false, msg: "يجب ملء جميع الحقول" });
        const count = await Id.countDocuments({ discord: discordId, status: { $ne: "hidden" } });
        if (count >= 1)
            return res.json({ success: false, msg: "لديك هوية واحدة مسجلة بالفعل، غير مسموح بتقديم أكثر من هوية" });
        let uniqueIds = generateUniqueNumbers();
        let isExist = await Id.findOne({ $or: [{ idNumber: uniqueIds.idNumber }, { shortId: uniqueIds.shortId }] });
        while (isExist) { 
            uniqueIds = generateUniqueNumbers();
            isExist = await Id.findOne({ $or: [{ idNumber: uniqueIds.idNumber }, { shortId: uniqueIds.shortId }] });
        }
        const id = await Id.create({ 
            idNumber: uniqueIds.idNumber,
            shortId: uniqueIds.shortId,
            name, age, dob, nationality, gender, 
            discord: discordId,
            discordTag: req.user.username 
        });
        await logEvent({
            action: "id_submitted",
            discordId, discordTag: req.user.username,
            details: `تقديم طلب هوية جديد باسم: ${name}`
        });
        res.json({ success: true, id });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

app.get("/api/ids/my", checkMaintenance, async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const settings = await Settings.findOne();
        if (settings && settings.isIdsPageLocked) {
            return res.json({ locked: true, msg: "صفحة استعراض الهويات مقفلة مؤقتاً" });
        }
        const ids = await Id.find({ discord: req.user.id, status: { $ne: "hidden" } });
        res.json(ids);
    } catch (e) { res.json([]); }
});

// ── APIs البنك (طلبات فتح الحساب) ─────────────────────────────────────────

// البنك يرسل طلب للتحقق من الهوية
app.post("/api/bank/verify-id", async (req, res) => {
    try {
        const { idInput, discordId, discordTag } = req.body;
        if (!idInput || !discordId) return res.json({ success: false, msg: "بيانات ناقصة" });

        // تحقق من الهوية في قاعدة البيانات
        const foundId = await Id.findOne({
            $or: [{ idNumber: idInput }, { shortId: idInput }],
            discord: discordId,
            status: "approved"
        });

        if (!foundId) {
            return res.json({ success: false, msg: "الهوية غير موجودة أو غير مقبولة أو لا تخصك" });
        }

        // تحقق ما عنده طلب سابق معلق
        const existing = await BankRequest.findOne({ discord: discordId, status: "pending" });
        if (existing) {
            return res.json({ success: false, msg: "عندك طلب فتح حساب معلق، انتظر رد الإدارة" });
        }

        // تحقق ما عنده حساب مفتوح
        const hasAccount = await BankRequest.findOne({ discord: discordId, status: "approved" });
        if (hasAccount) {
            return res.json({ success: false, msg: "عندك حساب بنكي مفتوح مسبقاً", accountNumber: hasAccount.accountNumber });
        }

        // إنشاء طلب فتح حساب
        await BankRequest.create({
            discord: discordId,
            discordTag: discordTag || "غير معروف",
            idNumber: idInput
        });

        await logEvent({
            action: "bank_request_submitted",
            discordId, discordTag: discordTag || "غير معروف",
            site: "بنك وزارة الداخلية",
            details: `طلب فتح حساب برقم هوية: ${idInput}`
        });

        res.json({ success: true, msg: "تم إرسال طلب فتح الحساب، انتظر القبول في موقع الأحوال المدنية" });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

// البنك يسأل عن حالة طلبه
app.get("/api/bank/status/:discordId", async (req, res) => {
    try {
        const req2 = await BankRequest.findOne({ discord: req.params.discordId }).sort({ createdAt: -1 });
        if (!req2) return res.json({ status: "none" });
        res.json({ status: req2.status, accountNumber: req2.accountNumber });
    } catch (e) {
        res.json({ status: "none" });
    }
});

// المستخدم يجلب طلباته في صفحة الأحوال المدنية
app.get("/api/bank/my-requests", async (req, res) => {
    if (!req.isAuthenticated()) return res.json([]);
    try {
        const requests = await BankRequest.find({ discord: req.user.id }).sort({ createdAt: -1 });
        res.json(requests);
    } catch (e) { res.json([]); }
});

// المستخدم يقبل أو يرفض طلبه بنفسه
app.put("/api/bank/my-requests/:id/:action", async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, msg: "يجب تسجيل الدخول" });
    const { id, action } = req.params;
    try {
        const bankReq = await BankRequest.findById(id);
        if (!bankReq) return res.json({ success: false, msg: "الطلب غير موجود" });
        if (bankReq.discord !== req.user.id) return res.json({ success: false, msg: "هذا الطلب ليس لك" });
        if (bankReq.status !== "pending") return res.json({ success: false, msg: "تم البت في هذا الطلب مسبقاً" });

        let accountNumber = null;
        if (action === "approve") {
            // توليد رقم حساب فريد
            accountNumber = generateAccountNumber();
            let exists = await BankRequest.findOne({ accountNumber });
            while (exists) {
                accountNumber = generateAccountNumber();
                exists = await BankRequest.findOne({ accountNumber });
            }
            await BankRequest.findByIdAndUpdate(id, { status: "approved", accountNumber });

            // تسجيل في لوق السوبر أدمين
            await ApprovalLog.create({
                discordId: req.user.id,
                discordTag: req.user.username,
                action: "bank_approved",
                site: "بنك وزارة الداخلية",
                accountNumber
            });

            return res.json({ success: true, msg: "تم قبول الطلب", accountNumber });
        } else if (action === "reject") {
            await BankRequest.findByIdAndUpdate(id, { status: "rejected" });

            await ApprovalLog.create({
                discordId: req.user.id,
                discordTag: req.user.username,
                action: "bank_rejected",
                site: "بنك وزارة الداخلية",
                accountNumber: null
            });

            return res.json({ success: true, msg: "تم رفض الطلب" });
        } else {
            return res.json({ success: false, msg: "إجراء غير صحيح" });
        }
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

// ── APIs لوحة المسؤولين ────────────────────────────────────────────────────

app.get("/api/admin/ids", isStaff, async (req, res) => {
    try {
        const ids = await Id.find({ status: { $ne: "hidden" } }).sort({ createdAt: -1 });
        res.json(ids);
    } catch (e) { res.json([]); }
});

app.get("/api/admin/ids/archived", isSuperAdmin, async (req, res) => {
    try {
        const ids = await Id.find({ status: "hidden" }).sort({ createdAt: -1 });
        res.json(ids);
    } catch (e) { res.json([]); }
});

app.put("/api/admin/ids/:id/:action", isStaff, async (req, res) => {
    const { id, action } = req.params;
    if ((action === 'hide' || action === 'unarchive')) {
        const role = await getRole(req.user.id);
        if (role !== 'super_admin') {
            return res.status(403).json({ success: false, msg: "الأرشفة صلاحية كبار المسؤولين فقط" });
        }
    }
    let update = {};
    if (action === 'approve') update = { status: "approved", rejectedAt: null };
    if (action === 'reject') update = { status: "rejected", rejectedAt: new Date() };
    if (action === 'hide') update = { status: "hidden" };
    if (action === 'unarchive') update = { status: "pending" };
    try {
        const targetId = await Id.findById(id);
        if (action === 'approve' && (!targetId.idNumber || !targetId.shortId)) {
            let uniqueIds = generateUniqueNumbers();
            let isExist = await Id.findOne({ $or: [{ idNumber: uniqueIds.idNumber }, { shortId: uniqueIds.shortId }] });
            while (isExist) {
                uniqueIds = generateUniqueNumbers();
                isExist = await Id.findOne({ $or: [{ idNumber: uniqueIds.idNumber }, { shortId: uniqueIds.shortId }] });
            }
            update.idNumber = uniqueIds.idNumber;
            update.shortId = uniqueIds.shortId;
        }
        await Id.findByIdAndUpdate(id, update);

        const actionLabels = {
            approve: "id_approved",
            reject: "id_rejected",
            hide: "id_hidden",
            unarchive: "id_unarchived"
        };
        if (targetId && actionLabels[action]) {
            await logEvent({
                action: actionLabels[action],
                discordId: targetId.discord, discordTag: targetId.discordTag,
                actorId: req.user.id, actorTag: req.user.username,
                site: "لوحة إدارة الأحوال المدنية",
                details: action === 'approve' ? `تم اعتماد الهوية (${update.idNumber || targetId.idNumber})` : `الاسم: ${targetId.name}`
            });
        }

        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// ── حذف الهوية نهائياً من الأرشيف (كبار المسؤولين فقط) ────────────────────
app.delete("/api/admin/ids/:id/delete", isSuperAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const targetId = await Id.findById(id);
        if (!targetId) return res.status(404).json({ success: false, msg: "الهوية غير موجودة" });
        if (targetId.status !== 'hidden') {
            return res.status(400).json({ success: false, msg: "لا يمكن حذف هوية إلا وهي في الأرشيف" });
        }
        await Id.findByIdAndDelete(id);
        await logEvent({
            action: "id_deleted",
            discordId: targetId.discord, discordTag: targetId.discordTag,
            actorId: req.user.id, actorTag: req.user.username,
            site: "لوحة إدارة الأحوال المدنية",
            details: `تم حذف الهوية نهائياً (${targetId.name})`
        });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: "خطأ في النظام" }); }
});

// ── API تصفير المستخدم من البنك ──────────────────────────────────────────

app.post("/api/bank/reset-user/:discordId", async (req, res) => {
    try {
        const { discordId } = req.params;

        if (!discordId) {
            return res.json({
                success: false,
                msg: "لم يتم إرسال الآيدي"
            });
        }

        // حذف الهويات الخاصة بالمستخدم
        await Id.deleteMany({ discord: discordId });

        // حذف طلبات البنك المرتبطة
        await BankRequest.deleteMany({ discord: discordId });

        // حذف سجلات القبول المرتبطة إذا موجودة
        try {
            await ApprovalLog.deleteMany({ discordId });
        } catch {}

        res.json({
            success: true,
            msg: "تم تصفير المستخدم بنجاح"
        });

    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
});

// ── APIs كبار المسؤولين ────────────────────────────────────────────────────

app.get("/api/superadmin/settings", isSuperAdmin, async (req, res) => {
    const settings = await Settings.findOne();
    res.json(settings);
});

app.post("/api/superadmin/settings/toggle", isSuperAdmin, async (req, res) => {
    const { isMaintenance, isApplyLocked, isIdsPageLocked } = req.body;
    try {
        await Settings.updateOne({}, { isMaintenance, isApplyLocked, isIdsPageLocked });
        await logEvent({
            action: "settings_toggled",
            actorId: req.user.id, actorTag: req.user.username,
            site: "إعدادات كبار السمؤولين",
            details: `صيانة: ${isMaintenance ? "مفعلة" : "متوقفة"} | قفل التقديم: ${isApplyLocked ? "مفعل" : "متوقف"} | قفل صفحة الهويات: ${isIdsPageLocked ? "مفعل" : "متوقف"}`
        });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post("/api/superadmin/staff/add", isSuperAdmin, async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.json({ success: false, msg: "يرجى إدخال الآيدي" });
    try {
        await Settings.updateOne({}, { $addToSet: { staffList: discordId } });
        await logEvent({
            action: "staff_added",
            discordId,
            actorId: req.user.id, actorTag: req.user.username,
            site: "إعدادات كبار السمؤولين",
            details: `تم تعيين الآيدي ${discordId} كمسؤول`
        });
        res.json({ success: true, msg: "تم تعيين المسؤول بنجاح" });
    } catch (e) { res.json({ success: false, msg: "خطأ في النظام" }); }
});

app.post("/api/superadmin/staff/remove", isSuperAdmin, async (req, res) => {
    const { discordId } = req.body;
    try {
        await Settings.updateOne({}, { $pull: { staffList: discordId } });
        await logEvent({
            action: "staff_removed",
            discordId,
            actorId: req.user.id, actorTag: req.user.username,
            site: "إعدادات كبار المسؤولين",
            details: `تم طرد الآيدي ${discordId} من المسؤولين`
        });
        res.json({ success: true, msg: "تم طرد المسؤول بنجاح" });
    } catch (e) { res.json({ success: false, msg: "خطأ في النظام" }); }
});

// جلب اللوق الشامل لكبار المسؤولين
app.get("/api/superadmin/approval-log", isSuperAdmin, async (req, res) => {
    try {
        const logs = await ApprovalLog.find().sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.json([]); }
});

// ── API للموظفين: جلب طلبات البنك المعلقة ─────────────────────────────────
app.get("/api/admin/bank-requests", isStaff, async (req, res) => {
    try {
        const requests = await BankRequest.find({ status: "pending" }).sort({ createdAt: -1 });
        res.json(requests);
    } catch (e) { res.json([]); }
});

// ── API للموظفين: قبول أو رفض طلب بنك ────────────────────────────────────
app.put("/api/admin/bank-requests/:id/:action", isStaff, async (req, res) => {
    const { id, action } = req.params;
    try {
        const bankReq = await BankRequest.findById(id);
        if (!bankReq) return res.json({ success: false, msg: "الطلب غير موجود" });
        if (bankReq.status !== "pending") return res.json({ success: false, msg: "تم البت في هذا الطلب مسبقاً" });

        if (action === "approve") {
            let accountNumber = generateAccountNumber();
            let exists = await BankRequest.findOne({ accountNumber });
            while (exists) {
                accountNumber = generateAccountNumber();
                exists = await BankRequest.findOne({ accountNumber });
            }
            await BankRequest.findByIdAndUpdate(id, { status: "approved", accountNumber });
            await ApprovalLog.create({
                discordId: bankReq.discord,
                discordTag: bankReq.discordTag,
                actorId: req.user.id,
                actorTag: req.user.username,
                action: "bank_approved",
                site: "الأحوال المدنية (موظف)",
                accountNumber
            });
            return res.json({ success: true, msg: "تم قبول الطلب", accountNumber });

        } else if (action === "reject") {
            await BankRequest.findByIdAndUpdate(id, { status: "rejected" });
            await ApprovalLog.create({
                discordId: bankReq.discord,
                discordTag: bankReq.discordTag,
                actorId: req.user.id,
                actorTag: req.user.username,
                action: "bank_rejected",
                site: "الأحوال المدنية (موظف)",
                accountNumber: null
            });
            return res.json({ success: true, msg: "تم رفض الطلب" });
        } else {
            return res.json({ success: false, msg: "إجراء غير صحيح" });
        }
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

// ── Frontend HTML/JS ────────────────────────────────────────────────────────
app.use(async (req, res) => {
    const settings = await Settings.findOne();
    let maintenanceActive = false;
    if (settings && settings.isMaintenance) {
        maintenanceActive = true;
        if (req.isAuthenticated()) {
            const role = await getRole(req.user.id);
            if (role === 'super_admin') maintenanceActive = false;
        }
    }

    if (maintenanceActive) {
        return res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8"><title>صيانة ومجدولة</title>
            <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@700&display=swap" rel="stylesheet">
            <style>
                body { background: #0a1628; color: #fca5a5; font-family: 'Tajawal', sans-serif; text-align: center; padding-top: 20vh; }
                .box { border: 2px solid #ef4444; background: rgba(239,68,68,0.1); padding: 30px; display:inline-block; border-radius:15px; }
                .disclaimer-bar { position: fixed; top: 0; left: 0; width: 100%; z-index: 999999; background: #dc2626; color: #fff; text-align: center; font-weight: 900; font-size: 0.85rem; padding: 10px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); font-family: 'Tajawal', sans-serif; }
                @media (max-width: 640px) { .disclaimer-bar { font-size: 0.72rem; padding: 8px 6px; } }
            </style>
        </head>
        <body>
            <div class="disclaimer-bar">⚠️ تنبيه: هذا الموقع مخصص للمحاكاة واللعب فقط، ولا يمت للواقع بصلة.</div>
            <div class="box">
                <h1>⚙️ الموقع تحت الصيانة حالياً</h1>
                <p style="color: #e2e8f0; margin-top:10px;">نعمل الآن على تحديث الأنظمة وتطوير الأحوال المدنية، يرجى العودة لاحقاً.</p>
                ${req.isAuthenticated() ? '' : `
                <div style="margin-top:20px;">
                    <a href="/auth/discord" style="display:inline-block; background:#5865F2; color:#fff; text-decoration:none; padding:10px 22px; border-radius:10px; font-weight:700; font-family:'Tajawal',sans-serif;">تسجيل الدخول عبر ديسكورد</a>
                </div>`}
            </div>
        </body>
        </html>`);
    }

    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>الأحوال المدنية — MOI</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { min-height: 100vh; background: linear-gradient(135deg, #0a1628 0%, #0d1f3c 40%, #0a2744 70%, #0d3060 100%); font-family: 'Tajawal', sans-serif; color: #e2e8f0; direction: rtl; }
        nav { background: rgba(5,15,30,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(59,130,246,0.3); padding: 0 1.5rem; display: flex; align-items: center; justify-content: space-between; height: 60px; position: sticky; top: 0; z-index: 100; }
        .logo { font-size: 1.4rem; font-weight: 900; background: linear-gradient(90deg,#60a5fa,#3b82f6,#1d4ed8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: 2px; }
        .nav-links { display: flex; gap: 0.5rem; list-style: none; }
        .nav-links button { background: transparent; border: 1px solid transparent; color: #94a3b8; padding: 0.35rem 0.8rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 0.85rem; transition: all 0.2s; }
        .nav-links button.active, .nav-links button:hover { background: rgba(59,130,246,0.2); border-color: #3b82f6; color: #60a5fa; }
        .login-btn { background: #5865F2; color: white; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; font-family: inherit; }
        .page { display: none; max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
        .page.active { display: block; }
        .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(59,130,246,0.2); border-radius: 16px; padding: 1.5rem; backdrop-filter: blur(8px); margin-bottom: 1.2rem; }
        h1 { color: #60a5fa; margin-bottom: 1.2rem; font-size: 1.6rem; }
        h2 { color: #60a5fa; margin-bottom: 1rem; font-size: 1.2rem; border-bottom: 1px solid rgba(59,130,246,0.2); padding-bottom: 0.7rem; }
        input, select { width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(59,130,246,0.3); border-radius: 8px; color: #e2e8f0; padding: 0.65rem 1rem; font-size: 0.9rem; font-family: inherit; outline: none; margin-bottom: 0.9rem; }
        .btn { border: none; color: #fff; padding: 0.6rem 1.3rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 0.88rem; transition: opacity 0.2s; }
        .btn-purple { background: linear-gradient(135deg,#1d4ed8,#3b82f6); }
        .btn-full { width: 100%; padding: 0.75rem; margin-top: 0.5rem; }
        
        .id-card { background: linear-gradient(135deg, rgba(30,58,95,0.8), rgba(5,15,30,0.95)); border: 2px solid #3b82f6; border-radius: 15px; padding: 1.5rem; margin-bottom: 1.2rem; box-shadow: 0 8px 24px rgba(0,0,0,0.4); position: relative; overflow: hidden; }
        .id-card::before { content: 'MOI ID'; position: absolute; left: -10px; bottom: -10px; font-size: 4rem; font-weight: 900; color: rgba(255,255,255,0.03); z-index: 0; pointer-events: none; }
        .id-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(59,130,246,0.3); padding-bottom: 8px; margin-bottom: 12px; }
        .id-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; font-size: 0.95rem; position: relative; z-index: 1; }
        .id-item { background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(59,130,246,0.1); }
        
        .status-badge { padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; }
        .status-approved { background: rgba(34,197,94,0.2); color: #4ade80; border: 1px solid #22c55e; }
        .status-pending { background: rgba(234,179,8,0.2); color: #fde047; border: 1px solid #eab308; }
        .status-rejected { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid #ef4444; }

        .admin-fab {
            position: fixed; bottom: 25px; right: 25px;
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            color: white; padding: 14px 24px; border-radius: 50px;
            font-weight: bold; font-family: inherit; cursor: pointer;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            display: none; z-index: 999; border: 2px solid rgba(255,255,255,0.2); transition: 0.3s;
        }
        .admin-fab:hover { transform: scale(1.05); box-shadow: 0 6px 25px rgba(59,130,246,0.5); }

        .custom-modal {
            display: none; position: fixed; top: 0; left: 0;
            width: 100%; height: 100%; background: rgba(0,0,0,0.85);
            z-index: 10000; backdrop-filter: blur(8px);
        }
        .modal-content {
            max-width: 850px; margin: 40px auto; background: #050f1e;
            border: 2px solid #3b82f6; border-radius: 15px; padding: 25px;
            max-height: 85vh; overflow-y: auto; color: white;
        }
        .toggle-btn { padding: 8px 15px; border-radius: 6px; cursor: pointer; font-weight: bold; border: none; margin-left: 10px; }
        .active-status { background: #22c55e; color: white; }
        .inactive-status { background: #ef4444; color: white; }
        
        .tabs-container { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid rgba(59,130,246,0.3); padding-bottom: 10px; flex-wrap: wrap; }
        .tab-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(59,130,246,0.3); color: #94a3b8; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; }
        .tab-btn.active { background: #3b82f6; color: white; border-color: #3b82f6; }

        /* Responsive */
        @media (max-width: 640px) {
            nav { padding: 0 0.8rem; height: auto; min-height: 60px; flex-wrap: wrap; gap: 6px; padding-top: 8px; padding-bottom: 8px; }
            .logo { font-size: 1.15rem; }
            .nav-links { display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; gap: 4px; flex-wrap: nowrap; width: 100%; }
            .nav-links::-webkit-scrollbar { display: none; }
            .nav-links button { font-size: 0.75rem; padding: 5px 9px; white-space: nowrap; flex-shrink: 0; }
            #auth-section { width: 100%; display: flex; justify-content: flex-end; padding-bottom: 6px; }
            .page { padding: 1.2rem 0.8rem 3rem; }
            h1 { font-size: 1.3rem; }
            .id-grid { grid-template-columns: 1fr; }
            .modal-content { margin: 10px auto; padding: 15px; max-height: 90vh; }
            .tabs-container { gap: 6px; }
            .tab-btn { padding: 5px 10px; font-size: 0.76rem; }
            .admin-fab { padding: 11px 18px; font-size: 0.82rem; bottom: 15px; right: 12px; }
            .bank-req-card { padding: 1rem; }
            .log-item { flex-direction: column; align-items: flex-start; gap: 5px; }
        }
        @media (max-width: 400px) {
            .logo { font-size: 1rem; }
            h1 { font-size: 1.15rem; }
            .card { padding: 1rem; }
        }

        /* بطاقة طلب البنك */
        .bank-req-card { background: rgba(59,130,246,0.05); border: 1px solid #3b82f6; border-radius: 12px; padding: 1.2rem; margin-bottom: 1rem; }
        .bank-req-card.approved { border-color: #22c55e; background: rgba(34,197,94,0.05); }
        .bank-req-card.rejected { border-color: #ef4444; background: rgba(239,68,68,0.05); }

        /* لوق السوبر أدمين */
        .log-item { background: rgba(255,255,255,0.02); border: 1px solid rgba(59,130,246,0.2); border-radius: 8px; padding: 10px 15px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 0.88rem; }
        .log-bank-approved { border-color: #22c55e; }
        .log-bank-rejected { border-color: #ef4444; }

        /* شريط التحذير الثابت أعلى الموقع */
        .disclaimer-bar { position: fixed; top: 0; left: 0; width: 100%; z-index: 999999; background: #dc2626; color: #fff; text-align: center; font-weight: 900; font-size: 0.85rem; padding: 10px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
        @media (max-width: 640px) { .disclaimer-bar { font-size: 0.72rem; padding: 8px 6px; } }
    </style>
</head>
<body>
    <div class="disclaimer-bar" id="norvDisclaimerBar">⚠️ تنبيه: هذا الموقع مخصص للمحاكاة واللعب فقط، ولا يمت للواقع بصلة.</div>
    <script>
        (function() {
            function adjustForDisclaimer() {
                var bar = document.getElementById('norvDisclaimerBar');
                var nav = document.querySelector('nav');
                if (!bar) return;
                var h = bar.offsetHeight;
                document.body.style.paddingTop = h + 'px';
                if (nav) nav.style.top = h + 'px';
            }
            window.addEventListener('DOMContentLoaded', adjustForDisclaimer);
            window.addEventListener('load', adjustForDisclaimer);
            window.addEventListener('resize', adjustForDisclaimer);
        })();
    </script>
    <nav>
        <div class="logo">MOI</div>
        <ul class="nav-links">
            <li><button onclick="goPage('home')" id="nav-home" class="active">الرئيسية</button></li>
            <li><button onclick="goPage('ids')" id="nav-ids">هوياتي</button></li>
            <li><button onclick="goPage('apply')" id="nav-apply">تقديم هوية</button></li>
            <li><button onclick="goPage('bank')" id="nav-bank">🏦 طلبات البنك</button></li>
        </ul>
        <div id="auth-section">
            <button class="login-btn" onclick="location.href='/auth/discord'">تسجيل دخول ديسكورد</button>
        </div>
    </nav>

    <div id="page-home" class="page active">
        <div style="text-align:center; margin-bottom:2rem;">
            <h1 style="font-size:3rem; text-shadow: 0 0 15px #3b82f6;">الأحوال المدنية</h1>
            <p>النظام الرسمي لوزارة الداخلية لاستخراج وإدارة الهويات الذكية</p>
        </div>
        <div class="card">
            <h2>📋 التعليمات والشروط الهامة</h2>
            <p style="margin-top:8px;">1. يجب أن يكون الاسم واقعي ومطابق لشروط سيرفر وزارة الداخلية (MOI).</p>
            <p style="margin-top:8px;">2. يمنع منعاً باتاً انتحال شخصيات المشاهير أو الإداريين.</p>
            <p style="margin-top:8px; color: #60a5fa; font-weight: bold;">3. يسمح بتقديم واستخراج (هويه وحده فقط 1) بحد أقصى لكل مواطن.</p>
            <p style="margin-top:8px;">4. عند الموافقة، ستحصل هويتك تلقائياً على رقم وطني فريد (11 رقم) واختصار فريد (5 أرقام).</p>
        </div>
    </div>

    <div id="page-ids" class="page">
        <h1>🪪 السجل المدني (هوياتي)</h1>
        <div id="my-ids-container" style="margin-top: 1.5rem;">جاري تحميل الهويات...</div>
    </div>

    <div id="page-apply" class="page">
        <h1>📝 تقديم طلب هوية جديدة</h1>
        <p style="color:#94a3b8; margin-bottom:1rem;">يمكنك امتلاك هويه واحد فقط لكل مستخدم كحد أقصى بالنظام.</p>
        <div id="apply-form-container" class="card">
            <div id="apply-msg"></div>
            <label>الاسم الكامل:</label>
            <input id="f-name" placeholder="الاسم الرباعي الكامل باللغة العربية" />
            <label>العمر:</label>
            <input id="f-age" type="number" placeholder="مثال: 25" />
            <label>تاريخ الميلاد:</label>
            <input id="f-dob" placeholder="مثال: 2001/04/18" />
            <label>الجنسية:</label>
            <select id="f-nat">
                <option value="">اختر الجنسية...</option>
                <option>🇸🇦 السعودية</option>
                <option>🇦🇪 الإمارات</option>
                <option>🇰🇼 الكويت</option>
                <option>🇶🇦 قطر</option>
                <option>🇧🇭 البحرين</option>
                <option>🇴🇲 عُمان</option>
                <option>🇪🇬 مصر</option>
                <option>🇯🇴 الأردن</option>
                <option>🇱🇧 لبنان</option>
                <option>🇮🇶 العراق</option>
                <option>🇲🇦 المغرب</option>
                <option>🇾🇪 اليمن</option>
                <option>🇩🇿 الجزائر</option>
                <option>🇹🇳 تونس</option>
            </select>
            <label>الجنس:</label>
            <select id="f-gender">
                <option value="">اختر...</option>
                <option>ذكر</option>
                <option>أنثى</option>
            </select>
            <button class="btn btn-purple btn-full" onclick="submitId()">إرسال الطلب بشكل رسمي</button>
        </div>
    </div>

    <!-- صفحة طلبات البنك -->
    <div id="page-bank" class="page">
        <h1>🏦 طلبات فتح حساب — بنك وزارة الداخلية</h1>
        <p style="color:#94a3b8; margin-bottom:1.5rem;">هنا تظهر طلبات فتح الحساب البنكي الواردة من بنك وزارة الداخلية. اقبل أو ارفض الطلب بنفسك.</p>
        <div id="bank-requests-container">جاري التحميل...</div>
    </div>

    <button id="admin-fab-btn" class="admin-fab" onclick="openAdminDashboard()">⚙️ لوحة الإدارة</button>

    <div id="adminModal" class="custom-modal">
        <div class="modal-content">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:2px solid #3b82f6; padding-bottom:10px;">
                <h2 id="admin-panel-title" style="color:#60a5fa;">لوحة إدارة الهويات ⚙️</h2>
                <button onclick="closeAdminModal()" style="background:none; border:none; color:white; font-size:24px; cursor:pointer;">✕</button>
            </div>
            
            <div class="tabs-container">
                <button id="tab-req" class="tab-btn active" onclick="switchMainTab('requests')">📥 طلبات الهوية</button>
                <button id="tab-bank" class="tab-btn" style="border-color:#3b82f6;" onclick="switchMainTab('bank')">🏦 طلبات البنك</button>
                <button id="tab-arch" class="tab-btn" style="display:none; border-color:#ef4444;" onclick="switchMainTab('archive')">🗄️ الأرشيف والمخفية</button>
                <button id="tab-log" class="tab-btn" style="display:none; border-color:#3b82f6;" onclick="switchMainTab('log')">📋 اللوق الشامل</button>
                <button id="tab-ctrl" class="tab-btn" style="display:none; border-color:#ef4444;" onclick="switchMainTab('controls')">👑 تحكم كبار المسؤولين</button>
            </div>

            <div id="admin-requests-section">
                <h3>📥 طلبات المواطنين الحالية</h3><br>
                <div id="admin-list-data">جاري تحميل الطلبات...</div>
            </div>

            <!-- قسم طلبات البنك للموظفين -->
            <div id="admin-bank-section" style="display:none;">
                <h3>🏦 طلبات فتح حساب بنك وزارة الداخلية المعلقة</h3>
                <p style="color:#94a3b8; font-size:0.85rem; margin: 8px 0 16px;">الطلبات اللي لم يرد عليها المستخدم بعد — تقدر تقبل أو ترفض بدلاً عنه.</p>
                <div id="admin-bank-data">جاري التحميل...</div>
            </div>

            <div id="admin-archive-section" style="display:none;">
                <h3>🗄️ الهويات المؤرشفة والمخفية</h3><br>
                <input id="archive-search" placeholder="🔍 ابحث بالاسم، اليوزر، الآيدي، رقم الهوية أو الاختصار..." oninput="filterArchive()" style="margin-bottom:15px;" />
                <div id="admin-archive-data">جاري تحميل الأرشيف...</div>
            </div>

            <!-- قسم اللوق الشامل -->
            <div id="admin-log-section" style="display:none;">
                <h3>📋 لوق الموقع الشامل</h3>
                <p style="color:#94a3b8; font-size:0.85rem; margin: 8px 0 16px;">سجل كامل بكل حدث يصير في الموقع: تقديم/قبول/رفض/أرشفة الهويات، طلبات البنك، تعيين وطرد المسؤولين، وتعديل الإعدادات.</p>
                <input id="log-search" placeholder="🔍 ابحث بالاسم، اليوزر، الآيدي، أو نوع الحدث..." oninput="filterLog()" style="margin-bottom:15px;" />
                <div id="admin-log-data">جاري التحميل...</div>
            </div>

            <div id="super-admin-controls-section" style="display:none;">
                <div class="card" style="border-color:#ef4444;">
                    <h3>🛠️ إعدادات التحكم والصيانة العامة</h3><br>
                    <div style="margin-bottom:15px; display:flex; align-items:center; justify-content:space-between;">
                        <span>وضع الصيانة الشامل:</span>
                        <button id="btn-toggle-maintenance" class="toggle-btn" onclick="toggleSetting('m')">تعطيل</button>
                    </div>
                    <div style="margin-bottom:15px; display:flex; align-items:center; justify-content:space-between;">
                        <span>إغلاق تقديم الهويات الجديدة:</span>
                        <button id="btn-toggle-apply" class="toggle-btn" onclick="toggleSetting('a')">تعطيل</button>
                    </div>
                    <div style="margin-bottom:15px; display:flex; align-items:center; justify-content:space-between;">
                        <span>إغلاق صفحة رؤية الهويات:</span>
                        <button id="btn-toggle-ids" class="toggle-btn" onclick="toggleSetting('i')">تعطيل</button>
                    </div>
                </div>
                <div class="card" style="border-color:#3b82f6;">
                    <h3>👥 إدارة طاقم المسؤولين</h3><br>
                    <div style="display:flex; gap:10px; margin-bottom:15px;">
                        <input id="new-staff-id" placeholder="ضع Discord User ID للمسؤول الجديد" style="margin-bottom:0;" />
                        <button class="btn" style="background:#22c55e;" onclick="addStaff()">تعيين كمسؤول</button>
                    </div>
                    <h4>قائمة المسؤولين الحاليين:</h4>
                    <ul id="current-staff-list" style="margin-top:10px; list-style-type:circle; padding-right:20px;"></ul>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentUserRole = 'user';
        let globalSettings = {};

        async function checkAuth() {
            const res = await fetch('/api/auth/me');
            const data = await res.json();
            if (data.loggedIn) {
                currentUser = data.user;
                currentUserRole = data.role;
                document.getElementById('auth-section').innerHTML = \`
                    <span style="margin-left:15px; font-weight:bold; color:#60a5fa;">\${data.user.username} (\${getRoleName(data.role)})</span>
                    <button class="btn" style="background:#dc2626;" onclick="location.href='/logout'">خروج</button>
                \`;
                if(currentUserRole === 'staff' || currentUserRole === 'super_admin') {
                    document.getElementById('admin-fab-btn').style.display = 'block';
                    if(currentUserRole === 'super_admin') {
                        document.getElementById('tab-ctrl').style.display = 'block';
                        document.getElementById('tab-log').style.display = 'block';
                        document.getElementById('tab-arch').style.display = 'block';
                        document.getElementById('admin-panel-title').innerText = "لوحة تحكم كبار المسؤولين 👑";
                    }
                }
                // حمّل طلبات البنك تلقائياً بعد التحقق من الدخول
                loadBankRequests();
            } else {
                // غير مسجل — أظهر رسالة بدل "جاري التحميل"
                document.getElementById('bank-requests-container').innerHTML = 
                    \`<div class="card" style="text-align:center; color:#ef4444;">يجب تسجيل الدخول أولاً لرؤية طلبات البنك.</div>\`;
            }
        }

        function getRoleName(role) {
            if(role === 'super_admin') return 'كبار المسؤولين 👑';
            if(role === 'staff') return 'مسؤول الأحوال ⚙️';
            return 'مواطن';
        }

        function goPage(p) {
            document.querySelectorAll(".page").forEach(el => el.classList.remove("active"));
            document.querySelectorAll(".nav-links button").forEach(el => el.classList.remove("active"));
            document.getElementById("page-"+p).classList.add("active");
            if(document.getElementById("nav-"+p)) document.getElementById("nav-"+p).classList.add("active");
            if(p === 'ids') loadMyIds();
            if(p === 'bank') loadBankRequests();
        }

        async function submitId() {
            if(!currentUser) return alert("سجل دخولك أولاً عبر ديسكورد!");
            const body = {
                name: document.getElementById("f-name").value,
                age: document.getElementById("f-age").value,
                dob: document.getElementById("f-dob").value,
                nationality: document.getElementById("f-nat").value,
                gender: document.getElementById("f-gender").value
            };
            const r = await fetch('/api/ids', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            const res = await r.json();
            const msg = document.getElementById("apply-msg");
            if(res.success) {
                msg.innerHTML = '<div class="card" style="background:rgba(34,197,94,0.2); border-color:#22c55e; color:#4ade80;">✅ تم إرسال طلب الهوية للمراجعة بنجاح!</div>';
                document.getElementById("f-name").value = "";
                document.getElementById("f-age").value = "";
                document.getElementById("f-dob").value = "";
                document.getElementById("f-nat").value = "";
                document.getElementById("f-gender").value = "";
            } else {
                msg.innerHTML = '<div class="card" style="background:rgba(239,68,68,0.2); border-color:#ef4444; color:#fca5a5;">❌ خطأ: ' + res.msg + '</div>';
            }
        }

        async function loadMyIds() {
            const container = document.getElementById('my-ids-container');
            if(!currentUser) return container.innerHTML = '<p class="card" style="text-align:center; color:#ef4444;">يجب تسجيل الدخول أولاً لرؤية السجل المدني الخاص بك.</p>';
            const r = await fetch('/api/ids/my');
            const data = await r.json();
            if(data.locked) return container.innerHTML = \`<p class="card" style="text-align:center; color:#ef4444;">⚠️ \${data.msg}</p>\`;
            if(data.length === 0) return container.innerHTML = '<p class="card" style="text-align:center; color:#64748b;">لا توجد هويات مسجلة باسمك حالياً.</p>';
            container.innerHTML = data.map(id => \`
                <div class="id-card">
                    <div class="id-header">
                        <span style="font-weight:900; font-size:1.1rem; color:#60a5fa;">ID CARD — MOI</span>
                        <span class="status-badge \${id.status === 'approved' ? 'status-approved' : (id.status === 'rejected' ? 'status-rejected' : 'status-pending')}">
                            \${id.status === 'approved' ? 'مقبولة ورسمية ✅' : (id.status === 'rejected' ? 'مرفوضة ❌' : 'قيد الانتظار ⏳')}
                        </span>
                    </div>
                    <div class="id-grid">
                        <div class="id-item"><b>الاسم الكامل:</b> \${id.name}</div>
                        <div class="id-item"><b>رقم الهوية الموحد:</b> <span style="color:#60a5fa; font-weight:bold;">\${id.idNumber || 'جاري التوليد بعد القبول'}</span></div>
                        <div class="id-item"><b>رقم الاختصار:</b> <span style="color:#60a5fa; font-weight:bold;">\${id.shortId || 'جاري التوليد'}</span></div>
                        <div class="id-item"><b>العمر:</b> \${id.age} سنة</div>
                        <div class="id-item"><b>تاريخ الميلاد:</b> \${id.dob}</div>
                        <div class="id-item"><b>الجنسية:</b> \${id.nationality}</div>
                        <div class="id-item"><b>الجنس:</b> \${id.gender}</div>
                        <div class="id-item"><b>حساب الديسكورد:</b> \${id.discordTag}</div>
                    </div>
                    \${id.status === 'rejected' ? \`
                    <div style="margin-top:12px; padding:10px 14px; border-radius:10px; background:rgba(239,68,68,0.1); border:1px solid #ef4444; color:#fca5a5; font-size:0.9rem;">
                        ⚠️ تم رفض هذه الهوية. للتواصل بخصوص إخفاء الهوية وإعادة التقديم من جديد، يرجى التواصل مع الدعم الفني للموقع عبر ديسكورد.
                    </div>\` : ''}
                </div>
            \`).join('');
        }

        // ── صفحة طلبات البنك ──────────────────────────────────────────────
        async function loadBankRequests() {
            const container = document.getElementById('bank-requests-container');
            container.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:20px;">جاري التحميل...</p>';

            const r = await fetch('/api/bank/my-requests');
            const data = await r.json();
            
            if(data.length === 0) {
                container.innerHTML = '<div class="card" style="text-align:center; color:#94a3b8;">لا توجد طلبات فتح حساب بنكي واردة حالياً.<br><small style="color:#64748b;">عندما تسجل في بنك وزارة الداخلية ستظهر الطلبات هنا.</small></div>';
                return;
            }

            container.innerHTML = data.map(req => \`
                <div class="bank-req-card \${req.status}">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <span style="font-weight:bold; color:#93c5fd;">🏦 طلب من بنك وزارة الداخلية</span>
                        <span class="status-badge \${req.status === 'approved' ? 'status-approved' : req.status === 'rejected' ? 'status-rejected' : 'status-pending'}">
                            \${req.status === 'approved' ? 'مقبول ✅' : req.status === 'rejected' ? 'مرفوض ❌' : 'في الانتظار ⏳'}
                        </span>
                    </div>
                    <p style="color:#94a3b8; font-size:0.9rem; margin-bottom:8px;">رقم الهوية المستخدم: <b style="color:#e2e8f0;">\${req.idNumber}</b></p>
                    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:10px;">تاريخ الطلب: \${new Date(req.createdAt).toLocaleString('ar-SA')}</p>
                    \${req.status === 'approved' ? \`
                        <div style="background:rgba(34,197,94,0.15); border:1px solid #22c55e; border-radius:8px; padding:10px; margin-bottom:10px;">
                            <p style="color:#4ade80; font-size:1rem; font-weight:bold;">✅ تم فتح الحساب البنكي بنجاح!</p>
                            <p style="color:#86efac; font-size:1.2rem; font-weight:900; letter-spacing:3px; margin-top:5px;">رقم الحساب: \${req.accountNumber}</p>
                            <p style="color:#6b7280; font-size:0.8rem; margin-top:5px;">⚠️ احفظ رقم الحساب هذا، ستحتاجه دائماً في البنك</p>
                        </div>
                    \` : ''}
                    \${req.status === 'pending' ? \`
                        <div style="background:rgba(234,179,8,0.1); border:1px solid #eab308; border-radius:8px; padding:10px; margin-bottom:12px;">
                            <p style="color:#fde047; font-size:0.9rem;">📨 طلب من بنك وزارة الداخلية لفتح حساب باستخدام هويتك. هل توافق؟</p>
                        </div>
                        <div style="display:flex; gap:10px;">
                            <button class="btn" style="background:#22c55e; flex:1;" onclick="actionBankReq('\${req._id}', 'approve')">✅ قبول وفتح الحساب</button>
                            <button class="btn" style="background:#ef4444; flex:1;" onclick="actionBankReq('\${req._id}', 'reject')">❌ رفض الطلب</button>
                        </div>
                    \` : ''}
                </div>
            \`).join('');
        }

        async function actionBankReq(id, action) {
            const r = await fetch(\`/api/bank/my-requests/\${id}/\${action}\`, { method: 'PUT' });
            const data = await r.json();
            if(data.success) {
                if(action === 'approve') {
                    alert(\`✅ تم قبول طلب البنك بنجاح!\\n\\nرقم حسابك البنكي هو:\\n\${data.accountNumber}\\n\\n⚠️ احفظ هذا الرقم جيداً، ستحتاجه دائماً عند الدخول للبنك.\`);
                } else {
                    alert("تم رفض طلب فتح الحساب.");
                }
                loadBankRequests();
            } else {
                alert("خطأ: " + data.msg);
            }
        }

        // ── لوحة الإدارة ──────────────────────────────────────────────────
        function openAdminDashboard() {
            document.getElementById('adminModal').style.display = 'block';
            switchMainTab('requests'); 
            if(currentUserRole === 'super_admin') {
                loadSuperAdminSettings();
            }
        }

        function closeAdminModal() {
            document.getElementById('adminModal').style.display = 'none';
        }

        function switchMainTab(tab) {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.getElementById("admin-requests-section").style.display = "none";
            document.getElementById("admin-bank-section").style.display = "none";
            document.getElementById("admin-archive-section").style.display = "none";
            document.getElementById("admin-log-section").style.display = "none";
            document.getElementById("super-admin-controls-section").style.display = "none";

            if(tab === 'requests') {
                document.getElementById("tab-req").classList.add("active");
                document.getElementById("admin-requests-section").style.display = "block";
                loadAdminRequests();
            } else if(tab === 'bank') {
                document.getElementById("tab-bank").classList.add("active");
                document.getElementById("admin-bank-section").style.display = "block";
                loadAdminBankRequests();
            } else if(tab === 'archive') {
                document.getElementById("tab-arch").classList.add("active");
                document.getElementById("admin-archive-section").style.display = "block";
                loadArchivedRequests();
            } else if(tab === 'log') {
                document.getElementById("tab-log").classList.add("active");
                document.getElementById("admin-log-section").style.display = "block";
                loadApprovalLog();
            } else if(tab === 'controls') {
                document.getElementById("tab-ctrl").classList.add("active");
                document.getElementById("super-admin-controls-section").style.display = "block";
            }
        }

        async function loadAdminRequests() {
            const res = await fetch('/api/admin/ids');
            const data = await res.json();
            const container = document.getElementById('admin-list-data');
            if(data.length === 0) return container.innerHTML = '<p style="text-align:center; padding:20px;">لا توجد أي طلبات هويات نشطة حالياً.</p>';
            container.innerHTML = data.map(id => \`
                <div class="card" style="background:rgba(255,255,255,0.02); margin-bottom:15px; border-color:#0d3060;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                        <span><b>مقدم الطلب:</b> \${id.discordTag} (\${id.discord})</span>
                        <span class="status-badge \${id.status === 'approved' ? 'status-approved' : (id.status === 'rejected' ? 'status-rejected' : 'status-pending')}">\${id.status}</span>
                    </div>
                    <p style="font-size:0.9rem; color:#94a3b8; margin-bottom:10px;">
                        الاسم: \${id.name} | العمر: \${id.age} | تاريخ الميلاد: \${id.dob} | الجنسية: \${id.nationality} | الجنس: \${id.gender}
                    </p>
                    \${id.idNumber ? \`<p style="font-size:0.9rem; color:#4ade80; margin-bottom:10px;">رقم الهوية: \${id.idNumber} | الاختصار: \${id.shortId}</p>\` : ''}
                    <div style="display:flex; gap:10px;">
                        \${id.status === 'pending' ? \`
                            <button class="btn" style="background:#22c55e; padding:5px 12px;" onclick="actionId('\${id._id}', 'approve')">✅ قبول واعتماد</button>
                            <button class="btn" style="background:#ef4444; padding:5px 12px;" onclick="actionId('\${id._id}', 'reject')">❌ رفض الطلب</button>
                        \` : ''}
                        \${currentUserRole === 'super_admin' ? \`<button class="btn" style="background:#eab308; padding:5px 12px; color:black;" onclick="actionId('\${id._id}', 'hide')">🗑️ أرشفة وإخفاء</button>\` : ''}
                    </div>
                </div>
            \`).join('');
        }

        let allArchivedData = [];

        async function loadArchivedRequests() {
            const res = await fetch('/api/admin/ids/archived');
            allArchivedData = await res.json();
            renderArchive(allArchivedData);
        }

        function renderArchive(data) {
            const container = document.getElementById('admin-archive-data');
            if(data.length === 0) return container.innerHTML = '<p style="text-align:center; padding:20px; color:#94a3b8;">لا توجد نتائج.</p>';
            container.innerHTML = data.map(id => \`
                <div class="card" style="background:rgba(239,68,68,0.02); margin-bottom:15px; border-color:#ef4444;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                        <span><b>مقدم الطلب (مؤرشفة):</b> \${id.discordTag} (\${id.discord})</span>
                        <span class="status-badge" style="background:rgba(239,68,68,0.2); color:#fca5a5;">مخفية 🗑️</span>
                    </div>
                    <p style="font-size:0.9rem; color:#94a3b8; margin-bottom:10px;">
                        الاسم: \${id.name} | العمر: \${id.age} | الجنسية: \${id.nationality} | الجنس: \${id.gender}
                        \${id.idNumber ? \` | رقم الهوية: \${id.idNumber} | الاختصار: \${id.shortId}\` : ''}
                    </p>
                    <div style="display:flex; gap:10px;">
                        <button class="btn btn-purple" style="padding:5px 12px;" onclick="actionId('\${id._id}', 'unarchive')">🔄 إلغاء الأرشيف</button>
                        <button class="btn" style="background:#22c55e; padding:5px 12px;" onclick="actionId('\${id._id}', 'approve')">✅ قبول مباشر</button>
                        <button class="btn" style="background:#7f1d1d; padding:5px 12px;" onclick="deleteId('\${id._id}')">🗑️ حذف نهائي</button>
                    </div>
                </div>
            \`).join('');
        }

        function filterArchive() {
            const q = document.getElementById('archive-search').value.trim().toLowerCase();
            if(!q) return renderArchive(allArchivedData);
            const filtered = allArchivedData.filter(id => {
                return [id.name, id.discordTag, id.discord, id.idNumber, id.shortId, id.nationality, id.gender]
                    .some(v => (v || '').toString().toLowerCase().includes(q));
            });
            renderArchive(filtered);
        }

        async function deleteId(id) {
            if(!confirm("متأكد إنك تبي تحذف هذي الهوية نهائياً؟ العملية ما ترجع فيها.")) return;
            const res = await fetch(\`/api/admin/ids/\${id}/delete\`, { method: 'DELETE' });
            const data = await res.json();
            if(data.success) {
                alert("تم حذف الهوية نهائياً.");
                loadArchivedRequests();
            } else {
                alert(data.msg || "فشلت عملية الحذف");
            }
        }

        async function actionId(id, action) {
            const res = await fetch(\`/api/admin/ids/\${id}/\${action}\`, { method: 'PUT' });
            const data = await res.json();
            if(data.success) {
                loadAdminRequests();
                loadArchivedRequests();
                if(action === 'approve') alert("تم اعتماد الهوية بنجاح!");
                if(action === 'hide') alert("تم نقل الهوية للأرشيف.");
                if(action === 'unarchive') alert("تمت إعادتها لقسم الطلبات.");
            } else {
                alert("فشلت العملية");
            }
        }

        // ── طلبات البنك في لوحة الإدارة ───────────────────────────────────
        async function loadAdminBankRequests() {
            const container = document.getElementById('admin-bank-data');
            container.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:20px;">جاري التحميل...</p>';
            try {
                const res = await fetch('/api/admin/bank-requests');
                if (!res.ok) {
                    container.innerHTML = '<p style="text-align:center; color:#ef4444; padding:20px;">❌ غير مصرح أو خطأ في السيرفر.</p>';
                    return;
                }
                const data = await res.json();
                if(data.length === 0) {
                    container.innerHTML = '<p style="text-align:center; padding:20px; color:#94a3b8;">لا توجد طلبات بنك معلقة حالياً.</p>';
                    return;
                }
                container.innerHTML = data.map(req => \`
                    <div class="card" style="margin-bottom:12px; border-color:#3b82f6; background:rgba(59,130,246,0.05);">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <span style="font-weight:bold; color:#93c5fd;">🏦 \${req.discordTag}</span>
                            <span style="color:#64748b; font-size:0.8rem;">\${req.discord}</span>
                        </div>
                        <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:4px;">رقم الهوية: <b style="color:#e2e8f0;">\${req.idNumber}</b></p>
                        <p style="color:#64748b; font-size:0.8rem; margin-bottom:12px;">تاريخ الطلب: \${new Date(req.createdAt).toLocaleString('ar-SA')}</p>
                        <div style="display:flex; gap:10px;">
                            <button class="btn" style="background:#22c55e; flex:1;" onclick="actionAdminBankReq('\${req._id}', 'approve')">✅ قبول وفتح الحساب</button>
                            <button class="btn" style="background:#ef4444; flex:1;" onclick="actionAdminBankReq('\${req._id}', 'reject')">❌ رفض الطلب</button>
                        </div>
                    </div>
                \`).join('');
            } catch(e) {
                container.innerHTML = '<p style="text-align:center; color:#ef4444; padding:20px;">❌ تعذر الاتصال بالسيرفر.</p>';
            }
        }

        async function actionAdminBankReq(id, action) {
            const r = await fetch(\`/api/admin/bank-requests/\${id}/\${action}\`, { method: 'PUT' });
            const data = await r.json();
            if(data.success) {
                if(action === 'approve') {
                    alert(\`✅ تم قبول الطلب بنجاح!\\nرقم الحساب المُولَّد: \${data.accountNumber}\\n\\nسيظهر للمستخدم كأنه قبل بنفسه.\`);
                } else {
                    alert("تم رفض الطلب.");
                }
                loadAdminBankRequests();
            } else {
                alert("خطأ: " + data.msg);
            }
        }

        // ── لوق الموقع الكامل (كبار المسؤولين فقط) ─────────────────────────
        const LOG_META = {
            id_submitted:        { icon: '📝', label: 'تقديم طلب هوية',      color: '#93c5fd', border: '#3b82f6' },
            id_approved:         { icon: '✅', label: 'اعتماد هوية',          color: '#4ade80', border: '#22c55e' },
            id_rejected:         { icon: '❌', label: 'رفض هوية',            color: '#fca5a5', border: '#ef4444' },
            id_hidden:           { icon: '🗑️', label: 'أرشفة هوية',          color: '#fde047', border: '#eab308' },
            id_unarchived:       { icon: '🔄', label: 'إلغاء أرشفة هوية',    color: '#60a5fa', border: '#3b82f6' },
            id_deleted:          { icon: '🗑️', label: 'حذف هوية نهائياً',    color: '#fca5a5', border: '#7f1d1d' },
            bank_request_submitted: { icon: '🏦', label: 'طلب فتح حساب بنكي', color: '#93c5fd', border: '#3b82f6' },
            bank_approved:       { icon: '✅', label: 'قبول حساب بنكي',      color: '#4ade80', border: '#22c55e' },
            bank_rejected:       { icon: '❌', label: 'رفض حساب بنكي',       color: '#fca5a5', border: '#ef4444' },
            staff_added:         { icon: '⭐', label: 'تعيين مسؤول جديد',     color: '#60a5fa', border: '#3b82f6' },
            staff_removed:       { icon: '🚫', label: 'طرد مسؤول',           color: '#fca5a5', border: '#ef4444' },
            settings_toggled:    { icon: '⚙️', label: 'تعديل إعدادات الموقع', color: '#60a5fa', border: '#3b82f6' }
        };

        let lastLogId = null;
        let allLogsData = [];
        async function loadApprovalLog(silent) {
            const res = await fetch('/api/superadmin/approval-log');
            const logs = await res.json();
            const container = document.getElementById('admin-log-data');
            if (!container) return;

            // لو التحديث صامت (بولنق) وما فيه شي جديد، لا تعيد الرسم
            if (silent && logs[0] && logs[0]._id === lastLogId) return;
            if (logs[0]) lastLogId = logs[0]._id;

            if (logs.length === 0) {
                allLogsData = [];
                container.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:20px;">لا توجد أي أحداث مسجلة حتى الآن.</p>';
                return;
            }

            allLogsData = logs;
            const q = (document.getElementById('log-search') || {}).value || '';
            renderLog(q.trim() ? filterLogsData(q) : logs);
        }

        function filterLogsData(q) {
            q = q.trim().toLowerCase();
            return allLogsData.filter(log => {
                const meta = LOG_META[log.action] || { label: log.action };
                return [log.discordId, log.discordTag, log.actorId, log.actorTag, log.details, log.action, meta.label, log.accountNumber]
                    .some(v => (v || '').toString().toLowerCase().includes(q));
            });
        }

        function filterLog() {
            const q = document.getElementById('log-search').value;
            renderLog(q.trim() ? filterLogsData(q) : allLogsData);
        }

        function renderLog(logs) {
            const container = document.getElementById('admin-log-data');
            if (!container) return;
            if(logs.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:20px;">لا توجد نتائج مطابقة.</p>';
                return;
            }

            container.innerHTML = logs.map(log => {
                const meta = LOG_META[log.action] || { icon: 'ℹ️', label: log.action, color: '#94a3b8', border: '#64748b' };
                return \`
                <div class="log-item" style="border-color:\${meta.border}; flex-wrap:wrap;">
                    <div>
                        <span style="color:\${meta.color}; font-weight:bold;">\${meta.icon} \${meta.label}</span>
                        <span style="color:#64748b; margin-right:10px; font-size:0.8rem;">\${log.site || ''}</span>
                    </div>
                    <div style="text-align:left; color:#94a3b8; font-size:0.85rem;">
                        \${log.discordId ? \`<div>المستخدم: <b style="color:#60a5fa;">\${log.discordTag || ''}</b> (\${log.discordId})</div>\` : ''}
                        \${log.actorTag ? \`<div>بواسطة: <b style="color:#e2e8f0;">\${log.actorTag}</b> (\${log.actorId})</div>\` : ''}
                        \${log.accountNumber ? \`<div style="color:#4ade80;">رقم الحساب: \${log.accountNumber}</div>\` : ''}
                        \${log.details ? \`<div style="color:#93c5fd;">\${log.details}</div>\` : ''}
                        <div style="font-size:0.78rem; color:#64748b;">\${new Date(log.createdAt).toLocaleString('ar-SA')}</div>
                    </div>
                </div>\`;
            }).join('');
        }

        // ── إعدادات السوبر أدمين ───────────────────────────────────────────
        async function loadSuperAdminSettings() {
            const res = await fetch('/api/superadmin/settings');
            globalSettings = await res.json();
            updateButtonState('btn-toggle-maintenance', globalSettings.isMaintenance);
            updateButtonState('btn-toggle-apply', globalSettings.isApplyLocked);
            updateButtonState('btn-toggle-ids', globalSettings.isIdsPageLocked);
            const listEl = document.getElementById('current-staff-list');
            if(globalSettings.staffList.length === 0) {
                listEl.innerHTML = '<li>لا يوجد مسؤولين عاديين حالياً</li>';
            } else {
                listEl.innerHTML = globalSettings.staffList.map(uid => \`
                    <li style="margin-bottom:8px;">
                        <span>\${uid}</span>
                        <button class="btn" style="background:#ef4444; padding:2px 8px; font-size:0.75rem; margin-right:15px;" onclick="removeStaff('\${uid}')">طرد وإلغاء الرتبة</button>
                    </li>
                \`).join('');
            }
        }

        function updateButtonState(btnId, active) {
            const btn = document.getElementById(btnId);
            if(active) {
                btn.innerText = "تفعيل / قيد الإغلاق الآن";
                btn.className = "toggle-btn active-status";
            } else {
                btn.innerText = "معطل / مفتوح ومتاح";
                btn.className = "toggle-btn inactive-status";
            }
        }

        async function toggleSetting(type) {
            let body = {
                isMaintenance: globalSettings.isMaintenance,
                isApplyLocked: globalSettings.isApplyLocked,
                isIdsPageLocked: globalSettings.isIdsPageLocked
            };
            if(type === 'm') body.isMaintenance = !globalSettings.isMaintenance;
            if(type === 'a') body.isApplyLocked = !globalSettings.isApplyLocked;
            if(type === 'i') body.isIdsPageLocked = !globalSettings.isIdsPageLocked;
            const res = await fetch('/api/superadmin/settings/toggle', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if(data.success) loadSuperAdminSettings();
        }

        async function addStaff() {
            const discordId = document.getElementById('new-staff-id').value;
            if(!discordId) return alert("اكتب الآيدي أولاً");
            const res = await fetch('/api/superadmin/staff/add', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ discordId })
            });
            const data = await res.json();
            alert(data.msg);
            if(data.success) {
                document.getElementById('new-staff-id').value = '';
                loadSuperAdminSettings();
            }
        }

        async function removeStaff(discordId) {
            if(!confirm("هل أنت متأكد من طرد هذا المسؤول؟")) return;
            const res = await fetch('/api/superadmin/staff/remove', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ discordId })
            });
            const data = await res.json();
            alert(data.msg);
            if(data.success) loadSuperAdminSettings();
        }

        checkAuth();

        // ── نظام التحديث المباشر (Live Update) ──────────────────────────────
        // يحدّث تلقائياً كل فترة قصيرة حسب الصفحة/القسم المفتوح حالياً،
        // بدون ما يحتاج المستخدم أو الإداري يعمل رفرش يدوي.
        setInterval(() => {
            const activePage = document.querySelector('.page.active');
            if (activePage) {
                if (activePage.id === 'page-ids') loadMyIds();
                if (activePage.id === 'page-bank') loadBankRequests();
            }

            const adminModal = document.getElementById('adminModal');
            if (adminModal && adminModal.style.display === 'block') {
                const activeTabBtn = document.querySelector('.tab-btn.active');
                if (!activeTabBtn) return;
                if (activeTabBtn.id === 'tab-req') loadAdminRequests();
                if (activeTabBtn.id === 'tab-bank') loadAdminBankRequests();
                if (activeTabBtn.id === 'tab-arch') loadArchivedRequests();
                if (activeTabBtn.id === 'tab-log') loadApprovalLog(true); // silent: ما يعيد الرسم إلا لو فيه جديد
            }
        }, 6000);
    </script>
<footer style="text-align: center; padding: 1.5rem; margin-top: 2rem; border-top: 1px solid rgba(59,130,246,0.2); background: rgba(5,15,30,0.6); color: #94a3b8; font-size: 0.9rem;">
    <p>جميع الحقوق محفوظة © 2026 | <span style="color: #60a5fa; font-weight: bold;">MOI - وزارة الداخلية</span></p>
</footer>
</body>
</html>`);
});

const PORT = process.env.PORT || 7622;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
