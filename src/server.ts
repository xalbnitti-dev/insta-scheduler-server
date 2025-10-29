import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs-extra";

// ✅ initialize app
const app = express();
const PORT = process.env.PORT || 5000;

// ✅ CORS settings
const allowedOrigins = [
  "http://localhost:5173",             // për testim lokal
  /\.vercel\.app$/,                    // çdo domain nga Vercel
  "https://insta-admin.vercel.app",    // (nëse ke domain specifik)
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (
        allowedOrigins.some((o) =>
          o instanceof RegExp ? o.test(origin) : o === origin
        )
      ) {
        return cb(null, true);
      }
      cb(new Error("CORS blocked"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Admin-Key"],
  })
);
app.options("*", cors());

// ✅ ensure uploads folder exists
const uploadDir = path.join(process.cwd(), "uploads");
fs.ensureDirSync(uploadDir);

// ✅ Multer setup
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// ✅ Middleware
app.use(express.json());
app.use("/uploads", express.static(uploadDir));

// ✅ Simple health check
app.get("/health", (_req, res) => res.send("OK"));

// ✅ Schedule endpoint (upload ose imageUrl)
app.post("/posts/schedule", upload.single("image"), async (req, res) => {
  try {
    const { caption, publishTime, account, imageUrl } = req.body;
    const adminKey = req.headers["x-admin-key"];

    // 🔒 validate admin key
    if (adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 🔍 kontrollo nëse ka foto
    let finalImageUrl = imageUrl;
    if (req.file) {
      finalImageUrl = `${process.env.APP_BASE_URL}/uploads/${req.file.filename}`;
    }

    if (!finalImageUrl) {
      return res.status(400).json({
        error: "Vendos një foto (upload ose URL)",
      });
    }

    console.log("✅ Planned post:", {
      account,
      caption,
      publishTime,
      image: finalImageUrl,
    });

    // këtu do të shtosh logjikën e planifikimit real (cron ose DB)
    res.json({
      success: true,
      message: "Post planifikuar me sukses!",
      data: { account, caption, publishTime, image: finalImageUrl },
    });
  } catch (err) {
    console.error("❌ Error in schedule:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ start server
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
