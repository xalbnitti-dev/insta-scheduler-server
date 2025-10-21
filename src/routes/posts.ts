import { Router } from 'express';
import { getAllPosts, addPost } from '../store/postStore';
import { NewPostInput } from '../models/post';

const router = Router();

router.get('/posts', async (_req, res, next) => {
  try {
    const posts = await getAllPosts();
    res.json(posts);
  } catch (error) {
    next(error);
  }
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
