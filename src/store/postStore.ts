import { promises as fs } from 'fs';
import path from 'path';
import { Post, NewPostInput } from '../models/post';

const DATA_FILE = path.resolve(__dirname, '../../data/posts.json');

async function readPosts(): Promise<Post[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw) as Post[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
      await fs.writeFile(DATA_FILE, '[]', 'utf-8');
      return [];
    }
    throw error;
  }
}

async function writePosts(posts: Post[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(posts, null, 2), 'utf-8');
}

export async function getAllPosts(): Promise<Post[]> {
  return readPosts();
}

export async function addPost(input: NewPostInput): Promise<Post> {
  const posts = await readPosts();
  const newPost: Post = {
    id: `post_${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: 'scheduled',
    ...input
  };
  posts.push(newPost);
  await writePosts(posts);
  return newPost;
}
