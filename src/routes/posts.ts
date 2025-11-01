import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "fs-extra";

const r = Router();
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.ensureDirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR });

r.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const publicUrl = `${process.env.APP_BASE_URL}/uploads/${req.file.filename}`;
  res.json({ url: publicUrl });
});

router.post('/schedule', async (req, res, next) => {
  try {
    const { caption, imageUrl, scheduledTime } = req.body as Partial<NewPostInput>;

    if (!caption || !imageUrl || !scheduledTime) {
      return res.status(400).json({ message: 'caption, imageUrl, and scheduledTime are required.' });
    }

    const newPost = await addPost({ caption, imageUrl, scheduledTime });
    res.status(201).json(newPost);
  } catch (error) {
    next(error);
  }
});

export default router;
