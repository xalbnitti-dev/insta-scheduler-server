import express from 'express';
import cron from 'node-cron';
import postsRouter from './routes/posts';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.use(postsRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ message: 'Internal server error' });
});

cron.schedule('* * * * *', () => {
  console.log('Checking scheduled posts...');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
